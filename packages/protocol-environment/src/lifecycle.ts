import { EnvironmentError, type EnvironmentFailure } from './errors.js';
import {
  LifecycleMutationSchema, LifecyclePhaseSchema, loadEnvironmentBundle, parseEnvironmentBundleJson, resolveEnvironmentProfile,
  type EnvironmentBundle, type EffectiveEnvironmentProfile, type LifecycleMutation,
  type LifecyclePhase, type LifecycleRun, type LifecycleRunPhase, type LifecycleState, type LifecycleRunRequest,
} from './schema.js';

export const LIFECYCLE_PHASES = LifecyclePhaseSchema.options;
export const BUILT_IN_CHECKS: Readonly<Record<string, string>> = {
  bun: 'bun --version', gh: 'gh --version', git: 'git --version', postgres: 'pg_isready',
  vercel: 'vercel whoami', node: 'node --version',
};
export const LIFECYCLE_PREVIEW_LIMIT = 16_384;
export const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30 * 60_000;

/** Facts authenticated by the adapter, never copied from a mutation payload. */
export interface LifecycleActor {
  machineId: string;
  actorId: string;
  human: boolean;
  destroyedMachineId?: string;
}
export interface LifecycleRunRecord { run: LifecycleRun; token: string | null; scope: string; lock: string }
export interface LifecycleTransitionFacts {
  state: LifecycleState;
  /** All runs for this project; includes other workspaces sharing machine preparation. */
  runs: readonly LifecycleRunRecord[];
  actor: LifecycleActor;
  now: string;
  token: string;
}

export function assertLifecycleCommandAuthorized(phase: LifecycleRunPhase, actor: { human: boolean }): void {
  if (phase === 'cloud/destroy' && !actor.human) throw new EnvironmentError('PermissionDenied', 'Resource destruction requires explicit human browser authorization');
}

export function assertLifecycleRequestIdentity(request: LifecycleRunRequest, accepted: Pick<LifecycleRun, 'phase'>): void {
  if (request.phase !== accepted.phase) throw new EnvironmentError('RunConflict', 'Run identity already belongs to a different operation', { runId: request.runId });
}

export function authorizeLifecycleMachineMutation(input: LifecycleMutation, facts: {
  machineId: string; projectId: string; machineOnline: boolean;
  placement: { projectId: string; machineId: string | null; generation: number; state: string } | null;
}): void {
  if (input.op === 'approval' || input.op === 'abandon') throw new EnvironmentError('PermissionDenied', 'Execution approval and destruction-confirmed recovery require an authenticated human browser');
  if (input.op !== 'claim') return;
  if (!facts.machineOnline) throw new EnvironmentError('RunnerUnavailable', 'Lifecycle execution requires an online authorized machine', { machineId: facts.machineId });
  const detachedPreparation = input.generation === null && (input.phase === 'machine/prepare' || input.phase === 'checks');
  if (input.phase.startsWith('cloud/') || detachedPreparation) return;
  const placement = facts.placement;
  if (!placement || placement.projectId !== facts.projectId || placement.machineId !== facts.machineId || placement.generation !== input.generation || !['open', 'opening', 'closing'].includes(placement.state)) throw new EnvironmentError('PermissionDenied', 'Lifecycle execution requires the current authorized workspace placement', { machineId: facts.machineId, projectId: facts.projectId });
}
export interface LifecycleTransition {
  state: LifecycleState;
  changed: boolean;
  record?: LifecycleRunRecord;
  log?: { runId: string; output: string };
  sharedChanged: boolean;
}

export function emptyLifecycleState(projectId: string, spaceId: string): LifecycleState {
  return { revision: 0, projectId, spaceId, bundleJson: null, selectedProfile: null, executions: [],
    values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: false },
    bindings: {}, provisioned: null, destroyedAt: null, runs: [], claim: null };
}
export function isLifecycleRunActive(run: Pick<LifecycleRun, 'status'>): boolean {
  return run.status === 'accepted' || run.status === 'running' || run.status === 'cancelling';
}
export function lifecycleRunOutcome(run: Pick<LifecycleRun, 'status'>): 'running' | 'failed' | 'succeeded' {
  return isLifecycleRunActive(run) ? 'running' : run.status === 'succeeded' ? 'succeeded' : 'failed';
}
export interface LifecycleProjectionScope { profile: string; machineId?: string; generation?: number | null }

