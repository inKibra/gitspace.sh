import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import { WorkspaceEnvironmentManager, type EnvironmentLifecycleRunner } from '../src/workspace-environment.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestLifecycleRunner implements EnvironmentLifecycleRunner {
  readonly calls: Array<{ spaceId: string; phase: 'checks' | 'setup' | 'select' | 'remove'; env: Record<string, string> }> = [];

  async runLifecyclePlan(
    spaceId: string,
    phase: 'checks' | 'setup' | 'select' | 'remove',
    steps: ReadonlyArray<{ id: string; kind: 'check' | 'script'; command: string }>,
    env: Record<string, string>,
  ) {
    this.calls.push({ spaceId, phase, env });
    const results: Array<{ id: string; exitCode: number; output: string }> = [];
    for (const step of steps) {
      if (step.command.includes('03-fail.sh')) {
        results.push({ id: step.id, exitCode: 7, output: 'failed' });
        return { terminalName: `life-${phase}`, exitCode: 7, output: 'failed', steps: results };
      }
      if (step.kind === 'check' && (env.TOKEN !== 'secret' || env.MODE !== 'project')) {
        results.push({ id: step.id, exitCode: 1, output: 'missing environment' });
        return { terminalName: `life-${phase}`, exitCode: 1, output: 'missing environment', steps: results };
      }
      const output = step.command.includes('01-base.sh') ? 'shared' : step.command.includes('02-ios.ios.sh') ? 'ios' : '';
      results.push({ id: step.id, exitCode: 0, output });
    }
    return { terminalName: `life-${phase}`, exitCode: 0, output: results.map((result) => result.output).join('\n'), steps: results };
  }
}

function writeEnvironment(root: string, script: string): void {
  mkdirSync(join(root, '.gitspace', 'lifecycle', 'setup'), { recursive: true });
  writeFileSync(join(root, '.gitspace', 'bundle.json'), JSON.stringify({
    version: 1,
    defaultProfile: 'base',
    profiles: {
      base: { checks: ['bun'], values: ['PORT'] },
      ios: { checks: ['xcode'], values: ['DEVICE'] },
      linux: {},
    },
    checks: {
      bun: { kind: 'built-in', check: 'bun' },
      xcode: { kind: 'command', label: 'Xcode', command: 'xcodebuild -version' },
    },
    values: { PORT: { default: '3000' }, DEVICE: {} },
  }));
  writeFileSync(join(root, '.gitspace', 'lifecycle', 'setup', '01-base.sh'), script);
  writeFileSync(join(root, '.gitspace', 'lifecycle', 'setup', '02-ios.ios.sh'), 'echo ios\n');
  writeFileSync(join(root, '.gitspace', 'lifecycle', 'setup', '02-linux.linux.sh'), 'echo linux\n');
}

