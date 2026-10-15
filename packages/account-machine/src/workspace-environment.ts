import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { watch, type FSWatcher } from 'node:fs';
import {
  executionHash, loadEnvironmentBundle, parseEnvironmentBundleJson, parseLifecycleBindingsJson, resolveEnvironmentProfile,
  resolveExecutionApproval, deriveLifecycleExecutions, isInteractiveLifecycleScript, skippedInteractiveScriptLine,
  effectiveEnvironmentValues, assertEnvironmentExecutionReady, environmentPreparationPhases,
  EnvironmentError, environmentFailure, isLifecycleRunActive, lifecycleStopReason, sanitizeLifecycleOutput, assertLifecycleRequestIdentity, parseLifecycleRunRequest, LifecycleLogReader,
  type ApprovalSource, type EffectiveEnvironmentProfile, type EnvironmentBundle, type LifecycleIncident,
  type EnvironmentLifecycleAuthority, type LifecyclePhase, type LifecycleRun, type LifecycleRunPhase, type LifecycleState, type LifecycleRunRequest,
} from '@gitspace/protocol-environment';
import type { EffectiveSecretMetadata } from '@gitspace/protocol';
import type { WorkspaceCheckouts, WorkspaceLifecyclePlanResult, WorkspaceLifecyclePlanStep } from './workspace-hub.js';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import type { RuntimeCacheObservation } from '@gitspace/protocol-runtime';


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
  interactive?: boolean;
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
  runLifecyclePlan(spaceId: string, phase: LifecycleRunPhase, steps: readonly WorkspaceLifecyclePlanStep[], env: Record<string, string>, options?: { runId?: string; interactive?: boolean; deadlineAt?: string; redactNames?: readonly string[]; onStarted?: () => Promise<void>; onOutput?: (output: string) => Promise<void>; directory?: string }): Promise<WorkspaceLifecyclePlanResult>;
  cancelLifecycleRun?(spaceId: string, terminalName: string, directory?: string): Promise<void>;
}
export class WorkspaceEnvironmentManager {
  private readonly accepting = new Map<string, { phase: LifecycleRunPhase; interactive?: boolean; promise: Promise<LifecycleRun> }>();
  /** Runs executing in this process; `update` hands a run the cloud's current record. */
  private readonly active = new Map<string, { projectId: string; spaceId: string; terminalName: string; directory?: string; update(run: LifecycleRun): void }>();
  constructor(
    private readonly checkouts: WorkspaceCheckouts,
    private readonly secrets: EnvironmentSecretMaterializer | undefined,
    private readonly runner: EnvironmentLifecycleRunner | undefined,
    private readonly authority: EnvironmentLifecycleAuthority & Pick<CloudSpaceCheckpointAuthority, 'listProjectWorkspaces'>,
    private readonly options: { machineId: string; stateRoot: string },
  ) {}

  /** The checkout a lifecycle operation reads: the named attachment, else this machine's held checkout. */
  private space(spaceId: string, attachment?: LocalAttachment): { id: string; projectId: string; rootPath: string; kind: 'base' | 'worktree' } {
    if (attachment) {
      const { workspaceId, projectId } = attachment.attachment;
      return { id: workspaceId, projectId, rootPath: attachment.rootPath, kind: String(workspaceId) === String(projectId) ? 'base' : 'worktree' };
    }
    const rootPath = this.checkouts.path(spaceId);
    const projectId = this.checkouts.projectId(spaceId);
    if (!rootPath || !projectId) throw new EnvironmentError('NotFound', `Space ${spaceId} does not exist`, { spaceId });
    return { id: spaceId, projectId, rootPath, kind: spaceId === projectId ? 'base' : 'worktree' };
  }

