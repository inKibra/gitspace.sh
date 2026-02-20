/**
 * tmux-lite protocol
 */

/** Protocol version - increment when making breaking changes */
export const PROTOCOL_VERSION = 1;

/** Package version - should match package.json */
export const PACKAGE_VERSION = "1.0.0";

const DEFAULT_ROUTER_SOCKET = "/tmp/tmux-lite.sock";
const DEFAULT_PID_FILE = "/tmp/tmux-lite.pid";
const DEFAULT_SESSION_DIR = "/tmp";

export function getRouterSocket(): string {
  return process.env.TMUX_LITE_SOCKET || DEFAULT_ROUTER_SOCKET;
}

export function getPidFile(): string {
  return process.env.TMUX_LITE_PID_FILE || DEFAULT_PID_FILE;
}

/**
 * Pattern for valid session IDs - alphanumeric, hyphens, underscores only
 * Security: Prevents path traversal attacks via session IDs
 */
const VALID_SESSION_ID_PATTERN = /^[a-zA-Z0-9\-_]+$/;

/**
 * Validate a session ID to prevent path traversal
 */
export function isValidSessionId(id: string): boolean {
  if (!id || id.length === 0 || id.length > 256) {
    return false;
  }
  return VALID_SESSION_ID_PATTERN.test(id);
}

