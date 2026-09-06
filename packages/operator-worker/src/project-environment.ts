import {
  EnvironmentBundleSchema, LifecycleMutationSchema, resolveEnvironmentProfile,
  type LifecycleMutation, type LifecycleRun, type LifecycleRunLog, type LifecycleState,
} from '@gitspace/protocol';

interface JsonRow extends Record<string, SqlStorageValue> { data: string }
interface RunRow extends JsonRow { scope: string; token: string | null }
interface SharedEnvironment { values: Record<string, string>; approvals: LifecycleState['approvals'] }
export interface LifecycleActor {
  machineId: string;
  actorId: string;
  human: boolean;
  /** Set only after the fleet authority confirms provider destruction. */
  destroyedMachineId?: string;
}
const PREVIEW_LIMIT = 16_384;
const LOG_PAGE_SIZE = 4;

/** Defense in depth; the runner must additionally redact every resolved secret. */
export function sanitizeLifecycleOutput(output: string): string {
  return output
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 [REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key|credential)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;]+)/giu, '$1[REDACTED]')
    .replace(/(:\/\/[^/\s:@]+:)[^/\s@]+@/gu, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu, '[REDACTED]');
}

/** Synchronous transactions fence claims across every machine in a project DO. */
export class ProjectEnvironmentStore {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {}

  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS environment_state(space_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environment_shared(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_runs(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,scope TEXT NOT NULL,lock_key TEXT NOT NULL,token TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_space ON lifecycle_runs(space_id);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_scope ON lifecycle_runs(scope);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_lock ON lifecycle_runs(lock_key);
      CREATE TABLE IF NOT EXISTS lifecycle_successes(scope TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_logs(run_id TEXT NOT NULL,offset INTEGER NOT NULL,output TEXT NOT NULL,PRIMARY KEY(run_id,offset));
    `);
  }

  get(projectId: string, spaceId: string): LifecycleState {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_state WHERE space_id=?', spaceId).toArray()[0];
    const shared = this.shared();
    const state: LifecycleState = row ? JSON.parse(row.data) as LifecycleState : {
      revision: 0, projectId, spaceId, bundleJson: null, selectedProfile: null,
      executions: [],
      values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: false },
      bindings: {}, provisioned: null, destroyedAt: null, runs: [], claim: null,
    };
    state.values.project = shared.values;
    state.approvals = [...shared.approvals, ...state.approvals.filter((approval) => approval.scope === 'workspace')];
    state.runs = this.storage.sql.exec<JsonRow>(
      'SELECT data FROM lifecycle_runs WHERE space_id=? ORDER BY rowid DESC LIMIT 50', spaceId,
    ).toArray().map((entry) => JSON.parse(entry.data) as LifecycleRun);
    state.claim = null;
    return state;
  }

  assertRetired(projectId: string, spaceId: string): void {
    const state = this.get(projectId, spaceId);
    const active = this.storage.sql.exec('SELECT id FROM lifecycle_runs WHERE space_id=? AND token IS NOT NULL LIMIT 1', spaceId).toArray().length > 0;
    const latestCloud = this.storage.sql.exec<{ phase: string; status: string }>(
      "SELECT json_extract(data,'$.phase') AS phase,json_extract(data,'$.status') AS status FROM lifecycle_runs WHERE space_id=? AND json_extract(data,'$.phase') LIKE 'cloud/%' ORDER BY rowid DESC LIMIT 1", spaceId,
    ).toArray()[0];
    if (active || ((latestCloud || Object.keys(state.bindings).length > 0)
      && (latestCloud?.phase !== 'cloud/destroy' || latestCloud.status !== 'succeeded'))) {
      throw new Error('Complete explicit cloud/destroy before deleting this workspace; lifecycle records and partial resources must remain inspectable');
    }
  }

  runLog(spaceId: string, runId: string, offset = 0): LifecycleRunLog {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid lifecycle log offset');
    this.run(spaceId, runId);
    const rows = this.storage.sql.exec<{ offset: number; output: string }>(
      'SELECT offset,output FROM lifecycle_logs WHERE run_id=? AND offset>=? ORDER BY offset LIMIT ?', runId, offset, LOG_PAGE_SIZE + 1,
    ).toArray();
    return { output: rows.slice(0, LOG_PAGE_SIZE).map((row) => row.output).join(''), nextOffset: rows[LOG_PAGE_SIZE]?.offset ?? null };
  }

  mutate(projectId: string, spaceId: string, candidate: LifecycleMutation, actor: LifecycleActor): LifecycleState {
    const input = LifecycleMutationSchema.parse(candidate);
    return this.storage.transactionSync(() => {
      const state = this.get(projectId, spaceId);
      const now = new Date().toISOString();
      switch (input.op) {
        case 'configure': {
          const bundle = EnvironmentBundleSchema.parse(JSON.parse(input.bundleJson));
          state.bundleJson = JSON.stringify(bundle);
          if (input.executions) state.executions = input.executions;
          if (state.selectedProfile === null) state.selectedProfile = bundle.defaultProfile;
          break;
        }
        case 'profile':
          if (!state.bundleJson) throw new Error('Configure the repository environment first');
          resolveEnvironmentProfile(EnvironmentBundleSchema.parse(JSON.parse(state.bundleJson)), input.profile);
          state.selectedProfile = input.profile;
          break;
        case 'value': {
          if (input.scope === 'global') throw new Error('Global values require the account authority');
          const values = input.scope === 'project' ? this.shared().values : state.values.workspace;
          if (input.value === null) delete values[input.name]; else values[input.name] = input.value;
          if (input.scope === 'project') this.saveShared({ ...this.shared(), values });
          break;
        }
        case 'approval': {
          if (!actor.human) throw new Error('Execution approval requires an authenticated human browser');
          const approvals = input.scope === 'project' ? this.shared().approvals : state.approvals.filter((entry) => entry.scope === 'workspace');
          const next = approvals.filter((entry) => entry.executionHash !== input.executionHash);
          if (input.approved) next.push({ scope: input.scope, executionHash: input.executionHash, approvedAt: now, approvedBy: actor.actorId });
          if (input.scope === 'project') this.saveShared({ ...this.shared(), approvals: next }); else state.approvals = next;
          break;
        }
        case 'policy': state.policy.automatic = input.automatic; break;
        case 'claim': {
          const decision = (status: 'skipped' | 'blocked', reason: string): LifecycleState => ({ ...state, claim: { runId: input.runId, status, reason, token: null } });
          if (this.storage.sql.exec('SELECT id FROM lifecycle_runs WHERE id=?', input.runId).toArray().length) return decision('blocked', 'Run identity already exists; inspect it rather than execute it again');
          const hashes = [...new Set(input.executionHashes)].sort();
          const contentScope = JSON.stringify([input.profile, hashes]);
          const scope = input.phase === 'machine/prepare' ? JSON.stringify([input.phase, actor.machineId, contentScope])
            : input.phase.startsWith('cloud/') ? JSON.stringify(['cloud', spaceId])
              : JSON.stringify([input.phase, spaceId, input.generation]);
          const lock = input.phase === 'machine/prepare' ? `machine:${actor.machineId}` : `workspace:${spaceId}`;
          if (this.storage.sql.exec('SELECT id FROM lifecycle_runs WHERE token IS NOT NULL AND (space_id=? OR lock_key=?) LIMIT 1', spaceId, lock).toArray().length) {
            return decision('blocked', 'A runner still owns this lifecycle claim; stop it or confirm machine destruction before recovery');
          }
          const scoped = this.storage.sql.exec<RunRow>('SELECT scope,token,data FROM lifecycle_runs WHERE scope=?', scope).toArray()
            .map((entry) => JSON.parse(entry.data) as LifecycleRun);
          if (input.phase === 'cloud/provision' && state.provisioned && !input.rerun) return decision('skipped', 'Workspace already provisioned; script or profile changes never automatically provision again');
          if (input.phase === 'cloud/destroy' && state.destroyedAt && !input.rerun) return decision('skipped', 'Workspace resources were already destroyed');
          if (input.phase.startsWith('cloud/') && !input.rerun && scoped.some((run) => run.phase === input.phase && (run.status === 'failed' || run.status === 'abandoned'))) return decision('blocked', 'Previous cloud effects require inspection and an explicit rerun');
          if (input.phase === 'cloud/provision' && !state.policy.automatic) return decision('blocked', 'Explicit workspace setup must enable lifecycle policy first');
          if (state.destroyedAt && input.phase !== 'cloud/destroy' && !(input.phase === 'cloud/provision' && input.rerun)) return decision('blocked', 'This workspace lifecycle was explicitly destroyed');
          if (hashes.some((hash) => !state.approvals.some((approval) => approval.executionHash === hash))) return decision('blocked', 'Awaiting human approval for execution content');
          if (!input.rerun && !input.phase.startsWith('cloud/') && input.phase !== 'checks'
            && this.storage.sql.exec('SELECT scope FROM lifecycle_successes WHERE scope=?', scope).toArray().length) return decision('skipped', 'This lifecycle scope already succeeded');
          const token = crypto.randomUUID();
          const run: LifecycleRun = {
            id: input.runId, projectId, spaceId, phase: input.phase, status: 'running', profile: input.profile,
            machineId: actor.machineId, generation: input.generation, executionHashes: input.executionHashes,
            terminalName: input.terminalName ?? null, results: [], output: '', exitCode: null, startedAt: now, finishedAt: null,
          };
          this.storage.sql.exec('INSERT INTO lifecycle_runs(id,space_id,scope,lock_key,token,data) VALUES(?,?,?,?,?,?)', run.id, spaceId, scope, lock, token, JSON.stringify(run));
          state.claim = { runId: run.id, status: 'claimed', reason: null, token };
          break;
        }
        case 'append': {
          const { row, run } = this.ownedRun(spaceId, input.runId, input.token, actor.machineId);
          const output = sanitizeLifecycleOutput(input.output);
          this.appendLog(run.id, output);
          run.output = (run.output + output).slice(-PREVIEW_LIMIT);
          if (input.bindings) state.bindings = { ...state.bindings, ...input.bindings };
          this.saveRun(run, row.token);
          break;
        }
        case 'finish': {
          const { row, run } = this.ownedRun(spaceId, input.runId, input.token, actor.machineId);
          if ((input.status === 'succeeded') !== (input.exitCode === 0)) throw new Error('Lifecycle status must agree with its exit code');
          const output = sanitizeLifecycleOutput(input.output || input.results.map((result) => result.output).join('\n'));
          const hasLogs = this.storage.sql.exec('SELECT offset FROM lifecycle_logs WHERE run_id=? LIMIT 1', run.id).toArray().length > 0;
          if (!hasLogs) this.appendLog(run.id, output);
          else if (output && !output.endsWith(run.output) && !run.output.endsWith(output)) this.appendLog(run.id, `\n[Final runner output]\n${output}`);
          run.output = output ? output.slice(-PREVIEW_LIMIT) : run.output;
          run.results = input.results.map((result) => ({ ...result, output: sanitizeLifecycleOutput(result.output).slice(-PREVIEW_LIMIT) }));
          run.status = input.status; run.exitCode = input.exitCode; run.finishedAt = now;
          state.bindings = { ...state.bindings, ...input.bindings };
          if (run.status === 'succeeded') {
            this.storage.sql.exec('INSERT INTO lifecycle_successes(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data', row.scope, JSON.stringify(run));
            if (run.phase === 'cloud/provision') {
              state.provisioned = { runId: run.id, profile: run.profile, executionHashes: run.executionHashes, machineId: run.machineId, completedAt: now };
              state.destroyedAt = null;
            }
            if (run.phase === 'cloud/destroy') { state.destroyedAt = now; state.policy.automatic = false; }
          }
          this.saveRun(run, null);
          break;
        }
        case 'abandon': {
          const { run } = this.run(spaceId, input.runId);
          if (!actor.human || actor.destroyedMachineId !== run.machineId) throw new Error('Recovery requires an authenticated human and confirmed destruction of the owning machine');
          if (run.status !== 'running') throw new Error('Only an unresolved running claim can be recovered');
          run.status = 'abandoned'; run.finishedAt = now;
          this.saveRun(run, null);
          break;
        }
      }
      state.revision += 1;
      const claim = state.claim;
      this.storage.sql.exec('INSERT INTO environment_state(space_id,data) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET data=excluded.data', spaceId, JSON.stringify({ ...state, runs: [], claim: null }));
      return { ...this.get(projectId, spaceId), claim };
    });
  }

  private shared(): SharedEnvironment {
    const row = this.storage.sql.exec<JsonRow>('SELECT data FROM environment_shared WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) as SharedEnvironment : { values: {}, approvals: [] };
  }
  private saveShared(shared: SharedEnvironment): void {
    this.storage.sql.exec('INSERT INTO environment_shared(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(shared));
  }
  private run(spaceId: string, runId: string): { row: RunRow; run: LifecycleRun } {
    const row = this.storage.sql.exec<RunRow>('SELECT scope,token,data FROM lifecycle_runs WHERE id=? AND space_id=?', runId, spaceId).toArray()[0];
    if (!row) throw new Error('Lifecycle run does not belong to this workspace');
    return { row, run: JSON.parse(row.data) as LifecycleRun };
  }
  private ownedRun(spaceId: string, runId: string, token: string, machineId: string): { row: RunRow; run: LifecycleRun } {
    const found = this.run(spaceId, runId);
    if (found.row.token !== token || found.run.status !== 'running' || found.run.machineId !== machineId) throw new Error('Lifecycle claim is fenced or belongs to another machine');
    return found;
  }
  private saveRun(run: LifecycleRun, token: string | null): void {
    this.storage.sql.exec('UPDATE lifecycle_runs SET token=?,data=? WHERE id=?', token, JSON.stringify(run), run.id);
  }
  private appendLog(runId: string, output: string): void {
    let offset = this.storage.sql.exec<{ next: number }>('SELECT COALESCE(MAX(offset)+1,0) AS next FROM lifecycle_logs WHERE run_id=?', runId).one().next;
    for (let start = 0; start < output.length; start += PREVIEW_LIMIT) {
      this.storage.sql.exec('INSERT INTO lifecycle_logs(run_id,offset,output) VALUES(?,?,?)', runId, offset++, output.slice(start, start + PREVIEW_LIMIT));
    }
  }
}