export function lifecycleRunMatchesScope(run: LifecycleRun, scope: LifecycleProjectionScope): boolean {
  if (run.phase === 'machine/prepare' || run.phase === 'checks') {
    if (run.profile !== scope.profile || scope.machineId !== undefined && run.machineId !== scope.machineId) return false;
  }
  return !((run.phase.startsWith('workspace/') || run.phase === 'checks') && scope.generation != null && run.generation !== scope.generation);
}

export function latestLifecycleRun(state: Pick<LifecycleState, 'runs'>, phase: LifecycleRunPhase, scope?: LifecycleProjectionScope): LifecycleRun | undefined {
  let latest: LifecycleRun | undefined;
  for (const run of state.runs) {
    if (run.phase !== phase) continue;
    if (scope && !lifecycleRunMatchesScope(run, scope)) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}

export function latestExecutionRun(state: Pick<LifecycleState, 'runs'>, executionHash: string, scope?: LifecycleProjectionScope): LifecycleRun | undefined {
  let latest: LifecycleRun | undefined;
  for (const run of state.runs) {
    if (!run.executionHashes.includes(executionHash) || scope && !lifecycleRunMatchesScope(run, scope)) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}
export function lifecycleSummary(state: Pick<LifecycleState, 'runs' | 'destroyedAt' | 'claim' | 'policy'>): { label: string; attention: boolean } {
  if (state.runs.some(isLifecycleRunActive)) return { label: 'Environment running', attention: false };
  if (state.claim?.status === 'blocked') return { label: 'Environment needs attention', attention: true };
  for (const phase of ['checks', ...LIFECYCLE_PHASES] as const) {
    const run = latestLifecycleRun(state, phase);
    if (run && run.status !== 'succeeded') return { label: 'Environment needs attention', attention: true };
  }
  if (state.destroyedAt) return { label: 'Resources retired', attention: false };
  return { label: state.policy.automatic ? 'Environment' : 'Environment not initialized', attention: false };
}
export function lifecycleActions(state: LifecycleState, phase: LifecycleRunPhase, facts: { runtimeAvailable: boolean; cloudRunnerAvailable: boolean; human: boolean }): { run: boolean; rerun: boolean; cancel: readonly string[]; reason: string | null } {
  const active = state.runs.filter(isLifecycleRunActive);
  const executions = state.executions.filter((entry) => phase === 'checks' ? entry.kind === 'check' : entry.phase === phase);
  const reason = active.length ? 'A lifecycle run still owns this workspace'
    : !(phase === 'cloud/destroy' ? facts.cloudRunnerAvailable : facts.runtimeAvailable) ? 'An authorized runner is unavailable'
      : phase === 'cloud/destroy' && !facts.human ? 'Resource retirement requires an authenticated human'
        : executions.some((entry) => !state.approvals.some((approval) => approval.executionHash === entry.hash)) ? 'Awaiting human approval for execution content'
          : state.destroyedAt && phase !== 'cloud/provision' && phase !== 'cloud/destroy' ? 'Workspace resources were explicitly retired' : null;
  return { run: reason === null, rerun: reason === null, cancel: active.filter((run) => run.status !== 'cancelling').map((run) => run.id), reason };
}

export function lifecyclePhasePresentation(state: LifecycleState, phase: LifecyclePhase, scope: { profile: string; machineId: string; generation?: number | null }): { running: boolean; readiness: string; action: string; rerun: boolean } {
  const run = latestLifecycleRun(state, phase, scope);
  const scripts = state.executions.filter((entry) => entry.phase === phase);
  const running = run !== undefined && isLifecycleRunActive(run);
  const approved = scripts.every((script) => state.approvals.some((approval) => approval.executionHash === script.hash));
  const succeeded = phase === 'cloud/provision' ? state.provisioned !== null : run?.status === 'succeeded';
  const failed = run !== undefined && !running && run.status !== 'succeeded';
  const contentMatches = run && sameHashes(scripts.map((script) => script.hash), run.executionHashes);
  return {
    running, rerun: succeeded || failed,
    readiness: running ? 'Running' : failed ? 'Needs attention' : !approved ? 'Awaiting approval' : !scripts.length ? 'No scripts' : succeeded && (phase !== 'machine/prepare' || contentMatches) ? 'Completed for this scope' : 'Not run for this scope',
    action: phase === 'cloud/destroy' ? 'Retire resources…' : succeeded ? 'Rerun explicitly…' : failed ? 'Retry explicitly…' : phase === 'cloud/provision' ? 'Request initial setup' : 'Run phase',
  };
}
export function shouldPrepareEnvironment(state: Pick<LifecycleState, 'policy' | 'provisioned' | 'destroyedAt'>): boolean {
  return state.policy.automatic && state.provisioned !== null && state.destroyedAt === null;
}
export function environmentPreparationPhases(phase: LifecyclePhase, detached: boolean): readonly LifecycleRunPhase[] {
  return phase === 'cloud/provision' || detached ? ['machine/prepare', 'checks', phase, ...(phase === 'cloud/provision' ? ['workspace/materialize' as const] : [])] : [phase];
}
export function effectiveEnvironmentValues(bundle: EnvironmentBundle, profile: EffectiveEnvironmentProfile, values: LifecycleState['values']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of profile.values) {
    const value = values.workspace[name] ?? values.project[name] ?? values.global[name] ?? bundle.values[name]?.default;
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export function projectEnvironmentState(lifecycle: LifecycleState) {
  const bundle = lifecycle.bundleJson === null ? loadEnvironmentBundle({ version: 1, profiles: { base: {} } }) : parseEnvironmentBundleJson(lifecycle.bundleJson);
  const selectedProfile = lifecycle.selectedProfile ?? bundle.defaultProfile;
  const effective = resolveEnvironmentProfile(bundle, selectedProfile);
  return {
    projectId: lifecycle.projectId, spaceId: lifecycle.spaceId, bundleJson: lifecycle.bundleJson ?? JSON.stringify(bundle), selectedProfile, effective,
    values: { ...lifecycle.values, effective: effectiveEnvironmentValues(bundle, effective, lifecycle.values) },
    executions: lifecycle.executions.map((execution) => ({
      ...execution,
      approval: lifecycle.approvals.find((entry) => entry.executionHash === execution.hash && entry.scope === 'project')?.scope
        ?? lifecycle.approvals.find((entry) => entry.executionHash === execution.hash && entry.scope === 'workspace')?.scope ?? null,
    })),
    runs: lifecycle.runs, lifecycle,
  };
}
export function assertEnvironmentExecutionReady(input: {
  phase: LifecycleRunPhase; state: LifecycleState; bundle: EnvironmentBundle; effective: EffectiveEnvironmentProfile;
  values: Readonly<Record<string, string>>; configuredSecrets: readonly string[]; executionCount: number;
  holder: boolean; detached: boolean; runnerAvailable: boolean;
}): void {
  if (!input.holder && !input.detached) throw new EnvironmentError('PermissionDenied', 'Lifecycle execution requires a checkout held by this authorized runner');
  if (input.detached && (input.phase.startsWith('workspace/') || input.phase === 'cloud/provision')) throw new EnvironmentError('PreconditionFailed', 'Detached recovery cannot provision or materialize a workspace');
  if (!input.runnerAvailable) throw new EnvironmentError('RunnerUnavailable', 'Workspace Hub lifecycle execution is unavailable');
  if (!input.executionCount) return;
  for (const name of [...input.effective.values, ...input.effective.secrets]) {
    if (/^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|NODE_OPTIONS|BUN_OPTIONS|RUBYOPT|PYTHONPATH|LD_.+|DYLD_.+|GIT_CONFIG.*|GITSPACE_.+)$/u.test(name)) throw new EnvironmentError('InvalidConfiguration', `Environment name ${name} is reserved for the trusted lifecycle runner`, { name });
  }
  for (const name of input.effective.values) if (input.bundle.values[name]?.required && !input.values[name]) throw new EnvironmentError('MissingValue', `Required environment value ${name} is missing`, { name });
  for (const name of input.effective.secrets) if (!input.configuredSecrets.includes(name)) throw new EnvironmentError('MissingSecret', `Required environment secret ${name} is missing`, { name });
}
export function assertEnvironmentRetired(state: LifecycleState): void {
  const latest = state.runs.filter((run) => run.phase.startsWith('cloud/')).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (state.runs.some(isLifecycleRunActive) || ((latest || Object.keys(state.bindings).length) && (latest?.phase !== 'cloud/destroy' || latest.status !== 'succeeded'))) throw new EnvironmentError('PreconditionFailed', 'Complete explicit cloud/destroy before deleting this workspace; partial resources and lifecycle history must remain inspectable');
}
export function sanitizeLifecycleOutput(output: string, secrets: readonly string[] = []): string {
  let result = output;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]');
  return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 [REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key|credential)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;]+)/giu, '$1[REDACTED]')
    .replace(/(:\/\/[^/\s:@]+:)[^/\s@]+@/gu, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu, '[REDACTED]');
}
function sameHashes(a: readonly string[], b: readonly string[]): boolean {
  const hashes = new Set(a);
  return hashes.size === new Set(b).size && b.every((hash) => hashes.has(hash));
}
export function lifecycleRunScope(input: { phase: LifecycleRunPhase; profile: string; executionHashes: readonly string[]; generation: number | null }, machineId: string, spaceId: string): string {
  return input.phase === 'machine/prepare' ? JSON.stringify([input.phase, machineId, input.profile, [...new Set(input.executionHashes)].sort()])
    : input.phase.startsWith('cloud/') ? JSON.stringify(['cloud', spaceId]) : JSON.stringify([input.phase, spaceId, input.generation]);
}
export function lifecycleStopReason(run: LifecycleRun, now: string): EnvironmentFailure | null {
  if (run.cancelRequestedAt) return { code: 'Cancelled', message: 'Lifecycle cancellation was explicitly requested', context: { runId: run.id } };
  if (now >= run.deadlineAt) return { code: 'DeadlineExceeded', message: 'Lifecycle deadline elapsed', context: { runId: run.id, deadlineAt: run.deadlineAt } };
  return null;
}

