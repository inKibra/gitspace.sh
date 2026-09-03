import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EnvironmentApproval, EnvironmentApprovalScope, EnvironmentRun, EnvironmentValueScope, GitSpaceDatabase } from '@gitspace/core';
import {
  EnvironmentBundleSchema,
  executionHash,
  resolveEnvironmentProfile,
  resolveEnvironmentValues,
  resolveExecutionApproval,
  selectLifecycleScripts,
  type ApprovalSource,
  type EffectiveEnvironmentProfile,
  type EnvironmentBundle,
} from '@gitspace/protocol';
const BUILT_IN_CHECKS: Readonly<Record<string, string>> = {
  bun: 'bun --version',
  gh: 'gh --version',
  git: 'git --version',
  postgres: 'pg_isready',
  vercel: 'vercel whoami',
  node: 'node --version',
};
const PHASES = ['setup', 'select', 'remove'] as const;

export interface EnvironmentExecutionView {
  id: string;
  kind: 'check' | 'script';
  label: string;
  command: string;
  hash: string;
  approval: ApprovalSource | null;
  phase?: typeof PHASES[number];
  fileName?: string;
}

export interface EnvironmentExecutionResult {
  id: string;
  hash: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceEnvironmentView {
  spaceId: string;
  projectId: string;
  bundle: EnvironmentBundle;
  selectedProfile: string;
  effective: EffectiveEnvironmentProfile;
  values: {
    global: Readonly<Record<string, string>>;
    project: Readonly<Record<string, string>>;
    workspace: Readonly<Record<string, string>>;
    effective: Readonly<Record<string, string>>;
  };
  configuredSecrets: readonly string[];
  executions: readonly EnvironmentExecutionView[];
  runs: readonly EnvironmentRun[];
}

export interface EnvironmentSecretMaterializer {
  listProjectSecrets(projectId: string): Promise<Array<{ name: string }>>;
  materializeProjectSecrets(projectId: string, names: string[]): Promise<Record<string, string>>;
}

export interface EnvironmentLifecycleRunner {
  runLifecyclePlan(
    spaceId: string,
    phase: EnvironmentRun['phase'],
    steps: ReadonlyArray<{ id: string; kind: 'check' | 'script'; command: string }>,
    env: Record<string, string>,
  ): Promise<{ terminalName: string; exitCode: number; output: string; steps: ReadonlyArray<{ id: string; exitCode: number; output: string }> }>;
}
export class WorkspaceEnvironmentManager {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly secrets?: EnvironmentSecretMaterializer,
    private readonly lifecycle?: EnvironmentLifecycleRunner,
  ) {}

