import { describe, it, expect } from 'bun:test';
import { PiCoordinator } from '../pi-coordinator.js';
import { listPiSessions, findPiSessionFile } from '../pi-session-files.js';
import { encodeSessionDirName } from '../pi-session-files.js';
import { getPiAgentDir } from '../pi-runtime.js';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Create a fake Pi session JSONL file for testing. */
function createFakeSession(sessionsRoot: string, cwd: string, id: string, firstMessage: string): string {
  const encoded = encodeSessionDirName(cwd);
  const dir = join(sessionsRoot, encoded);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filename = `2026-03-24T00-00-00-000Z_${id}.jsonl`;
  const filePath = join(dir, filename);
  const header = JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-03-24T00:00:00.000Z' });
  const userMsg = JSON.stringify({ type: 'message', id: 'msg1', parentId: id, timestamp: '2026-03-24T00:00:01.000Z', message: { role: 'user', content: firstMessage } });
  const assistantMsg = JSON.stringify({ type: 'message', id: 'msg2', parentId: 'msg1', timestamp: '2026-03-24T00:00:02.000Z', message: { role: 'assistant', content: 'Hello!' } });
  writeFileSync(filePath, [header, userMsg, assistantMsg].join('\n') + '\n');
  return filePath;
}

describe('pi-session-files', () => {
  it('getPiAgentDir points to managed dir under gitspace', () => {
    const dir = getPiAgentDir();
    expect(dir).toContain('gitspace');
    expect(dir).toEndWith('.pi');
  });

  it('listPiSessions returns empty for workspace with no sessions', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const sessions = listPiSessions(tmpDir);
    expect(sessions).toEqual([]);
  });

  it('listPiSessions finds sessions from JSONL files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });

    // Point session discovery at our temp sessions root
    const sessionsRoot = join(tmpDir, 'sessions');
    createFakeSession(sessionsRoot, cwd, 'test-session-1', 'hello world');
    createFakeSession(sessionsRoot, cwd, 'test-session-2', 'second session');

    const sessions = listPiSessions(cwd, sessionsRoot);
    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.id).sort()).toEqual(['test-session-1', 'test-session-2']);
    expect(sessions[0].messageCount).toBeGreaterThan(0);
  });

  it('findPiSessionFile finds a specific session by ID', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });

    const sessionsRoot = join(tmpDir, 'sessions');
    createFakeSession(sessionsRoot, cwd, 'find-me', 'test message');

    const found = findPiSessionFile(cwd, 'find-me', sessionsRoot);
    expect(found).not.toBeNull();
    expect(found!.id).toBe('find-me');
    expect(found!.firstMessage).toBe('test message');
  });

  it('findPiSessionFile returns null for unknown ID', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });

    const found = findPiSessionFile(cwd, 'nonexistent-id', join(tmpDir, 'sessions'));
    expect(found).toBeNull();
  });
});

describe('PiCoordinator session discovery', () => {
  it('refreshAgentSessions finds sessions from JSONL files', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-coord-test-'));
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });

    const sessionsRoot = join(tmpDir, 'sessions');
    createFakeSession(sessionsRoot, cwd, 'coord-test-1', 'coordinator test');

    const coordinator = new PiCoordinator(sessionsRoot);
    const sessions = await coordinator.refreshAgentSessions({
      workspaceId: 'test:ws',
      workspaceName: 'ws',
      workspacePath: cwd,
      projectName: 'test',
    });

    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('coord-test-1');
  });
});
