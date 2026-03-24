import { describe, it, expect } from 'bun:test';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { PiBackend } from '../pi-backend.js';
import { PiCoordinator } from '../pi-coordinator.js';
import { setupPiEnvironment, getPiAgentDir } from '../pi-runtime.js';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('pi-runtime', () => {
  it('setupPiEnvironment returns PI_CODING_AGENT_DIR', () => {
    const env = setupPiEnvironment({ workspaceId: 'test:ws' });
    expect(env.PI_CODING_AGENT_DIR).toBeDefined();
    expect(env.PI_CODING_AGENT_DIR).toContain('.pi');
    expect(existsSync(env.PI_CODING_AGENT_DIR)).toBe(true);
  });

  it('getPiAgentDir is under gitspace', () => {
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

  it('SessionManager.list works with Pi SDK', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const sessions = await SessionManager.list(tmpDir);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
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
});
