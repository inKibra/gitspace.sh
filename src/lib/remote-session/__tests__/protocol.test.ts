import { describe, expect, it } from 'bun:test';
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  isBrowseMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type CommandResponse,
  type StartProcessRequest,
} from '../protocol.js';

describe('parseRemoteMessage', () => {
  it('parses explicit command messages', () => {
    const msg = parseRemoteMessage('{"type":"start_process","requestId":"req-1","workspaceId":"w1","processName":"web"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('start_process');
  });

  it('returns null for invalid JSON', () => {
    expect(parseRemoteMessage('not json')).toBeNull();
  });
});

describe('serializeRemoteMessage', () => {
  it('serializes command responses', () => {
    const msg: MachineToClientMessage = {
      type: 'command_response',
      requestId: 'req-1',
      response: { type: 'sessions', sessions: [] },
    };
    const json = serializeRemoteMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('command_response');
    expect(parsed.response.type).toBe('sessions');
  });
});

describe('round-trip serialization', () => {
  it('round-trips a StartProcessRequest', () => {
    const original: StartProcessRequest = {
      type: 'start_process',
      requestId: 'req-1',
      workspaceId: 'project:feature-branch',
      processName: 'dev-server',
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as StartProcessRequest;
    expect(parsed.type).toBe('start_process');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.processName).toBe('dev-server');
  });

  it('round-trips a CommandResponse', () => {
    const original: CommandResponse = {
      type: 'command_response',
      requestId: 'req-2',
      response: { type: 'service-stopped', workspaceId: 'project:workspace', processName: 'web' },
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as CommandResponse;
    expect(parsed.type).toBe('command_response');
    expect(parsed.requestId).toBe('req-2');
    expect(parsed.response.type).toBe('service-stopped');
  });

  it('round-trips an events command response', () => {
    const original: CommandResponse = {
      type: 'command_response',
      requestId: 'req-3',
      response: { type: 'events-list', workspaceId: 'my-workspace', events: [], liveEventIds: ['evt-1', 'evt-2'] },
    };
    const parsed = parseRemoteMessage(serializeRemoteMessage(original)) as CommandResponse;
    expect(parsed.type).toBe('command_response');
    expect(parsed.response.type).toBe('events-list');
  });
});

describe('isBrowseMessage', () => {
  it('returns true for attach_session', () => {
    expect(isBrowseMessage({ type: 'attach_session' } as ClientToMachineMessage)).toBe(true);
  });

  it('returns true for explicit commands', () => {
    expect(isBrowseMessage({ type: 'start_process', requestId: 'req-1', workspaceId: 'w1', processName: 'web' } as ClientToMachineMessage)).toBe(true);
    expect(isBrowseMessage({ type: 'list_github_repos', requestId: 'req-2' } as ClientToMachineMessage)).toBe(true);
    expect(isBrowseMessage({ type: 'create_agent_session', requestId: 'req-3', target: { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' } } as ClientToMachineMessage)).toBe(true);
  });

  it('returns false for response messages', () => {
    expect(isBrowseMessage({ type: 'command_response', requestId: 'req', response: { type: 'ok' } } as MachineToClientMessage)).toBe(false);
  });
});

const AGENT_TARGET = { workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp/w1', projectName: 'p1' };

describe('message union coverage', () => {
  it('accepts current client messages', () => {
    const clientMessages: ClientToMachineMessage[] = [
      { type: 'attach_session', streamId: 2, cols: 80, rows: 24 },
      { type: 'list_github_repos', requestId: 'req-repos' },
      { type: 'list_remote_branches', requestId: 'req-branches', projectName: 'p1' },
      { type: 'list_linear_issues', requestId: 'req-linear', projectName: 'p1' },
      { type: 'create_project', requestId: 'req-project-create', repository: 'org/repo' },
      { type: 'create_workspace', requestId: 'req-workspace-create', projectName: 'p1', workspaceName: 'w1' },
      { type: 'delete_project', requestId: 'req-project-delete', projectName: 'p1' },
      { type: 'delete_workspace', workspaceId: 'w1', projectName: 'p1' },
      { type: 'get_bundle_refresh_plan', requestId: 'req-bundle-plan', projectName: 'p1', workspaceId: 'w1' },
      { type: 'apply_bundle_refresh', requestId: 'req-bundle-apply', projectName: 'p1', workspaceId: 'w1', submission: { inputValues: {}, secretValues: {}, confirmResults: {} } },
      { type: 'get_bundle_config_state', requestId: 'req-bundle-config-state', projectName: 'p1', workspaceId: 'w1' },
      { type: 'apply_bundle_config', requestId: 'req-bundle-config-apply', projectName: 'p1', workspaceId: 'w1', submission: { inputValues: {}, secretValues: {}, confirmResults: {} } },
      { type: 'set_workspace_phase', requestId: 'req-set-phase', projectName: 'p1', workspaceName: 'w1', phase: 'code' },
      { type: 'kill_session', requestId: 'req-kill', sessionId: 's1' },
      { type: 'get_inbox', requestId: 'req-inbox' },
      { type: 'clear_inbox', requestId: 'req-inbox-clear', id: 'i1' },
      { type: 'mark_inbox_read', requestId: 'req-inbox-read', id: 'i1' },
      { type: 'get_notification_config', requestId: 'req-notify-get' },
      { type: 'update_notification_config', requestId: 'req-notify-update', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } },
      { type: 'request_events', requestId: 'req-events', workspacePath: '/tmp' },
      { type: 'start_process', requestId: 'req-6', workspaceId: 'w1', processName: 'web' },
      { type: 'list_agent_sessions', requestId: 'req-agent-list', target: AGENT_TARGET, mode: 'live' },
      { type: 'create_agent_session', requestId: 'req-agent-create', target: AGENT_TARGET, title: 'Investigate auth' },
      { type: 'abort_agent_session', requestId: 'req-agent-abort', target: AGENT_TARGET, agentSessionId: 'agent-1' },
      { type: 'respond_agent_permission', requestId: 'req-agent-permission', target: AGENT_TARGET, agentSessionId: 'agent-1', permissionId: 'perm-1', response: 'allow' },
      { type: 'get_replay_frame', requestId: 'req-5', replayId: 'r1', atMs: 1000 },
    ];
    expect(clientMessages).toHaveLength(26);
  });

  it('accepts current machine messages', () => {
    const machineMessages: MachineToClientMessage[] = [
      { type: 'attached', streamId: 2, sessionId: 's1', sessionName: 'shell' },
      { type: 'detached', streamId: 2 },
      { type: 'session_exited', sessionId: 's1', streamId: 2, exitCode: 0 },
      { type: 'error', code: 'TEST', message: 'test error' },
      { type: 'command_response', requestId: 'req-repos', response: { type: 'github-repos', repos: [] } },
      { type: 'command_response', requestId: 'req-branches', response: { type: 'remote-branches', projectName: 'p1', branches: ['main'] } },
      { type: 'command_response', requestId: 'req-linear', response: { type: 'linear-issues', projectName: 'p1', issues: [] } },
      { type: 'command_response', requestId: 'req-project-create', response: { type: 'project-created', projectName: 'p1', repository: 'org/repo', baseBranch: 'main' } },
      { type: 'command_response', requestId: 'req-workspace-create', response: { type: 'workspace-created', projectName: 'p1', workspaceId: 'p1:w1', workspaceName: 'w1', branchName: 'w1' } },
      { type: 'command_response', requestId: 'req-project-delete', response: { type: 'project-deleted', projectName: 'p1' } },
      { type: 'workspace_deleted', workspaceId: 'w1' },
      { type: 'script_output', phase: 'setup', data: '' },
      { type: 'command_response', requestId: 'req-bundle-plan', response: { type: 'bundle-refresh-plan', plan: { projectName: 'p1', workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp', hasBundle: false, hasChanged: false, details: '', steps: [], autoConfirmResults: {} } } },
      { type: 'command_response', requestId: 'req-bundle-apply', response: { type: 'bundle-refresh-applied', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'command_response', requestId: 'req-bundle-config-state', response: { type: 'bundle-config-state', state: { projectName: 'p1', workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp', hasBundle: false, details: '', steps: [] } } },
      { type: 'command_response', requestId: 'req-bundle-config-apply', response: { type: 'bundle-config-applied', projectName: 'p1', workspaceId: 'w1' } },
      { type: 'command_response', requestId: 'req-set-phase', response: { type: 'ok' } },
      { type: 'command_response', requestId: 'req-kill', response: { type: 'ok' } },
      { type: 'command_response', requestId: 'req-inbox', response: { type: 'inbox', items: [] } },
      { type: 'command_response', requestId: 'req-inbox-clear', response: { type: 'ok' } },
      { type: 'command_response', requestId: 'req-inbox-read', response: { type: 'ok' } },
      { type: 'command_response', requestId: 'req-notify-get', response: { type: 'notification-config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } } },
      { type: 'command_response', requestId: 'req-notify-update', response: { type: 'notification-config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } } },
      { type: 'command_response', requestId: 'req-events', response: { type: 'events-list', workspaceId: 'w1', events: [], liveEventIds: [] } },
      { type: 'command_response', requestId: 'req-4', response: { type: 'service-started', workspaceId: 'w1', processName: 'web', sessionId: 'sess-1', sessionIds: ['sess-1'] } },
      { type: 'agent_state_snapshot', workspaces: [] },
      { type: 'agent_state_update', delta: { type: 'agent_state_snapshot', workspaces: {} } },
      { type: 'replay_frame', requestId: 'req-3', replayId: 'r1', frame: { replayId: 'r1', checkpoint: null, events: [] }, chunkIndex: 0, totalChunks: 1 },
    ];
    expect(machineMessages).toHaveLength(28);
  });
});
