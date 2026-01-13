/**
 * Terminal - TUI Component for embedded terminal sessions
 *
 * Uses ghostty-opentui in persistent mode for efficient streaming ANSI rendering.
 * Connects to tmux-lite sessions via Unix socket for PTY I/O.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { extend, useKeyboard, useRenderer } from '@opentui/react';
import type { PasteEvent, ScrollBoxRenderable } from '@opentui/core';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import { appendFileSync } from 'fs';
import type { Session, SessionEvent } from '../../lib/tmux-lite/protocol.js';
import { encodeControl, encodePTY, parseFrames, decodeControl, FrameType } from '../../lib/tmux-lite/protocol.js';
import { createBufferedSocketWriter } from '../../utils/bun-socket-writer.js';
import { BracketedPasteModeTracker, wrapPaste } from '../terminal-bracketed-paste.js';
import { findUtf8Boundary } from '../../utils/utf8.js';

// Debug logging to file (TUI-safe)
const DEBUG_TERMINAL = process.env.DEBUG_TERMINAL === '1';
const DEBUG_LOG_PATH = '/tmp/terminal-debug.log';

function debugLog(message: string, data?: Buffer | string): void {
  if (!DEBUG_TERMINAL) return;
  try {
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] ${message}`;
    if (data) {
      if (Buffer.isBuffer(data)) {
        const hex = data.toString('hex').slice(0, 200);
        const printable = data.toString('utf-8').replace(/[\x00-\x1f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).slice(0, 200);
        logLine += `\n  Hex: ${hex}...\n  Text: ${printable}...`;
      } else {
        logLine += `\n  ${data}`;
      }
    }
    appendFileSync(DEBUG_LOG_PATH, logLine + '\n');
  } catch {
    // Ignore logging errors
  }
}

// Register the ghostty-terminal component
extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

// ============================================================================
// Types
// ============================================================================

export interface TerminalProps {
  session: Session;
  onDetach: () => void;
  onExit: (code: number) => void;
  onKicked: () => void;
  onError: (error: string) => void;
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error';


// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  statusBar: '#333333',
  session: '#00FF88',
  textDim: '#888888',
  detachHint: '#FFAA00',
  error: '#FF4444',
};

// ============================================================================
// Terminal Component
// ============================================================================

// Helper to get terminal size
function getTerminalSize() {
  let cols = process.stdout.columns || 0;
  let rows = process.stdout.rows || 0;
  if (cols <= 0 || rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      cols = size[0];
      rows = size[1];
    }
  }
  // Reserve 1 row for header
  return {
    cols: cols > 0 ? cols : 80,
    rows: (rows > 0 ? rows : 24) - 1,
  };
}

export function Terminal({ session, onDetach, onExit, onKicked, onError }: TerminalProps) {
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [termSize, setTermSize] = useState(getTerminalSize);
  const renderer = useRenderer();

  // Initial data state - we don't render terminal until we have initial content
  const [initialData, setInitialData] = useState<Buffer | null>(null);
  const initialDataReceivedRef = useRef(false); // Ref for socket callback

  // Refs
  const terminalRef = useRef<GhosttyTerminalRenderable | null>(null);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const socketRef = useRef<Awaited<ReturnType<typeof Bun.connect>> | null>(null);
  const socketWriterRef = useRef<ReturnType<typeof createBufferedSocketWriter> | null>(null);
  const bufferRef = useRef<Buffer>(Buffer.alloc(0));
  const ptyUtf8BufferRef = useRef<Buffer>(Buffer.alloc(0)); // Buffer for incomplete UTF-8 sequences
  const pendingPtyDataRef = useRef<Buffer[]>([]); // Buffer PTY data until "attached" received
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const statusRef = useRef<TerminalStatus>(status);

  // Track bracketed paste mode (DECSET 2004) as requested by the remote program.
  const bracketedPasteRef = useRef(new BracketedPasteModeTracker());

  // Store callbacks in refs to avoid useEffect re-runs when parent re-renders
  const onDetachRef = useRef(onDetach);
  const onExitRef = useRef(onExit);
  const onKickedRef = useRef(onKicked);
  const onErrorRef = useRef(onError);

  // Keep refs up to date
  useEffect(() => {
    onDetachRef.current = onDetach;
    onExitRef.current = onExit;
    onKickedRef.current = onKicked;
    onErrorRef.current = onError;
  });

  // Keep status ref up to date for stable event handlers
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Reset refs when session changes to prevent stale state
  useEffect(() => {
    bufferRef.current = Buffer.alloc(0);
    ptyUtf8BufferRef.current = Buffer.alloc(0);
    pendingPtyDataRef.current = [];
    initialDataReceivedRef.current = false;
    bracketedPasteRef.current = new BracketedPasteModeTracker();
    setInitialData(null);
    setTerminalMounted(false);
  }, [session.socketPath]);

  const updateBracketedPasteMode = useCallback((chunk: Buffer) => {
    bracketedPasteRef.current.update(chunk);
  }, []);

  // Handle paste events from OpenTUI (bracketed paste on the *local* terminal).
  // This is separate from keypress events and must be forwarded manually.
  useEffect(() => {
    const handlePaste = (e: PasteEvent) => {
      if (statusRef.current !== 'connected') return;
      const socket = socketRef.current;
      if (!socket) return;

      const text = e.text ?? '';
      if (text.length === 0) return;

      const payload = wrapPaste(text, bracketedPasteRef.current.isEnabled);

      const frame = encodePTY(Buffer.from(payload));
      if (socketWriterRef.current) socketWriterRef.current.write(frame);
      else socket.write(frame);

      e.preventDefault();
    };

    renderer.keyInput.on('paste', handlePaste);
    return () => {
      renderer.keyInput.off('paste', handlePaste);
    };
  }, [renderer]);

  // Track when terminal ref changes to flush pending data
  const [terminalMounted, setTerminalMounted] = useState(false);

  // Flush any pending PTY data when terminal mounts (after initial render)
  useEffect(() => {
    if (terminalMounted && terminalRef.current && pendingPtyDataRef.current.length > 0) {
      debugLog(`Terminal mounted, flushing ${pendingPtyDataRef.current.length} pending chunks`);
      const combined = Buffer.concat(pendingPtyDataRef.current);
      pendingPtyDataRef.current = [];
      terminalRef.current.feed(combined);
    }
  }, [terminalMounted]);

  // Send resize to session
  const sendResize = useCallback((force = false) => {
    const socket = socketRef.current;
    if (!socket) return;

    const { cols, rows } = getTerminalSize();
    if (!force && cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) {
      return;
    }
    lastSizeRef.current = { cols, rows };

    // Update state to trigger re-render
    setTermSize({ cols, rows });

    // Send resize command to PTY
    const frame = encodeControl({ type: 'resize', cols, rows });
    if (socketWriterRef.current) socketWriterRef.current.write(frame);
    else socket.write(frame);

    // Also update ghostty-terminal dimensions directly
    if (terminalRef.current) {
      terminalRef.current.cols = cols;
      terminalRef.current.rows = rows;
    }
  }, []);

  // Connect to session socket
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    const connect = async () => {
      try {
        const socket = await Bun.connect({
          unix: session.socketPath,
          socket: {
            drain() {
              socketWriterRef.current?.flush();
            },
            data(_, data) {
              let buf = Buffer.from(data);
              debugLog(`Socket data received: ${buf.length} bytes`);

              // Combine with existing buffer
              if (bufferRef.current.length > 0) {
                buf = Buffer.concat([bufferRef.current, buf]);
              }

              // Parse frames from the buffer
              let frames;
              let remaining;
              try {
                const result = parseFrames(buf);
                frames = result.frames;
                remaining = result.remaining;
              } catch (err) {
                // Protocol error - likely desync or corrupted data
                const msg = err instanceof Error ? err.message : 'Frame parse error';
                debugLog(`Frame parse error: ${msg}`);
                console.error(`[Terminal] Frame parse error: ${msg}`);
                setStatus('error');
                setErrorMsg(msg);
                onErrorRef.current(msg);
                return;
              }
              // Copy remaining bytes - subarray references can become invalid when Bun reuses buffers
              bufferRef.current = Buffer.from(remaining);

              debugLog(`Parsed ${frames.length} frames, ${remaining.length} bytes remaining`);

              const ptyChunks: Buffer[] = [];
              let receivedAttached = false;

              for (const frame of frames) {
                if (frame.type === FrameType.CONTROL) {
                  const event = decodeControl(frame.payload) as SessionEvent;
                  debugLog(`Control frame: ${event.type}`);

                  if (event.type === 'attached') {
                    receivedAttached = true;
                    setStatus('connected');
                  } else if (event.type === 'exited') {
                    onExitRef.current(event.code);
                    return;
                  } else if (event.type === 'kicked') {
                    onKickedRef.current();
                    return;
                  }
                } else if (frame.type === FrameType.PTY) {
                  debugLog(`PTY frame: ${frame.payload.length} bytes`);
                  ptyChunks.push(frame.payload);
                }
              }

              // Handle PTY data
              if (ptyChunks.length > 0) {
                // Before "attached" is received, buffer all PTY data
                if (!initialDataReceivedRef.current) {
                  pendingPtyDataRef.current.push(...ptyChunks);
                  debugLog(`Buffering ${ptyChunks.length} PTY chunks before attach (${ptyChunks.reduce((a, b) => a + b.length, 0)} bytes)`);
                } else if (terminalRef.current) {
                  // After initial data AND terminal is mounted, feed directly
                  // Combine chunks with any incomplete UTF-8 bytes
                  let combined: Buffer;
                  if (ptyUtf8BufferRef.current.length > 0) {
                    combined = Buffer.concat([ptyUtf8BufferRef.current, ...ptyChunks]);
                    ptyUtf8BufferRef.current = Buffer.alloc(0);
                  } else {
                    combined = Buffer.concat(ptyChunks);
                  }

                  // Track bracketed paste mode based on output from the remote program
                  if (combined.length > 0) updateBracketedPasteMode(combined);

                  // Find UTF-8 boundary
                  const boundary = findUtf8Boundary(combined);
                  if (boundary < combined.length) {
                    ptyUtf8BufferRef.current = Buffer.from(combined.subarray(boundary));
                    combined = combined.subarray(0, boundary) as Buffer;
                    debugLog(`UTF-8 split: feeding ${combined.length} bytes, buffering ${ptyUtf8BufferRef.current.length} bytes`);
                  }

                  if (combined.length > 0) {
                    debugLog(`Feeding ${combined.length} bytes to ghostty`, combined);
                    terminalRef.current.feed(combined);
                  }
                } else {
                  // Terminal not yet mounted - buffer for later
                  pendingPtyDataRef.current.push(...ptyChunks);
                  debugLog(`Terminal not mounted yet, buffering ${ptyChunks.length} PTY chunks`);
                }
              }

              // When we receive "attached", flush all buffered data as initial content
              if (receivedAttached && !initialDataReceivedRef.current) {
                initialDataReceivedRef.current = true;

                // Combine all buffered PTY data
                debugLog(`Received 'attached', pendingPtyDataRef has ${pendingPtyDataRef.current.length} chunks`);
                const allBuffered = Buffer.concat(pendingPtyDataRef.current);
                pendingPtyDataRef.current = [];

                debugLog(`Setting initial data: ${allBuffered.length} bytes`, allBuffered);

                // Initialize bracketed paste mode from the attach snapshot (if present)
                if (allBuffered.length > 0) updateBracketedPasteMode(allBuffered);

                // Set initial data - this will cause the terminal to render with ansi prop
                setInitialData(allBuffered);

                // Send resize after we have initial data
                sendResize(true);
              } else if (receivedAttached) {
                debugLog(`Received 'attached' but initialDataReceivedRef already true`);
              }
            },

            close() {
              setStatus('disconnected');
              onDetachRef.current();
            },

            error(_, e) {
              setStatus('error');
              setErrorMsg(e.message);
              onErrorRef.current(e.message);
            },
          },
        });

        socketRef.current = socket;
        socketWriterRef.current = createBufferedSocketWriter(socket);

        // Send attach init with current terminal dimensions
        const { cols, rows } = getTerminalSize();
        socketWriterRef.current.write(encodeControl({ type: 'attach-init', cols, rows, clientType: 'cli' }));

        // Handle window resize
        const onResize = () => sendResize();
        process.on('SIGWINCH', onResize);

        cleanup = () => {
          process.removeListener('SIGWINCH', onResize);
          socket.end();
          socketRef.current = null;
          socketWriterRef.current = null;
        };
      } catch (err) {
        setStatus('error');
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setErrorMsg(msg);
        onErrorRef.current(msg);
      }
    };

    connect();

    return () => {
      cleanup?.();
    };
  }, [session.socketPath, sendResize]); // Callbacks use refs, so not in deps

  // Handle keyboard input using OpenTUI's useKeyboard
  useKeyboard((key) => {
    if (status !== 'connected') return;

    const socket = socketRef.current;
    if (!socket) return;

    // Check for Ctrl+Esc (detach) - key.name is 'escape' with ctrl modifier
    if (key.name === 'escape' && key.ctrl) {
      const frame = encodeControl({ type: 'detach' });
      if (socketWriterRef.current) socketWriterRef.current.write(frame);
      else socket.write(frame);
      onDetach();
      return;
    }

    // Determine what to send to the PTY
    let data: string | undefined;

    // Debug: log key info
    if (DEBUG_TERMINAL) {
      debugLog(`Key: name=${key.name} shift=${key.shift} ctrl=${key.ctrl} meta=${key.meta} seq=${key.sequence?.replace(/\x1b/g, '\\e')} raw=${key.raw}`);
    }

    // Compute modifier value for CSI sequences
    // Modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
    const modifier = 1 + (key.shift ? 1 : 0) + (key.meta ? 2 : 0) + (key.ctrl ? 4 : 0);
    const hasModifier = modifier > 1;

    // Map of special key names to their CSI codes
    const specialKeys: Record<string, string> = {
      'up': 'A', 'down': 'B', 'right': 'C', 'left': 'D',
      'end': 'F', 'home': 'H',
      'insert': '2~', 'delete': '3~', 'pageup': '5~', 'pagedown': '6~',
      'f1': 'P', 'f2': 'Q', 'f3': 'R', 'f4': 'S',
      'f5': '15~', 'f6': '17~', 'f7': '18~', 'f8': '19~',
      'f9': '20~', 'f10': '21~', 'f11': '23~', 'f12': '24~',
    };

    // Handle Ctrl+letter combinations (synthesize control characters)
    if (key.ctrl && key.name && key.name.length === 1 && /[a-z]/i.test(key.name)) {
      // Ctrl+A = \x01, Ctrl+C = \x03, etc.
      const charCode = key.name.toLowerCase().charCodeAt(0) - 96;
      data = String.fromCharCode(charCode);
    } else if (key.shift && key.name === 'tab') {
      // Shift+Tab (backtab) - send CSI Z
      data = '\x1b[Z';
    } else if (hasModifier && key.name && specialKeys[key.name]) {
      // Special keys with modifiers - construct proper CSI sequence
      const code = specialKeys[key.name];
      if (code.endsWith('~')) {
        // Tilde-style: \e[{code};{modifier}~
        data = `\x1b[${code.slice(0, -1)};${modifier}~`;
      } else if (code.length === 1) {
        // Letter-style (arrows, F1-F4): \e[1;{modifier}{code}
        data = `\x1b[1;${modifier}${code}`;
      }
    } else if (key.sequence) {
      // Use the full escape sequence for special keys (arrows, function keys, etc.)
      data = key.sequence;
    } else if (key.raw) {
      // Use raw character for regular keys
      data = key.raw;
    }

    if (data) {
      const frame = encodePTY(Buffer.from(data));
      if (socketWriterRef.current) socketWriterRef.current.write(frame);
      else socket.write(frame);
    }
  });

  // Render
  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box
        height={1}
        width="100%"
        backgroundColor={COLORS.statusBar}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexGrow={1} flexDirection="row">
          <text fg={COLORS.session}>{session.name}</text>
          <text fg={COLORS.textDim}> - {session.cwd}</text>
        </box>
        <text fg={COLORS.detachHint}>[Ctrl+Esc] Detach</text>
      </box>

      {/* Terminal content */}
      {status === 'connecting' && !initialData && (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.textDim}>Connecting to session...</text>
        </box>
      )}

      {status === 'error' && (
        <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
          <text fg={COLORS.error}>Connection Error</text>
          <text fg={COLORS.textDim}>{errorMsg}</text>
        </box>
      )}

      {/* Only render terminal once we have initial data */}
      {initialData !== null && (
        <scrollbox
          ref={(el: ScrollBoxRenderable | null) => {
            scrollBoxRef.current = el;
          }}
          flexGrow={1}
          viewportCulling={true}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <ghostty-terminal
            ref={(el: GhosttyTerminalRenderable | null) => {
              terminalRef.current = el;
              if (el) {
                debugLog('Terminal mounted with initial data');
                setTerminalMounted(true);
                // Scroll to cursor position after mount
                requestAnimationFrame(() => {
                  if (el && scrollBoxRef.current) {
                    try {
                      const [, cursorY] = el.getCursor();
                      const scrollPos = el.getScrollPositionForLine(cursorY);
                      scrollBoxRef.current.scrollTo(scrollPos);
                      debugLog(`Scrolled to cursor position: line ${cursorY}, scrollPos ${scrollPos}`);
                    } catch (err) {
                      debugLog(`Failed to scroll to cursor: ${err}`);
                    }
                  }
                });
              }
            }}
            persistent={true}
            showCursor={true}
            cursorStyle="block"
            cols={termSize.cols}
            rows={termSize.rows}
            ansi={initialData}
          />
        </scrollbox>
      )}
    </box>
  );
}

