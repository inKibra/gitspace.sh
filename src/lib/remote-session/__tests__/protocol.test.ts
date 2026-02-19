/**
 * Remote session protocol tests - serialization, parsing, message type coverage
 */

import { describe, expect, it } from 'bun:test';
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  isBrowseMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type GetEventsRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type EventsListResponse,
  type ProcessStartedResponse,
  type ProcessStoppedResponse,
} from '../protocol.js';

// ============================================================================
// parseRemoteMessage
// ============================================================================

describe('parseRemoteMessage', () => {
  it('should parse valid JSON with type field', () => {
    const msg = parseRemoteMessage('{"type":"list_workspaces"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('list_workspaces');
  });

  it('should return null for invalid JSON', () => {
    expect(parseRemoteMessage('not json')).toBeNull();
  });

  it('should return null for JSON without type field', () => {
    expect(parseRemoteMessage('{"foo":"bar"}')).toBeNull();
  });

  it('should return null for null type', () => {
    expect(parseRemoteMessage('{"type":null}')).toBeNull();
  });

  it('should return null for numeric type', () => {
    expect(parseRemoteMessage('{"type":123}')).toBeNull();
  });
});

// ============================================================================
// serializeRemoteMessage
// ============================================================================

describe('serializeRemoteMessage', () => {
  it('should serialize message to JSON', () => {
    const msg: MachineToClientMessage = {
      type: 'workspace_list',
      workspaces: [],
    };
    const json = serializeRemoteMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('workspace_list');
    expect(parsed.workspaces).toEqual([]);
  });
});

// ============================================================================
// Round-trip: serialize then parse
// ============================================================================

describe('round-trip serialization', () => {
  it('should round-trip a GetEventsRequest', () => {
    const original: GetEventsRequest = {
      type: 'get_events',
      workspacePath: '/home/user/workspace',
      processName: 'web',
      limit: 100,
      sinceMs: 1700000000000,
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as GetEventsRequest;
    expect(parsed.type).toBe('get_events');
    expect(parsed.workspacePath).toBe('/home/user/workspace');
    expect(parsed.processName).toBe('web');
    expect(parsed.limit).toBe(100);
    expect(parsed.sinceMs).toBe(1700000000000);
  });

  it('should round-trip a StartProcessRequest', () => {
    const original: StartProcessRequest = {
      type: 'start_process',
      workspaceId: 'project:feature-branch',
      processName: 'dev-server',
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as StartProcessRequest;
    expect(parsed.type).toBe('start_process');
    expect(parsed.workspaceId).toBe('project:feature-branch');
    expect(parsed.processName).toBe('dev-server');
  });

  it('should round-trip a StopProcessRequest', () => {
    const original: StopProcessRequest = {
      type: 'stop_process',
      workspaceId: 'project:feature-branch',
      processName: 'dev-server',
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as StopProcessRequest;
    expect(parsed.type).toBe('stop_process');
    expect(parsed.workspaceId).toBe('project:feature-branch');
    expect(parsed.processName).toBe('dev-server');
  });

  it('should round-trip an EventsListResponse', () => {
    const original: EventsListResponse = {
      type: 'events_list',
      workspaceId: 'my-workspace',
      events: [],
      liveEventIds: ['evt-1', 'evt-2'],
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as EventsListResponse;
    expect(parsed.type).toBe('events_list');
    expect(parsed.workspaceId).toBe('my-workspace');
    expect(parsed.events).toEqual([]);
    expect(parsed.liveEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('should round-trip a ProcessStartedResponse', () => {
    const original: ProcessStartedResponse = {
      type: 'process_started',
      workspaceId: 'project:workspace',
      processName: 'web',
      sessionId: 'sess-123',
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as ProcessStartedResponse;
    expect(parsed.type).toBe('process_started');
    expect(parsed.workspaceId).toBe('project:workspace');
    expect(parsed.processName).toBe('web');
    expect(parsed.sessionId).toBe('sess-123');
  });

  it('should round-trip a ProcessStoppedResponse', () => {
    const original: ProcessStoppedResponse = {
      type: 'process_stopped',
      workspaceId: 'project:workspace',
      processName: 'web',
    };
    const json = serializeRemoteMessage(original);
    const parsed = parseRemoteMessage(json) as ProcessStoppedResponse;
    expect(parsed.type).toBe('process_stopped');
    expect(parsed.workspaceId).toBe('project:workspace');
    expect(parsed.processName).toBe('web');
  });
});

// ============================================================================
// isBrowseMessage
// ============================================================================

describe('isBrowseMessage', () => {
  it('should return true for list_workspaces', () => {
    expect(isBrowseMessage({ type: 'list_workspaces' })).toBe(true);
  });

  it('should return true for list_sessions', () => {
    expect(isBrowseMessage({ type: 'list_sessions' })).toBe(true);
  });

  it('should return true for attach_session', () => {
    expect(isBrowseMessage({ type: 'attach_session' })).toBe(true);
  });

  it('should return true for get_events', () => {
    const msg: GetEventsRequest = {
      type: 'get_events',
      workspacePath: '/tmp',
    };
    expect(isBrowseMessage(msg)).toBe(true);
  });

  it('should return false for start_process', () => {
    const msg: StartProcessRequest = {
      type: 'start_process',
      workspaceId: 'ws',
      processName: 'web',
    };
    expect(isBrowseMessage(msg)).toBe(false);
  });

  it('should return false for stop_process', () => {
    const msg: StopProcessRequest = {
      type: 'stop_process',
      workspaceId: 'ws',
      processName: 'web',
    };
    expect(isBrowseMessage(msg)).toBe(false);
  });

  it('should return false for response messages', () => {
    const msg: EventsListResponse = {
      type: 'events_list',
      workspaceId: 'ws',
      events: [],
      liveEventIds: [],
    };
    expect(isBrowseMessage(msg)).toBe(false);
  });
});

// ============================================================================
// ClientToMachineMessage union type coverage
// ============================================================================

describe('ClientToMachineMessage type coverage', () => {
  const clientMessages: ClientToMachineMessage[] = [
    { type: 'list_workspaces' },
    { type: 'list_sessions' },
    { type: 'attach_session' },
    { type: 'list_projects' },
    { type: 'kill_session', sessionId: 's1' },
    { type: 'delete_workspace', workspaceId: 'w1', projectName: 'p1' },
    { type: 'get_inbox' },
    { type: 'clear_inbox' },
    { type: 'mark_inbox_read', id: 'i1' },
    { type: 'get_notification_config' },
    { type: 'update_notification_config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } },
    { type: 'get_bundle_refresh_plan', projectName: 'p1', workspaceId: 'w1' },
    { type: 'apply_bundle_refresh', projectName: 'p1', workspaceId: 'w1', submission: { inputValues: {}, secretValues: {}, confirmResults: {} } },
    { type: 'get_events', workspacePath: '/tmp' },
    { type: 'start_process', workspaceId: 'w1', processName: 'web' },
    { type: 'stop_process', workspaceId: 'w1', processName: 'web' },
  ];

  it('should include all 16 client message types', () => {
    const types = new Set(clientMessages.map(m => m.type));
    expect(types.size).toBe(16);
  });

  it('should all parse successfully via round-trip', () => {
    for (const msg of clientMessages) {
      const json = JSON.stringify(msg);
      const parsed = parseRemoteMessage(json);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe(msg.type);
    }
  });
});

// ============================================================================
// MachineToClientMessage union type coverage
// ============================================================================

describe('MachineToClientMessage type coverage', () => {
  const machineMessages: MachineToClientMessage[] = [
    { type: 'workspace_list', workspaces: [] },
    { type: 'session_list', sessions: [] },
    { type: 'attached', sessionId: 's1', sessionName: 'test', cols: 80, rows: 24 },
    { type: 'detached' },
    { type: 'session_exited', sessionId: 's1', exitCode: 0 },
    { type: 'error', code: 'TEST', message: 'test error' },
    { type: 'project_list', projects: [] },
    { type: 'session_killed', sessionId: 's1', workspaceId: 'w1' },
    { type: 'workspace_deleted', workspaceId: 'w1' },
    { type: 'inbox_list', items: [], unreadCount: 0 },
    { type: 'inbox_cleared' },
    { type: 'inbox_marked_read', id: 'i1' },
    { type: 'notification_config', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } },
    { type: 'notification_config_updated', config: { enabled: true, minCommandDurationMs: 10000, types: { exit: true, idle: true, bell: true, title: true, osc: true }, toast: { enabled: true, holdWhenIdleMs: 15000 } } },
    { type: 'script_output', phase: 'setup', data: '' },
    { type: 'bundle_refresh_plan', plan: { projectName: 'p1', workspaceId: 'w1', workspaceName: 'w1', workspacePath: '/tmp', hasBundle: false, hasChanged: false, details: '', steps: [], autoConfirmResults: {} } },
    { type: 'bundle_refresh_applied', projectName: 'p1', workspaceId: 'w1' },
    { type: 'events_list', workspaceId: 'w1', events: [], liveEventIds: [] },
    { type: 'process_started', workspaceId: 'w1', processName: 'web' },
    { type: 'process_stopped', workspaceId: 'w1', processName: 'web' },
  ];

  it('should include all 20 machine message types', () => {
    const types = new Set(machineMessages.map(m => m.type));
    expect(types.size).toBe(20);
  });

  it('should all parse successfully via round-trip', () => {
    for (const msg of machineMessages) {
      const json = serializeRemoteMessage(msg);
      const parsed = parseRemoteMessage(json);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe(msg.type);
    }
  });
});