describe('WorkspaceEnvironmentManager', () => {
  it('resolves flat profiles, scoped values, exact scripts, and approval inheritance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-'));
    roots.push(root);
    const baseRoot = join(root, 'base');
    const workspaceRoot = join(root, 'workspace');
    writeEnvironment(baseRoot, 'echo shared\n');
    writeEnvironment(workspaceRoot, 'echo shared\n');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const project = database.createProject({ id: 'project-a', name: 'Project', repositoryPath: baseRoot });
    if (project.status === 'error') throw project.error;
    const base = database.getBaseSpace('project-a');
    if (!base) throw new Error('Base space was not created');
    const created = database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'feature', rootPath: workspaceRoot });
    if (created.status === 'error') throw created.error;
    const lifecycle = new TestLifecycleRunner();
    const manager = new WorkspaceEnvironmentManager(database, undefined, lifecycle);

    await manager.putValue('workspace-a', 'global', 'PORT', '1000');
    await manager.putValue('workspace-a', 'project', 'PORT', '2000');
    await manager.putValue('workspace-a', 'workspace', 'PORT', '3000');
    await manager.putValue('workspace-a', 'workspace', 'DEVICE', 'simulator');
    await manager.setProfile('workspace-a', 'ios');
    const selected = await manager.view('workspace-a');
    expect(selected.effective).toMatchObject({ name: 'ios', checks: ['bun', 'xcode'], values: ['PORT', 'DEVICE'] });
    expect(selected.values.effective).toEqual({ PORT: '3000', DEVICE: 'simulator' });
    expect(selected.executions.filter((item) => item.kind === 'script').map((item) => item.fileName)).toEqual(['01-base.sh', '02-ios.ios.sh']);
    for (const execution of selected.executions.filter((item) => item.kind === 'script')) await manager.approve('workspace-a', 'workspace', execution.hash);
    expect((await manager.runPhase('workspace-a', 'setup')).map((result) => result.stdout.trim())).toEqual(['shared', 'ios']);
    expect((await manager.view('workspace-a')).runs[0]).toMatchObject({ phase: 'setup', status: 'succeeded', terminalName: 'life-setup', exitCode: 0 });

    const sharedHash = selected.executions.find((item) => item.fileName === '01-base.sh')?.hash;
    if (!sharedHash) throw new Error('Shared script was not selected');
    await manager.approve(base.id, 'project', sharedHash);
    expect((await manager.view('workspace-a')).executions.find((item) => item.hash === sharedHash)?.approval).toBe('project');

    writeFileSync(join(workspaceRoot, '.gitspace', 'lifecycle', 'setup', '01-base.sh'), 'echo changed\n');
    const changed = await manager.view('workspace-a');
    const changedExecution = changed.executions.find((item) => item.fileName === '01-base.sh');
    expect(changedExecution?.approval).toBeNull();
    if (!changedExecution) throw new Error('Changed script was not selected');
    await manager.approve('workspace-a', 'workspace', changedExecution.hash);
    expect((await manager.view('workspace-a')).executions.find((item) => item.hash === changedExecution.hash)?.approval).toBe('workspace');
    expect((await manager.view(base.id)).executions.some((item) => item.approval === 'workspace')).toBeFalse();

    const marker = join(root, 'should-not-run');
    writeFileSync(join(workspaceRoot, '.gitspace', 'lifecycle', 'setup', '03-fail.sh'), 'echo failed >&2\nexit 7\n');
    writeFileSync(join(workspaceRoot, '.gitspace', 'lifecycle', 'setup', '04-after.sh'), `touch '${marker}'\n`);
    const withFailure = await manager.view('workspace-a');
    for (const execution of withFailure.executions.filter((item) => item.kind === 'script' && item.approval === null)) await manager.approve('workspace-a', 'workspace', execution.hash);
    await expect(manager.runPhase('workspace-a', 'setup')).rejects.toThrow('03-fail.sh failed with exit 7');
    expect(existsSync(marker)).toBeFalse();
    expect((await manager.view('workspace-a')).runs[0]).toMatchObject({ phase: 'setup', status: 'failed', terminalName: 'life-setup', exitCode: 7 });
  });

  it('gates checks before materializing profile-scoped secrets and values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-secrets-'));
    roots.push(root);
    mkdirSync(join(root, '.gitspace'), { recursive: true });
    writeFileSync(join(root, '.gitspace', 'bundle.json'), JSON.stringify({
      version: 1,
      defaultProfile: 'base',
      profiles: { base: { checks: ['credentials'], secrets: ['TOKEN'], values: ['MODE'] } },
      checks: { credentials: { kind: 'command', label: 'Credentials', command: 'test \"$TOKEN\" = secret && test \"$MODE\" = project' } },
      values: { MODE: { default: 'default' } },
    }));
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const project = database.createProject({ id: 'project-secrets', name: 'Project', repositoryPath: root });
    if (project.status === 'error') throw project.error;
    const base = database.getBaseSpace('project-secrets');
    if (!base) throw new Error('Base space was not created');
    database.putEnvironmentValue('project', 'project-secrets', 'MODE', 'project');
    let materializations = 0;
    const lifecycle = new TestLifecycleRunner();
    const manager = new WorkspaceEnvironmentManager(database, {
      listProjectSecrets: async () => [{ name: 'TOKEN' }],
      materializeProjectSecrets: async () => {
        materializations += 1;
        return { TOKEN: 'secret' };
      },
    }, lifecycle);
    const execution = (await manager.view(base.id)).executions[0];
    if (!execution) throw new Error('Credential check was not resolved');
    await expect(manager.runChecks(base.id)).rejects.toThrow('Execution approval required');
    expect(materializations).toBe(0);
    await manager.approve(base.id, 'project', execution.hash);
    expect(await manager.runChecks(base.id)).toEqual([{ id: 'credentials', hash: execution.hash, exitCode: 0, stdout: '', stderr: '' }]);
    expect(materializations).toBe(1);
    expect(lifecycle.calls[0]).toMatchObject({ spaceId: base.id, phase: 'checks', env: { TOKEN: 'secret', MODE: 'project' } });
    expect((await manager.view(base.id)).runs[0]).toMatchObject({ phase: 'checks', status: 'succeeded' });
  });
});
