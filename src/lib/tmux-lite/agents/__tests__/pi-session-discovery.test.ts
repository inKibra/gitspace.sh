import { describe, it, expect } from 'bun:test';
import { PiCoordinator } from '../pi-coordinator.js';
import { listPiSessions, findPiSessionFile } from '../pi-session-files.js';
import { encodeSessionDirName } from '../pi-session-files.js';
import { join } from 'node:path';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('listPiSessions returns empty for workspace with no sessions', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const sessions = listPiSessions(tmpDir);
    expect(sessions).toEqual([]);
  });

  it('finds symlinked working dirs with canonical session encoding', () => {
    if (process.platform === 'win32') {
      return;
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const cwd = join(tmpDir, 'real-workspace');
    const symlinkedCwd = join(tmpDir, 'symlink-workspace');
    mkdirSync(cwd, { recursive: true });
    symlinkSync(cwd, symlinkedCwd, 'dir');

    const sessionsRoot = join(tmpDir, 'sessions');
    createFakeSession(sessionsRoot, symlinkedCwd, 'symlink-session', 'hello from symlink');

    const sessions = listPiSessions(cwd, sessionsRoot);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('symlink-session');
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

  it('discovers sessions whose header is preceded by a leading title record', () => {
    // Newer omp session files prepend a padded, in-place-updatable `title`
    // record, so the `session` header is on line 2. Sessions must still be
    // discovered (otherwise they vanish from the sidebar), and the leading
    // title (freshest) should win over the header's original title.
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const sessionsRoot = join(tmpDir, 'sessions');
    const dir = join(sessionsRoot, encodeSessionDirName(cwd));
    mkdirSync(dir, { recursive: true });

    const titleRecord = JSON.stringify({ type: 'title', v: 1, title: 'Fresh Title', source: 'auto', updatedAt: '2026-07-04T00:00:00.000Z', pad: ' '.repeat(50) });
    const header = JSON.stringify({ type: 'session', version: 3, id: 'title-first', cwd, title: 'Old Title', timestamp: '2026-03-24T00:00:00.000Z' });
    const userMsg = JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' } });
    writeFileSync(join(dir, '2026-03-24T00-00-00-000Z_title-first.jsonl'), [titleRecord, header, userMsg].join('\n') + '\n');

    const sessions = listPiSessions(cwd, sessionsRoot);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('title-first');
    expect(sessions[0].title).toBe('Fresh Title');
    expect(sessions[0].messageCount).toBe(1);
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
  it('tracks PTY ownership independently when one PTY forks to a new session', () => {
    const coordinator = new PiCoordinator();
    coordinator.rebindTerminalSession('test:ws', 'pty-a', 'agent-old');
    coordinator.rebindTerminalSession('test:ws', 'pty-b', 'agent-old');

    const reassignment = coordinator.rebindTerminalSession('test:ws', 'pty-b', 'agent-new');

    expect(reassignment.previousAgentSessionId).toBe('agent-old');
    expect(reassignment.previousOwnerCount).toBe(1);
    expect(coordinator.getTerminalBinding('pty-a')).toEqual({ workspaceId: 'test:ws', agentSessionId: 'agent-old' });
    expect(coordinator.getTerminalBinding('pty-b')).toEqual({ workspaceId: 'test:ws', agentSessionId: 'agent-new' });
    expect(coordinator.hasTerminalOwners('test:ws', 'agent-old')).toBe(true);
    expect(coordinator.hasTerminalOwners('test:ws', 'agent-new')).toBe(true);
  });

  it('reports zero previous owners when the last PTY leaves a session', () => {
    const coordinator = new PiCoordinator();
    coordinator.rebindTerminalSession('test:ws', 'pty-a', 'agent-old');

    const reassignment = coordinator.rebindTerminalSession('test:ws', 'pty-a', 'agent-new');

    expect(reassignment.previousAgentSessionId).toBe('agent-old');
    expect(reassignment.previousOwnerCount).toBe(0);
    expect(coordinator.hasTerminalOwners('test:ws', 'agent-old')).toBe(false);
    expect(coordinator.getTerminalBinding('pty-a')).toEqual({ workspaceId: 'test:ws', agentSessionId: 'agent-new' });
  });

});
