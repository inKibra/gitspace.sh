import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import type { EnvironmentLifecycleAuthority, LifecycleMutation, LifecycleState } from '@gitspace/protocol';
import { WorkspaceEnvironmentManager, type EnvironmentLifecycleRunner } from '../src/workspace-environment.js';

const roots: string[] = [];
const databases: GitSpaceDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Ledger implements EnvironmentLifecycleAuthority {
  readonly bindingWritten = Promise.withResolvers<void>();
  readonly state: LifecycleState = {
    revision: 0, projectId: 'project-a', spaceId: 'workspace-a', bundleJson: null, selectedProfile: null,
    values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: false },
    bindings: {}, provisioned: null, destroyedAt: null, runs: [], claim: null, executions: [],
  };
  async getLifecycleState() { return structuredClone(this.state); }
  async getLifecycleRunLog(_projectId: string, _spaceId: string, runId: string) {
    return { output: this.state.runs.find((run) => run.id === runId)?.output ?? '', nextOffset: null };
  }
  async mutateLifecycleState(_projectId: string, _spaceId: string, input: LifecycleMutation) {
    const state = this.state;
    if (input.op === 'configure') { state.bundleJson = input.bundleJson; if (input.executions) state.executions = input.executions; }
    else if (input.op === 'policy') state.policy.automatic = input.automatic;
    else if (input.op === 'profile') state.selectedProfile = input.profile;
    else if (input.op === 'value') {
      if (input.value === null) delete state.values[input.scope][input.name];
      else state.values[input.scope][input.name] = input.value;
    } else if (input.op === 'claim') {
      const missing = input.executionHashes.some((hash) => !state.approvals.some((approval) => approval.executionHash === hash));
      state.claim = { runId: input.runId, status: missing ? 'blocked' : 'claimed', token: missing ? null : 'claim-token', reason: missing ? 'Execution approval required' : null };
      if (!missing) state.runs.unshift({
        id: input.runId, projectId: state.projectId, spaceId: state.spaceId, phase: input.phase,
        status: 'running', profile: input.profile, machineId: 'machine-a', generation: input.generation,
        executionHashes: input.executionHashes, terminalName: input.terminalName ?? null,
        results: [], output: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null,
      });
    } else if (input.op === 'append' || input.op === 'finish') {
      const run = state.runs.find((candidate) => candidate.id === input.runId)!;
      if (input.op === 'append') run.output += input.output;
      else {
        run.output = input.output; run.results = input.results; run.exitCode = input.exitCode;
        run.status = input.status; run.finishedAt = new Date().toISOString();
      }
      if (input.bindings) {
        Object.assign(state.bindings, input.bindings);
        if (input.bindings.resourceId) this.bindingWritten.resolve();
      }
    } else throw new Error(`Unsupported test mutation: ${input.op}`);
    state.revision += 1;
    return structuredClone(state);
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
  let materializations = 0;
  let beforeRun: (() => void) | undefined;
  const runner: EnvironmentLifecycleRunner = {
    async runLifecyclePlan(_spaceId, _phase, steps, env, options) {
      if (steps.some((step) => step.kind === 'script')) beforeRun?.();
      const results: Array<{ id: string; exitCode: number; output: string }> = [];
      for (const step of steps) {
        const child = Bun.spawn(['/bin/sh', '-c', `exec 2>&1\n${step.content ?? step.command}`], { cwd: options?.directory ?? checkout, env, stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        results.push({ id: step.id, exitCode, output });
        await options?.onOutput?.(output);
        if (exitCode !== 0) return { terminalName: 'runner', exitCode, output, steps: results };
      }
      return { terminalName: 'runner', exitCode: 0, output: results.map((result) => result.output).join(''), steps: results };
    },
  };
  const managerOptions: ConstructorParameters<typeof WorkspaceEnvironmentManager>[4] = { machineId: 'machine-a', stateRoot: join(root, 'runs') };
  const manager = new WorkspaceEnvironmentManager(database, {
    async listProjectSecrets() { return [{ name: 'TOKEN' }]; },
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
    expect(context.ledger.state.runs[0]!.output).toContain('[redacted]');
    expect(JSON.stringify(context.ledger.state)).not.toContain('private-provider-credential');
    expect(context.ledger.state.bindings).toEqual({ resourceId: 'db-123' });
  });

  it('keeps preparation failures advisory, excludes ambient credentials, and retains machine tool installs', async () => {
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

  it('reports legacy lifecycle migration instead of silently executing old hooks', async () => {
    const context = fixture('touch should-not-exist\n', 'setup');
    expect((await context.manager.view('workspace-a')).migrationRequired).toEqual(['setup']);
    await expect(context.manager.runPhase('workspace-a', 'cloud/provision')).rejects.toThrow('migration required');
    expect(existsSync(join(context.checkout, 'should-not-exist'))).toBeFalse();
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
