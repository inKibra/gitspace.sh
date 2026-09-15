import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { watch, type FSWatcher } from 'node:fs';
import type { GitSpaceDatabase } from '@gitspace/core';
import {
  executionHash, loadEnvironmentBundle, parseEnvironmentBundleJson, parseLifecycleBindingsJson, resolveEnvironmentProfile,
  resolveExecutionApproval, selectLifecycleScripts, BUILT_IN_CHECKS, LIFECYCLE_PHASES,
  effectiveEnvironmentValues, assertEnvironmentExecutionReady, shouldPrepareEnvironment, environmentPreparationPhases,
  EnvironmentError, environmentFailure, isLifecycleRunActive, lifecycleStopReason, sanitizeLifecycleOutput, assertLifecycleRequestIdentity, parseLifecycleRunRequest, LifecycleLogReader,
  type ApprovalSource, type EffectiveEnvironmentProfile, type EnvironmentBundle, type LifecycleMutation, type LifecycleIncident, type EnvironmentValueScope, type EnvironmentApprovalScope,
  type EnvironmentLifecycleAuthority, type LifecyclePhase, type LifecycleRun, type LifecycleRunPhase, type LifecycleState, type LifecycleRunRequest,
} from '@gitspace/protocol-environment';
import type { EffectiveSecretMetadata } from '@gitspace/protocol';
import type { WorkspaceLifecyclePlanResult, WorkspaceLifecyclePlanStep } from './workspace-hub.js';
import type { ProjectLifecycleAuthority } from './project-lifecycle.js';


