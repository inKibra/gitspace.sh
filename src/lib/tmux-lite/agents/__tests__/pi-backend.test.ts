import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { PiBackend } from '../pi-backend.js';
import { PiCoordinator } from '../pi-coordinator.js';
import { getManagedPiBinDir, getManagedPiExtensionPaths, getPiAgentDir, setupPiEnvironment } from '../pi-runtime.js';
import { getManagedSessionBootstrap, getManagedSkillPaths, loadManagedDefaultSkills, mergeManagedSkills } from '../managed-defaults.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('pi-runtime', () => {
  it('getPiAgentDir is under gitspace/.pi', () => {
    const dir = getPiAgentDir();
    expect(dir).toContain('gitspace');
    expect(dir).toEndWith('.pi');
  });

  it('includes the managed GitSpace space command extension', () => {
    expect(getManagedPiExtensionPaths()).toEqual([expect.stringContaining('space-command.ts')]);
  });

  it('creates a managed space shim and prepends it to PATH', () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const tempHome = mkdtempSync(join(tmpdir(), 'pi-env-'));
    process.env.HOME = tempHome;
    process.env.PATH = '/usr/bin';

    try {
      const env = setupPiEnvironment({ workspaceId: 'test:ws' });
      const binDir = getManagedPiBinDir();
      const shimPath = join(binDir, 'space');

      expect(env.PI_CODING_AGENT_DIR).toBe(getPiAgentDir());
      expect(env.PATH.split(':')[0]).toBe(binDir);
      expect(existsSync(shimPath)).toBe(true);
      expect(readFileSync(shimPath, 'utf8')).toContain(' space "$@"');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it('disables context promotion by default in managed Pi config', () => {
    const originalGitspaceHome = process.env.GITSPACE_HOME;
    const tempRoot = mkdtempSync(join(tmpdir(), 'pi-context-promotion-'));
    process.env.GITSPACE_HOME = tempRoot;

    try {
      setupPiEnvironment({ workspaceId: 'test:ws' });
      const configPath = join(getPiAgentDir(), 'config.yml');

      expect(readFileSync(configPath, 'utf8')).toContain('enabled: false');
    } finally {
      if (originalGitspaceHome === undefined) {
        delete process.env.GITSPACE_HOME;
      } else {
        process.env.GITSPACE_HOME = originalGitspaceHome;
      }
    }
  });

  it('preserves an explicit managed Pi context promotion setting', () => {
    const originalGitspaceHome = process.env.GITSPACE_HOME;
    const tempRoot = mkdtempSync(join(tmpdir(), 'pi-context-promotion-explicit-'));
    process.env.GITSPACE_HOME = tempRoot;

    try {
      const agentDir = getPiAgentDir();
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'config.yml'), 'contextPromotion:\n  enabled: true\n');

      setupPiEnvironment({ workspaceId: 'test:ws' });

      expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toContain('enabled: true');
    } finally {
      if (originalGitspaceHome === undefined) {
        delete process.env.GITSPACE_HOME;
      } else {
        process.env.GITSPACE_HOME = originalGitspaceHome;
      }
    }
  });

  it('loads managed GitSpace default skills', async () => {
    const paths = getManagedSkillPaths();
    expect(paths).toHaveLength(5);
    expect(paths).toEqual([
      expect.stringContaining('space-review/SKILL.md'),
      expect.stringContaining('space-notes/SKILL.md'),
      expect.stringContaining('space-process-config/SKILL.md'),
      expect.stringContaining('space-run-process/SKILL.md'),
      expect.stringContaining('space-event-logs/SKILL.md'),
    ]);

    const skills = await loadManagedDefaultSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      'space-review',
      'space-notes',
      'space-process-config',
      'space-run-process',
      'space-event-logs',
    ]);
    expect(skills.every((skill) => skill.description.length > 0)).toBe(true);
  });

  it('merges managed skills over discovered skills by name', async () => {
    const managed = await loadManagedDefaultSkills();
    const merged = mergeManagedSkills([
      {
        name: 'space-review',
        description: 'User override that should lose',
        filePath: '/tmp/user-space-review/SKILL.md',
        baseDir: '/tmp/user-space-review',
        source: 'user:test',
      },
      {
        name: 'user-skill',
        description: 'User skill that should remain',
        filePath: '/tmp/user-skill/SKILL.md',
        baseDir: '/tmp/user-skill',
        source: 'user:test',
      },
    ], managed);

    expect(merged.find((skill) => skill.name === 'space-review')?.source).toBe('gitspace-managed:native');
    expect(merged.find((skill) => skill.name === 'user-skill')?.source).toBe('user:test');
  });

  it('builds managed session bootstrap from discovered and managed skills', async () => {
    const bootstrap = await getManagedSessionBootstrap('/tmp/workspace', '/tmp/agent', async () => ({
      skills: [{
        name: 'user-skill',
        description: 'User skill',
        filePath: '/tmp/user-skill/SKILL.md',
        baseDir: '/tmp/user-skill',
        source: 'user:test',
      }],
    }));

    expect(bootstrap.skills.some((skill) => skill.name === 'user-skill')).toBe(true);
    expect(bootstrap.skills.some((skill) => skill.name === 'space-event-logs')).toBe(true);
  });
});

describe('PiBackend', () => {
  it('detect always returns installed and running', async () => {
    const backend = new PiBackend();
    const status = await backend.detect({ workspaceId: 'test:ws' });
    expect(status.backendId).toBe('pi');
    expect(status.installed).toBe(true);
    expect(status.serverRunning).toBe(true);
  });

  it('ensureServer returns synthetic handle', async () => {
    const backend = new PiBackend();
    const handle = await backend.ensureServer({ workspaceId: 'test:ws' });
    expect(handle.backendId).toBe('pi');
    expect(handle.baseUrl).toBe('pi://in-process');
  });

  it('listSessions returns empty for fresh directory', async () => {
    const backend = new PiBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const sessions = await backend.listSessions({
      workspaceId: 'test:ws',
      workspacePath: tmpDir,
    });
    expect(sessions).toEqual([]);
  });

  it('resumeSession fails explicitly when the Pi session file is missing', async () => {
    const backend = new PiBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    await expect(
      backend.resumeSession({ workspaceId: 'test:ws', workspacePath: tmpDir }, 'missing-session'),
    ).rejects.toThrow('Pi session missing-session not found');
  });
});


describe('PiCoordinator', () => {
  it('refreshAgentSessions returns empty for fresh directory', async () => {
    const coordinator = new PiCoordinator();
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-coord-test-'));
    const sessions = await coordinator.refreshAgentSessions({
      workspaceId: 'test:ws',
      workspaceName: 'ws',
      workspacePath: tmpDir,
      projectName: 'test',
    });
    expect(sessions).toEqual([]);
  });

  it('ensureAgentTerminalSession fails explicitly when the Pi session file is missing', async () => {
    const coordinator = new PiCoordinator(join(tmpdir(), 'pi-missing-sessions'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-coord-test-'));
    await expect(
      coordinator.ensureAgentTerminalSession({
        workspaceId: 'test:ws',
        workspaceName: 'ws',
        workspacePath: tmpDir,
        projectName: 'test',
      }, 'missing-session'),
    ).rejects.toThrow("Pi session 'missing-session' not found");
  });
});
