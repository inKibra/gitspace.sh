import {
  EnvironmentError, emptyLifecycleState, transitionLifecycle, isLifecycleRunActive, LIFECYCLE_PREVIEW_LIMIT, LifecycleStateSchema, LifecycleRunSchema,
  type LifecycleActor, type LifecycleMutation, type LifecycleRun, type LifecycleRunLog, type LifecycleRunRecord, type LifecycleState,
} from '@gitspace/protocol-environment';
import { z } from 'zod';
import type { LiveChanges } from './live-changes.js';
import type { SpaceAuthorityDO } from './space-authority.js';

/** The workspace object's environment operations its own runtime calls in-process. */
export type WorkspaceEnvironment = Pick<SpaceAuthorityDO, 'getLifecycleState' | 'refreshBrowserOrigins' | 'mutateLifecycleState' | 'getLifecycleRunLog' | 'lifecycleRunEnded'>;

const StoredEnvironmentSchema = LifecycleStateSchema.extend({ browserOriginsAvailable: z.boolean().default(true) });
type StoredEnvironment = z.output<typeof StoredEnvironmentSchema>;
function availableState({ browserOriginsAvailable, ...state }: StoredEnvironment): LifecycleState {
  return browserOriginsAvailable ? state : { ...state, browserOrigins: [] };
}

/** Values and approvals every workspace of a project shares; the project object owns them. */
export interface SharedEnvironment { values: Record<string, string>; approvals: LifecycleState['approvals'] }
/** What a workspace change does to the shared part: values set (null deletes), approvals granted, hashes revoked. */
export interface SharedEnvironmentChange { values: Record<string, string | null>; approvals: LifecycleState['approvals']; revoked: string[] }
/** A machine, or one attachment of it, the cloud knows is gone. */
export interface LostLifecycleHolder { machineId: string; attachment?: { attachmentId: string; generation: number }; reason: string }
/** The rows the project object held for one workspace before environments moved into workspace objects. */
export interface ExportedEnvironment { state: string | null; runs: { id: string; scope: string; data: string }[] }
export interface ExportedLogs { rows: { runId: string; offset: number; output: string }[]; next: { runId: string; offset: number } | null }

interface JsonRow extends Record<string, SqlStorageValue> { data: string }
interface RunRow extends JsonRow { scope: string }
const LOG_PAGE_SIZE = 4;

function sharedChange(before: SharedEnvironment, after: SharedEnvironment): SharedEnvironmentChange | null {
  const values: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(after.values)) if (before.values[name] !== value) values[name] = value;
  for (const name of Object.keys(before.values)) if (!(name in after.values)) values[name] = null;
  const approvals = after.approvals.filter(approval => !before.approvals.some(entry => entry.executionHash === approval.executionHash && entry.approvedAt === approval.approvedAt && entry.approvedBy === approval.approvedBy));
  const kept = new Set(after.approvals.map(approval => approval.executionHash));
  const revoked = before.approvals.filter(approval => !kept.has(approval.executionHash)).map(approval => approval.executionHash);
  return Object.keys(values).length || approvals.length || revoked.length ? { values, approvals, revoked } : null;
}

/** One workspace's environment: its configuration, runs and run logs, stored in the workspace object. Shared project
 * values and approvals are passed in by the caller, which writes back the change a transition makes to them. */
