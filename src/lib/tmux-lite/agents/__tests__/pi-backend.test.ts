import { describe, it, expect } from 'bun:test';
import { PiBackend } from '../pi-backend.js';
import { PiCoordinator } from '../pi-coordinator.js';
import { getPiAgentDir } from '../pi-runtime.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('pi-runtime', () => {
  it('getPiAgentDir is under gitspace/.pi', () => {
    const dir = getPiAgentDir();
    expect(dir).toContain('gitspace');
    expect(dir).toEndWith('.pi');
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
