import { EnvironmentError, type EnvironmentFailure } from './errors.js';
import {
  LifecycleMutationSchema, LifecyclePhaseSchema, executionHash, loadEnvironmentBundle, parseEnvironmentBundleJson, resolveEnvironmentProfile, selectLifecycleScripts,
  type EnvironmentBundle, type EffectiveEnvironmentProfile, type LifecycleExecution, type LifecycleMutation,
  type LifecyclePhase, type LifecycleRun, type LifecycleRunPhase, type LifecycleState, type LifecycleRunRequest,
} from './schema.js';
import { SERVICE_INGRESS_EXECUTION_ID, serviceIngressContent } from './service-ingress.js';

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
  kind: 'browser' | 'client' | 'machine';
  lifecycleControl: boolean;
  attachment?: { attachmentId: string; generation: number };
}
/** `scope` is what a later run must match to count this run's success as already done. */
export interface LifecycleRunRecord { run: LifecycleRun; scope: string }
export interface LifecycleTransitionFacts {
  state: LifecycleState;
  /** All runs for this project. */
  runs: readonly LifecycleRunRecord[];
  actor: LifecycleActor;
  now: string;
}

export function assertLifecycleCommandAuthorized(phase: LifecycleRunPhase, actor: { lifecycleControl: boolean }): void {
  if (phase === 'cloud/destroy' && !actor.lifecycleControl) throw new EnvironmentError('PermissionDenied', 'Resource destruction requires lifecycle control authorization');
}

export function assertLifecycleRequestIdentity(request: LifecycleRunRequest, accepted: Pick<LifecycleRun, 'phase' | 'interactive'>): void {
  if (request.phase !== accepted.phase || Boolean(request.interactive) !== Boolean(accepted.interactive)) throw new EnvironmentError('RunConflict', 'Run identity already belongs to a different operation', { runId: request.runId });
}

/** Only the leading shell header can declare interactive execution. */
export function isInteractiveLifecycleScript(content: string): boolean {
  for (const line of content.split(/\r?\n/u)) {
    if (line === '# gitspace: interactive') return true;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return false;
  }
  return false;
}

/** Output line recording an interactive script that a run without a terminal skipped instead of executing. */
export function skippedInteractiveScriptLine(script: string): string {
  return `skipped: ${script} needs a terminal; run setup from a terminal to execute it`;
}

export function authorizeLifecycleMachineMutation(input: LifecycleMutation, facts: {
  machineId: string; projectId: string; machineOnline: boolean;
  attachment?: { attachmentId: string; generation: number; machineId: string; projectId: string; workspaceId: string; state: string } | null;
}): void {
  if (input.op === 'approval' || input.op === 'interrupt') throw new EnvironmentError('PermissionDenied', 'Execution approval and interrupting a run require account lifecycle control');
  if (input.op !== 'claim') return;
  if (!facts.machineOnline) throw new EnvironmentError('RunnerUnavailable', 'Lifecycle execution requires an online authorized machine', { machineId: facts.machineId });
  if (input.attachment) {
    const attachment = facts.attachment;
    if (!attachment || attachment.attachmentId !== input.attachment.attachmentId || attachment.generation !== input.attachment.generation || attachment.machineId !== facts.machineId || attachment.projectId !== facts.projectId || !['attaching', 'ready'].includes(attachment.state) || input.generation !== null || !['machine/prepare', 'checks', 'workspace/materialize', 'workspace/dematerialize'].includes(input.phase)) {
      throw new EnvironmentError('PermissionDenied', 'Lifecycle attachment admission is missing or stale');
    }
    return;
  }
  const detachedPreparation = input.generation === null && (input.phase === 'machine/prepare' || input.phase === 'checks');
  if (input.phase.startsWith('cloud/') || detachedPreparation) return;
  throw new EnvironmentError('PermissionDenied', 'Lifecycle execution requires a checkout attachment on this machine', { machineId: facts.machineId, projectId: facts.projectId });
}
export interface LifecycleTransition {
  state: LifecycleState;
  changed: boolean;
  record?: LifecycleRunRecord;
  /** Runs a new claim cancelled: the newest run wins. */
  replaced?: LifecycleRunRecord[];
  log?: { runId: string; output: string };
  sharedChanged: boolean;
}

