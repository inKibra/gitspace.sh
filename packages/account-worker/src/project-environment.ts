import {
  EnvironmentError, LifecycleMutationSchema, assertEnvironmentRetired, emptyLifecycleState,
  transitionLifecycle, isLifecycleRunActive, LIFECYCLE_PREVIEW_LIMIT, LifecycleStateSchema, LifecycleRunSchema,
  type LifecycleActor, type LifecycleMutation, type LifecycleRunLog,
  type LifecycleRunRecord, type LifecycleState,
} from '@gitspace/protocol-environment';
import { DurableChangeLog } from './durable-stream.js';
import { z } from 'zod';

const StoredEnvironmentSchema = LifecycleStateSchema.extend({ browserOriginsAvailable: z.boolean().default(true) });
type StoredEnvironment = z.output<typeof StoredEnvironmentSchema>;
function availableState({ browserOriginsAvailable, ...state }: StoredEnvironment): LifecycleState {
  return browserOriginsAvailable ? state : { ...state, browserOrigins: [] };
}

interface JsonRow extends Record<string, SqlStorageValue> { data: string }
interface RunRow extends JsonRow { scope: string; token: string | null; lock_key: string }
interface SharedEnvironment { values: Record<string, string>; approvals: LifecycleState['approvals'] }
const LOG_PAGE_SIZE = 4;

