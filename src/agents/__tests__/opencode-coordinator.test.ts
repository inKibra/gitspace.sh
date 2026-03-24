/**
 * Unit tests for opencode-coordinator pure helpers.
 *
 * We test the extracted pure functions without spinning up any real
 * tmux-lite server, OpenCode binary, or file-system dependencies.
 */

import { describe, it, expect } from 'bun:test';
import { buildOpenCodeAttachArgs, mergeCreatedAgentSession } from '../opencode-coordinator.js';

describe('buildOpenCodeAttachArgs', () => {
  const runtime = { hostname: '127.0.0.1', port: 41234 };
  const agentSessionId = 'sess-abc123';
  const workspacePath = '/home/user/gitspace/myproject/workspaces/my-feature';

  it('starts with the attach subcommand', () => {
    const args = buildOpenCodeAttachArgs(runtime, agentSessionId, workspacePath);
    expect(args[0]).toBe('attach');
  });

  it('includes the server URL', () => {
    const args = buildOpenCodeAttachArgs(runtime, agentSessionId, workspacePath);
    expect(args).toContain('http://127.0.0.1:41234');
  });

  it('includes --session followed by the agentSessionId', () => {
    const args = buildOpenCodeAttachArgs(runtime, agentSessionId, workspacePath);
    const sessionIdx = args.indexOf('--session');
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(args[sessionIdx + 1]).toBe(agentSessionId);
  });

  it('includes --dir followed by the workspace path', () => {
    const args = buildOpenCodeAttachArgs(runtime, agentSessionId, workspacePath);
    const dirIdx = args.indexOf('--dir');
    expect(dirIdx).toBeGreaterThan(-1);
    expect(args[dirIdx + 1]).toBe(workspacePath);
  });

  it('uses the workspace path as the --dir value, not the runtime hostname', () => {
    const otherPath = '/home/user/gitspace/otherproject/workspaces/other-branch';
    const args = buildOpenCodeAttachArgs(runtime, agentSessionId, otherPath);
    const dirIdx = args.indexOf('--dir');
    expect(args[dirIdx + 1]).toBe(otherPath);
    expect(args[dirIdx + 1]).not.toContain('127.0.0.1');
  });

  it('encodes the port correctly in the URL', () => {
    const args = buildOpenCodeAttachArgs({ hostname: 'localhost', port: 9999 }, agentSessionId, workspacePath);
    expect(args).toContain('http://localhost:9999');
  });
});

describe('mergeCreatedAgentSession', () => {
  it('prepends the created session when the refresh result is stale', () => {
    const merged = mergeCreatedAgentSession(
      [{ id: 'existing', workspaceId: 'demo:ws', title: 'Existing', updatedAt: '2026-03-20T10:00:00.000Z' }],
      { id: 'created', workspaceId: 'demo:ws', title: 'Investigate auth bug', updatedAt: '2026-03-20T11:00:00.000Z' },
    );

    expect(merged.map((session) => session.id)).toEqual(['created', 'existing']);
    expect(merged[0]?.title).toBe('Investigate auth bug');
  });

  it('preserves the created title when the refresh result omits it', () => {
    const merged = mergeCreatedAgentSession(
      [{ id: 'created', workspaceId: 'demo:ws', title: 'Untitled agent session', updatedAt: undefined }],
      { id: 'created', workspaceId: 'demo:ws', title: 'Investigate auth bug', updatedAt: '2026-03-20T11:00:00.000Z' },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('Investigate auth bug');
    expect(merged[0]?.updatedAt).toBe('2026-03-20T11:00:00.000Z');
  });
});
