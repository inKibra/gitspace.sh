/**
 * Shared protocol between router, sessions, and clients
 */

export const ROUTER_SOCKET = "/tmp/spaces-router.sock";
export const SESSION_SOCKET_PREFIX = "/tmp/spaces-session-";

// Router commands (JSON over socket)
export type RouterCommand =
  | { type: "list" }
  | { type: "create"; project: string; workspace: string; cwd: string }
  | { type: "attach"; sessionId: string; mode?: AttachMode }
  | { type: "kill"; sessionId: string }
  | { type: "kick"; sessionId: string };  // Disconnect current client

export type RouterResponse =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "created"; session: SessionInfo }
  | { type: "already-attached"; session: SessionInfo }  // Session exists but has a client
  | { type: "error"; message: string }
  | { type: "ok" };

export interface SessionInfo {
  id: string;
  project: string;
  workspace: string;
  socketPath: string;
  pid: number;
  attached: boolean;  // true if a client is connected
  createdAt: number;
}

// When attaching to an already-attached session
export type AttachMode =
  | "take-over"   // Disconnect existing client, you take over
  | "new"         // Create a new session for the same workspace
  | "cancel";     // Abort

// Session protocol (binary + JSON control)
// Control messages start with 0x00, data is raw bytes
export const CONTROL_PREFIX = 0x00;

export type SessionControl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" }
  | { type: "ping" };

export type SessionEvent =
  | { type: "attached"; scrollback: string }
  | { type: "exited"; code: number }
  | { type: "kicked" }  // Another client took over
  | { type: "pong" };

// Helper to encode control message
export function encodeControl(msg: SessionControl | SessionEvent): Buffer {
  const json = JSON.stringify(msg);
  const buf = Buffer.alloc(1 + 4 + json.length);
  buf[0] = CONTROL_PREFIX;
  buf.writeUInt32BE(json.length, 1);
  buf.write(json, 5);
  return buf;
}

// Helper to check if data is control message
export function isControl(data: Buffer): boolean {
  return data[0] === CONTROL_PREFIX;
}

// Helper to decode control message
export function decodeControl(data: Buffer): SessionControl | SessionEvent {
  const len = data.readUInt32BE(1);
  const json = data.subarray(5, 5 + len).toString();
  return JSON.parse(json);
}