export class SpaceEnvironmentStore {
  private readonly settled = new Map<string, Set<(run: LifecycleRun) => void>>();
  /** `changes` is the workspace object's: environment changes reach watching tabs with its other changes. */
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>, private readonly changes: LiveChanges) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS environment_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_logs(run_id TEXT NOT NULL,offset INTEGER NOT NULL,output TEXT NOT NULL,PRIMARY KEY(run_id,offset));
    `);
  }

  /** False until the workspace's environment was imported from the project object (or started empty here). */
  present(): boolean {
    return this.storage.sql.exec('SELECT id FROM environment_state WHERE id=1').toArray().length > 0;
  }

  /** One-time import; `logs` pages the project's log rows. */
  async import(projectId: string, spaceId: string, exported: ExportedEnvironment, logs: (after: ExportedLogs['next']) => Promise<ExportedLogs>): Promise<void> {
    let after: ExportedLogs['next'] = null;
    const pages: ExportedLogs['rows'][] = [];
    do {
      const page = await logs(after);
      pages.push(page.rows);
      after = page.next;
    } while (after);
    if (this.present()) return;
    this.storage.transactionSync(() => {
      for (const run of exported.runs) this.storage.sql.exec('INSERT OR IGNORE INTO lifecycle_runs(id,scope,data) VALUES(?,?,?)', run.id, run.scope, run.data);
      for (const row of pages.flat()) this.storage.sql.exec('INSERT OR IGNORE INTO lifecycle_logs(run_id,offset,output) VALUES(?,?,?)', row.runId, row.offset, row.output);
      this.persist(StoredEnvironmentSchema.parse(exported.state ? JSON.parse(exported.state) : emptyLifecycleState(projectId, spaceId)));
    });
  }

  get(projectId: string, spaceId: string, shared: SharedEnvironment): LifecycleState {
    return availableState(this.stored(projectId, spaceId, shared));
  }

  private stored(projectId: string, spaceId: string, shared: SharedEnvironment): StoredEnvironment {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state WHERE id=1').toArray()[0];
    const state = StoredEnvironmentSchema.parse(row ? JSON.parse(row.data) : emptyLifecycleState(projectId, spaceId));
    state.values.project = shared.values;
    state.approvals = [...shared.approvals, ...state.approvals.filter((approval) => approval.scope === 'workspace')];
    state.runs = this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs ORDER BY rowid DESC').toArray().map((entry) => LifecycleRunSchema.parse(JSON.parse(entry.data)));
    state.claim = null;
    return state;
  }

  /** Trusted ingress only: entries are derived from the canonical committed HEAD. On the base workspace, a removed
   * origin also loses its project-wide approval. */
  setBrowserOrigins(projectId: string, spaceId: string, origins: LifecycleState['browserOrigins'], shared: SharedEnvironment): { state: LifecycleState; shared: SharedEnvironmentChange | null } {
    const browserOrigins = LifecycleStateSchema.shape.browserOrigins.parse(origins);
    const result = this.storage.transactionSync(() => {
      const state = this.stored(projectId, spaceId, shared);
      if (state.browserOriginsAvailable && JSON.stringify(state.browserOrigins) === JSON.stringify(browserOrigins)) return { state: availableState(state), shared: null };
      const retained = new Set(browserOrigins.map((entry) => entry.hash));
      const removed = new Set(state.browserOrigins.filter((entry) => !retained.has(entry.hash)).map((entry) => entry.hash));
      const projectScope = spaceId === projectId;
      state.approvals = state.approvals.filter((entry) => !removed.has(entry.executionHash) || (entry.scope === 'project' && !projectScope));
      state.browserOrigins = browserOrigins;
      state.browserOriginsAvailable = true;
      state.revision += 1;
      this.persist(state);
      this.changes.mark(`environment:${spaceId}`);
      return { state: availableState(state), shared: sharedChange(shared, { values: shared.values, approvals: state.approvals.filter((entry) => entry.scope === 'project') }) };
    });
    this.changes.wake();
    return result;
  }

  markBrowserOriginsUnavailable(projectId: string, spaceId: string, shared: SharedEnvironment): void {
    this.storage.transactionSync(() => {
      const state = this.stored(projectId, spaceId, shared);
      if (!state.browserOriginsAvailable) return;
      state.browserOriginsAvailable = false;
      state.revision += 1;
      this.persist(state);
      this.changes.mark(`environment:${spaceId}`);
    });
    this.changes.wake();
  }

  /** The active runs of a lost holder: a lost attachment's runs, or all the machine's runs when the machine itself is gone. */
  lostRuns(holder: LostLifecycleHolder): string[] {
    return this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs').toArray().map((row) => LifecycleRunSchema.parse(JSON.parse(row.data)))
      .filter((run) => run.machineId === holder.machineId && isLifecycleRunActive(run)
        && (!holder.attachment || (run.attachment?.attachmentId === holder.attachment.attachmentId && run.attachment.generation === holder.attachment.generation)))
      .map((run) => run.id);
  }

  runLog(runId: string, offset = 0): LifecycleRunLog {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new EnvironmentError('InvalidConfiguration', 'Invalid lifecycle log offset');
    if (!this.storage.sql.exec('SELECT id FROM lifecycle_runs WHERE id=?', runId).toArray().length) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId });
    const rows = this.storage.sql.exec<{ offset: number; output: string }>(
      'SELECT offset,output FROM lifecycle_logs WHERE run_id=? AND offset>=? ORDER BY offset LIMIT ?', runId, offset, LOG_PAGE_SIZE + 1,
    ).toArray();
    const page = rows.slice(0, LOG_PAGE_SIZE);
    return { output: page.map((row) => row.output).join(''), nextOffset: rows[LOG_PAGE_SIZE]?.offset ?? null, cursor: page.length ? page[page.length - 1]!.offset + 1 : offset };
  }


  mutate(projectId: string, spaceId: string, input: LifecycleMutation, actor: LifecycleActor, shared: SharedEnvironment): { state: LifecycleState; shared: SharedEnvironmentChange | null } {
    const ended: LifecycleRun[] = [];
    const result = this.storage.transactionSync(() => {
      const runs: LifecycleRunRecord[] = this.storage.sql.exec<RunRow>('SELECT scope,data FROM lifecycle_runs')
        .toArray().map((row) => ({ run: LifecycleRunSchema.parse(JSON.parse(row.data)), scope: row.scope }));
      const stored = this.stored(projectId, spaceId, shared);
      const current = availableState(stored);
      if (input.op === 'approval' && input.approved && input.scope === 'project' && spaceId !== projectId && current.browserOrigins.some((entry) => entry.hash === input.executionHash)) throw new EnvironmentError('PermissionDenied', 'Approve browser origins on the base workspace for project-wide access');
      const transition = transitionLifecycle({ state: current, runs, actor, now: new Date().toISOString() }, input);
      if (!transition.changed) return { state: transition.state, shared: null };
      const { state, record, log } = transition;
      for (const entry of [...(record ? [record] : []), ...(transition.replaced ?? [])]) {
        this.storage.sql.exec('INSERT INTO lifecycle_runs(id,scope,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', entry.run.id, entry.scope, JSON.stringify(entry.run));
        if (!isLifecycleRunActive(entry.run)) ended.push(entry.run);
      }
      if (log?.output) {
        let offset = this.storage.sql.exec<{ next: number }>('SELECT COALESCE(MAX(offset)+1,0) AS next FROM lifecycle_logs WHERE run_id=?', log.runId).one().next;
        for (let start = 0; start < log.output.length; start += LIFECYCLE_PREVIEW_LIMIT) this.storage.sql.exec(
          'INSERT INTO lifecycle_logs(run_id,offset,output) VALUES(?,?,?)', log.runId, offset++, log.output.slice(start, start + LIFECYCLE_PREVIEW_LIMIT),
        );
      }
      this.persist({ ...state, browserOrigins: stored.browserOriginsAvailable ? state.browserOrigins : stored.browserOrigins, browserOriginsAvailable: stored.browserOriginsAvailable });
      this.changes.mark(`environment:${spaceId}`);
      return { state, shared: transition.sharedChanged ? sharedChange(shared, { values: state.values.project, approvals: state.approvals.filter((entry) => entry.scope === 'project') }) : null };
    });
    this.changes.wake();
    for (const run of ended) {
      for (const resolve of this.settled.get(run.id) ?? []) resolve(run);
      this.settled.delete(run.id);
    }
    return result;
  }

  /** Resolves when the run ends: it finished, was cancelled, replaced or interrupted. */
  ended(runId: string, signal?: AbortSignal): Promise<LifecycleRun> {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs WHERE id=?', runId).toArray()[0];
    if (!row) return Promise.reject(new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId }));
    const run = LifecycleRunSchema.parse(JSON.parse(row.data));
    if (!isLifecycleRunActive(run)) return Promise.resolve(run);
    const { promise, resolve, reject } = Promise.withResolvers<LifecycleRun>();
    const waiters = this.settled.get(runId) ?? new Set<(run: LifecycleRun) => void>();
    this.settled.set(runId, waiters);
    const abort = () => { waiters.delete(done); reject(signal?.reason); };
    const done = (ended: LifecycleRun) => { signal?.removeEventListener('abort', abort); resolve(ended); };
    waiters.add(done);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return promise;
  }

  private persist(state: StoredEnvironment): void {
    this.storage.sql.exec('INSERT INTO environment_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify({ ...state, runs: [], claim: null }));
  }
}
