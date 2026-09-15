import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import { cloudWorkspaceDefinitionSchema, type CloudWorkspaceDefinition } from '@gitspace/protocol';
import { transitionLifecycle, type EnvironmentLifecycleAuthority, type LifecycleMutation, type LifecycleState, type LifecycleRunRecord } from '@gitspace/protocol-environment';
import { WorkspaceEnvironmentManager, type EnvironmentLifecycleRunner } from '../src/workspace-environment.js';

const roots: string[] = [];
const databases: GitSpaceDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Ledger implements EnvironmentLifecycleAuthority {
  readonly workspaces: CloudWorkspaceDefinition[] = [];
  async listProjectWorkspaces() { return structuredClone(this.workspaces); }
  readonly bindingWritten = Promise.withResolvers<void>();
  private readonly records = new Map<string, LifecycleRunRecord>();
  private readonly listeners = new Set<(state: LifecycleState) => void>();
  readonly state: LifecycleState = {
    revision: 0, projectId: 'project-a', spaceId: 'workspace-a', bundleJson: null, selectedProfile: null,
    values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: false },
    bindings: {}, provisioned: null, destroyedAt: null, runs: [], claim: null, executions: [],
  };
  async getLifecycleState() { return structuredClone(this.state); }
  async getLifecycleRunLog(_projectId: string, _spaceId: string, runId: string) {
    return { output: this.state.runs.find((run) => run.id === runId)?.output ?? '', nextOffset: null, cursor: 1 };
  }
  async mutateLifecycleState(_projectId: string, _spaceId: string, input: LifecycleMutation) {
    if (input.op === 'value' && input.scope === 'global') {
      if (input.value === null) delete this.state.values.global[input.name]; else this.state.values.global[input.name] = input.value;
      return structuredClone(this.state);
    }
    const transition = transitionLifecycle({ state: this.state, runs: [...this.records.values()], actor: { actorId: 'machine-a', machineId: 'machine-a', human: false }, now: new Date().toISOString(), token: crypto.randomUUID() }, input);
    if (transition.record) this.records.set(transition.record.run.id, transition.record);
    Object.assign(this.state, transition.state);
    if (this.state.bindings.resourceId) this.bindingWritten.resolve();
    for (const listener of this.listeners) listener(structuredClone(this.state));
    return structuredClone(this.state);
  }
  async watchLifecycleState(_projectId: string, _spaceId: string, onState: (state: LifecycleState) => void, signal: AbortSignal): Promise<void> {
    this.listeners.add(onState);
    try { await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); }
    finally { this.listeners.delete(onState); }
  }
}