/** Decides effects without a database, process, clock, network, or browser dependency. */
export function transitionLifecycle(facts: LifecycleTransitionFacts, candidate: LifecycleMutation): LifecycleTransition {
  const parsed = LifecycleMutationSchema.safeParse(candidate);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'Invalid lifecycle mutation', { detail: parsed.error.message });
  const input = parsed.data;
  const { actor, now } = facts;
  if (!actor.actorId || !actor.machineId) throw new EnvironmentError('PermissionDenied', 'A verified lifecycle actor is required');
  const state: LifecycleState = { ...facts.state, claim: null };
  let record: LifecycleRunRecord | undefined;
  let log: LifecycleTransition['log'];
  let sharedChanged = false;
  const owned = (runId: string, token?: string): LifecycleRunRecord => {
    const found = facts.runs.find((entry) => entry.run.id === runId && entry.run.spaceId === state.spaceId);
    if (!found) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId });
    if (token !== undefined && (found.token !== token || found.run.machineId !== actor.machineId || !isLifecycleRunActive(found.run))) throw new EnvironmentError('RunFenced', 'Lifecycle claim is fenced or belongs to another machine', { runId });
    return { ...found, run: { ...found.run } };
  };
  switch (input.op) {
    case 'configure': {
      const bundle = parseEnvironmentBundleJson(input.bundleJson);
      if (state.selectedProfile !== null) resolveEnvironmentProfile(bundle, state.selectedProfile);
      state.bundleJson = JSON.stringify(bundle);
      state.selectedProfile ??= bundle.defaultProfile;
      if (input.executions) state.executions = input.executions;
      break;
    }
    case 'profile': {
      if (!state.bundleJson) throw new EnvironmentError('PreconditionFailed', 'Configure the repository environment first');
      resolveEnvironmentProfile(parseEnvironmentBundleJson(state.bundleJson), input.profile);
      state.selectedProfile = input.profile;
      break;
    }
    case 'value': {
      if (input.scope === 'global') throw new EnvironmentError('PermissionDenied', 'Global values require the account authority');
      const values = { ...state.values[input.scope] };
      if (input.value === null) delete values[input.name]; else values[input.name] = input.value;
      state.values = { ...state.values, [input.scope]: values };
      sharedChanged = input.scope === 'project';
      break;
    }
    case 'approval': {
      if (!actor.human) throw new EnvironmentError('PermissionDenied', 'Execution approval requires an authenticated human browser');
      if (input.approved && !state.executions.some((entry) => entry.hash === input.executionHash)) throw new EnvironmentError('ContentChanged', 'Refresh the environment and review execution content before approving');
      state.approvals = state.approvals.filter((entry) => entry.scope !== input.scope || entry.executionHash !== input.executionHash);
      if (input.approved) state.approvals.push({ scope: input.scope, executionHash: input.executionHash, approvedAt: now, approvedBy: actor.actorId });
      sharedChanged = input.scope === 'project';
      break;
    }
    case 'policy': state.policy = { automatic: input.automatic }; break;
    case 'claim': {
      const existing = facts.runs.find((entry) => entry.run.id === input.runId);
      if (existing) {
        const run = existing.run;
        if (run.spaceId !== state.spaceId || run.phase !== input.phase || run.profile !== input.profile || run.generation !== input.generation || !sameHashes(run.executionHashes, input.executionHashes)) throw new EnvironmentError('RunConflict', 'Run identity already belongs to a different operation', { runId: input.runId });
        return { state: { ...state, claim: { runId: run.id, status: 'existing', reason: null, token: null } }, changed: false, sharedChanged: false };
      }
      const scope = lifecycleRunScope(input, actor.machineId, state.spaceId);
      const lock = input.phase === 'machine/prepare' ? `machine:${actor.machineId}` : `workspace:${state.spaceId}`;
      if (facts.runs.some((entry) => entry.token && (entry.run.spaceId === state.spaceId || entry.lock === lock))) throw new EnvironmentError('RunConflict', 'A runner still owns this lifecycle claim; stop it or confirm machine destruction before recovery');
      if (state.destroyedAt && input.phase !== 'cloud/destroy' && !(input.phase === 'cloud/provision' && input.rerun)) throw new EnvironmentError('PreconditionFailed', 'This workspace lifecycle was explicitly destroyed');
      if (input.phase.startsWith('cloud/') && !input.rerun && facts.runs.some((entry) => entry.scope === scope && entry.run.phase === input.phase && !isLifecycleRunActive(entry.run) && entry.run.status !== 'succeeded')) throw new EnvironmentError('RecoveryRequired', 'Previous cloud effects require inspection and an explicit rerun');
      if (input.phase === 'cloud/provision' && !state.policy.automatic) throw new EnvironmentError('PreconditionFailed', 'Explicit workspace setup must enable lifecycle policy first');
      if (input.executionHashes.some((hash) => !state.approvals.some((approval) => approval.executionHash === hash))) throw new EnvironmentError('ApprovalRequired', 'Awaiting human approval for execution content');
      const deadlineAt = new Date(input.deadlineAt === undefined ? Date.parse(now) + DEFAULT_LIFECYCLE_TIMEOUT_MS : Date.parse(input.deadlineAt)).toISOString();
      if (deadlineAt <= now) throw new EnvironmentError('DeadlineExceeded', 'Lifecycle deadline has already elapsed', { deadlineAt });
      const skipped = !input.rerun && (input.phase === 'cloud/provision' && state.provisioned !== null || input.phase === 'cloud/destroy' && state.destroyedAt !== null || !input.phase.startsWith('cloud/') && input.phase !== 'checks' && facts.runs.some((entry) => entry.scope === scope && entry.run.status === 'succeeded'));
      const run: LifecycleRun = { id: input.runId, projectId: state.projectId, spaceId: state.spaceId, phase: input.phase,
        status: skipped ? 'succeeded' : 'accepted', profile: input.profile, machineId: actor.machineId, generation: input.generation,
        executionHashes: input.executionHashes, terminalName: input.terminalName ?? null, results: [], output: '',
        exitCode: skipped ? 0 : null, startedAt: now, finishedAt: skipped ? now : null, deadlineAt, cancelRequestedAt: null, failure: null, incidents: [] };
      record = { run, scope, lock, token: skipped ? null : input.ownershipToken ?? facts.token };
      state.claim = { runId: run.id, status: skipped ? 'skipped' : 'claimed', reason: skipped ? 'This lifecycle scope already succeeded' : null, token: record.token };
      break;
    }
    case 'start': {
      record = owned(input.runId, input.token);
      if (record.run.status !== 'accepted') throw new EnvironmentError('RunConflict', 'Only an accepted lifecycle run may start', { runId: input.runId });
      const stop = lifecycleStopReason(record.run, now);
      if (stop) throw new EnvironmentError(stop.code, stop.message, stop.context);
      record.run.status = 'running';
      break;
    }
    case 'cancel': {
      record = owned(input.runId);
      if (!actor.human && actor.machineId !== record.run.machineId) throw new EnvironmentError('PermissionDenied', 'Only an authenticated human or the owning runner may cancel this run');
      if (!isLifecycleRunActive(record.run) || record.run.cancelRequestedAt) return { state, changed: false, sharedChanged: false };
      record.run.status = 'cancelling';
      record.run.cancelRequestedAt = now;
      break;
    }
    case 'incidents': {
      record = owned(input.runId);
      if (!actor.human && actor.machineId !== record.run.machineId) throw new EnvironmentError('PermissionDenied', 'Only the owning runner or an authenticated human may synchronize run incidents');
      const additions = input.incidents.filter((incident) => !record!.run.incidents.some((entry) => entry.id === incident.id));
      if (!additions.length) return { state, changed: false, sharedChanged: false };
      record.run.incidents = [...record.run.incidents, ...additions];
      break;
    }
    case 'append': {
      record = owned(input.runId, input.token);
      if (input.incidents) record.run.incidents = [...record.run.incidents, ...input.incidents.filter((incident) => !record!.run.incidents.some((entry) => entry.id === incident.id))];
      const output = sanitizeLifecycleOutput(input.output);
      record.run.output = (record.run.output + output).slice(-LIFECYCLE_PREVIEW_LIMIT);
      log = { runId: input.runId, output };
      if (input.bindings) state.bindings = { ...state.bindings, ...input.bindings };
      break;
    }
    case 'finish': {
      record = owned(input.runId, input.token);
      if (input.incidents) record.run.incidents = [...record.run.incidents, ...input.incidents.filter((incident) => !record!.run.incidents.some((entry) => entry.id === incident.id))];
      if ((input.status === 'succeeded') !== (input.exitCode === 0)) throw new EnvironmentError('InvalidConfiguration', 'Lifecycle status must agree with its exit code');
      const stop = lifecycleStopReason(record.run, now);
      const failure: EnvironmentFailure | null = stop ?? input.failure ?? (input.status === 'succeeded' ? null : { code: input.status === 'interrupted' ? 'Interrupted' : input.status === 'cancelled' ? 'Cancelled' : input.status === 'timed-out' ? 'DeadlineExceeded' : 'ExecutionFailed', message: `Lifecycle ${record.run.phase} ${input.status}`, context: { runId: input.runId, exitCode: String(input.exitCode) } });
      const status = failure?.code === 'Cancelled' ? 'cancelled' : failure?.code === 'DeadlineExceeded' ? 'timed-out' : failure && input.status === 'succeeded' ? 'failed' : input.status;
      const output = sanitizeLifecycleOutput(input.output || input.results.map((result) => result.output).join('\n'));
      if (output && !record.run.output.endsWith(output) && !output.endsWith(record.run.output)) log = { runId: input.runId, output };
      else if (!record.run.output && output) log = { runId: input.runId, output };
      record.run = { ...record.run, status, failure, finishedAt: now, exitCode: failure ? input.exitCode || 1 : 0,
        results: input.results.map((result) => ({ ...result, output: sanitizeLifecycleOutput(result.output).slice(-LIFECYCLE_PREVIEW_LIMIT) })), output: output ? output.slice(-LIFECYCLE_PREVIEW_LIMIT) : record.run.output };
      if (failure) record.run.incidents = [...record.run.incidents, { id: `${record.run.id}:failure`, kind: 'domain', occurredAt: now, message: failure.message, failure }];
      record.token = null;
      state.bindings = { ...state.bindings, ...input.bindings };
      if (status === 'succeeded' && record.run.phase === 'cloud/provision') {
        state.provisioned = { runId: record.run.id, profile: record.run.profile, executionHashes: record.run.executionHashes, machineId: record.run.machineId, completedAt: now };
        state.destroyedAt = null;
      }
      if (status === 'succeeded' && record.run.phase === 'cloud/destroy') { state.destroyedAt = now; state.policy = { automatic: false }; }
      break;
    }
    case 'abandon': {
      record = owned(input.runId);
      if (!actor.human || actor.destroyedMachineId !== record.run.machineId) throw new EnvironmentError('PermissionDenied', 'Recovery requires an authenticated human and confirmed destruction of the owning machine');
      if (!isLifecycleRunActive(record.run)) throw new EnvironmentError('PreconditionFailed', 'Only an unresolved lifecycle claim can be recovered');
      record.run = { ...record.run, status: 'interrupted', finishedAt: now, exitCode: 1, failure: { code: 'Interrupted', message: 'Owning machine was destroyed before run completion; inspect effects before retrying', context: { runId: input.runId } } };
      record.run.incidents = [...record.run.incidents, { id: `${record.run.id}:interrupted`, kind: 'domain', occurredAt: now, message: record.run.failure!.message, failure: record.run.failure }];
      record.token = null;
      break;
    }
  }
  if (record) state.runs = [record.run, ...state.runs.filter((run) => run.id !== record.run.id)];
  state.revision += 1;
  return { state, changed: true, record, log, sharedChanged };
}
