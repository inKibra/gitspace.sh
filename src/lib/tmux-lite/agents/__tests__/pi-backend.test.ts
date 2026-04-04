import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { PiBackend } from '../pi-backend.js';
import { PiCoordinator } from '../pi-coordinator.js';
import { getManagedPiBinDir, getManagedPiExtensionPaths, getPiAgentDir, setupPiEnvironment } from '../pi-runtime.js';
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