// ============================================================================
// Hook for terminal session management
// ============================================================================

export interface UseTerminalSessionOptions {
  onDetach?: () => void;
  onExit?: (code: number) => void;
  onKicked?: () => void;
  onError?: (error: string) => void;
}

export interface UseTerminalSessionReturn {
  session: Session | null;
  isAttached: boolean;
  attach: (session: Session) => void;
  detach: () => void;
  handlers: {
    onDetach: () => void;
    onExit: (code: number) => void;
    onKicked: () => void;
    onError: (error: string) => void;
  };
}

export function useTerminalSession(options: UseTerminalSessionOptions = {}): UseTerminalSessionReturn {
  const [session, setSession] = useState<Session | null>(null);

  const attach = useCallback((sess: Session) => {
    setSession(sess);
  }, []);

  const detach = useCallback(() => {
    setSession(null);
    options.onDetach?.();
  }, [options.onDetach]);

  // Memoize handlers to prevent useEffect re-runs on every render
  const handleDetach = useCallback(() => {
    setSession(null);
    options.onDetach?.();
  }, [options.onDetach]);

  const handleExit = useCallback((code: number) => {
    setSession(null);
    options.onExit?.(code);
  }, [options.onExit]);

  const handleKicked = useCallback(() => {
    setSession(null);
    options.onKicked?.();
  }, [options.onKicked]);

  const handleError = useCallback((error: string) => {
    setSession(null);
    options.onError?.(error);
  }, [options.onError]);

  // Use useMemo to keep handlers object reference stable
  const handlers = useMemo(() => ({
    onDetach: handleDetach,
    onExit: handleExit,
    onKicked: handleKicked,
    onError: handleError,
  }), [handleDetach, handleExit, handleKicked, handleError]);

  return {
    session,
    isAttached: session !== null,
    attach,
    detach,
    handlers,
  };
}
