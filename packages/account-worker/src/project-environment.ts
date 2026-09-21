import {
  EnvironmentError, LifecycleMutationSchema, assertEnvironmentRetired, emptyLifecycleState,
  transitionLifecycle, LIFECYCLE_PREVIEW_LIMIT,
  type LifecycleActor, type LifecycleMutation, type LifecycleRun, type LifecycleRunLog,
  type LifecycleRunRecord, type LifecycleState,
} from '@gitspace/protocol-environment';
import { DurableChangeLog } from './durable-stream.js';

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
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state WHERE space_id=?', spaceId).toArray()[0];
    const shared = this.shared();
    const state: LifecycleState = row ? JSON.parse(row.data) as LifecycleState : emptyLifecycleState(projectId, spaceId);
    state.values.project = shared.values;
    state.approvals = [...shared.approvals, ...state.approvals.filter((approval) => approval.scope === 'workspace')];
    state.runs = this.storage.sql.exec<JsonRow>('SELECT data FROM lifecycle_runs WHERE space_id=? ORDER BY rowid DESC', spaceId)
      .toArray().map((entry) => JSON.parse(entry.data) as LifecycleRun);
    state.claim = null;
    return state;
  }

  getValues(): Record<string, string> { return this.shared().values; }

  setValue(name: string, value: string | null): Record<string, string> {
    const mutation = LifecycleMutationSchema.parse({ op: 'value', scope: 'project', name, value });
    const values = this.storage.transactionSync(() => {
      const shared = this.shared();
      const first = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state LIMIT 1').toArray()[0];
      const state = first ? JSON.parse(first.data) as LifecycleState : emptyLifecycleState('project', 'account-values');
      state.values.project = shared.values;
      const transition = transitionLifecycle({ state, runs: [], actor: { actorId: 'account-authority', machineId: 'account-authority', human: false }, now: new Date().toISOString(), token: '' }, mutation);
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
        .toArray().map((row) => ({ run: JSON.parse(row.data) as LifecycleRun, token: row.token, scope: row.scope, lock: row.lock_key }));
      const transition = transitionLifecycle({ state: this.get(projectId, spaceId), runs, actor, now: new Date().toISOString(), token: crypto.randomUUID() }, input);
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
      this.persist(state);
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
  private persist(state: LifecycleState): void {
    this.storage.sql.exec('INSERT INTO environment_state(space_id,data) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET data=excluded.data', state.spaceId, JSON.stringify({ ...state, runs: [], claim: null }));
  }
  private publishShared(exceptSpaceId?: string): void {
    for (const row of this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state').toArray()) {
      const stored = JSON.parse(row.data) as LifecycleState;
      if (stored.spaceId === exceptSpaceId) continue;
      const state = this.get(stored.projectId, stored.spaceId);
      state.revision += 1;
      this.persist(state);
      this.changes.append(`environment:${state.spaceId}`, state);
    }
  }
}