function fixture(script: string, phase = 'cloud/provision') {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-'));
  roots.push(root);
  const checkout = join(root, 'checkout');
  const scriptPath = join(checkout, '.gitspace', 'lifecycle', phase, '01-main.sh');
  mkdirSync(join(checkout, '.gitspace', 'lifecycle', phase), { recursive: true });
  writeFileSync(scriptPath, script);
  writeFileSync(join(checkout, '.gitspace', 'bundle.json'), JSON.stringify({
    version: 1, defaultProfile: 'base', profiles: { base: { secrets: ['TOKEN'], values: ['GATE'] }, ios: {} },
    values: { GATE: { default: join(root, 'gate') } },
  }));
  const database = new GitSpaceDatabase(join(root, 'database.sqlite'));
  databases.push(database);
  const project = database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'base') });
  if (project.status === 'error') throw project.error;
  const workspace = database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'feature', rootPath: checkout });
  if (workspace.status === 'error') throw workspace.error;
  const possessed = database.possessWorkspace('workspace-a', 'machine-a');
  if (possessed.status === 'error') throw possessed.error;
  const ledger = new Ledger();
  ledger.workspaces.push(cloudWorkspaceDefinitionSchema.parse({
    id: 'workspace-a', projectId: 'project-a', kind: 'worktree', name: 'Workspace', branch: 'feature', phase: 'code',
    sourceKind: 'branch', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  let materializations = 0;
  let beforeRun: (() => void) | undefined;
  const runner: EnvironmentLifecycleRunner = {
    async runLifecyclePlan(_spaceId, _phase, steps, env, options) {
      await options?.onStarted?.();
      if (steps.some((step) => step.kind === 'script')) beforeRun?.();
      const results: Array<{ id: string; exitCode: number; output: string }> = [];
      for (const step of steps) {
        await options?.onOutput?.(`__GITSPACE_START__${Buffer.from(step.id).toString('base64url')}\n`);
        const child = Bun.spawn(['/bin/sh', '-c', `exec 2>&1\n${step.content ?? step.command}`], { cwd: options?.directory ?? checkout, env, stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        results.push({ id: step.id, exitCode, output });
        await options?.onOutput?.(output);
        await options?.onOutput?.(`__GITSPACE_END__${Buffer.from(step.id).toString('base64url')}:${exitCode}\n`);
        if (exitCode !== 0) return { terminalName: 'runner', exitCode, output, steps: results };
      }
      return { terminalName: 'runner', exitCode: 0, output: results.map((result) => result.output).join(''), steps: results };
    },
  };
  const managerOptions: ConstructorParameters<typeof WorkspaceEnvironmentManager>[4] = { machineId: 'machine-a', stateRoot: join(root, 'runs') };
  const manager = new WorkspaceEnvironmentManager(database, {
    async listEffectiveSecrets() { return [{ projectId: 'project-a', name: 'TOKEN', revision: 1, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'human-browser', source: 'project' }]; },
    async materializeProjectSecrets() { materializations += 1; return { TOKEN: 'private-provider-credential' }; },
  }, runner, ledger, managerOptions);
  return { root, checkout, scriptPath, database, ledger, manager, managerOptions, materializations: () => materializations, beforeRun: (callback: () => void) => { beforeRun = callback; } };
}

async function approveActive(manager: WorkspaceEnvironmentManager, ledger: Ledger) {
  ledger.state.approvals = (await manager.view('workspace-a')).executions.map((execution) => ({
    scope: 'workspace', executionHash: execution.hash, approvedBy: 'human-browser', approvedAt: new Date().toISOString(),
  }));
}

describe('WorkspaceEnvironmentManager', () => {
  it.each([false, true])('uses only recorded source provenance despite changed local HEAD and inherited overrides (legacy=%s)', async (legacy) => {
    const context = fixture('printf "%s" "$GITSPACE_WORKSPACE_SOURCE_COMMIT" > source-commit.txt\n', 'workspace/materialize');
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: context.checkout, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git('init', '-b', 'main');
    git('-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'source');
    const sourceCommit = git('rev-parse', 'HEAD');
    Object.assign(context.ledger.workspaces[0]!, { sourceKind: 'commit', sourceRef: sourceCommit, sourceCommit: legacy ? null : sourceCommit });
    git('switch', '-c', 'later-branch');
    git('-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'later work');
    expect(git('rev-parse', 'HEAD')).not.toBe(sourceCommit);
    await approveActive(context.manager, context.ledger);
    const inherited = process.env.GITSPACE_WORKSPACE_SOURCE_COMMIT;
    process.env.GITSPACE_WORKSPACE_SOURCE_COMMIT = 'spoofed-inherited-source';
    try {
      await context.manager.runPhase('workspace-a', 'workspace/materialize');
      expect(readFileSync(join(context.checkout, 'source-commit.txt'), 'utf8')).toBe(legacy ? '' : sourceCommit);
    } finally {
      if (inherited === undefined) delete process.env.GITSPACE_WORKSPACE_SOURCE_COMMIT;
      else process.env.GITSPACE_WORKSPACE_SOURCE_COMMIT = inherited;
    }
  });

  it.each(['values', 'secrets'] as const)('rejects declared %s that try to spoof reserved source provenance before running scripts', async (kind) => {
    const context = fixture('printf "%s" "$GITSPACE_WORKSPACE_SOURCE_COMMIT" > spoofed.txt\n');
    const name = 'GITSPACE_WORKSPACE_SOURCE_COMMIT';
    await context.manager.putBundle('workspace-a', {
      version: 1, profiles: { base: { [kind]: [name] } },
      ...(kind === 'values' ? { values: { [name]: { default: 'spoofed-declared-source' } } } : {}),
    });
    await approveActive(context.manager, context.ledger);
    await expect(context.manager.runPhase('workspace-a', 'cloud/provision')).rejects.toMatchObject({ code: 'InvalidConfiguration' });
    expect(existsSync(join(context.checkout, 'spoofed.txt'))).toBe(false);
    expect(context.materializations()).toBe(0);
  });


  it('resolves inherited profiles and scoped values while excluding scripts for other profiles', async () => {
    const context = fixture('printf "%s:%s" "$PORT" "$DEVICE"\n');
    await context.manager.putBundle('workspace-a', {
      version: 1, defaultProfile: 'base',
      profiles: { base: { values: ['PORT'] }, ios: { values: ['DEVICE'] }, linux: {} },
      values: { PORT: { default: '1000' }, DEVICE: {} },
    });
    const directory = join(context.checkout, '.gitspace', 'lifecycle', 'cloud', 'provision');
    writeFileSync(join(directory, '02-ios.ios.sh'), 'echo ios\n');
    writeFileSync(join(directory, '02-linux.linux.sh'), 'echo linux\n');
    await context.manager.putValue('workspace-a', 'global', 'PORT', '1500');
    await context.manager.putValue('workspace-a', 'project', 'PORT', '2000');
    await context.manager.putValue('workspace-a', 'workspace', 'PORT', '3000');
    await context.manager.putValue('workspace-a', 'workspace', 'DEVICE', 'simulator');
    await context.manager.setProfile('workspace-a', 'ios');
    const view = await context.manager.view('workspace-a');
    expect(view.effective.values).toEqual(['PORT', 'DEVICE']);
    expect(view.executions.map((execution) => execution.fileName)).toEqual(['01-main.sh', '02-ios.ios.sh']);
    await approveActive(context.manager, context.ledger);
    context.ledger.state.approvals.push({ ...context.ledger.state.approvals[0]!, scope: 'project' });
    expect((await context.manager.view('workspace-a')).executions[0]?.approval).toBe('project');
    expect((await context.manager.runPhase('workspace-a', 'cloud/provision')).map((result) => result.stdout.trim())).toEqual(['3000:simulator', 'ios']);
  });

  it('refuses unapproved content before secret materialization and executes frozen approved bytes', async () => {
    const context = fixture('echo approved > result.txt\n');
    await expect(context.manager.runPhase('workspace-a', 'cloud/provision')).rejects.toThrow('approval');
    expect(context.materializations()).toBe(0);
    await expect(context.manager.approve('workspace-a', 'workspace', 'anything')).rejects.toThrow('human browser');
    await approveActive(context.manager, context.ledger);
    context.beforeRun(() => writeFileSync(context.scriptPath, 'echo unapproved > result.txt\n'));
    await context.manager.runPhase('workspace-a', 'cloud/provision');
    expect(readFileSync(join(context.checkout, 'result.txt'), 'utf8')).toBe('approved\n');
    expect((await context.manager.view('workspace-a')).executions.find((execution) => execution.fileName === '01-main.sh')?.approval).toBeNull();
  });

  it('durably records partial resource bindings while the shell is still running, and preserves them on failure', async () => {
    const context = fixture(`printf '%s' '{"bindings":{"resourceId":"db-123"}}' > "$GITSPACE_LIFECYCLE_OUTPUT"\nwhile [ ! -f "$GATE" ]; do sleep 0.01; done\necho "$TOKEN"\nexit 7\n`);
    await approveActive(context.manager, context.ledger);
    const outcome = context.manager.runPhase('workspace-a', 'cloud/provision').then(() => null, (error: unknown) => error);
    await context.ledger.bindingWritten.promise;
    expect(context.ledger.state.bindings).toEqual({ resourceId: 'db-123' });
    expect(context.ledger.state.runs[0]?.status).toBe('running');
    writeFileSync(join(context.root, 'gate'), 'continue');
    expect(await outcome).toBeInstanceOf(Error);
    expect(context.ledger.state.runs[0]).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(JSON.stringify(context.ledger.state)).not.toContain('private-provider-credential');
    expect(context.ledger.state.bindings).toEqual({ resourceId: 'db-123' });
  });

  it('keeps preparation failures advisory, excludes daemon bootstrap credentials, and retains machine tool installs', async () => {
    const context = fixture('test -z "$GITSPACE_CONTROL_TOKEN" || exit 8\nprintf tool > "$GITSPACE_MACHINE_TOOLS/bin/tool"\necho failed >&2\nexit 7\n', 'machine/prepare');
    await approveActive(context.manager, context.ledger);
    context.ledger.state.policy.automatic = true;
    context.ledger.state.provisioned = { runId: 'previous-provision', profile: 'base', executionHashes: [], machineId: 'machine-b', completedAt: new Date().toISOString() };
    const previous = process.env.GITSPACE_CONTROL_TOKEN;
    process.env.GITSPACE_CONTROL_TOKEN = 'ambient-control-secret';
    try { await context.manager.prepare('workspace-a'); }
    finally { if (previous === undefined) delete process.env.GITSPACE_CONTROL_TOKEN; else process.env.GITSPACE_CONTROL_TOKEN = previous; }
    expect(context.database.getSpace('workspace-a')?.placementState).toBe('open');
    expect(context.ledger.state.runs[0]).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(readFileSync(join(context.root, 'runs', 'tools', 'bin', 'tool'), 'utf8')).toBe('tool');
  });

  it('uses user tools and home configuration while managed tools and declared inputs take precedence', async () => {
    const context = fixture(`set -eu
user-only-tool > inherited-tool.txt
preferred-tool > preferred-tool.txt
git config --global user.name > home-config.txt
test "$TOKEN" = private-provider-credential
test "$GATE" = "$DECLARED_GATE"
test "$HOME" != "\${GITSPACE_LIFECYCLE_OUTPUT%/*}"
printf '%s' "$GITSPACE_LIFECYCLE_OUTPUT" > run-output-path.txt
`, 'workspace/materialize');
    const home = join(context.root, 'user-home');
    const userBin = join(home, 'bin');
    const managedBin = join(context.root, 'runs', 'tools', 'bin');
    mkdirSync(userBin, { recursive: true });
    mkdirSync(managedBin, { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Machine User\n');
    writeFileSync(join(userBin, 'user-only-tool'), '#!/bin/sh\n[ "$INHERITED_CREDENTIAL" = machine-user-credential ] || exit 9\nprintf user-authenticated\n', { mode: 0o755 });
    writeFileSync(join(userBin, 'preferred-tool'), '#!/bin/sh\nprintf user-version\n', { mode: 0o755 });
    writeFileSync(join(managedBin, 'preferred-tool'), '#!/bin/sh\nprintf managed-version\n', { mode: 0o755 });
    await approveActive(context.manager, context.ledger);
    const overrides = {
      HOME: home, PATH: `${userBin}:/usr/bin:/bin`, TOKEN: 'ambient-overridden-token',
      GATE: 'ambient-overridden-value', DECLARED_GATE: join(context.root, 'gate'),
      INHERITED_CREDENTIAL: 'machine-user-credential', GIT_CONFIG_GLOBAL: undefined,
    };
    const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    try {
      await context.manager.runPhase('workspace-a', 'workspace/materialize');
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    expect(readFileSync(join(context.checkout, 'inherited-tool.txt'), 'utf8')).toBe('user-authenticated');
    expect(readFileSync(join(context.checkout, 'preferred-tool.txt'), 'utf8')).toBe('managed-version');
    expect(readFileSync(join(context.checkout, 'home-config.txt'), 'utf8')).toBe('Machine User\n');
    expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toBe('[user]\n  name = Machine User\n');
    expect(existsSync(readFileSync(join(context.checkout, 'run-output-path.txt'), 'utf8'))).toBeFalse();
  });


  it('retires from saved repository context after eviction without reopening or provisioning the workspace', async () => {
    const context = fixture('. ./saved-helper.sh\nretire_resource\n', 'cloud/destroy');
    const resource = join(context.root, 'external-resource');
    const accidentalProvision = join(context.root, 'must-not-provision');
    writeFileSync(resource, 'external');
    mkdirSync(join(context.checkout, '.gitspace', 'lifecycle', 'cloud', 'provision'), { recursive: true });
    writeFileSync(join(context.checkout, '.gitspace', 'lifecycle', 'cloud', 'provision', '01-create.sh'), `touch '${accidentalProvision}'`);
    await approveActive(context.manager, context.ledger);
    const saved = join(context.root, 'saved-repository');
    mkdirSync(saved);
    writeFileSync(join(saved, 'saved-helper.sh'), `retire_resource() { rm '${resource}'; }\n`);
    context.managerOptions.prepareRunner = async () => saved;
    expect(context.database.releaseWorkspacePossession({ workspaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 }).status).toBe('ok');
    rmSync(context.checkout, { recursive: true });
    await context.manager.runPhase('workspace-a', 'cloud/destroy');
    expect(existsSync(resource)).toBeFalse();
    expect(existsSync(accidentalProvision)).toBeFalse();
    expect(context.database.getSpace('workspace-a')?.placementState).toBe('closed');
    expect(existsSync(context.checkout)).toBeFalse();
  });
});
