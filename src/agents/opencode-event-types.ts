/**
 * OpenCode server-sent event types.
 * Ported from @opencode-ai/sdk types.gen.ts
 * Only the subset relevant to GitSpace agent tracking.
 */

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

export interface Permission {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export interface EventSessionStatus {
  type: 'session.status';
  properties: { sessionID: string; status: SessionStatus };
}

export interface EventSessionIdle {
  type: 'session.idle';
  properties: { sessionID: string };
}

export interface EventSessionError {
  type: 'session.error';
  properties: {
    sessionID?: string;
    error?: { name: string; data?: { message?: string } };
  };
}

export interface EventSessionCreated {
  type: 'session.created';
  properties: { info: { id: string; title: string; directory: string; parentID?: string } };
}

export interface EventSessionUpdated {
  type: 'session.updated';
  properties: { info: { id: string; title: string; directory: string; parentID?: string } };
}

export interface EventSessionDeleted {
  type: 'session.deleted';
  properties: { info: { id: string } };
}

export interface EventPermissionUpdated {
  type: 'permission.updated';
  properties: Permission;
}

export interface EventPermissionReplied {
  type: 'permission.replied';
  properties: { sessionID: string; permissionID: string; response: string };
}

export interface EventMessagePartUpdated {
  type: 'message.part.updated';
  properties: {
    part: {
      id: string;
      sessionID: string;
      messageID: string;
      type: string;
      text?: string;
    };
    delta?: string;
  };
}

export interface EventServerConnected {
  type: 'server.connected';
  properties: Record<string, unknown>;
}

export type OpenCodeEvent =
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionError
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventPermissionUpdated
  | EventPermissionReplied
  | EventMessagePartUpdated
  | EventServerConnected
  | { type: string; properties?: unknown };

export function parseOpenCodeEvent(data: string): OpenCodeEvent | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as OpenCodeEvent;
  } catch {
    return null;
  }
}
