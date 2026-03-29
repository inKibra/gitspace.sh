import { describe, expect, it } from 'bun:test';
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  isBrowseMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type TmuxCommandRequest,
  type TmuxCommandResponse,
} from '../protocol.js';

describe('parseRemoteMessage', () => {
  it('parses tmux command messages', () => {
    const msg = parseRemoteMessage('{"type":"tmux_command","requestId":"req-1","command":{"type":"list"}}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('tmux_command');
  });

  it('returns null for invalid JSON', () => {
    expect(parseRemoteMessage('not json')).toBeNull();
  });
});

describe('serializeRemoteMessage', () => {
  it('serializes tmux command responses', () => {
    const msg: MachineToClientMessage = {
      type: 'tmux_command_response',
      requestId: 'req-1',
      response: { type: 'sessions', sessions: [] },
    };
    const json = serializeRemoteMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('tmux_command_response');
    expect(parsed.response.type).toBe('sessions');
  });
});

describe('round-trip serialization', () => {
  it('round-trips a TmuxCommandRequest', () => {
    const original: TmuxCommandRequest = {
      type: 'tmux_command',
      requestId: 'req-1',
      command: { type: 'service-start', workspaceId: 'project:feature-branch', processName: 'dev-server' },
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as TmuxCommandRequest;
    expect(parsed.type).toBe('tmux_command');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.command.type).toBe('service-start');
  });

  it('round-trips a TmuxCommandResponse', () => {
    const original: TmuxCommandResponse = {
      type: 'tmux_command_response',
      requestId: 'req-2',
      response: { type: 'service-stopped', workspaceId: 'project:workspace', processName: 'web' },
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as TmuxCommandResponse;
    expect(parsed.type).toBe('tmux_command_response');
    expect(parsed.requestId).toBe('req-2');
    expect(parsed.response.type).toBe('service-stopped');
  });

  it('round-trips an events tmux response', () => {
    const original: TmuxCommandResponse = {
      type: 'tmux_command_response',
      requestId: 'req-3',
      response: { type: 'events-list', workspaceId: 'my-workspace', events: [], liveEventIds: ['evt-1', 'evt-2'] },
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as TmuxCommandResponse;
    expect(parsed.type).toBe('tmux_command_response');
    expect(parsed.response.type).toBe('events-list');
  });
});

describe('isBrowseMessage', () => {
  it('returns true for attach_session', () => {
    expect(isBrowseMessage({ type: 'attach_session' })).toBe(true);
  });

  it('returns true for tmux_command', () => {
    expect(isBrowseMessage({ type: 'tmux_command', requestId: 'req-1', command: { type: 'list' } })).toBe(true);
  });

  it('returns false for response messages', () => {
    expect(isBrowseMessage({ type: 'tmux_command_response', requestId: 'req', response: { type: 'ok' } })).toBe(false);
  });
});

describe('message union coverage', () => {
  it('accepts current client messages', () => {
    const clientMessages: ClientToMachineMessage[] = [
      { type: 'attach_session' },
      { type: 'tmux_command', requestId: 'req-repos', command: { type: 'github-repos' } },
      { type: 'tmux_command', requestId: 'req-branches', command: { type: 'remote-branches', projectName: 'p1' } },
      { type: 'tmux_command', requestId: 'req-linear', command: { type: 'linear-issues', projectName: 'p1' } },
      { type: 'tmux_command', requestId: 'req-project-create', command: { type: 'project-create', repository: 'org/repo' } },
      { type: 'tmux_command', requestId: 'req-workspace-create', command: { type: 'workspace-create', projectName: 'p1', workspaceName: 'w1' } },
      { type: 'tmux_command', requestId: 'req-project-delete', command: { type: 'project-delete', projectName: 'p1' } },
      { type: 'delete_workspace', workspaceId: 'w1', projectName: 'p1' },
      { type: 'tmux_command', requestId: 'req-bundle-plan', command: { type: 'bundle-refresh-plan', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'tmux_command', requestId: 'req-bundle-apply', command: { type: 'bundle-refresh-apply', projectName: 'p1', workspaceId: 'w1', submission: { inputValues: {}, secretValues: {}, confirmResults: {} } } },
      { type: 'tmux_command', requestId: 'req-bundle-config-state', command: { type: 'bundle-config-state', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'tmux_command', requestId: 'req-bundle-config-apply', command: { type: 'bundle-config-apply', projectName: 'p1', workspaceId: 'w1', submission: { inputValues: {}, secretValues: {}, confirmResults: {} } } },
      { type: 'tmux_command', requestId: 'req-set-phase', command: { type: 'workspace-set-phase', projectName: 'p1', workspaceName: 'w1', phase: 'code' } },
      { type: 'tmux_command', requestId: 'req-kill', command: { type: 'kill', id: 's1' } },
      { type: 'tmux_command', requestId: 'req-inbox', command: { type: 'inbox' } },
      { type: 'tmux_command', requestId: 'req-inbox-clear', command: { type: 'inbox-clear', id: 'i1' } },
      { type: 'tmux_command', requestId: 'req-inbox-read', command: { type: 'inbox-read', id: 'i1' } },
      { type: 'tmux_command', requestId: 'req-notify-get', command: { type: 'notification-config-get' } },
      { type: 'tmux_command', requestId: 'req-notify-update', command: { type: 'notification-config-update', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } } },
      { type: 'tmux_command', requestId: 'req-events', command: { type: 'events-request', workspacePath: '/tmp' } },
      { type: 'tmux_command', requestId: 'req-6', command: { type: 'service-start', workspaceId: 'w1', processName: 'web' } },
      { type: 'tmux_command', requestId: 'req-agent-list', command: { type: 'agent-sessions', target: { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' }, mode: 'live' } },
      { type: 'tmux_command', requestId: 'req-agent-create', command: { type: 'agent-create', target: { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' }, title: 'Investigate auth' } },
      { type: 'tmux_command', requestId: 'req-agent-abort', command: { type: 'agent-abort', target: { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' }, agentSessionId: 'agent-1' } },
      { type: 'tmux_command', requestId: 'req-agent-permission', command: { type: 'agent-permission', target: { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' }, agentSessionId: 'agent-1', permissionId: 'perm-1', response: 'allow' } },
      { type: 'get_replay_frame', requestId: 'req-5', replayId: 'r1', atMs: 1000 },
    ];
    expect(clientMessages).toHaveLength(26);
  });

  it('accepts current machine messages', () => {
    const machineMessages: MachineToClientMessage[] = [
      { type: 'detached' },
      { type: 'session_exited', sessionId: 's1', exitCode: 0 },
      { type: 'error', code: 'TEST', message: 'test error' },
      { type: 'tmux_command_response', requestId: 'req-repos', response: { type: 'github-repos', repos: [] } },
      { type: 'tmux_command_response', requestId: 'req-branches', response: { type: 'remote-branches', projectName: 'p1', branches: ['main'] } },
      { type: 'tmux_command_response', requestId: 'req-linear', response: { type: 'linear-issues', projectName: 'p1', issues: [] } },
      { type: 'tmux_command_response', requestId: 'req-project-create', response: { type: 'project-created', projectName: 'p1', repository: 'org/repo', baseBranch: 'main' } },
      { type: 'tmux_command_response', requestId: 'req-workspace-create', response: { type: 'workspace-created', projectName: 'p1', workspaceId: 'p1:w1', workspaceName: 'w1', branchName: 'w1' } },
      { type: 'tmux_command_response', requestId: 'req-project-delete', response: { type: 'project-deleted', projectName: 'p1' } },
      { type: 'workspace_deleted', workspaceId: 'w1' },
      { type: 'script_output', phase: 'setup', data: '' },
      { type: 'tmux_command_response', requestId: 'req-bundle-plan', response: { type: 'bundle-refresh-plan', plan: { projectName: 'p1', workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp', hasBundle: false, hasChanged: false, details: '', steps: [], autoConfirmResults: {} } } },
      { type: 'tmux_command_response', requestId: 'req-bundle-apply', response: { type: 'bundle-refresh-applied', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'tmux_command_response', requestId: 'req-bundle-config-state', response: { type: 'bundle-config-state', state: { projectName: 'p1', workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp', hasBundle: false, details: '', steps: [] } } },
      { type: 'tmux_command_response', requestId: 'req-bundle-config-apply', response: { type: 'bundle-config-applied', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'tmux_command_response', requestId: 'req-set-phase', response: { type: 'ok' } },
      { type: 'tmux_command_response', requestId: 'req-kill', response: { type: 'ok' } },
      { type: 'tmux_command_response', requestId: 'req-inbox', response: { type: 'inbox', items: [] } },
      { type: 'tmux_command_response', requestId: 'req-inbox-clear', response: { type: 'ok' } },
      { type: 'tmux_command_response', requestId: 'req-inbox-read', response: { type: 'ok' } },
      { type: 'tmux_command_response', requestId: 'req-notify-get', response: { type: 'notification-config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } } },
      { type: 'tmux_command_response', requestId: 'req-notify-update', response: { type: 'notification-config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } } },
      { type: 'tmux_command_response', requestId: 'req-events', response: { type: 'events-list', workspaceId: 'w1', events: [], liveEventIds: [] } },
      { type: 'tmux_command_response', requestId: 'req-4', response: { type: 'service-started', workspaceId: 'w1', processName: 'web', sessionId: 'sess-1', sessionIds: ['sess-1'] } },
      { type: 'agent_state_snapshot', workspaces: [] },
      { type: 'agent_state_update', delta: { type: 'agent_state_snapshot', workspaces: {} } },
      { type: 'replay_frame', requestId: 'req-3', replayId: 'r1', frame: { replayId: 'r1', checkpoint: null, events: [] }, chunkIndex: 0, totalChunks: 1 },
    ];
    expect(machineMessages).toHaveLength(27);
  });
});