  async view(spaceId: string, cloudOnly = false, attachment?: LocalAttachment): Promise<WorkspaceEnvironmentView> {
    const space = this.space(spaceId, attachment);
    let lifecycle = await this.authority.getLifecycleState(space.projectId, spaceId);
    if (attachment) {
      const copyBindings = lifecycle.runs.filter(run => run.attachment?.attachmentId === attachment.attachment.attachmentId && run.attachment.generation === attachment.attachment.generation).reduce<Record<string, string>>((bindings, run) => ({ ...bindings, ...run.bindings }), {});
      lifecycle = { ...lifecycle, bindings: { ...lifecycle.bindings, ...copyBindings } };
    }
    const available = (attachment !== undefined || !cloudOnly)
      && await stat(space.rootPath).then((entry) => entry.isDirectory(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error));
    const source = available ? await readFile(join(space.rootPath, '.gitspace', 'bundle.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)) : null;
    const bundle = source !== null ? parseEnvironmentBundleJson(source)
      : lifecycle.bundleJson !== null ? parseEnvironmentBundleJson(lifecycle.bundleJson)
        : loadEnvironmentBundle({ version: 1, defaultProfile: 'base', profiles: { base: {} } });
    if (!attachment && (source !== null || lifecycle.bundleJson !== null) && JSON.stringify(bundle) !== lifecycle.bundleJson) {
      lifecycle = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle) });
    }
    const selectedProfile = lifecycle.selectedProfile ?? bundle.defaultProfile;
    const effective = resolveEnvironmentProfile(bundle, selectedProfile);
    const effectiveValues = effectiveEnvironmentValues(bundle, effective, lifecycle.values);
    const projectApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'project').map((item) => item.executionHash));
    const workspaceApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'workspace').map((item) => item.executionHash));
    const approval = (hash: string) => resolveExecutionApproval({ executionHash: hash, projectApprovals, workspaceApprovals });
    // The same derivation the cloud applies to a cloud workspace's checkpoint: equal content, equal approval hash.
    const derived = available ? await deriveLifecycleExecutions({
      bundle, selectedProfile,
      list: (phase) => readdir(join(space.rootPath, '.gitspace', 'lifecycle', phase)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error)),
      read: async (phase, fileName) => {
        const command = join(space.rootPath, '.gitspace', 'lifecycle', phase, fileName);
        return { command, content: await readFile(command, 'utf8') };
      },
    }) : null;
    const executions: EnvironmentExecutionView[] = (derived ?? lifecycle.executions).map((execution) => ({
      ...execution, phase: execution.phase ?? undefined, fileName: execution.fileName ?? undefined, approval: approval(execution.hash), ...(execution.kind === 'script' ? { interactive: isInteractiveLifecycleScript(execution.content) } : {}),
    }));
    if (!attachment && derived && (source !== null || derived.length > 0) && JSON.stringify(derived) !== JSON.stringify(lifecycle.executions)) {
      lifecycle = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle), executions: derived });
    }
    const secretMetadata = await this.secrets?.listEffectiveSecrets(space.projectId, space.kind === 'base' ? null : space.id) ?? [];
    return {
      spaceId, projectId: space.projectId, bundle, selectedProfile, effective,
      values: { ...lifecycle.values, effective: effectiveValues },
      configuredSecrets: secretMetadata.map((secret) => secret.name), secretMetadata,
      executions, runs: lifecycle.runs, lifecycle,
    };
  }


  /** The request ends after durable acceptance; no caller signal owns execution. */
  async acceptRun(spaceId: string, candidate: LifecycleRunRequest, attachment?: LocalAttachment): Promise<LifecycleRun> {
    const request = parseLifecycleRunRequest(candidate);
    const key = `${spaceId}:${request.runId}`;
    const accepting = this.accepting.get(key);
    if (accepting) {
      assertLifecycleRequestIdentity(request, accepting);
      return accepting.promise;
    }
    const space = this.space(spaceId, attachment);
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
    this.accepting.set(key, { phase: request.phase, interactive: request.interactive, promise: accepted.promise });
    const options = { ...request, accepted: (run: LifecycleRun) => { this.accepting.delete(key); accepted.resolve(run); } };
    const execution = attachment && !request.phase.startsWith('cloud/')
      ? this.runApproved(spaceId, request.phase, request.rerun ?? true, attachment.rootPath, options, attachment)
      : request.phase === 'checks'
        ? this.runApproved(spaceId, 'checks', true, undefined, options)
        : this.runPhase(spaceId, request.phase, request.rerun ?? false, options);
    void execution.catch((error: unknown) => {
      accepted.reject(error);
      console.error('[gitspace-lifecycle] accepted operation requires attention', request.runId, error);
    }).finally(() => { this.accepting.delete(key); });
    return accepted.promise;
  }

  async cancelRun(spaceId: string, runId: string): Promise<LifecycleRun> {
    const space = this.space(spaceId);
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

  async runPhase(spaceId: string, phase: LifecyclePhase, rerun = false, request?: { runId: string; interactive?: boolean; deadlineAt?: string; accepted: (run: LifecycleRun) => void }): Promise<readonly EnvironmentExecutionResult[]> {
    const current = await this.view(spaceId);
    if (phase === 'cloud/provision') await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'policy', automatic: true });
    let result: readonly EnvironmentExecutionResult[] = [];
    for (const next of environmentPreparationPhases(phase, false)) {
      const operation = request ? { ...request, interactive: next === 'checks' ? false : request.interactive, runId: next === phase ? request.runId : `${request.runId}:${next.replace('/', '-')}`, accepted: next === phase ? request.accepted : () => undefined } : undefined;
      const completed = await this.runApproved(spaceId, next, next === phase ? rerun : next === 'checks', undefined, operation);
      if (next === phase) result = completed;
    }
    return result;
  }

  /** Runs every setup phase on a machine cache. A failed phase is recorded on its step and the next phase still runs. */
  async prepareAttachment(local: LocalAttachment, signal: AbortSignal, progress?: (step: RuntimeCacheObservation['setup'][number]) => Promise<void>): Promise<void> {
    const { workspaceId, projectId, attachmentId, generation } = local.attachment;
    for (const phase of ['machine/prepare', 'checks', 'workspace/materialize'] as const) {
      signal.throwIfAborted();
      const runId = `attachment:${attachmentId}:${generation}:${phase}`;
      await progress?.({ phase, state: 'running', runId, error: null });
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => { cancellation ??= this.authority.mutateLifecycleState(projectId, workspaceId, { op: 'cancel', runId }); void cancellation.catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const results = await this.runApproved(workspaceId, phase, true, local.rootPath, {
          runId, deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          accepted: () => { if (signal.aborted) cancel(); },
        }, local);
        if (results.some(result => result.exitCode !== 0)) throw new EnvironmentError('ExecutionFailed', 'Attachment preparation failed', { attachmentId, phase });
        signal.throwIfAborted();
        await progress?.({ phase, state: 'succeeded', runId, error: null });
      } catch (error) {
        const waiting = error instanceof EnvironmentError && ['ApprovalRequired', 'RunConflict'].includes(error.code);
        const message = error instanceof Error ? error.message : String(error);
        await progress?.({ phase, state: waiting ? 'waiting-for-approval' : 'failed', runId, error: message.slice(0, 2000) });
        if (signal.aborted) throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        await cancellation;
      }
    }
  }

  /** An `environment` notice for a workspace (every workspace with a run here when null): each of this machine's runs
   * there takes the cloud's current record, so a cancelled run stops. A run the cloud still shows active that no
   * process here owns (the runtime restarted) is stopped if its terminal remains and finished as interrupted. */
  async environmentChanged(spaceId: string | null): Promise<void> {
    const spaces = new Map<string, string>();
    for (const run of this.active.values()) if (spaceId === null || run.spaceId === spaceId) spaces.set(run.spaceId, run.projectId);
    const held = spaceId === null ? null : this.checkouts.projectId(spaceId);
    if (spaceId !== null && held !== null && !spaces.has(spaceId)) spaces.set(spaceId, held);
    for (const [space, projectId] of spaces) {
      const state = await this.authority.getLifecycleState(projectId, space);
      for (const run of state.runs) {
        if (run.machineId !== this.options.machineId || !isLifecycleRunActive(run)) continue;
        const local = this.active.get(run.id);
        if (local) { local.update(run); continue; }
        if (!run.cancelRequestedAt || [...this.accepting.keys()].includes(`${space}:${run.id}`)) continue;
        if (run.terminalName) await this.runner?.cancelLifecycleRun?.(space, run.terminalName).catch(() => undefined);
        await this.authority.mutateLifecycleState(projectId, space, {
          op: 'finish', runId: run.id, status: 'interrupted', exitCode: 1, results: [], output: 'The machine runtime restarted during this run.', bindings: {},
          failure: { code: 'Interrupted', message: 'The machine runtime restarted during this run; the outcome of its scripts is unknown', context: { runId: run.id } },
        });
      }
    }
  }

  async runLog(spaceId: string, runId: string, offset = 0) {
    const space = this.space(spaceId);
    return this.authority.getLifecycleRunLog(space.projectId, spaceId, runId, offset);
  }

  private async runApproved(spaceId: string, phase: LifecycleRunPhase, rerun: boolean, workingDirectory?: string, request?: { runId: string; interactive?: boolean; deadlineAt?: string; accepted: (run: LifecycleRun) => void }, attachment?: LocalAttachment): Promise<readonly EnvironmentExecutionResult[]> {
    const space = this.space(spaceId, attachment);
    const current = await this.view(spaceId, workingDirectory !== undefined, attachment);
    const phaseExecutions = current.executions.filter((execution) => phase === 'checks' ? execution.kind === 'check' : execution.phase === phase);
    // Without a terminal, interactive scripts are skipped and recorded instead of refusing the whole phase.
    const skipped = request?.interactive ? [] : phaseExecutions.filter((execution) => execution.interactive);
    const planned = phaseExecutions.filter((execution) => !skipped.includes(execution));
    const skippedOutput = skipped.map((execution) => `${skippedInteractiveScriptLine(execution.fileName ?? execution.label)}\n`).join('');
    // An attached machine runs in its own checkout, so it can open a terminal; a detached runner directory cannot.
    if (request?.interactive && (phase === 'checks' || (workingDirectory !== undefined && !attachment))) throw new EnvironmentError('InvalidConfiguration', 'Interactive lifecycle execution requires a script phase in an open workspace');
    assertEnvironmentExecutionReady({
      phase, state: current.lifecycle, bundle: current.bundle, effective: current.effective, values: current.values.effective,
      configuredSecrets: current.configuredSecrets, executionCount: planned.length,
      holder: true,
      detached: workingDirectory !== undefined, runnerAvailable: this.runner !== undefined, attachment: attachment !== undefined,
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
    // Terminal names are plain identifiers; run ids may contain ':' and '/'.
    const terminalId = crypto.randomUUID();
    const terminalName = `life-${terminalId}`;
    if (this.active.has(runId)) throw new EnvironmentError('RunConflict', 'Operation is already executing; observe its durable state', { runId });
    const state = await this.authority.mutateLifecycleState(current.projectId, spaceId, {
      op: 'claim', runId, phase, profile: current.selectedProfile, executionHashes: planned.map((execution) => execution.hash),
      interactive: request?.interactive ?? false,
      generation: null, rerun, terminalName, ...(request?.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
      ...(attachment ? { attachment: { attachmentId: attachment.attachment.attachmentId, generation: attachment.attachment.generation } } : {}),
    });
    const acceptedRun = state.runs.find((run) => run.id === runId);
    if (!acceptedRun) throw new EnvironmentError('RunConflict', 'Authority did not persist the accepted lifecycle run', { runId });
    if (state.claim?.status === 'skipped' || state.claim?.status === 'existing') {
      request?.accepted(acceptedRun);
      if (isLifecycleRunActive(acceptedRun)) throw new EnvironmentError('RunConflict', 'Operation is already executing; observe its durable state', { runId });
      if (acceptedRun.status !== 'succeeded') throw new EnvironmentError(acceptedRun.failure?.code ?? 'ExecutionFailed', acceptedRun.failure?.message ?? 'Previous operation failed; explicit retry requires a new run identity', acceptedRun.failure?.context ?? { runId });
      return acceptedRun.results.flatMap((result) => result.exitCode === null ? [] : [{ id: result.id, hash: planned.find((entry) => entry.id === result.id)?.hash ?? '', exitCode: result.exitCode, stdout: result.output, stderr: '' }]);
    }
    if (state.claim?.status !== 'claimed') throw new EnvironmentError('RunConflict', state.claim?.reason ?? 'Lifecycle execution is awaiting approval');
    const directory = await mkdtemp(join(tmpdir(), 'gitspace-lifecycle-'));
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
      if (!this.runner?.cancelLifecycleRun) throw new EnvironmentError('ExecutionFailed', 'The runner cannot stop a lifecycle run', { runId });
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
    let incidents: LifecycleIncident[] | undefined;
    // A failed progress write is reported on the run's next write; refusals end the run.
    const reportTransportFailure = (error: unknown): void => {
      if (environmentFailure(error)) throw error;
      incidents ??= [{ id: `${runId}:transport`, kind: 'transport', occurredAt: new Date().toISOString(), message: sanitizeLifecycleOutput(error instanceof Error ? error.message : String(error), redactions), failure: null }];
    };
    this.active.set(runId, {
      projectId: current.projectId, spaceId, terminalName, ...(workingDirectory ? { directory: workingDirectory } : {}),
      update: (run) => { Object.assign(acceptedRun, run); void enforceStop().catch((error: unknown) => { failure ??= error; }); },
    });
    request?.accepted(acceptedRun);
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
        GITSPACE_WORKSPACE_GENERATION: '', GITSPACE_ENVIRONMENT_PROFILE: current.selectedProfile,
        GITSPACE_WORKSPACE_SOURCE_COMMIT: definition?.sourceCommit ?? '',
        GITSPACE_LIFECYCLE_BINDINGS: JSON.stringify(state.bindings), GITSPACE_LIFECYCLE_OUTPUT: join(directory, 'output.json'),
      };
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'start', runId });
      if (skippedOutput) await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, output: skippedOutput, incidents }).catch(reportTransportFailure);
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
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, output: '', bindings, incidents }).catch(reportTransportFailure);
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
        runId: terminalId, deadlineAt: acceptedRun.deadlineAt, redactNames: Object.keys(secretValues), ...(workingDirectory ? { directory: workingDirectory } : {}),
        interactive: acceptedRun.interactive ?? false,
        onStarted: async () => { launched = true; await enforceStop(); },
        onOutput: async (output) => {
          const sanitized = sanitizeLifecycleOutput(logPending + output, redactions);
          const retained = retainedLogCharacters;
          const safeLength = Math.max(0, sanitized.length - retained);
          logPending = sanitized.slice(safeLength);
          for (let offset = 0; offset < safeLength; offset += 16_000) {
            const chunk = sanitized.slice(offset, Math.min(safeLength, offset + 16_000));
            scriptLog.push(chunk, { at: new Date().toISOString() });
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, output: chunk, results: scriptLog.results, incidents }).catch(reportTransportFailure);
          }
        },
      });
      result = await execution;
    } catch (error) {
      // The runner connection failed after launch: the shell may have run, so its outcome is reported as unknown.
      failure = started && !result && !environmentFailure(error)
        ? new EnvironmentError('Interrupted', `The runner connection failed; the outcome of its scripts is unknown: ${error instanceof Error ? error.message : String(error)}`, { runId })
        : error;
    } finally {
      stopped = true;
      bindingWatcher?.close();
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      await stopping?.catch((error: unknown) => { failure ??= error; });
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
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, output: chunk, results: scriptLog.results, incidents }).catch(reportTransportFailure);
    }
    const exitCode = failure ? 1 : result?.exitCode ?? 1;
    const output = sanitize([skippedOutput + (result?.output ?? ''), failure ? failure instanceof Error ? failure.message : String(failure) : ''].filter(Boolean).join('\n'));
    const results = (scriptLog.results.length ? scriptLog.results : result?.steps ?? []).map((step) => ({ ...step, output: sanitize(step.output) }));
    const domainFailure = environmentFailure(failure);
    const status = domainFailure?.code === 'DeadlineExceeded' ? 'timed-out' : domainFailure?.code === 'Cancelled' ? 'cancelled' : domainFailure?.code === 'Interrupted' ? 'interrupted' : exitCode === 0 ? 'succeeded' : 'failed';
    let completed: LifecycleState;
    try {
      completed = await this.authority.mutateLifecycleState(current.projectId, spaceId, {
        op: 'finish', runId, status, exitCode, results, output, bindings, ...(domainFailure ? { failure: domainFailure } : {}), incidents,
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
    const finalRun = completed.runs.find((run) => run.id === runId);
    if (finalRun?.failure) throw new EnvironmentError(finalRun.failure.code, finalRun.failure.message, finalRun.failure.context);
    return results.flatMap((step) => step.exitCode === null ? [] : [{ id: step.id, hash: planned.find((execution) => execution.id === step.id)!.hash, exitCode: step.exitCode, stdout: step.output, stderr: '' }]);
  }


  private async readBindings(directory: string, secrets: readonly string[]): Promise<Record<string, string>> {
    const source = await readFile(join(directory, 'output.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"bindings":{}}' : Promise.reject(error));
    return parseLifecycleBindingsJson(source, secrets);
  }
}
