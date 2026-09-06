import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { EnvironmentApprovalScope, EnvironmentValueScope, GitSpaceDatabase } from '@gitspace/core';
import {
  EnvironmentBundleSchema, LifecycleBindingsSchema, executionHash, resolveEnvironmentProfile, resolveEnvironmentValues,
  resolveExecutionApproval, selectLifecycleScripts,
  type ApprovalSource, type EffectiveEnvironmentProfile, type EnvironmentBundle,
  type EnvironmentLifecycleAuthority, type LifecyclePhase, type LifecycleRunPhase, type LifecycleState,
} from '@gitspace/protocol';
import type { WorkspaceLifecyclePlanResult, WorkspaceLifecyclePlanStep } from './workspace-hub.js';

const BUILT_IN_CHECKS: Readonly<Record<string, string>> = {
  bun: 'bun --version', gh: 'gh --version', git: 'git --version', postgres: 'pg_isready',
  vercel: 'vercel whoami', node: 'node --version',
};
const PHASES: readonly LifecyclePhase[] = ['cloud/provision', 'machine/prepare', 'workspace/materialize', 'workspace/dematerialize', 'cloud/destroy'];

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
  executions: readonly EnvironmentExecutionView[];
  runs: LifecycleState['runs'];
  lifecycle: LifecycleState;
  migrationRequired: readonly string[];
}
export interface EnvironmentSecretMaterializer {
  listProjectSecrets(projectId: string): Promise<Array<{ name: string }>>;
  materializeProjectSecrets(projectId: string, names: string[]): Promise<Record<string, string>>;
}
export interface EnvironmentLifecycleRunner {
  runLifecyclePlan(spaceId: string, phase: LifecycleRunPhase, steps: readonly WorkspaceLifecyclePlanStep[], env: Record<string, string>, options?: { runId?: string; redactNames?: readonly string[]; onOutput?: (output: string) => Promise<void>; directory?: string }): Promise<WorkspaceLifecyclePlanResult>;
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
}
export class WorkspaceEnvironmentManager {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly secrets: EnvironmentSecretMaterializer | undefined,
    private readonly runner: EnvironmentLifecycleRunner | undefined,
    private readonly authority: EnvironmentLifecycleAuthority,
    private readonly options: { machineId: string; stateRoot: string; prepareRunner?: (spaceId: string, phase: LifecyclePhase) => Promise<string | undefined> },
  ) {}

  async view(spaceId: string, cloudOnly = false): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    let lifecycle = await this.authority.getLifecycleState(space.projectId, spaceId);
    const available = !cloudOnly && space.placementState !== 'closed' && space.holderId === this.options.machineId
      && await stat(space.rootPath).then((entry) => entry.isDirectory(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error));
    const source = available ? await readFile(join(space.rootPath, '.gitspace', 'bundle.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)) : null;
    const bundle = EnvironmentBundleSchema.parse(source === null
      ? lifecycle.bundleJson === null ? { version: 1, defaultProfile: 'base', profiles: { base: {} } } : JSON.parse(lifecycle.bundleJson)
      : JSON.parse(source));
    if (source !== null && JSON.stringify(bundle) !== lifecycle.bundleJson) {
      lifecycle = await this.authority.mutateLifecycleState(space.projectId, spaceId, { op: 'configure', bundleJson: JSON.stringify(bundle) });
    }
    const selectedProfile = lifecycle.selectedProfile ?? bundle.defaultProfile;
    const effective = resolveEnvironmentProfile(bundle, selectedProfile);
    const defaults = Object.fromEntries(effective.values.flatMap((name) => bundle.values[name]?.default === undefined ? [] : [[name, bundle.values[name].default]]));
    const resolvedValues = resolveEnvironmentValues({ global: { ...defaults, ...lifecycle.values.global }, project: lifecycle.values.project, workspace: lifecycle.values.workspace });
    const effectiveValues = Object.fromEntries(effective.values.flatMap((name) => resolvedValues[name] === undefined ? [] : [[name, resolvedValues[name]]]));
    const projectApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'project').map((item) => item.executionHash));
    const workspaceApprovals = new Set(lifecycle.approvals.filter((item) => item.scope === 'workspace').map((item) => item.executionHash));
    const approval = (hash: string) => resolveExecutionApproval({ executionHash: hash, projectApprovals, workspaceApprovals });
    const checks = await Promise.all(effective.checks.map(async (id): Promise<EnvironmentExecutionView> => {
      const definition = bundle.checks[id]!;
      const command = definition.kind === 'built-in' ? BUILT_IN_CHECKS[definition.check] : definition.command;
      if (!command) throw new Error(`Unknown built-in environment check: ${id}`);
      const hash = await executionHash({ kind: 'check', command });
      return { id, kind: 'check', label: definition.kind === 'built-in' ? definition.label ?? definition.check : definition.label, command, content: command, hash, approval: approval(hash) };
    }));
    const scripts = (await Promise.all(PHASES.map(async (phase) => {
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
    const migrationRequired = available ? (await Promise.all(['setup', 'select', 'remove'].map(async (phase) => {
      const files = await readdir(join(space.rootPath, '.gitspace', 'lifecycle', phase)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      return files.length ? phase : null;
    }))).filter((phase): phase is string => phase !== null) : [];
    return {
      spaceId, projectId: space.projectId, bundle, selectedProfile, effective,
      values: { ...lifecycle.values, effective: effectiveValues },
      configuredSecrets: this.secrets ? (await this.secrets.listProjectSecrets(space.projectId)).map((secret) => secret.name) : [],
      executions, runs: lifecycle.runs, lifecycle, migrationRequired,
    };
  }

  async putBundle(spaceId: string, source: unknown): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const bundle = EnvironmentBundleSchema.parse(source);
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
    if (!current.bundle.profiles[profile]) throw new Error(`Unknown environment profile: ${profile}`);
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
    throw new Error('Execution approval requires a human browser authorization through the account gateway');
  }

  async revokeApproval(_spaceId: string, _scope: EnvironmentApprovalScope, _hash: string): Promise<WorkspaceEnvironmentView> {
    throw new Error('Execution approval changes require a human browser authorization through the account gateway');
  }

  async runChecks(spaceId: string): Promise<readonly EnvironmentExecutionResult[]> {
    return this.runApproved(spaceId, 'checks', true);
  }

  async runPhase(spaceId: string, phase: LifecyclePhase, rerun = false): Promise<readonly EnvironmentExecutionResult[]> {
    const directory = phase.startsWith('cloud/') ? await this.options.prepareRunner?.(spaceId, phase) : undefined;
    const current = await this.view(spaceId, directory !== undefined);
    try {
      if (phase === 'cloud/provision') await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'policy', automatic: true });
      if (phase === 'cloud/provision' || directory) {
        await this.runApproved(spaceId, 'machine/prepare', false, directory);
        await this.runApproved(spaceId, 'checks', true, directory);
      }
      const result = await this.runApproved(spaceId, phase, rerun, directory);
      if (phase === 'cloud/provision') await this.runApproved(spaceId, 'workspace/materialize', false);
      return result;
    } finally {
      if (directory) {
        // Preserve isolated recovery context while any shell outcome remains uncertain.
        const state = await this.authority.getLifecycleState(current.projectId, spaceId).catch(() => null);
        if (state && !state.runs.some((run) => run.status === 'running' && run.machineId === this.options.machineId)) await rm(directory, { recursive: true, force: true });
      }
    }
  }

  /** Preparation is advisory; never gate checkout, terminal or agent access on it. */
  async prepare(spaceId: string): Promise<void> {
    try {
      const current = await this.view(spaceId);
      if (!current.lifecycle.policy.automatic || !current.lifecycle.provisioned || current.lifecycle.destroyedAt) return;
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
        if (!this.runner?.cancelLifecycleRun) continue;
        await this.runner.cancelLifecycleRun(pending.spaceId, pending.terminalName, pending.workingDirectory);
        const secrets = pending.secretNames.length ? await this.secrets?.materializeProjectSecrets(pending.projectId, pending.secretNames) : {};
        if (!secrets) continue;
        const bindings = await this.readBindings(pending.directory, Object.values(secrets));
        const spool = await open(join(pending.directory, 'runner.log'), 'r').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (spool) {
          try {
            await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, { op: 'append', runId: pending.runId, token: pending.token, output: '\n[Recovered local lifecycle log; previously streamed output may repeat]\n' });
            const buffer = Buffer.allocUnsafe(16_000);
            const decoder = new TextDecoder();
            for (;;) {
              const { bytesRead } = await spool.read(buffer);
              const output = bytesRead ? decoder.decode(buffer.subarray(0, bytesRead), { stream: true }) : decoder.decode();
              if (output) await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, { op: 'append', runId: pending.runId, token: pending.token, output });
              if (bytesRead === 0) break;
            }
          } finally { await spool.close(); }
        }
        await this.authority.mutateLifecycleState(pending.projectId, pending.spaceId, {
          op: 'finish', runId: pending.runId, token: pending.token, status: 'failed', exitCode: 1,
          results: [], output: 'Interrupted lifecycle runner was confirmed stopped. Explicit retry is required.', bindings,
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
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    return this.authority.getLifecycleRunLog(space.projectId, spaceId, runId, offset);
  }

  private async runApproved(spaceId: string, phase: LifecycleRunPhase, rerun: boolean, workingDirectory?: string): Promise<readonly EnvironmentExecutionResult[]> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    if (!workingDirectory && (space.holderId !== this.options.machineId || space.placementState === 'closed')) throw new Error('Lifecycle execution requires a checkout held by this authorized runner');
    if (workingDirectory && (phase.startsWith('workspace/') || phase === 'cloud/provision')) throw new Error('Detached recovery cannot provision or materialize a workspace');
    const current = await this.view(spaceId, workingDirectory !== undefined);
    if (current.migrationRequired.length) throw new Error(`Lifecycle migration required: replace ${current.migrationRequired.join(', ')} with cloud/provision, machine/prepare, workspace/materialize, workspace/dematerialize and cloud/destroy`);
    if (current.lifecycle.destroyedAt && phase !== 'cloud/destroy' && !workingDirectory) throw new Error('Workspace resources have been explicitly retired');
    if (!this.runner) throw new Error('Workspace Hub lifecycle execution is unavailable');
    const planned = current.executions.filter((execution) => phase === 'checks' ? execution.kind === 'check' : execution.phase === phase);
    if (phase === 'checks' && planned.length === 0) return [];
    const secretNames = planned.length > 0 ? [...current.effective.secrets] : [];
    const reserved = [...current.effective.values, ...secretNames].find((name) => /^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|NODE_OPTIONS|BUN_OPTIONS|RUBYOPT|PYTHONPATH|LD_.+|DYLD_.+|GIT_CONFIG.*|GITSPACE_.+)$/u.test(name));
    if (reserved) throw new Error(`Environment name ${reserved} is reserved for the trusted lifecycle runner`);
    const steps = await Promise.all(planned.map(async (execution): Promise<WorkspaceLifecyclePlanStep> => {
      const content = workingDirectory ? execution.content : execution.kind === 'script' ? await readFile(execution.command, 'utf8') : execution.command;
      if (await executionHash({ kind: execution.kind, command: content }) !== execution.hash) throw new Error(`Execution content changed before claim: ${execution.label}`);
      const command = workingDirectory && execution.kind === 'script'
        ? join(workingDirectory, '.gitspace', 'lifecycle', execution.phase!, execution.fileName!)
        : execution.command;
      return { id: execution.id, kind: execution.kind, command, ...(execution.kind === 'script' ? { content } : {}) };
    }));
    const runId = crypto.randomUUID();
    const terminalName = `life-${runId}`;
    const state = await this.authority.mutateLifecycleState(current.projectId, spaceId, {
      op: 'claim', runId, phase, profile: current.selectedProfile, executionHashes: planned.map((execution) => execution.hash),
      generation: phase.startsWith('cloud/') || workingDirectory ? null : space.generation, rerun, terminalName,
    });
    if (state.claim?.status === 'skipped') return [];
    if (state.claim?.status !== 'claimed' || !state.claim.token) throw new Error(state.claim?.reason ?? 'Lifecycle execution is awaiting approval or recovery');
    const token = state.claim.token;
    let directory: string;
    const journal = join(this.options.stateRoot, `${runId}.json`);
    try {
      await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(tmpdir(), 'gitspace-lifecycle-'));
      const pending: PendingLifecycleRun = { projectId: current.projectId, spaceId, runId, token, terminalName, directory, secretNames, ...(workingDirectory ? { workingDirectory } : {}) };
      await writeFile(journal, JSON.stringify(pending), { mode: 0o600 });
    } catch (error) {
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'finish', runId, token, status: 'failed', exitCode: 1, results: [], output: 'Unable to persist runner recovery journal; no shell was started.', bindings: {} });
      throw error;
    }
    let secretValues: Record<string, string> = {};
    let started = false;
    let stopped = false;
    let monitor: Promise<void> | undefined;
    let result: WorkspaceLifecyclePlanResult | undefined;
    let failure: unknown;
    let logPending = '';
    let redactions: string[] = [];
    let retainedLogCharacters = 256;
    try {
      secretValues = secretNames.length ? await this.secrets?.materializeProjectSecrets(current.projectId, secretNames) ?? {} : {};
      redactions = Object.values(secretValues).filter(Boolean).sort((left, right) => right.length - left.length);
      retainedLogCharacters = Math.max(256, ...redactions.map((value) => value.length));
      if (secretNames.some((name) => secretValues[name] === undefined)) throw new Error('Project secret materialization is unavailable');
      await writeFile(join(directory, 'output.json'), JSON.stringify({ bindings: {} }), { mode: 0o600 });
      const tools = join(this.options.stateRoot, 'tools');
      await mkdir(join(tools, 'bin'), { recursive: true, mode: 0o700 });
      const env = {
        ...current.values.effective, ...secretValues,
        PATH: `${join(tools, 'bin')}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`, HOME: directory,
        GITSPACE_MACHINE_TOOLS: tools,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GITSPACE_PROJECT_ID: current.projectId, GITSPACE_WORKSPACE_ID: spaceId, GITSPACE_MACHINE_ID: this.options.machineId,
        GITSPACE_WORKSPACE_GENERATION: workingDirectory ? '' : String(space.generation), GITSPACE_ENVIRONMENT_PROFILE: current.selectedProfile,
        GITSPACE_LIFECYCLE_BINDINGS: JSON.stringify(state.bindings), GITSPACE_LIFECYCLE_OUTPUT: join(directory, 'output.json'),
      };
      started = true;
      monitor = (async () => {
        let previous = '{}';
        while (!stopped) {
          let bindings: Record<string, string> | undefined;
          // Atomic rename is recommended; tolerate in-progress writes, never persist partial JSON.
          try { bindings = await this.readBindings(directory, redactions); } catch { /* Final validation reports invalid output. */ }
          if (bindings && JSON.stringify(bindings) !== previous) {
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: '', bindings });
            previous = JSON.stringify(bindings);
          }
          await delay(250);
        }
      })();
      const execution = this.runner.runLifecyclePlan(spaceId, phase, steps, env, {
        runId, redactNames: Object.keys(secretValues), ...(workingDirectory ? { directory: workingDirectory } : {}),
        onOutput: async (output) => {
          const sanitized = this.sanitize(logPending + output, redactions);
          const retained = retainedLogCharacters;
          const safeLength = Math.max(0, sanitized.length - retained);
          logPending = sanitized.slice(safeLength);
          for (let offset = 0; offset < safeLength; offset += 16_000) {
            await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: sanitized.slice(offset, Math.min(safeLength, offset + 16_000)) });
          }
        },
      });
      result = await Promise.race([execution, monitor.then((): never => { throw new Error('Lifecycle binding monitor stopped unexpectedly'); })]);
    } catch (error) {
      failure = error;
      if (started && !result) {
        // A transport/logging error is not evidence that shell effects stopped.
        if (!this.runner.cancelLifecycleRun) throw new Error('Lifecycle outcome is uncertain; explicit runner recovery is required');
        await this.runner.cancelLifecycleRun(spaceId, terminalName, workingDirectory);
      }
    } finally {
      stopped = true;
      await monitor?.catch((error) => { failure ??= error; });
    }
    let bindings: Record<string, string> = {};
    try { bindings = await this.readBindings(directory, redactions); }
    catch (error) { failure ??= error; }
    const sanitize = (output: string) => this.sanitize(output, redactions);
    const finalLog = sanitize(logPending);
    for (let offset = 0; offset < finalLog.length; offset += 16_000) {
      await this.authority.mutateLifecycleState(current.projectId, spaceId, { op: 'append', runId, token, output: finalLog.slice(offset, offset + 16_000) });
    }
    const exitCode = failure ? 1 : result?.exitCode ?? 1;
    const output = sanitize([result?.output ?? '', failure ? failure instanceof Error ? failure.message : String(failure) : ''].filter(Boolean).join('\n'));
    const results = result?.steps.map((step) => ({ ...step, output: sanitize(step.output) })) ?? [];
    await this.authority.mutateLifecycleState(current.projectId, spaceId, {
      op: 'finish', runId, token, status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, results, output, bindings,
    });
    await rm(journal);
    await rm(directory, { recursive: true, force: true });
    if (exitCode !== 0) throw new Error(`${phase} failed with exit ${exitCode}: ${output.slice(-2_000)}`);
    return results.map((step) => ({ id: step.id, hash: planned.find((execution) => execution.id === step.id)!.hash, exitCode: step.exitCode, stdout: step.output, stderr: '' }));
  }

  private sanitize(output: string, secrets: readonly string[]): string {
    let sanitized = output;
    for (const secret of secrets) sanitized = sanitized.replaceAll(secret, '[redacted]');
    return sanitized.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$1[redacted]@')
      .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s&]+/giu, '$1[redacted]');
  }

  private async readBindings(directory: string, secrets: readonly string[]): Promise<Record<string, string>> {
    const source = await readFile(join(directory, 'output.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"bindings":{}}' : Promise.reject(error));
    if (source.length > 65_536) throw new Error('Lifecycle output exceeds 64 KiB');
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || !('bindings' in value) || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) throw new Error('Lifecycle output must be JSON {bindings:Record<string,string>}');
    const bindings = LifecycleBindingsSchema.parse(value.bindings);
    for (const [name, binding] of Object.entries(bindings)) {
      if (!/^secret:[A-Z][A-Z0-9_]*$/u.test(binding) && secrets.some((secret) => secret && binding.includes(secret))) throw new Error(`Lifecycle binding ${name} must use a secret:NAME reference, not a credential`);
    }
    return bindings;
  }
}