export interface EnvironmentExecutionView {
  id: string;
  kind: 'check' | 'script';
  label: string;
  command: string;
  content: string;
  hash: string;
  approval: ApprovalSource | null;
  phase?: LifecyclePhase;
  fileName?: string;
}
export interface EnvironmentExecutionResult { id: string; hash: string; exitCode: number; stdout: string; stderr: string }
export interface WorkspaceEnvironmentView {
  spaceId: string;
  projectId: string;
  bundle: EnvironmentBundle;
  selectedProfile: string;
  effective: EffectiveEnvironmentProfile;
  values: { global: Readonly<Record<string, string>>; project: Readonly<Record<string, string>>; workspace: Readonly<Record<string, string>>; effective: Readonly<Record<string, string>> };
  configuredSecrets: readonly string[];
  secretMetadata: readonly EffectiveSecretMetadata[];
  executions: readonly EnvironmentExecutionView[];
  runs: LifecycleState['runs'];
  lifecycle: LifecycleState;
}
export interface EnvironmentSecretMaterializer {
  listEffectiveSecrets(projectId: string, workspaceId: string | null): Promise<EffectiveSecretMetadata[]>;
  materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>>;
}
export interface EnvironmentLifecycleRunner {
  runLifecyclePlan(spaceId: string, phase: LifecycleRunPhase, steps: readonly WorkspaceLifecyclePlanStep[], env: Record<string, string>, options?: { runId?: string; deadlineAt?: string; redactNames?: readonly string[]; onStarted?: () => Promise<void>; onOutput?: (output: string) => Promise<void>; directory?: string }): Promise<WorkspaceLifecyclePlanResult>;
  cancelLifecycleRun?(spaceId: string, terminalName: string, directory?: string): Promise<void>;
}
interface PendingLifecycleRun {
  projectId: string;
  spaceId: string;
  runId: string;
  token: string;
  terminalName: string;
  directory: string;
  secretNames: string[];
  workingDirectory?: string;
  started?: boolean;
  incidents?: LifecycleIncident[];
  completion?: Extract<LifecycleMutation, { op: 'finish' }>;
}
export class WorkspaceEnvironmentManager {
  private readonly accepting = new Map<string, { phase: LifecycleRunPhase; promise: Promise<LifecycleRun> }>();
  private readonly active = new Map<string, { projectId: string; spaceId: string; terminalName: string; directory?: string }>();
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly secrets: EnvironmentSecretMaterializer | undefined,
    private readonly runner: EnvironmentLifecycleRunner | undefined,
    private readonly authority: EnvironmentLifecycleAuthority & Pick<ProjectLifecycleAuthority, 'listProjectWorkspaces'>,
    private readonly options: { machineId: string; stateRoot: string; prepareRunner?: (spaceId: string, phase: LifecyclePhase) => Promise<string | undefined> },
  ) {}

  async view(spaceId: string, cloudOnly = false): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    let lifecycle = await this.authority.getLifecycleState(space.projectId, spaceId);
    const available = !cloudOnly && space.placementState !== 'closed' && space.holderId === this.options.machineId
      && await stat(space.rootPath).then((entry) => entry.isDirectory(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error));
    const source = available ? await readFile(join(space.rootPath, '.gitspace', 'bundle.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)) : null;
    const bundle = source !== null ? parseEnvironmentBundleJson(source)
      : lifecycle.bundleJson !== null ? parseEnvironmentBundleJson(lifecycle.bundleJson)
        : loadEnvironmentBundle({ version: 1, defaultProfile: 'base', profiles: { base: {} } });
    if ((source !== null || lifecycle.bundleJson !== null) && JSON.stringify(bundle) !== lifecycle.bundleJson) {
      lifecycle = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle) });
    }
    const selectedProfile = lifecycle.selectedProfile ?? bundle.defaultProfile;
    const effective = resolveEnvironmentProfile(bundle, selectedProfile);
    const effectiveValues = effectiveEnvironmentValues(bundle, effective, lifecycle.values);
    const projectApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'project').map((item) => item.executionHash));
    const workspaceApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'workspace').map((item) => item.executionHash));
    const approval = (hash: string) => resolveExecutionApproval({ executionHash: hash, projectApprovals, workspaceApprovals });
    const checks = await Promise.all(effective.checks.map(async (id): Promise<EnvironmentExecutionView> => {
      const definition = bundle.checks[id]!;
      const command = definition.kind === 'built-in' ? BUILT_IN_CHECKS[definition.check] : definition.command;
      if (!command) throw new EnvironmentError('InvalidConfiguration', `Unknown built-in environment check: ${id}`, { checkId: id });
      const hash = await executionHash({ kind: 'check', command });
      return { id, kind: 'check', label: definition.kind === 'built-in' ? definition.label ?? definition.check : definition.label, command, content: command, hash, approval: approval(hash) };
    }));
    const scripts = (await Promise.all(LIFECYCLE_PHASES.map(async (phase) => {
      if (!available) return [];
      const directory = join(space.rootPath, '.gitspace', 'lifecycle', phase);
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      return Promise.all(selectLifecycleScripts(names, selectedProfile, new Set(Object.keys(bundle.profiles))).map(async (script): Promise<EnvironmentExecutionView> => {
        const command = join(directory, script.fileName);
        const content = await readFile(command, 'utf8');
        const hash = await executionHash({ kind: 'script', command: content });
        return { id: `${phase}:${script.fileName}`, kind: 'script', label: script.fileName, command, content, hash, approval: approval(hash), phase, fileName: script.fileName };
      }));
    }))).flat();
    const executions: EnvironmentExecutionView[] = available ? [...checks, ...scripts] : lifecycle.executions.map((execution) => ({
      ...execution, phase: execution.phase ?? undefined, fileName: execution.fileName ?? undefined, approval: approval(execution.hash),
    }));
    if (available && (source !== null || executions.length > 0)) {
      const snapshot = executions.map(({ approval: _approval, ...execution }) => ({ ...execution, phase: execution.phase ?? null, fileName: execution.fileName ?? null }));
      if (JSON.stringify(snapshot) !== JSON.stringify(lifecycle.executions)) {
        lifecycle = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle), executions: snapshot });
      }
    }
    const secretMetadata = await this.secrets?.listEffectiveSecrets(space.projectId, space.kind === 'base' ? null : space.id) ?? [];
    return {
      spaceId, projectId: space.projectId, bundle, selectedProfile, effective,
      values: { ...lifecycle.values, effective: effectiveValues },
      configuredSecrets: secretMetadata.map((secret) => secret.name), secretMetadata,
      executions, runs: lifecycle.runs, lifecycle,
    };
  }

  async putBundle(spaceId: string, source: unknown): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    const bundle = loadEnvironmentBundle(source);
    const path = join(space.rootPath, '.gitspace', 'bundle.json');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle) });
    return this.view(spaceId);
  }

  async setProfile(spaceId: string, profile: string): Promise<WorkspaceEnvironmentView> {
    const current = await this.view(spaceId);
    resolveEnvironmentProfile(current.bundle, profile);
    await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'profile', profile });
    return this.view(spaceId);
  }

  async putValue(spaceId: string, scope: EnvironmentValueScope, name: string, value: string): Promise<WorkspaceEnvironmentView> {
    const current = await this.view(spaceId);
    await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'value', scope, name, value });
    return this.view(spaceId);
  }

  async deleteValue(spaceId: string, scope: EnvironmentValueScope, name: string): Promise<WorkspaceEnvironmentView> {
    const current = await this.view(spaceId);
    await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'value', scope, name, value: null });
    return this.view(spaceId);
  }

  async approve(_spaceId: string, _scope: EnvironmentApprovalScope, _hash: string): Promise<WorkspaceEnvironmentView> {
    throw new EnvironmentError('PermissionDenied', 'Execution approval requires a human browser authorization through the account gateway');
  }

  async revokeApproval(_spaceId: string, _scope: EnvironmentApprovalScope, _hash: string): Promise<WorkspaceEnvironmentView> {
    throw new EnvironmentError('PermissionDenied', 'Execution approval changes require a human browser authorization through the account gateway');
  }

  /** The request ends after durable acceptance; no caller signal owns execution. */
  async acceptRun(spaceId: string, candidate: LifecycleRunRequest): Promise<LifecycleRun> {
    const request = parseLifecycleRunRequest(candidate);
    const key = `${spaceId}:${request.runId}`;
    const accepting = this.accepting.get(key);
    if (accepting) {
      assertLifecycleRequestIdentity(request, accepting);
      return accepting.promise;
    }
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    const state = await this.authority.getLifecycleState(space.projectId, spaceId);
    const concurrent = this.accepting.get(key);
    if (concurrent) {
      assertLifecycleRequestIdentity(request, concurrent);
      return concurrent.promise;
    }
    const existing = state.runs.find((run) => run.id === request.runId);
    if (existing) {
      assertLifecycleRequestIdentity(request, existing);
      return existing;
    }
    const accepted = Promise.withResolvers<LifecycleRun>();
    this.accepting.set(key, { phase: request.phase, promise: accepted.promise });
    const options = { ...request, accepted: (run: LifecycleRun) => { this.accepting.delete(key); accepted.resolve(run); } };
    const execution = request.phase === 'checks'
      ? this.runApproved(spaceId, 'checks', true, undefined, options)
      : this.runPhase(spaceId, request.phase, request.rerun ?? false, options);
    void execution.catch((error: unknown) => {
      accepted.reject(error);
      console.error('[gitspace-lifecycle] accepted operation requires attention', request.runId, error);
    }).finally(() => { this.accepting.delete(key); });
    return accepted.promise;
  }

  async cancelRun(spaceId: string, runId: string): Promise<LifecycleRun> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    const state = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'cancel', runId });
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run) throw new EnvironmentError('NotFound', 'Lifecycle run does not belong to this workspace', { runId });
    const active = this.active.get(runId);
    if (active && this.runner?.cancelLifecycleRun) await this.runner.cancelLifecycleRun(spaceId, active.terminalName, active.directory);
    return run;
  }
  async runChecks(spaceId: string): Promise<readonly EnvironmentExecutionResult[]> {
    return this.runApproved(spaceId, 'checks', true);
  }

  async runPhase(spaceId: string, phase: LifecyclePhase, rerun = false, request?: { runId: string; deadlineAt?: string; accepted: (run: LifecycleRun) => void }): Promise<readonly EnvironmentExecutionResult[]> {
    const directory = phase.startsWith('cloud/') ? await this.options.prepareRunner?.(spaceId, phase) : undefined;
    const current = await this.view(spaceId, directory !== undefined);
    try {
      if (phase === 'cloud/provision') await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'policy', automatic: true });
      let result: readonly EnvironmentExecutionResult[] = [];
      for (const next of environmentPreparationPhases(phase, directory !== undefined)) {
        const operation = request ? { ...request, runId: next === phase ? request.runId : `${request.runId}:${next.replace('/', '-')}`, accepted: next === phase ? request.accepted : () => undefined } : undefined;
        const completed = await this.runApproved(spaceId, next, next === phase ? rerun : next === 'checks', next.startsWith('workspace/') ? undefined : directory, operation);
        if (next === phase) result = completed;
      }
      return result;
    } finally {
      if (directory) {
        // Preserve isolated recovery context while any shell outcome remains uncertain.
        const state = await this.authority.getLifecycleState(current.projectId, spaceId).catch(() => null);
        if (state && !state.runs.some((run) => isLifecycleRunActive(run) && run.machineId === this.options.machineId)) await rm(directory, { recursive: true, force: true });
      }
    }
  }

  /** Preparation is advisory; never gate checkout, terminal or agent access on it. */
  async prepare(spaceId: string): Promise<void> {
    try {
      const current = await this.view(spaceId);
      if (!shouldPrepareEnvironment(current.lifecycle)) return;
      await this.runApproved(spaceId, 'machine/prepare', false);
      await this.runApproved(spaceId, 'checks', true);
      await this.runApproved(spaceId, 'workspace/materialize', false);
    } catch (error) {
      console.error('[gitspace-lifecycle] local preparation needs attention; workspace remains accessible', spaceId, error instanceof Error ? error.message : String(error));
    }
  }

  async dematerialize(spaceId: string): Promise<void> {
    const current = await this.view(spaceId);
    if (current.lifecycle.policy.automatic && !current.lifecycle.destroyedAt) await this.runApproved(spaceId, 'workspace/dematerialize', false);
  }

  /** An interrupted run may be marked failed only after its exact Hub process is confirmed stopped. */
  async recoverInterruptedRuns(): Promise<void> {
    const files = await readdir(this.options.stateRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      try {
        const pending = JSON.parse(await readFile(join(this.options.stateRoot, file), 'utf8')) as PendingLifecycleRun;
        if (this.active.has(pending.runId) || this.accepting.has(`${pending.spaceId}:${pending.runId}`)) continue;
        const space = this.database.getSpace(pending.spaceId);
        if (!space || space.projectId !== pending.projectId) throw new EnvironmentError('NotFound', 'Lifecycle recovery space is unavailable');
        const state = await this.authority.getLifecycleState(pending.projectId, pending.spaceId);
        const run = state.runs.find((entry) => entry.id === pending.runId);
        if (!run || !isLifecycleRunActive(run)) {
          if (run && pending.incidents?.length) await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, { op: 'incidents', runId: run.id, incidents: pending.incidents });
          await rm(join(this.options.stateRoot, file));
          await rm(pending.directory, { recursive: true, force: true });
          continue;
        }
        if (pending.started && !pending.completion) {
          if (!this.runner?.cancelLifecycleRun) continue;
          await this.runner.cancelLifecycleRun(pending.spaceId, pending.terminalName, pending.workingDirectory);
        }
        const secrets = pending.secretNames.length ? await this.secrets?.materializeProjectSecrets(pending.projectId, pending.secretNames, space.kind === 'base' ? null : space.id) : {};
        if (!secrets) continue;
        const bindings = await this.readBindings(pending.directory, Object.values(secrets));
        await this.syncPendingLog(pending);
        await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, pending.completion ?? {
          op: 'finish', runId: pending.runId, token: pending.token, status: 'interrupted', exitCode: 1,
          results: [], output: 'Interrupted lifecycle runner was confirmed stopped. Explicit retry is required.', bindings,
          failure: { code: 'Interrupted', message: 'Runner restarted before lifecycle completion', context: { runId: pending.runId } },
          incidents: pending.incidents,
        });
        await rm(join(this.options.stateRoot, file));
        await rm(pending.directory, { recursive: true, force: true });
        if (pending.workingDirectory) await rm(pending.workingDirectory, { recursive: true, force: true });
      } catch (error) {
        console.error('[gitspace-lifecycle] interrupted run requires explicit recovery', file, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async runLog(spaceId: string, runId: string, offset = 0) {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    return this.authority.getLifecycleRunLog(space.projectId, spaceId, runId, offset);
  }

  private async runApproved(spaceId: string, phase: LifecycleRunPhase, rerun: boolean, workingDirectory?: string, request?: { runId: string; deadlineAt?: string; accepted: (run: LifecycleRun) => void }): Promise<readonly EnvironmentExecutionResult[]> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    const current = await this.view(spaceId, workingDirectory !== undefined);
    const planned = current.executions.filter((execution) => phase === 'checks' ? execution.kind === 'check' : execution.phase === phase);
    assertEnvironmentExecutionReady({
      phase, state: current.lifecycle, bundle: current.bundle, effective: current.effective, values: current.values.effective,
      configuredSecrets: current.configuredSecrets, executionCount: planned.length,
      holder: space.holderId === this.options.machineId && space.placementState !== 'closed',
      detached: workingDirectory !== undefined, runnerAvailable: this.runner !== undefined,
    });
    const secretNames = planned.length > 0 ? [...current.effective.secrets] : [];
    const steps = await Promise.all(planned.map(async (execution): Promise<WorkspaceLifecyclePlanStep> => {
      const content = workingDirectory ? execution.content : execution.kind === 'script' ? await readFile(execution.command, 'utf8') : execution.command;
      if (await executionHash({ kind: execution.kind, command: content }) !== execution.hash) throw new EnvironmentError('ContentChanged', `Execution content changed before claim: ${execution.label}`, { executionId: execution.id });
      const command = workingDirectory && execution.kind === 'script'
        ? join(workingDirectory, '.gitspace', 'lifecycle', execution.phase!, execution.fileName!)
        : execution.command;
      return { id: execution.id, kind: execution.kind, command, ...(execution.kind === 'script' ? { content } : {}) };
    }));
    const runId = request?.runId ?? crypto.randomUUID();
    const token = crypto.randomUUID();
    const terminalName = `life-${token}`;
    const journalId = (await executionHash({ kind: 'check', command: JSON.stringify([spaceId, runId]) })).slice('sha256:'.length);
    const journal = join(this.options.stateRoot, `${journalId}.json`);
    await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(tmpdir(), 'gitspace-lifecycle-'));
    const pending: PendingLifecycleRun = { projectId: current.projectId, spaceId, runId, token, terminalName, directory, secretNames, ...(workingDirectory ? { workingDirectory } : {}) };
    // Write ownership capability before cloud acceptance; a lost claim response is recoverable.
    await writeFile(journal, JSON.stringify(pending), { mode: 0o600, flag: 'wx' });
    const state = await this.authority.mutateLifecycleState(current.projectId, spaceId, {
      op: 'claim', runId, ownershipToken: token, phase, profile: current.selectedProfile, executionHashes: planned.map((execution) => execution.hash),
      generation: phase.startsWith('cloud/') || workingDirectory ? null : space.generation, rerun, terminalName, ...(request?.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
    });
    const acceptedRun = state.runs.find((run) => run.id === runId);
    if (!acceptedRun) throw new EnvironmentError('RunConflict', 'Authority did not persist the accepted lifecycle run', { runId });
    if (state.claim?.status === 'skipped' || state.claim?.status === 'existing') {
      await rm(journal);
      await rm(directory, { recursive: true, force: true });
      request?.accepted(acceptedRun);
      if (isLifecycleRunActive(acceptedRun)) throw new EnvironmentError('RunConflict', 'Operation is already executing; observe its durable state', { runId });
      if (acceptedRun.status !== 'succeeded') throw new EnvironmentError(acceptedRun.failure?.code ?? 'ExecutionFailed', acceptedRun.failure?.message ?? 'Previous operation failed; explicit retry requires a new run identity', acceptedRun.failure?.context ?? { runId });
      return acceptedRun.results.flatMap((result) => result.exitCode === null ? [] : [{ id: result.id, hash: planned.find((entry) => entry.id === result.id)?.hash ?? '', exitCode: result.exitCode, stdout: result.output, stderr: '' }]);
    }
    if (state.claim?.status !== 'claimed' || !state.claim.token) throw new EnvironmentError('RunConflict', state.claim?.reason ?? 'Lifecycle execution is awaiting approval or recovery');
      this.active.set(runId, { projectId: current.projectId, spaceId, terminalName, ...(workingDirectory ? { directory: workingDirectory } : {}) });
    request?.accepted(acceptedRun);
    let secretValues: Record<string, string> = {};
    let started = false;
    let stopped = false;
    let monitor: Promise<void> | undefined;
    let bindingWatcher: FSWatcher | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let launched = false;
    let stopping: Promise<void> | undefined;
    const enforceStop = async (): Promise<void> => {
      if (!launched || stopped) return;
      const stop = lifecycleStopReason(acceptedRun, new Date().toISOString());
      if (!stop) return;
      failure = new EnvironmentError(stop.code, stop.message, stop.context);
      if (!this.runner?.cancelLifecycleRun) throw new EnvironmentError('RecoveryRequired', 'The runner cannot confirm cancellation', { runId });
      stopping ??= this.runner.cancelLifecycleRun(spaceId, terminalName, workingDirectory);
      await stopping;
    };
    const scheduleDeadline = (): void => {
      const remaining = Date.parse(acceptedRun.deadlineAt) - Date.now();
      if (remaining <= 0) void enforceStop().catch((error: unknown) => { failure ??= error; });
      else deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
    };
    let result: WorkspaceLifecyclePlanResult | undefined;
    let failure: unknown;
    let logPending = '';
    const scriptLog = new LifecycleLogReader({ ids: planned.map((execution) => execution.id), outputLimit: Math.min(16_000, Math.floor(64_000 / Math.max(1, planned.length))) });
    let redactions: string[] = [];
    let retainedLogCharacters = 256;
    let incidentWrite: Promise<void> | undefined;
    const retainTransportFailure = async (error: unknown): Promise<void> => {
      if (environmentFailure(error)) throw error;
      if (pending.incidents?.length) { await incidentWrite; return; }
      pending.incidents = [{ id: `${runId}:transport`, kind: 'transport', occurredAt: new Date().toISOString(), message: sanitizeLifecycleOutput(error instanceof Error ? error.message : String(error), redactions), failure: null }];
      if (pending.completion) pending.completion.incidents = pending.incidents;
      incidentWrite = (async () => {
        await writeFile(`${journal}.incident.tmp`, JSON.stringify(pending), { mode: 0o600 });
        await rename(`${journal}.incident.tmp`, journal);
      })();
      await incidentWrite;
    };
    const subscription = new AbortController();
    const stateUpdates = this.authority.watchLifecycleState(current.projectId, spaceId, (snapshot) => {
      const authoritative = snapshot.runs.find((run) => run.id === runId);
      if (authoritative) Object.assign(acceptedRun, authoritative);
      void enforceStop().catch((error: unknown) => { failure ??= error; });
    }, subscription.signal, retainTransportFailure).catch(async (error: unknown) => {
      if (!subscription.signal.aborted) {
        try { await retainTransportFailure(error); } catch (retentionError) { failure ??= retentionError; }
      }
    });
    try {
      const definition = (await this.authority.listProjectWorkspaces(current.projectId)).find((workspace) => workspace.id === spaceId && workspace.projectId === current.projectId);
      secretValues = secretNames.length ? await this.secrets?.materializeProjectSecrets(current.projectId, secretNames, space.kind === 'base' ? null : space.id) ?? {} : {};
      redactions = Object.values(secretValues).filter(Boolean).sort((left, right) => right.length - left.length);
      retainedLogCharacters = Math.max(256, ...redactions.map((value) => value.length));
      if (secretNames.some((name) => secretValues[name] === undefined)) throw new EnvironmentError('MissingSecret', 'Project secret materialization is unavailable');
      await writeFile(join(directory, 'output.json'), JSON.stringify({ bindings: {} }), { mode: 0o600 });
      const tools = join(this.options.stateRoot, 'tools');
      await mkdir(join(tools, 'bin'), { recursive: true, mode: 0o700 });
      const inherited = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GITSPACE_'),
      ));
      const env = {
        ...inherited, ...current.values.effective, ...secretValues,
        HOME: inherited.HOME ?? homedir(),
        PATH: `${join(tools, 'bin')}${inherited.PATH ? `:${inherited.PATH}` : ''}`,
        GITSPACE_MACHINE_TOOLS: tools,
        GIT_TERMINAL_PROMPT: '0',
        GITSPACE_PROJECT_ID: current.projectId, GITSPACE_WORKSPACE_ID: spaceId, GITSPACE_MACHINE_ID: this.options.machineId,
        GITSPACE_WORKSPACE_GENERATION: workingDirectory ? '' : String(space.generation), GITSPACE_ENVIRONMENT_PROFILE: current.selectedProfile,
        GITSPACE_WORKSPACE_SOURCE_COMMIT: definition?.sourceCommit ?? '',
        GITSPACE_LIFECYCLE_BINDINGS: JSON.stringify(state.bindings), GITSPACE_LIFECYCLE_OUTPUT: join(directory, 'output.json'),
      };
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'start', runId, token });
      await incidentWrite;
      pending.started = true;
      await writeFile(`${journal}.tmp`, JSON.stringify(pending), { mode: 0o600 });
      await rename(`${journal}.tmp`, journal);
      let previous = '{}';
      let dirty = false;
      let syncing = false;
      const syncBindings = (): void => {
        dirty = true;
        if (syncing || stopped) return;
        syncing = true;
        monitor = (async () => {
          while (dirty && !stopped) {
            dirty = false;
            let bindings: Record<string, string>;
            // A write may be incomplete; only final output validation determines validity.
            try { bindings = await this.readBindings(directory, redactions); } catch { continue; }
            const serialized = JSON.stringify(bindings);
            if (serialized === previous) continue;
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: '', bindings, incidents: pending.incidents }).catch(retainTransportFailure);
            previous = serialized;
          }
        })().catch((error: unknown) => { failure ??= error; }).finally(() => { syncing = false; });
      };
      bindingWatcher = watch(directory, (_event, name) => { if (name === null || name === 'output.json') syncBindings(); });
      bindingWatcher.on('error', (error) => { failure ??= error; });
      syncBindings();
      scheduleDeadline();
      started = true;
      const execution = this.runner!.runLifecyclePlan(spaceId, phase, steps, env, {
        runId: token, deadlineAt: acceptedRun.deadlineAt, redactNames: Object.keys(secretValues), ...(workingDirectory ? { directory: workingDirectory } : {}),
        onStarted: async () => { launched = true; await enforceStop(); },
        onOutput: async (output) => {
          const sanitized = sanitizeLifecycleOutput(logPending + output, redactions);
          const retained = retainedLogCharacters;
          const safeLength = Math.max(0, sanitized.length - retained);
          logPending = sanitized.slice(safeLength);
          for (let offset = 0; offset < safeLength; offset += 16_000) {
            const chunk = sanitized.slice(offset, Math.min(safeLength, offset + 16_000));
            scriptLog.push(chunk, { at: new Date().toISOString() });
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: chunk, results: scriptLog.results, incidents: pending.incidents }).catch(retainTransportFailure);
          }
        },
      });
      result = await execution;
    } catch (error) {
      failure = error;
      if (started && !result) {
        // A failed Hub/log connection cannot own shell lifetime or prove completion.
        // Keep the durable claim and local spool for explicit restart reconciliation.
        await retainTransportFailure(error);
        throw new EnvironmentError('RecoveryRequired', 'Lifecycle outcome is uncertain; durable run and local log are retained for reconciliation', { runId });
      }
    } finally {
      stopped = true;
      bindingWatcher?.close();
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      await stopping?.catch((error: unknown) => { failure ??= error; });
      subscription.abort();
      await stateUpdates;
      await monitor?.catch((error) => { failure ??= error; });
      this.active.delete(runId);
    }
    let bindings: Record<string, string> = {};
    try { bindings = await this.readBindings(directory, redactions); }
    catch (error) { failure ??= error; }
    const sanitize = (output: string) => sanitizeLifecycleOutput(output, redactions);
    const finalLog = sanitize(logPending);
    for (let offset = 0; offset < finalLog.length; offset += 16_000) {
      const chunk = finalLog.slice(offset, offset + 16_000);
      scriptLog.push(chunk, { at: new Date().toISOString(), final: offset + 16_000 >= finalLog.length });
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: chunk, results: scriptLog.results, incidents: pending.incidents }).catch(retainTransportFailure);
    }
    const exitCode = failure ? 1 : result?.exitCode ?? 1;
    const output = sanitize([result?.output ?? '', failure ? failure instanceof Error ? failure.message : String(failure) : ''].filter(Boolean).join('\n'));
    const results = (scriptLog.results.length ? scriptLog.results : result?.steps ?? []).map((step) => ({ ...step, output: sanitize(step.output) }));
    const domainFailure = environmentFailure(failure);
    const completion: NonNullable<PendingLifecycleRun['completion']> = {
      op: 'finish', runId, token, status: domainFailure?.code === 'DeadlineExceeded' ? 'timed-out' : domainFailure?.code === 'Cancelled' ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
      exitCode, results, output, bindings, ...(domainFailure ? { failure: domainFailure } : {}),
      incidents: pending.incidents,
    };
    await writeFile(`${journal}.tmp`, JSON.stringify({ ...pending, completion }), { mode: 0o600 });
    pending.completion = completion;
    await rename(`${journal}.tmp`, journal);
    let completed: LifecycleState;
    try {
      if (pending.incidents?.length) await this.syncPendingLog(pending);
      completed = await this.authority.mutateLifecycleState(current.projectId, spaceId, completion);
    } catch (error) {
      await retainTransportFailure(error);
      const committed = Promise.withResolvers<LifecycleState>();
      const reconnect = new AbortController();
      let synchronizing = false;
      // A fresh stream snapshot proves connectivity; replay the durable local outcome,
      // never rerun shell effects and never poll the authority while disconnected.
      const reconnecting = this.authority.watchLifecycleState(current.projectId, spaceId, (snapshot) => {
        if (synchronizing) return;
        synchronizing = true;
        void (async () => {
          const recorded = snapshot.runs.find((run) => run.id === runId);
          if (recorded && !isLifecycleRunActive(recorded)) {
            return pending.incidents?.length
              ? this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'incidents', runId, incidents: pending.incidents })
              : snapshot;
          }
          await this.syncPendingLog(pending);
          return this.authority.mutateLifecycleState(current.projectId, spaceId, completion);
        })().then(committed.resolve).catch(async (syncError: unknown) => {
          try { await retainTransportFailure(syncError); } catch (domainError) { committed.reject(domainError); }
        }).finally(() => { synchronizing = false; });
      }, reconnect.signal, retainTransportFailure).catch(committed.reject);
      try { completed = await committed.promise; }
      finally { reconnect.abort(); await reconnecting; }
    }
    const finalRun = completed.runs.find((run) => run.id === runId);
    if (!finalRun) throw new EnvironmentError('RecoveryRequired', 'Authority did not confirm the lifecycle terminal outcome', { runId });
    await rm(journal);
    await rm(directory, { recursive: true, force: true });
    if (finalRun.failure) throw new EnvironmentError(finalRun.failure.code, finalRun.failure.message, finalRun.failure.context);
    return results.flatMap((step) => step.exitCode === null ? [] : [{ id: step.id, hash: planned.find((execution) => execution.id === step.id)!.hash, exitCode: step.exitCode, stdout: step.output, stderr: '' }]);
  }


  private async syncPendingLog(pending: PendingLifecycleRun): Promise<void> {
    const spool = await open(join(pending.directory, 'runner.log'), 'r').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!spool) return;
    try {
      await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, { op: 'append', runId: pending.runId, token: pending.token, output: '\n[Recovered local lifecycle log; previously streamed output may repeat]\n', incidents: pending.incidents });
      const buffer = Buffer.allocUnsafe(16_000);
      const decoder = new TextDecoder();
      const scriptLog = new LifecycleLogReader({ outputLimit: 500 });
      for (;;) {
        const { bytesRead } = await spool.read(buffer);
        const output = bytesRead ? decoder.decode(buffer.subarray(0, bytesRead), { stream: true }) : decoder.decode();
        scriptLog.push(output, { final: bytesRead === 0 });
        if (output) await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, { op: 'append', runId: pending.runId, token: pending.token, output, results: scriptLog.results });
        if (bytesRead === 0) break;
      }
    } finally { await spool.close(); }
  }

  private async readBindings(directory: string, secrets: readonly string[]): Promise<Record<string, string>> {
    const source = await readFile(join(directory, 'output.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"bindings":{}}' : Promise.reject(error));
    return parseLifecycleBindingsJson(source, secrets);
  }
}