  async view(spaceId: string): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const bundle = await this.readBundle(space.rootPath);
    const selectedProfile = this.database.getEnvironmentProfile(spaceId) ?? bundle.defaultProfile;
    const effective = resolveEnvironmentProfile(bundle, selectedProfile);
    const globalValues = this.database.listEnvironmentValues('global', 'global');
    const projectValues = this.database.listEnvironmentValues('project', space.projectId);
    const defaults = Object.fromEntries(effective.values.flatMap((name) => bundle.values[name]?.default === undefined ? [] : [[name, bundle.values[name].default]]));
    const workspaceValues = space.kind === 'worktree' ? this.database.listEnvironmentValues('workspace', spaceId) : {};
    const approvals = this.database.listEnvironmentApprovals(space.projectId, space.kind === 'worktree' ? spaceId : undefined);
    const projectApprovals = new Set(approvals.filter((item) => item.scope === 'project').map((item) => item.executionHash));
    const resolvedValues = resolveEnvironmentValues({ global: { ...defaults, ...globalValues }, project: projectValues, workspace: workspaceValues });
    const effectiveValues = Object.fromEntries(effective.values.flatMap((name) => resolvedValues[name] === undefined ? [] : [[name, resolvedValues[name]]]));
    const configuredSecrets = this.secrets ? (await this.secrets.listProjectSecrets(space.projectId)).map((secret) => secret.name) : [];
    const runs = this.database.listEnvironmentRuns(spaceId);
    const workspaceApprovals = new Set(approvals.filter((item) => item.scope === 'workspace').map((item) => item.executionHash));
    const approval = (hash: string) => resolveExecutionApproval({ executionHash: hash, projectApprovals, workspaceApprovals });
    const checks = await Promise.all(effective.checks.map(async (id): Promise<EnvironmentExecutionView> => {
      const definition = bundle.checks[id]!;
      const command = definition.kind === 'built-in' ? BUILT_IN_CHECKS[definition.check] : definition.command;
      if (!command) throw new Error(`Unknown built-in environment check: ${definition.kind === 'built-in' ? definition.check : id}`);
      const hash = await executionHash({ kind: 'check', command });
      const label = definition.kind === 'built-in' ? definition.label ?? definition.check : definition.label;
      return { id, kind: 'check', label, command, hash, approval: approval(hash) };
    }));
    const scripts = (await Promise.all(PHASES.map(async (phase) => {
      const directory = join(space.rootPath, '.gitspace', 'lifecycle', phase);
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      return Promise.all(selectLifecycleScripts(names, selectedProfile, new Set(Object.keys(bundle.profiles))).map(async (script): Promise<EnvironmentExecutionView> => {
        const command = join(directory, script.fileName);
        const hash = await executionHash({ kind: 'script', command: await readFile(command, 'utf8') });
        return { id: `${phase}:${script.fileName}`, kind: 'script', label: script.fileName, command, hash, approval: approval(hash), phase, fileName: script.fileName };
      }));
    }))).flat();
    return {
      spaceId,
      projectId: space.projectId,
      bundle,
      configuredSecrets,
      selectedProfile,
      effective,
      values: { global: globalValues, project: projectValues, workspace: workspaceValues, effective: effectiveValues },
      executions: [...checks, ...scripts],
      runs,
    };
  }

  async putBundle(spaceId: string, source: unknown): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const bundle = EnvironmentBundleSchema.parse(source);
    const path = join(space.rootPath, '.gitspace', 'bundle.json');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    if (!bundle.profiles[this.database.getEnvironmentProfile(spaceId) ?? bundle.defaultProfile]) this.database.setEnvironmentProfile(spaceId, bundle.defaultProfile);
    return this.view(spaceId);
  }

  async setProfile(spaceId: string, profile: string): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const bundle = await this.readBundle(space.rootPath);
    if (!bundle.profiles[profile]) throw new Error(`Unknown environment profile: ${profile}`);
    this.database.setEnvironmentProfile(spaceId, profile);
    return this.view(spaceId);
  }

  async putValue(spaceId: string, scope: EnvironmentValueScope, name: string, value: string): Promise<WorkspaceEnvironmentView> {
    const ownerId = this.ownerId(spaceId, scope);
    this.database.putEnvironmentValue(scope, ownerId, name, value);
    return this.view(spaceId);
  }

  async deleteValue(spaceId: string, scope: EnvironmentValueScope, name: string): Promise<WorkspaceEnvironmentView> {
    this.database.deleteEnvironmentValue(scope, this.ownerId(spaceId, scope), name);
    return this.view(spaceId);
  }

  async approve(spaceId: string, scope: EnvironmentApprovalScope, executionHashValue: string): Promise<WorkspaceEnvironmentView> {
    const current = await this.view(spaceId);
    const execution = current.executions.find((item) => item.hash === executionHashValue);
    if (!execution) throw new Error(`Execution ${executionHashValue} is not active in space ${spaceId}`);
    const ownerId = scope === 'project' ? current.projectId : spaceId;
    const approval: Omit<EnvironmentApproval, 'approvedAt'> = { projectId: current.projectId, scope, ownerId, executionHash: execution.hash, kind: execution.kind, command: execution.command };
    this.database.putEnvironmentApproval(approval);
    return this.view(spaceId);
  }

  async runChecks(spaceId: string): Promise<readonly EnvironmentExecutionResult[]> {
    return this.runApproved(spaceId, (execution) => execution.kind === 'check');
  }

  async runPhase(spaceId: string, phase: 'setup' | 'select' | 'remove'): Promise<readonly EnvironmentExecutionResult[]> {
    return this.runApproved(spaceId, (execution) => execution.kind === 'script' && execution.phase === phase);
  }

  private async runApproved(spaceId: string, include: (execution: EnvironmentExecutionView) => boolean): Promise<readonly EnvironmentExecutionResult[]> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const current = await this.view(spaceId);
    const planned = current.executions.filter(include);
    if (planned.length === 0) return [];
    if (!this.lifecycle) throw new Error('Workspace Hub lifecycle execution is unavailable');
    const unapproved = planned.find((execution) => execution.approval === null);
    if (unapproved) throw new Error(`Execution approval required: ${unapproved.label} (${unapproved.hash})`);
    const secretValues = current.effective.secrets.length === 0
      ? {}
      : await this.secrets?.materializeProjectSecrets(current.projectId, [...current.effective.secrets]);
    if (current.effective.secrets.length > 0 && !secretValues) throw new Error('Project secret materialization is unavailable');
    const phase: EnvironmentRun['phase'] = planned[0]?.kind === 'check' ? 'checks' : planned[0]?.phase ?? 'checks';
    const run = this.database.startEnvironmentRun({
      id: crypto.randomUUID(),
      projectId: current.projectId,
      spaceId,
      phase,
      executionHashes: planned.map((execution) => execution.hash),
    });
    try {
      const result = await this.lifecycle.runLifecyclePlan(
        spaceId,
        phase,
        planned.map((execution) => ({ id: execution.id, kind: execution.kind, command: execution.command })),
        { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...current.values.effective, ...secretValues },
      );
      const status = result.exitCode === 0 ? 'succeeded' : 'failed';
      this.database.finishEnvironmentRun({ id: run.id, status, terminalName: result.terminalName, results: result.steps, output: result.output, exitCode: result.exitCode });
      const executionResults = result.steps.map((step) => ({ id: step.id, hash: planned.find((execution) => execution.id === step.id)?.hash ?? '', exitCode: step.exitCode, stdout: step.output, stderr: '' }));
      if (result.exitCode !== 0) {
        const failed = result.steps.find((step) => step.exitCode !== 0);
        throw new Error(`${failed?.id ?? phase} failed with exit ${result.exitCode}: ${failed?.output.trim() || result.output.trim()}`);
      }
      return executionResults;
    } catch (error) {
      const persisted = this.database.getEnvironmentRun(run.id);
      if (persisted?.status === 'running') {
        this.database.finishEnvironmentRun({ id: run.id, status: 'failed', terminalName: null, results: [], output: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
      throw error;
    }
  }

  async revokeApproval(spaceId: string, scope: EnvironmentApprovalScope, executionHashValue: string): Promise<WorkspaceEnvironmentView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    this.database.deleteEnvironmentApproval(scope, scope === 'project' ? space.projectId : spaceId, executionHashValue);
    return this.view(spaceId);
  }

  private ownerId(spaceId: string, scope: EnvironmentValueScope): string {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    if (scope === 'global') return 'global';
    if (scope === 'project') return space.projectId;
    if (space.kind !== 'worktree') throw new Error('Workspace values require a workspace scope');
    return spaceId;
  }

  private async readBundle(rootPath: string): Promise<EnvironmentBundle> {
    const path = join(rootPath, '.gitspace', 'bundle.json');
    const source = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (source === null) return EnvironmentBundleSchema.parse({ version: 1, defaultProfile: 'base', profiles: { base: {} } });
    return EnvironmentBundleSchema.parse(JSON.parse(source));
  }
}