/** Owns persistence only; the same transition executes in browser, Bun and Worker. */
export class ProjectEnvironmentStore {
  private readonly changes: DurableChangeLog;
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {
    this.changes = new DurableChangeLog(storage);
  }

  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS environment_state(space_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environment_shared(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_runs(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,scope TEXT NOT NULL,lock_key TEXT NOT NULL,token TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_space ON lifecycle_runs(space_id);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_scope ON lifecycle_runs(scope);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_lock ON lifecycle_runs(lock_key);
      CREATE TABLE IF NOT EXISTS lifecycle_logs(run_id TEXT NOT NULL,offset INTEGER NOT NULL,output TEXT NOT NULL,PRIMARY KEY(run_id,offset));
    `);
  }

  get(projectId: string, spaceId: string): LifecycleState {
    return availableState(this.stored(projectId, spaceId));
  }

  private stored(projectId: string, spaceId: string): StoredEnvironment {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state WHERE space_id=?', spaceId).toArray()[0];
    const shared = this.shared();
    const state = StoredEnvironmentSchema.parse(row ? JSON.parse(row.data) : emptyLifecycleState(projectId, spaceId));
    state.values.project = shared.values;
    state.approvals = [...shared.approvals, ...state.approvals.filter((approval) => approval.scope === 'workspace')];
    state.runs = this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs WHERE space_id=? ORDER BY rowid DESC', spaceId)
      .toArray().map((entry) => LifecycleRunSchema.parse(JSON.parse(entry.data)));
    state.claim = null;
    return state;
  }

  /** Trusted authority ingress only: entries are derived from the canonical committed HEAD. */
  setBrowserOrigins(projectId: string, spaceId: string, origins: LifecycleState['browserOrigins']): LifecycleState {
    const browserOrigins = LifecycleStateSchema.shape.browserOrigins.parse(origins);
    const result = this.storage.transactionSync(() => {
      const state = this.stored(projectId, spaceId);
      if (state.browserOriginsAvailable && JSON.stringify(state.browserOrigins) === JSON.stringify(browserOrigins)) return availableState(state);
      const retainedHashes = new Set(browserOrigins.map((entry) => entry.hash));
      const removedHashes = new Set(state.browserOrigins.filter((entry) => !retainedHashes.has(entry.hash)).map((entry) => entry.hash));
      const projectScope = spaceId === projectId;
      const approvals = state.approvals.filter((entry) => !removedHashes.has(entry.executionHash) || (entry.scope === 'project' && !projectScope));
      const sharedChanged = projectScope && state.approvals.some((entry) => entry.scope === 'project' && removedHashes.has(entry.executionHash));
      state.approvals = approvals;
      if (sharedChanged) this.saveShared({ values: state.values.project, approvals: approvals.filter((entry) => entry.scope === 'project') });
      state.browserOrigins = browserOrigins;
      state.browserOriginsAvailable = true;
      state.revision += 1;
      this.persist(state);
      this.changes.append(`environment:${spaceId}`, availableState(state));
      if (sharedChanged) this.publishShared(spaceId);
      return availableState(state);
    });
    this.changes.wake();
    return result;
  }

  markBrowserOriginsUnavailable(projectId: string, spaceId: string): void {
    this.storage.transactionSync(() => {
      const state = this.stored(projectId, spaceId);
      if (!state.browserOriginsAvailable) return;
      state.browserOriginsAvailable = false;
      state.revision += 1;
      this.persist(state);
      this.changes.append(`environment:${spaceId}`, availableState(state));
    });
    this.changes.wake();
  }

  getValues(): Record<string, string> { return this.shared().values; }

  setValue(name: string, value: string | null): Record<string, string> {
    const mutation = LifecycleMutationSchema.parse({ op: 'value', scope: 'project', name, value });
    const values = this.storage.transactionSync(() => {
      const shared = this.shared();
      const first = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state LIMIT 1').toArray()[0];
      const state = first ? availableState(StoredEnvironmentSchema.parse(JSON.parse(first.data))) : emptyLifecycleState('project', 'account-values');
      state.values.project = shared.values;
      const transition = transitionLifecycle({ state, runs: [], actor: { actorId: 'account-authority', machineId: 'account-authority', kind: 'machine', lifecycleControl: false }, now: new Date().toISOString(), token: '' }, mutation);
      this.saveShared({ ...shared, values: transition.state.values.project });
      this.publishShared();
      return transition.state.values.project;
    });
    this.changes.wake();
    return values;
  }

  assertRetired(projectId: string, spaceId: string): void {
    assertEnvironmentRetired(this.get(projectId, spaceId));
  }

  /** Interrupt every claim the lost holder still owns in this workspace: a lost attachment's runs, or all the machine's
   * runs when the machine itself is gone. The abandon transition re-proves ownership; returns the released run ids. */
  releaseLostHolder(projectId: string, spaceId: string, holder: NonNullable<LifecycleActor['lostHolder']>): string[] {
    const actor: LifecycleActor = { actorId: 'cloud:attachment-lease', machineId: 'cloud:attachment-lease', kind: 'client', lifecycleControl: true, lostHolder: holder };
    const claimed = this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs WHERE space_id=? AND token IS NOT NULL', spaceId).toArray().map((row) => LifecycleRunSchema.parse(JSON.parse(row.data)));
    const released: string[] = [];
    for (const run of claimed) {
      if (run.machineId !== holder.machineId || !isLifecycleRunActive(run)) continue;
      if (holder.attachment && (run.attachment?.attachmentId !== holder.attachment.attachmentId || run.attachment.generation !== holder.attachment.generation)) continue;
      this.mutate(projectId, spaceId, { op: 'abandon', runId: run.id }, actor);
      released.push(run.id);
    }
    return released;
  }

  runLog(spaceId: string, runId: string, offset = 0): LifecycleRunLog {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new EnvironmentError('InvalidConfiguration', 'Invalid lifecycle log offset');
    if (!this.storage.sql.exec('SELECT id FROM lifecycle_runs WHERE id=? AND space_id=?', runId, spaceId).toArray().length) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId });
    const rows = this.storage.sql.exec<{ offset: number; output: string }>(
      'SELECT offset,output FROM lifecycle_logs WHERE run_id=? AND offset>=? ORDER BY offset LIMIT ?', runId, offset, LOG_PAGE_SIZE + 1,
    ).toArray();
    const page = rows.slice(0, LOG_PAGE_SIZE);
    return { output: page.map((row) => row.output).join(''), nextOffset: rows[LOG_PAGE_SIZE]?.offset ?? null, cursor: page.length ? page[page.length - 1]!.offset + 1 : offset };
  }

  mutate(projectId: string, spaceId: string, input: LifecycleMutation, actor: LifecycleActor): LifecycleState {
    const result = this.storage.transactionSync(() => {
      const runs: LifecycleRunRecord[] = this.storage.sql.exec<RunRow>('SELECT scope,token,lock_key,data FROM lifecycle_runs')
        .toArray().map((row) => ({ run: LifecycleRunSchema.parse(JSON.parse(row.data)), token: row.token, scope: row.scope, lock: row.lock_key }));
      const stored = this.stored(projectId, spaceId);
      const current = availableState(stored);
      if (input.op === 'approval' && input.approved && input.scope === 'project' && spaceId !== projectId && current.browserOrigins.some((entry) => entry.hash === input.executionHash)) throw new EnvironmentError('PermissionDenied', 'Approve browser origins on the base workspace for project-wide access');
      const transition = transitionLifecycle({ state: current, runs, actor, now: new Date().toISOString(), token: crypto.randomUUID() }, input);
      if (!transition.changed) return transition.state;
      const { state, record, log } = transition;
      if (record) this.storage.sql.exec(
        'INSERT INTO lifecycle_runs(id,space_id,scope,lock_key,token,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,data=excluded.data',
        record.run.id, spaceId, record.scope, record.lock, record.token, JSON.stringify(record.run),
      );
      if (log?.output) {
        let offset = this.storage.sql.exec<{ next: number }>('SELECT COALESCE(MAX(offset)+1,0) AS next FROM lifecycle_logs WHERE run_id=?', log.runId).one().next;
        for (let start = 0; start < log.output.length; start += LIFECYCLE_PREVIEW_LIMIT) this.storage.sql.exec(
          'INSERT INTO lifecycle_logs(run_id,offset,output) VALUES(?,?,?)', log.runId, offset++, log.output.slice(start, start + LIFECYCLE_PREVIEW_LIMIT),
        );
      }
      if (transition.sharedChanged) this.saveShared({ values: state.values.project, approvals: state.approvals.filter((entry) => entry.scope === 'project') });
      this.persist({ ...state, browserOrigins: stored.browserOriginsAvailable ? state.browserOrigins : stored.browserOrigins, browserOriginsAvailable: stored.browserOriginsAvailable });
      this.changes.append(`environment:${spaceId}`, { ...state, claim: null });
      if (transition.sharedChanged) this.publishShared(spaceId);
      return state;
    });
    this.changes.wake();
    return result;
  }

  private shared(): SharedEnvironment {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_shared WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) as SharedEnvironment : { values: {}, approvals: [] };
  }
  private saveShared(shared: SharedEnvironment): void {
    this.storage.sql.exec('INSERT INTO environment_shared(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(shared));
  }
  private persist(state: StoredEnvironment): void {
    this.storage.sql.exec('INSERT INTO environment_state(space_id,data) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET data=excluded.data', state.spaceId, JSON.stringify({ ...state, runs: [], claim: null }));
  }
  private publishShared(exceptSpaceId?: string): void {
    for (const row of this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state').toArray()) {
      const stored = StoredEnvironmentSchema.parse(JSON.parse(row.data));
      if (stored.spaceId === exceptSpaceId) continue;
      const state = this.stored(stored.projectId, stored.spaceId);
      state.revision += 1;
      this.persist(state);
      this.changes.append(`environment:${state.spaceId}`, availableState(state));
    }
  }
}