export function emptyLifecycleState(projectId: string, spaceId: string): LifecycleState {
  return { revision: 0, projectId, spaceId, bundleJson: null, selectedProfile: null, executions: [], browserOrigins: [],
    values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: false },
    bindings: {}, provisioned: null, destroyedAt: null, runs: [], claim: null };
}

/** Only canonical committed origins participate; bundle previews and automatic policy do not grant access. */
export function approvedBrowserOrigins(state: LifecycleState): string[] {
  const approved = new Set(state.approvals.map((entry) => entry.executionHash));
  return state.browserOrigins.filter((entry) => approved.has(entry.hash)).map((entry) => entry.pattern);
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

/** Every checkout reader derives executions here: a hash approved from one checkout's view is the hash
 * any runner recomputes from identical `.gitspace/lifecycle/<phase>/<file>` content. The signed-caller routes of
 * `.gitspace/services.json` are one `ingress` execution: approved like a script, never run. */
export async function deriveLifecycleExecutions(input: {
  bundle: EnvironmentBundle;
  selectedProfile: string;
  /** Entry names directly inside `.gitspace/lifecycle/<phase>`; absent directories list nothing. */
  list(phase: LifecyclePhase): Promise<readonly string[]>;
  read(phase: LifecyclePhase, fileName: string): Promise<{ command: string; content: string }>;
  /** `.gitspace/services.json`, or null when absent. */
  services(): Promise<string | null>;
}): Promise<LifecycleExecution[]> {
  const { bundle, selectedProfile } = input;
  const checks = await Promise.all(resolveEnvironmentProfile(bundle, selectedProfile).checks.map(async (id): Promise<LifecycleExecution> => {
    const definition = bundle.checks[id]!;
    const command = definition.kind === 'built-in' ? BUILT_IN_CHECKS[definition.check] : definition.command;
    if (!command) throw new EnvironmentError('InvalidConfiguration', `Unknown built-in environment check: ${id}`, { checkId: id });
    const label = definition.kind === 'built-in' ? definition.label ?? definition.check : definition.label;
    return { id, kind: 'check', label, command, hash: await executionHash({ kind: 'check', command }), phase: null, fileName: null, content: command };
  }));
  const profiles = new Set(Object.keys(bundle.profiles));
  const scripts = await Promise.all(LIFECYCLE_PHASES.map(async (phase) => Promise.all(
    selectLifecycleScripts(await input.list(phase), selectedProfile, profiles).map(async ({ fileName }): Promise<LifecycleExecution> => {
      const { command, content } = await input.read(phase, fileName);
      return { id: `${phase}:${fileName}`, kind: 'script', label: fileName, command, hash: await executionHash({ kind: 'script', command: content }), phase, fileName, content };
    }),
  )));
  const ingress = serviceIngressContent(await input.services());
  const declared: LifecycleExecution[] = ingress === null ? [] : [{
    id: SERVICE_INGRESS_EXECUTION_ID, kind: 'ingress', label: 'Signed callers', command: '.gitspace/services.json',
    hash: await executionHash({ kind: 'ingress', command: ingress }), phase: null, fileName: null, content: ingress,
  }];
  return [...checks, ...scripts.flat(), ...declared];
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
      ...(execution.kind === 'script' ? { interactive: isInteractiveLifecycleScript(execution.content) } : {}),
      approval: lifecycle.approvals.find((entry) => entry.executionHash === execution.hash && entry.scope === 'project')?.scope
        ?? lifecycle.approvals.find((entry) => entry.executionHash === execution.hash && entry.scope === 'workspace')?.scope ?? null,
    })),
    runs: lifecycle.runs, lifecycle,
  };
}
export function assertEnvironmentExecutionReady(input: {
  phase: LifecycleRunPhase; state: LifecycleState; bundle: EnvironmentBundle; effective: EffectiveEnvironmentProfile;
  values: Readonly<Record<string, string>>; configuredSecrets: readonly string[]; executionCount: number;
  holder: boolean; detached: boolean; runnerAvailable: boolean; attachment?: boolean;
}): void {
  if (!input.holder && !input.detached) throw new EnvironmentError('PermissionDenied', 'Lifecycle execution requires a checkout held by this authorized runner');
  if (input.detached && !input.attachment && (input.phase.startsWith('workspace/') || input.phase === 'cloud/provision')) throw new EnvironmentError('PreconditionFailed', 'Detached recovery cannot provision or materialize a workspace');
  if (!input.runnerAvailable) throw new EnvironmentError('RunnerUnavailable', 'Workspace Hub lifecycle execution is unavailable');
  if (!input.executionCount) return;
  for (const name of [...input.effective.values, ...input.effective.secrets]) {
    if (/^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|NODE_OPTIONS|BUN_OPTIONS|RUBYOPT|PYTHONPATH|LD_.+|DYLD_.+|GIT_CONFIG.*|GITSPACE_.+)$/u.test(name)) throw new EnvironmentError('InvalidConfiguration', `Environment name ${name} is reserved for the trusted lifecycle runner`, { name });
  }
  for (const name of input.effective.values) if (input.bundle.values[name]?.required && !input.values[name]) throw new EnvironmentError('MissingValue', `Required environment value ${name} is missing`, { name });
  for (const name of input.effective.secrets) if (!input.configuredSecrets.includes(name)) throw new EnvironmentError('MissingSecret', `Required environment secret ${name} is missing`, { name });
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
export function lifecycleRunScope(input: { phase: LifecycleRunPhase; profile: string; executionHashes: readonly string[]; generation: number | null; attachment?: { attachmentId: string; generation: number } }, machineId: string, spaceId: string): string {
  if (input.attachment) return JSON.stringify(['attachment', input.attachment.attachmentId, input.attachment.generation, input.phase, input.profile, [...new Set(input.executionHashes)].sort()]);
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
  const replaced: LifecycleRunRecord[] = [];
  let log: LifecycleTransition['log'];
  let sharedChanged = false;
  const owned = (runId: string): LifecycleRunRecord => {
    const found = facts.runs.find((entry) => entry.run.id === runId && entry.run.spaceId === state.spaceId);
    if (!found) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId });
    return { ...found, run: { ...found.run } };
  };
  /** The run's own machine reporting progress. A report on a run that already ended (cancelled while offline, replaced) changes nothing. */
  const reported = (runId: string): LifecycleRunRecord | null => {
    const found = owned(runId);
    if (found.run.machineId !== actor.machineId) throw new EnvironmentError('PermissionDenied', 'Only the run\'s machine reports its progress', { runId });
    return isLifecycleRunActive(found.run) ? found : null;
  };
  const unchanged: LifecycleTransition = { state, changed: false, sharedChanged: false };
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
      if (!actor.lifecycleControl) throw new EnvironmentError('PermissionDenied', 'Execution approval requires lifecycle control authorization');
      if (input.approved && !state.executions.some((entry) => entry.hash === input.executionHash) && !state.browserOrigins.some((entry) => entry.hash === input.executionHash)) throw new EnvironmentError('ContentChanged', 'Refresh the environment and review current content before approving');
      state.approvals = state.approvals.filter((entry) => entry.scope !== input.scope || entry.executionHash !== input.executionHash);
      if (input.approved) state.approvals.push({ scope: input.scope, executionHash: input.executionHash, approvedAt: now, approvedBy: actor.actorId });
      sharedChanged = input.scope === 'project';
      break;
    }
    case 'policy': state.policy = { automatic: input.automatic }; break;
    case 'claim': {
      if (input.attachment && (actor.attachment?.attachmentId !== input.attachment.attachmentId || actor.attachment.generation !== input.attachment.generation)) throw new EnvironmentError('PermissionDenied', 'Attachment lifecycle claim lacks authenticated admission');
      // Without a terminal, interactive scripts are skipped rather than executed, so they are neither claimed nor approval-gated.
      const executionHashes = input.interactive ? input.executionHashes : input.executionHashes.filter((hash) => !state.executions.some((execution) => execution.kind === 'script' && execution.hash === hash && isInteractiveLifecycleScript(execution.content)));
      const existing = facts.runs.find((entry) => entry.run.id === input.runId);
      if (existing) {
        const run = existing.run;
        if (JSON.stringify(run.attachment) !== JSON.stringify(input.attachment)) throw new EnvironmentError('RunConflict', 'Run identity belongs to another attachment');
        if (run.spaceId !== state.spaceId || run.phase !== input.phase || Boolean(run.interactive) !== Boolean(input.interactive) || run.profile !== input.profile || run.generation !== input.generation || !sameHashes(run.executionHashes, executionHashes)) throw new EnvironmentError('RunConflict', 'Run identity already belongs to a different operation', { runId: input.runId });
        return { state: { ...state, claim: { runId: run.id, status: 'existing', reason: null } }, changed: false, sharedChanged: false };
      }
      const scope = lifecycleRunScope({ ...input, executionHashes }, actor.machineId, state.spaceId);
      if (executionHashes.some((hash) => !state.approvals.some((approval) => approval.executionHash === hash))) throw new EnvironmentError('ApprovalRequired', 'Awaiting human approval for execution content');
      if (input.phase === 'checks' && input.interactive) throw new EnvironmentError('InvalidConfiguration', 'Environment checks cannot run interactively');
      const deadlineAt = new Date(input.deadlineAt === undefined ? Date.parse(now) + DEFAULT_LIFECYCLE_TIMEOUT_MS : Date.parse(input.deadlineAt)).toISOString();
      if (deadlineAt <= now) throw new EnvironmentError('DeadlineExceeded', 'Lifecycle deadline has already elapsed', { deadlineAt });
      const skipped = !input.rerun && (input.phase === 'cloud/provision' && state.provisioned !== null || input.phase === 'cloud/destroy' && state.destroyedAt !== null || !input.phase.startsWith('cloud/') && input.phase !== 'checks' && facts.runs.some((entry) => entry.scope === scope && entry.run.status === 'succeeded'));
      const run: LifecycleRun = { id: input.runId, projectId: state.projectId, spaceId: state.spaceId, phase: input.phase,
        status: skipped ? 'succeeded' : 'accepted', profile: input.profile, machineId: actor.machineId, generation: input.generation,
        interactive: input.interactive ?? false,
        ...(input.attachment ? { attachment: input.attachment } : {}),
        executionHashes, terminalName: input.terminalName ?? null, results: [], output: '',
        exitCode: skipped ? 0 : null, startedAt: now, finishedAt: skipped ? now : null, deadlineAt, cancelRequestedAt: null, failure: null, incidents: [] };
      record = { run, scope };
      // A new run replaces the workspace's running run of the same phase: that run is cancelled and its machine stops it.
      if (!skipped) for (const entry of facts.runs) {
        if (entry.run.spaceId !== state.spaceId || entry.run.phase !== input.phase || !isLifecycleRunActive(entry.run) || entry.run.cancelRequestedAt) continue;
        replaced.push({ ...entry, run: { ...entry.run, status: 'cancelling', cancelRequestedAt: now } });
      }
      state.claim = { runId: run.id, status: skipped ? 'skipped' : 'claimed', reason: skipped ? 'This lifecycle scope already succeeded' : null };
      break;
    }
    case 'start': {
      const found = reported(input.runId);
      if (!found || found.run.status !== 'accepted') throw new EnvironmentError('RunConflict', 'Only an accepted lifecycle run may start', { runId: input.runId });
      const stop = lifecycleStopReason(found.run, now);
      if (stop) throw new EnvironmentError(stop.code, stop.message, stop.context);
      record = found;
      record.run.status = 'running';
      break;
    }
    case 'cancel': {
      record = owned(input.runId);
      if (!isLifecycleRunActive(record.run) || record.run.cancelRequestedAt) return { state, changed: false, sharedChanged: false };
      record.run.status = 'cancelling';
      record.run.cancelRequestedAt = now;
      break;
    }
    case 'append': {
      const found = reported(input.runId);
      if (!found) return unchanged;
      record = found;
      if (input.incidents) record.run.incidents = [...record.run.incidents, ...input.incidents.filter((incident) => !record!.run.incidents.some((entry) => entry.id === incident.id))];
      const output = sanitizeLifecycleOutput(input.output);
      record.run.output = (record.run.output + output).slice(-LIFECYCLE_PREVIEW_LIMIT);
      if (input.results) record.run.results = input.results.map((result) => ({ ...result, output: sanitizeLifecycleOutput(result.output).slice(-LIFECYCLE_PREVIEW_LIMIT) }));
      log = { runId: input.runId, output };
      if (input.bindings) {
        if (record.run.attachment) record.run.bindings = { ...record.run.bindings, ...input.bindings };
        else state.bindings = { ...state.bindings, ...input.bindings };
      }
      break;
    }
    case 'finish': {
      const found = reported(input.runId);
      if (!found) return unchanged;
      record = found;
      if (input.incidents) record.run.incidents = [...record.run.incidents, ...input.incidents.filter((incident) => !record!.run.incidents.some((entry) => entry.id === incident.id))];
      if ((input.status === 'succeeded') !== (input.exitCode === 0)) throw new EnvironmentError('InvalidConfiguration', 'Lifecycle status must agree with its exit code');
      const stop = lifecycleStopReason(record.run, now);
      const failure: EnvironmentFailure | null = stop ?? input.failure ?? (input.status === 'succeeded' ? null : { code: input.status === 'interrupted' ? 'Interrupted' : input.status === 'cancelled' ? 'Cancelled' : input.status === 'timed-out' ? 'DeadlineExceeded' : 'ExecutionFailed', message: `Lifecycle ${record.run.phase} ${input.status}`, context: { runId: input.runId, exitCode: String(input.exitCode) } });
      const status = failure?.code === 'Cancelled' ? 'cancelled' : failure?.code === 'DeadlineExceeded' ? 'timed-out' : failure && input.status === 'succeeded' ? 'failed' : input.status;
      const output = sanitizeLifecycleOutput(input.output || input.results.map((result) => result.output).join('\n'));
      if (output && !record.run.output.endsWith(output) && !output.endsWith(record.run.output)) log = { runId: input.runId, output };
      else if (!record.run.output && output) log = { runId: input.runId, output };
      record.run = { ...record.run, status, failure, finishedAt: now, exitCode: failure ? input.exitCode || 1 : 0,
        results: (input.results.length ? input.results : record.run.results).map((result) => ({ ...result, output: sanitizeLifecycleOutput(result.output).slice(-LIFECYCLE_PREVIEW_LIMIT) })), output: output ? output.slice(-LIFECYCLE_PREVIEW_LIMIT) : record.run.output };
      if (failure) record.run.incidents = [...record.run.incidents, { id: `${record.run.id}:failure`, kind: 'domain', occurredAt: now, message: failure.message, failure }];
      if (record.run.attachment) record.run.bindings = { ...record.run.bindings, ...input.bindings };
      else state.bindings = { ...state.bindings, ...input.bindings };
      if (status === 'succeeded' && record.run.phase === 'cloud/provision') {
        state.provisioned = { runId: record.run.id, profile: record.run.profile, executionHashes: record.run.executionHashes, machineId: record.run.machineId, completedAt: now };
        state.destroyedAt = null;
      }
      if (status === 'succeeded' && record.run.phase === 'cloud/destroy') { state.destroyedAt = now; state.policy = { automatic: false }; }
      break;
    }
    case 'interrupt': {
      // The run's machine is gone or unreachable: the run ends here and its effects are reported as unknown.
      record = owned(input.runId);
      const run = record.run;
      if (!actor.lifecycleControl) throw new EnvironmentError('PermissionDenied', 'Interrupting a run requires lifecycle control');
      if (!isLifecycleRunActive(run)) return { state, changed: false, sharedChanged: false };
      const message = `${input.reason}; the outcome of its scripts is unknown`;
      record.run = { ...run, status: 'interrupted', finishedAt: now, exitCode: 1, failure: { code: 'Interrupted', message, context: { runId: input.runId } } };
      record.run.incidents = [...record.run.incidents, { id: `${record.run.id}:interrupted`, kind: 'domain', occurredAt: now, message, failure: record.run.failure }];
      break;
    }
  }
  if (record) state.runs = [record.run, ...state.runs.filter((run) => run.id !== record.run.id)];
  for (const entry of replaced) state.runs = state.runs.map((run) => run.id === entry.run.id ? entry.run : run);
  state.revision += 1;
  return { state, changed: true, record, replaced, log, sharedChanged };
}