export function getSessionSocketPath(id: string): string {
  // Security: Validate session ID to prevent path traversal
  if (!isValidSessionId(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
  const dir = process.env.TMUX_LITE_SESSION_DIR || DEFAULT_SESSION_DIR;
  const normalizedDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${normalizedDir}/tmux-lite-${id}.sock`;
}

const ROUTER_FRAME_HEADER_BYTES = 4;

export function encodeRouterMessage(msg: Command | Response): Buffer {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json);
  const buf = Buffer.alloc(ROUTER_FRAME_HEADER_BYTES + len);
  buf.writeUInt32BE(len, 0);
  buf.write(json, ROUTER_FRAME_HEADER_BYTES);
  return buf;
}

export function decodeRouterMessages(buffer: Buffer): {
  messages: Array<Command | Response>;
  remaining: Buffer;
} {
  const messages: Array<Command | Response> = [];
  let offset = 0;

  while (offset + ROUTER_FRAME_HEADER_BYTES <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const frameEnd = offset + ROUTER_FRAME_HEADER_BYTES + len;
    if (frameEnd > buffer.length) {
      break;
    }
    const json = buffer.subarray(offset + ROUTER_FRAME_HEADER_BYTES, frameEnd).toString();
    messages.push(JSON.parse(json));
    offset = frameEnd;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

// Router commands
export interface SessionCreateHooks {
  /** Environment variables injected into spawned shell process */
  env?: Record<string, string>;
  /** Optional shell init snippets (run once after shell starts) */
  shellInit?: {
    /** Runs for all shells */
    all?: string;
    /** Runs for bash shells */
    bash?: string;
    /** Runs for zsh shells */
    zsh?: string;
    /** Runs for sh shells */
    sh?: string;
  };
}

export type Command =
  | { type: "list" }
  | {
      type: "new";
      name?: string;
      cwd: string;
      hooks?: SessionCreateHooks;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "attach"; id: string; force?: boolean }
  | { type: "kill"; id: string }
  | { type: "kill-server" }
  | { type: "inbox" }
  | { type: "inbox-clear"; id?: string }  // Clear one or all
  | { type: "inbox-read"; id: string }    // Mark as read
  | { type: "version" }                   // Get server version info
  | { type: "status" };                   // Get server status (version + stats)

export type Response =
  | { type: "sessions"; sessions: Session[] }
  | { type: "session"; session: Session }
  | { type: "already-attached"; session: Session }
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "inbox"; items: InboxItem[] }
  | { type: "version"; version: string; protocol: number }
  | { type: "status"; version: string; protocol: number; pid: number; uptime: number; sessions: number; attached: number };

export interface Session {
  id: string;
  name: string;
  socketPath: string;
  pid: number;
  attached: boolean;
  cwd: string;
  createdAt: number;
  exitCode?: number;  // undefined = running, number = exited
  processTitle?: string;  // Title set by running process (e.g., vim, npm run dev)
}

// Inbox item - things that need attention
export interface InboxItem {
  id: string;
  sessionId: string;
  sessionName: string;
  type: 'bell' | 'exit' | 'title' | 'idle' | 'osc';
  timestamp: number;
  exitCode?: number;
  context: string;  // The actual message/output
  processTitle?: string;  // What process was running (e.g., "claude", "npm run dev")
  read: boolean;
}

// ============================================================================
// Session Framed Protocol
// ============================================================================
//
// All session socket communication uses length-prefixed framing:
//   [type:1 byte][len:4 bytes BE][payload:len bytes]
//
// Frame types:
//   0x00 = PTY data (raw bytes, passthrough)
//   0x01 = CONTROL message (JSON)
//
// This replaces the old CTRL_MAGIC scanning approach which had collision
// issues with OSC 99 (Kitty notifications).

/** Frame types for the session protocol */
export const FrameType = {
  PTY: 0x00,      // Raw PTY data
  CONTROL: 0x01,  // JSON control message
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Session control messages (client → server) */
export type SessionCtrl =
  | { type: "attach-init"; cols: number; rows: number; clientType?: "cli" | "web" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

/** Session events (server → client) */
export type SessionEvent =
  | { type: "attach-ready"; cols: number; rows: number }
  | { type: "attached" }
  | { type: "exited"; code: number }
  | { type: "kicked" }
  | { type: "wide_event"; event: Record<string, unknown> };

/** A decoded frame from the session socket */
export interface SessionFrame {
  type: FrameTypeValue;
  payload: Buffer;
}

/** Result of parsing frames from a buffer */
export interface FrameParseResult {
  frames: SessionFrame[];
  remaining: Buffer;
}

// Frame header: 1 byte type + 4 bytes length
const FRAME_HEADER_LEN = 5;

// Maximum frame size (1MB) - security limit to prevent DoS
// Matches relay protocol limit for consistency across all transport paths
export const MAX_FRAME_SIZE = 1024 * 1024;

// Valid frame types for sanity checking (helps detect protocol desync)
const VALID_FRAME_TYPES = new Set([FrameType.PTY, FrameType.CONTROL]);

/**
 * Encode data into a frame
 * @param type - FrameType.PTY or FrameType.CONTROL
 * @param payload - Raw bytes to send
 */
export function encodeFrame(type: FrameTypeValue, payload: Buffer | Uint8Array): Buffer {
  const payloadBuf = Buffer.from(payload);
  const buf = Buffer.alloc(FRAME_HEADER_LEN + payloadBuf.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(payloadBuf.length, 1);
  payloadBuf.copy(buf, FRAME_HEADER_LEN);
  return buf;
}

/**
 * Encode raw PTY data into a frame
 */
export function encodePTY(data: Buffer | Uint8Array): Buffer {
  return encodeFrame(FrameType.PTY, data);
}

/**
 * Encode a control message (SessionCtrl or SessionEvent) into a frame
 */
export function encodeControl(msg: SessionCtrl | SessionEvent): Buffer {
  const json = JSON.stringify(msg);
  return encodeFrame(FrameType.CONTROL, Buffer.from(json));
}

/**
 * Parse frames from a buffer (handles partial frames)
 *
 * @param buffer - Buffer containing one or more frames
 * @returns Parsed frames and any remaining bytes (incomplete frame)
 */
export function parseFrames(buffer: Buffer): FrameParseResult {
  const frames: SessionFrame[] = [];
  let offset = 0;

  while (offset + FRAME_HEADER_LEN <= buffer.length) {
    const type = buffer.readUInt8(offset) as FrameTypeValue;
    const length = buffer.readUInt32BE(offset + 1);

    // Security: Validate frame type (helps detect protocol desync)
    if (!VALID_FRAME_TYPES.has(type)) {
      throw new Error(`Invalid frame type 0x${type.toString(16).padStart(2, '0')} at offset ${offset} (possible protocol desync)`);
    }

    // Security: Reject oversized frames
    if (length > MAX_FRAME_SIZE) {
      throw new Error(`Frame size ${length} exceeds maximum ${MAX_FRAME_SIZE} (type=0x${type.toString(16).padStart(2, '0')}, offset=${offset})`);
    }

    const frameEnd = offset + FRAME_HEADER_LEN + length;
    if (frameEnd > buffer.length) {
      // Incomplete frame, need more data
      break;
    }

    // Copy payload data - subarray references become invalid when Bun reuses socket buffers
    const payload = Buffer.from(buffer.subarray(offset + FRAME_HEADER_LEN, frameEnd));
    frames.push({ type, payload });
    offset = frameEnd;
  }

  return {
    frames,
    // Copy remaining bytes - subarray references become invalid when Bun reuses socket buffers
    remaining: Buffer.from(buffer.subarray(offset)),
  };
}

/**
 * Decode a control message from a frame payload
 */
export function decodeControl(payload: Buffer): SessionCtrl | SessionEvent {
  return JSON.parse(payload.toString());
}
