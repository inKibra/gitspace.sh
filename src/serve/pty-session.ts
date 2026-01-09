// @ts-nocheck - Uses Bun-specific APIs (Bun.Terminal)
/**
 * PTY session wrapper for remote terminal access
 *
 * Wraps Bun.Terminal to provide:
 * - Encrypted frame I/O using session keys
 * - Resize handling with SIGWINCH
 * - Clean lifecycle management
 */

import { createFrame, openFrame } from "../lib/tmux-lite/crypto/frames.js";
import { decodeControl, type SessionCtrl } from "../lib/tmux-lite/protocol.js";
import type { SessionKeys } from "../types/identity.js";
import { STREAM_ID } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** PTY session options */
export interface PTYSessionOptions {
  /** Shell to spawn (default: $SHELL or /bin/bash) */
  shell?: string;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Initial terminal columns */
  cols?: number;
  /** Initial terminal rows */
  rows?: number;
  /** Session encryption keys */
  sessionKeys: SessionKeys;
  /** Callback for encrypted output data */
  onData: (encrypted: Buffer) => void;
  /** Callback when PTY exits */
  onClose: (exitCode: number) => void;
}

// ============================================================================
// PTYSession Class
// ============================================================================

/**
 * Manages a PTY session with encrypted I/O
 *
 * @example
 * ```typescript
 * const pty = new PTYSession({
 *   sessionKeys,
 *   onData: (encrypted) => relay.send(connectionId, encrypted),
 *   onClose: (code) => console.log(`Exit: ${code}`),
 * });
 *
 * // Write encrypted input from client
 * pty.write(encryptedFrame);
 *
 * // Handle resize
 * pty.resize(120, 40);
 *
 * // Clean up
 * pty.close();
 * ```
 */
export class PTYSession {
  private terminal: ReturnType<typeof Bun.Terminal> | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private sendKey: Uint8Array;
  private receiveKey: Uint8Array;
  private onData: (encrypted: Buffer) => void;
  private onClose: (exitCode: number) => void;
  private closed = false;

  constructor(options: PTYSessionOptions) {
    this.sendKey = options.sessionKeys.sendKey;
    this.receiveKey = options.sessionKeys.receiveKey;
    this.onData = options.onData;
    this.onClose = options.onClose;

    const shell = options.shell ?? process.env.SHELL ?? "/bin/bash";
    const cwd = options.cwd ?? process.env.HOME ?? "/";
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    // Build environment
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...options.env,
      TERM: "xterm-256color",
      SPACES_REMOTE: "true",
    };

    // Create PTY terminal
    this.terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_term: unknown, data: Uint8Array) => {
        if (this.closed) return;

        // Encrypt and send output
        const frame = createFrame(STREAM_ID.DATA, data, this.sendKey);
        this.onData(frame);
      },
    });

    // Spawn shell process
    this.proc = Bun.spawn([shell], {
      terminal: this.terminal,
      cwd,
      env,
    });

    // Handle process exit
    this.proc.exited.then((code) => {
      if (!this.closed) {
        this.closed = true;
        this.onClose(code);
      }
    });
  }

  /**
   * Get the process ID
   */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * Check if session is closed
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Write encrypted input data to PTY
   *
   * Decrypts the frame and writes plaintext to stdin.
   *
   * @param encryptedFrame - Encrypted frame from client
   * @returns True if write succeeded, false on decryption failure
   */
  write(encryptedFrame: Buffer | Uint8Array): boolean {
    if (this.closed || !this.terminal) return false;

    const result = openFrame(Buffer.from(encryptedFrame), this.receiveKey);
    if (!result) {
      console.warn("[pty-session] Failed to decrypt input frame");
      return false;
    }

    // Check stream ID
    if (result.streamId === STREAM_ID.CONTROL) {
      // Handle control message
      this.handleControlMessage(result.data);
      return true;
    }

    // Write data to PTY stdin
    this.terminal.write(result.data);
    return true;
  }

  /**
   * Handle control messages (resize, etc.)
   * Uses tmux-lite SessionCtrl format for consistency
   */
  private handleControlMessage(data: Buffer): void {
    try {
      const msg = decodeControl(data) as SessionCtrl;

      switch (msg.type) {
        case "resize":
          this.resize(msg.cols, msg.rows);
          break;
        case "detach":
          // Detach is handled at a higher level, ignore here
          break;
        case "attach-init":
          // attach-init doesn't apply to PTYSession (already started)
          break;
        default:
          console.warn("[pty-session] Unknown control message:", msg);
      }
    } catch (e) {
      console.warn("[pty-session] Invalid control message:", e);
    }
  }

  /**
   * Resize the PTY
   *
   * @param cols - Number of columns
   * @param rows - Number of rows
   */
  resize(cols: number, rows: number): void {
    if (this.closed || !this.terminal || !this.proc) return;

    try {
      this.terminal.resize(cols, rows);
      // Send SIGWINCH to process group so child processes get it
      try {
        process.kill(-this.proc.pid, "SIGWINCH");
      } catch {
        // Fallback to direct signal if process group fails
        try {
          process.kill(this.proc.pid, "SIGWINCH");
        } catch {
          // Process may have exited
        }
      }
    } catch (e) {
      console.warn("[pty-session] Resize failed:", e);
    }
  }

  /**
   * Close the PTY session
   *
   * Kills the process and cleans up resources.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    try {
      this.proc?.kill();
    } catch {
      // Already exited
    }

    this.terminal = null;
    this.proc = null;
  }
}
