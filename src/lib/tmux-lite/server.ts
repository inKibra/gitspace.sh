#!/usr/bin/env bun
// @ts-nocheck - Uses Bun-specific APIs (Bun.Terminal, etc.)
/**
 * tmux-lite server - manages all sessions in a single process
 * Uses xterm-headless for proper terminal state tracking
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Terminal as XTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createBufferedSocketWriter } from "../../utils/bun-socket-writer";
import { installDsrCprResponder } from "./terminal-queries";
import { getNotificationConfig, type NotificationConfig } from "../../core/config.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "../../types/config.js";
import {
  applyTmuxLiteSandboxEnvironment,
  getRouterSocket,
  getSessionSocketPath,
  getPidFile,
  PROTOCOL_VERSION,
  PACKAGE_VERSION,
  type Command,
  type Response,
  type Session,
  type SessionCtrl,
  type InboxItem,
  type SessionCreateHooks,
  encodeRouterMessage,
  decodeRouterMessages,
  encodePTY,
  encodeControl,
  parseFrames,
  decodeControl,
  FrameType,
  MAX_FRAME_SIZE,
} from "./protocol";

// Chunk size for large PTY data (leave room for frame header overhead)
// Using 512KB to be well under the 1MB limit
const PTY_CHUNK_SIZE = 512 * 1024;

// Max scrollback lines to include in serialized state during attach
// This is a limit - if less scrollback exists, we'll send what's available
const SERIALIZE_SCROLLBACK_LINES = 10_000;

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--test")) {
  applyTmuxLiteSandboxEnvironment("test", { preserveExplicit: true });
}

const ROUTER_SOCKET = getRouterSocket();
const PID_FILE = getPidFile();
const SERVER_START_TIME = Date.now();

// Load notification config (with fallback to defaults)
let notificationConfig: NotificationConfig;
try {
  notificationConfig = getNotificationConfig();
} catch {
  // If config can't be loaded (e.g., gitspace not initialized), use defaults
  notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
}

/**
 * Check if a notification type is enabled
 */
function isNotificationTypeEnabled(type: InboxItem['type']): boolean {
  if (!notificationConfig.enabled) return false;

  switch (type) {
    case 'exit':
      return notificationConfig.types.exit;
    case 'idle':
      return notificationConfig.types.idle;
    case 'bell':
      return notificationConfig.types.bell;
    case 'title':
      return notificationConfig.types.title;
    case 'osc':
      return notificationConfig.types.osc;
    default:
      return notificationConfig.types.osc;
  }
}

// Clean up old socket
try { unlinkSync(ROUTER_SOCKET); } catch {}

// Write PID file
writeFileSync(PID_FILE, String(process.pid));

interface SessionData {
  info: Session;
  listener: any;
  ptyTerminal: Bun.Terminal;
  xterm: XTerminal;
  serialize: SerializeAddon;
  proc: Bun.Subprocess;
  client: any;
  clientWriter: any;
  ctrlBuffer: Buffer;
  pendingWrites: number;  // Track pending xterm writes
  attaching: boolean;
  attachBuffer: Buffer[];
  attachPending: boolean;
  attachTimer: any;
  processTitle: string;   // Title set by running process (via OSC 0)
  lastInteraction: number;  // Timestamp of last user input
  lastDetached: number;  // Timestamp of last detach (for grace period)
  lastAttached: number;  // Timestamp of last attach (for grace period)
}

const sessions = new Map<string, SessionData>();
const inbox: InboxItem[] = [];
let routerListener: any = null;
let shuttingDown = false;

function stopListener(listener: any): void {
  if (!listener || typeof listener.stop !== "function") {
    return;
  }
  try {
    listener.stop(true);
  } catch {
    try {
      listener.stop();
    } catch {}
  }
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch {}
}

function writeToClient(session: SessionData, data: Buffer): void {
  if (!session.client) return;
  if (session.clientWriter) {
    session.clientWriter.write(data);
    return;
  }
  session.client.write(data);
}

function flushClient(session: SessionData): void {
  if (session.clientWriter) session.clientWriter.flush();
}

// ============================================================================
// Socket State Management
// ============================================================================

/**
 * Type-safe socket state manager using WeakMap.
 * This avoids mutating socket objects with `as any` casts.
 */
interface RouterSocketState {
  buffer: Buffer;
  writer: any;
}

const routerSocketStates = new WeakMap<object, RouterSocketState>();

function getRouterSocketState(socket: object): RouterSocketState {
  let state = routerSocketStates.get(socket);
  if (!state) {
    state = { buffer: Buffer.alloc(0), writer: null };
    routerSocketStates.set(socket, state);
  }
  return state;
}

function clearRouterSocketState(socket: object): void {
  routerSocketStates.delete(socket);
}

function cleanupSessionResources(session: SessionData, options: { removeFromMap?: boolean } = {}): void {
  clearAttachTimer(session);
  session.attachPending = false;
  session.attaching = false;
  session.attachBuffer = [];
  session.info.attached = false;
  session.clientWriter = null;
  if (session.client) {
    try { session.client.end(); } catch {}
    session.client = null;
  }
  stopListener(session.listener);
  safeUnlink(session.info.socketPath);
  if (options.removeFromMap !== false) {
    sessions.delete(session.info.id);
  }
}

function shutdownServer(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const session of sessions.values()) {
    try { session.xterm.dispose(); } catch {}
    cleanupSessionResources(session, { removeFromMap: false });
    try { session.proc.kill(9); } catch {}
  }
  sessions.clear();

  stopListener(routerListener);
  safeUnlink(PID_FILE);
  safeUnlink(ROUTER_SOCKET);
}

// How long after last interaction before we consider the user "inactive"
const INTERACTION_TIMEOUT_MS = 30000; // 30 seconds
// Grace period after attach/detach - don't notify immediately
const ATTACH_GRACE_MS = 5000; // 5 seconds after attach
const DETACH_GRACE_MS = 5000; // 5 seconds after detach

type CtrlCMode = "auto" | "signal" | "byte";

const CTRL_C_MODE_ENV = "TMUX_LITE_CTRL_C_MODE";
const CTRL_C_MODE_VALUES = new Set<CtrlCMode>(["auto", "signal", "byte"]);
const ISIG_FLAG_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 0x80,
  linux: 0x01,
  freebsd: 0x80,
  netbsd: 0x80,
  openbsd: 0x80,
};
const ETX_BYTE = 0x03;

function resolveCtrlCModeFromEnv(): CtrlCMode {
  const raw = process.env[CTRL_C_MODE_ENV]?.trim().toLowerCase();
  if (!raw) {
    return "auto";
  }

  if (CTRL_C_MODE_VALUES.has(raw as CtrlCMode)) {
    return raw as CtrlCMode;
  }

  console.warn(
    `[tmux-lite] Ignoring invalid ${CTRL_C_MODE_ENV}=${JSON.stringify(raw)} (expected auto|signal|byte)`
  );
  return "auto";
}

const ctrlCMode = resolveCtrlCModeFromEnv();

function terminalSignalsEnabled(ptyTerminal: Bun.Terminal): boolean {
  if (ctrlCMode === "signal") {
    return true;
  }

  if (ctrlCMode === "byte") {
    return false;
  }

  const isigFlag = ISIG_FLAG_BY_PLATFORM[process.platform];
  if (typeof isigFlag !== "number") {
    // Unknown platform: keep signal behavior so Ctrl+C still interrupts by default.
    return true;
  }

  // Closed terminals report 0; default to signal behavior in that edge case.
  const flags = ptyTerminal.localFlags;
  if (typeof flags !== "number" || flags === 0) {
    return true;
  }

  return (flags & isigFlag) !== 0;
}

function sendInterruptSignal(proc: Bun.Subprocess): boolean {
  try {
    process.kill(-proc.pid, 'SIGINT');
    return true;
  } catch {}

  try {
    process.kill(proc.pid, 'SIGINT');
    return true;
  } catch {}

  return false;
}

// ============================================================================
// OSC Pattern Registry
// ============================================================================

/**
 * Registry of OSC (Operating System Command) patterns for terminal notifications.
 * Each pattern matches specific escape sequences and extracts relevant data.
 */
interface OscPattern {
  name: string;
  pattern: RegExp;
  /** Extract notification data from a match. Returns null to skip notification. */
  extract: (match: RegExpMatchArray, context: OscMatchContext) => OscNotificationData | null;
}

interface OscMatchContext {
  sessionId: string;
  sessionName: string;
  processTitle: string;
  xterm: XTerminal;
  now: number;
}

interface OscNotificationData {
  type: InboxItem['type'];
  context: string;
  exitCode?: number;
}

const OSC_PATTERNS: OscPattern[] = [
  {
    // Custom exit code: ESC ] 777 ; exit : <code> BEL
    name: 'exit',
    pattern: /\x1b\]777;exit:(-?\d+)\x07/g,
    extract: (match, ctx) => ({
      type: 'exit',
      exitCode: parseInt(match[1], 10),
      context: getCurrentLine(ctx.xterm) || `Exit code: ${match[1]}`,
    }),
  },
  {
    // iTerm2/Growl notification: ESC ] 9 ; message BEL
    name: 'osc9',
    pattern: /\x1b\]9;([^\x07]*)\x07/g,
    extract: (match) => match[1] ? { type: 'osc', context: match[1] } : null,
  },
  {
    // Kitty notification: ESC ] 99 ; i=id:d=0; body BEL (simplified)
    name: 'osc99',
    pattern: /\x1b\]99;[^;]*;([^\x07]*)\x07/g,
    extract: (match) => match[1] ? { type: 'osc', context: match[1] } : null,
  },
  {
    // rxvt notification: ESC ] 777 ; notify ; title ; body BEL
    name: 'osc777notify',
    pattern: /\x1b\]777;notify;([^;]*);([^\x07]*)\x07/g,
    extract: (match) => ({
      type: 'osc',
      context: match[2] || match[1] || 'Notification',
    }),
  },
];

// Semantic shell integration patterns (OSC 133) - handled separately due to state tracking
const OSC_133_DONE_PATTERN = /\x1b\]133;D(?:;(\d+))?\x07/g;
const OSC_133_CMD_START = /\x1b\]133;C\x07/g;

/**
 * Process OSC patterns in terminal output and create inbox notifications.
 */
function processOscPatterns(
  str: string,
  ctx: OscMatchContext,
  addNotification: (data: OscNotificationData) => void
): void {
  for (const { name, pattern, extract } of OSC_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = [...str.matchAll(pattern)];
    for (const match of matches) {
      const data = extract(match, ctx);
      if (data) {
        addNotification(data);
        console.log(`[${ctx.sessionName}] ${name} notification: ${data.context.substring(0, 50)}`);
      }
    }
  }
}

// ============================================================================
// Inbox Notification Helpers
// ============================================================================

/**
 * Creates an inbox item with common fields populated.
 */
function createInboxNotification(
  sessionId: string,
  sessionName: string,
  type: InboxItem['type'],
  context: string,
  processTitle?: string,
  exitCode?: number
): Omit<InboxItem, 'id' | 'read'> {
  return {
    sessionId,
    sessionName,
    type,
    timestamp: Date.now(),
    context,
    processTitle,
    exitCode,
  };
}

// Check if user is actively using the session or recently attached/detached
// Returns true if we should SUPPRESS notifications
function isActivelyUsing(session: SessionData | undefined): boolean {
  if (!session) return false;

  const now = Date.now();

  // If recently detached, still suppress notifications (grace period)
  if (session.lastDetached > 0) {
    const timeSinceDetach = now - session.lastDetached;
    if (timeSinceDetach < DETACH_GRACE_MS) {
      return true; // Suppress - just detached
    }
  }

  // If not attached, don't suppress (unless in grace period above)
  if (!session.info.attached) return false;

  // If recently attached, suppress notifications (startup grace period)
  if (session.lastAttached > 0) {
    const timeSinceAttach = now - session.lastAttached;
    if (timeSinceAttach < ATTACH_GRACE_MS) {
      return true; // Suppress - just attached
    }
  }

  // If attached but never interacted AND past the attach grace period, don't suppress
  if (session.lastInteraction === 0) return false;

  // If attached and recently interacted, suppress
  const timeSinceInteraction = now - session.lastInteraction;
  return timeSinceInteraction < INTERACTION_TIMEOUT_MS;
}

let sessionCounter = 0;
let inboxCounter = 0;

function genId(): string {
  return String(sessionCounter++);
}

function genInboxId(): string {
  return String(inboxCounter++);
}

function addInboxItem(item: Omit<InboxItem, 'id' | 'read'>): void {
  // Check if this notification type is enabled in config
  if (!isNotificationTypeEnabled(item.type)) {
    return;
  }

  inbox.push({
    ...item,
    id: genInboxId(),
    read: false,
  });
  console.log(`[inbox] ${item.type}: ${item.sessionName} - ${item.context.substring(0, 50)}`);

  // Update titles for all attached sessions to show new inbox count
  broadcastTitleUpdate();
}

/**
 * Prune inbox items for a destroyed session.
 * This removes all notifications associated with a session when it exits,
 * keeping the inbox clean and ensuring the count only reflects active sessions.
 */
function pruneInboxForSession(sessionId: string): void {
  // Find and remove all inbox items for this session
  let i = inbox.length;
  while (i--) {
    if (inbox[i].sessionId === sessionId) {
      inbox.splice(i, 1);
    }
  }
  console.log(`[inbox] Pruned notifications for session ${sessionId}`);
}

function getLastLines(xterm: XTerminal, count: number): string {
  const buffer = xterm.buffer.active;
  const lines: string[] = [];
  const startRow = Math.max(0, buffer.cursorY - count + 1);

  for (let i = startRow; i <= buffer.cursorY; i++) {
    const line = buffer.getLine(i)?.translateToString(true);
    if (line) lines.push(line);
  }

  return lines.join('\n').trim();
}

function getCurrentLine(xterm: XTerminal): string {
  const buffer = xterm.buffer.active;
  return buffer.getLine(buffer.cursorY)?.translateToString(true)?.trim() || '';
}

/**
 * Get count of unread inbox items, bounded by active sessions.
 * Returns the number of unique active sessions that have unread notifications,
 * not the total number of unread items. This prevents the count from growing
 * unboundedly (e.g., to 3000) and instead caps it at one per active session.
 */
function getUnreadInboxCount(): number {
  // Get unique session IDs that have unread items AND are still active
  const activeSessionsWithUnread = new Set<string>();
  
  for (const item of inbox) {
    if (!item.read && sessions.has(item.sessionId)) {
      activeSessionsWithUnread.add(item.sessionId);
    }
  }
  
  return activeSessionsWithUnread.size;
}

function buildTitle(sessionName: string, processTitle?: string): string {
  const unread = getUnreadInboxCount();
  let title = `tl: ${sessionName}`;

  if (processTitle) {
    title += ` | ${processTitle}`;
  }

  if (unread > 0) {
    title += ` (${unread} 🔔)`;
  }

  return title;
}

function sendTitle(session: SessionData, sessionName: string, processTitle?: string): void {
  if (!session.client) return;
  const title = buildTitle(sessionName, processTitle);
  // OSC 0 sets both icon and window title - must be framed!
  writeToClient(session, encodePTY(Buffer.from(`\x1b]0;${title}\x07`)));
}

function broadcastTitleUpdate(): void {
  // Update title for all attached sessions
  for (const [id, session] of sessions) {
    if (session.client) {
      sendTitle(session, session.info.name, session.processTitle);
    }
  }
}

// RIS (Reset to Initial State) - the nuclear option that resets everything
const TERM_RESET = Buffer.from("\x1bc");

// ============================================================================
// Session Helper Functions
// ============================================================================

/**
 * Configuration for idle detection in a session.
 */
interface IdleDetectionState {
  lastOutputTime: number;
  outputSinceIdle: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const IDLE_THRESHOLD_MS = 10000; // 10 seconds of quiet after output
const MIN_OUTPUT_FOR_IDLE = 500; // Need at least 500 bytes of output to consider "activity"

/**
 * Creates the idle detection check function for a session.
 */
function createIdleChecker(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  idleState: IdleDetectionState,
  getProcessTitle: () => string
): () => void {
  return () => {
    const session = sessions.get(id);
    // Only notify if: not actively using, had significant output, and now idle
    if (!isActivelyUsing(session) && idleState.outputSinceIdle >= MIN_OUTPUT_FOR_IDLE) {
      const context = getLastLines(xterm, 3) || '(idle)';
      addInboxItem(createInboxNotification(
        id,
        sessionName,
        'idle',
        context,
        session?.processTitle || getProcessTitle()
      ));
      console.log(`[${sessionName}] idle notification after ${idleState.outputSinceIdle} bytes output`);
    }
    idleState.outputSinceIdle = 0;
  };
}

/**
 * Sets up xterm event handlers for bell and title change notifications.
 */
function setupXtermEventHandlers(
  id: string,
  sessionName: string,
  xterm: XTerminal
): { getProcessTitle: () => string; setProcessTitle: (title: string) => void } {
  let processTitle = '';
  let lastBellTime = 0;
  let lastTitleNotification = 0;

  // Track bells for inbox notifications (with debounce)
  xterm.onBell(() => {
    const session = sessions.get(id);
    // Don't notify if user is actively using the session
    if (isActivelyUsing(session)) return;

    const now = Date.now();
    // Debounce: ignore bells within 500ms of each other
    if (now - lastBellTime < 500) return;
    lastBellTime = now;

    // Get last few lines for context (not just current line)
    const context = getLastLines(xterm, 3) || getCurrentLine(xterm) || '(bell)';
    addInboxItem(createInboxNotification(
      id,
      sessionName,
      'bell',
      context,
      session?.processTitle
    ));
  });

  // Track title changes from running processes
  xterm.onTitleChange((title) => {
    console.log(`[${sessionName}] title changed: "${title}"`);
    const previousTitle = processTitle;
    processTitle = title;
    const session = sessions.get(id);
    if (session) {
      session.processTitle = title;
      // Update client's terminal title if attached
      if (session.client) {
        sendTitle(session.client, sessionName, title);
      }

      // Create inbox notification for ANY title change when not actively using
      // This helps track when background processes change state
      const now = Date.now();
      if (!isActivelyUsing(session) && title && title !== previousTitle) {
        // Debounce: don't notify more than once per 3 seconds
        if (now - lastTitleNotification > 3000) {
          lastTitleNotification = now;
          addInboxItem(createInboxNotification(
            id,
            sessionName,
            'title',
            title,
            title
          ));
          console.log(`[${sessionName}] title change: ${previousTitle} -> ${title}`);
        }
      }
    }
  });

  return {
    getProcessTitle: () => processTitle,
    setProcessTitle: (title: string) => { processTitle = title; },
  };
}

/**
 * State for tracking OSC 133 shell integration commands.
 */
interface Osc133State {
  commandRunning: boolean;
  commandStartTime: number;  // Timestamp when command started (for duration filter)
}

/**
 * Creates the PTY data handler that processes terminal output.
 */
function createPtyDataHandler(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  idleState: IdleDetectionState,
  osc133State: Osc133State,
  checkIdle: () => void,
  getProcessTitle: () => string
): (term: Bun.Terminal, data: Buffer) => void {
  return (term, data) => {
    // Track output for idle detection
    idleState.lastOutputTime = Date.now();
    idleState.outputSinceIdle += data.length;

    // Reset idle timer
    if (idleState.idleTimer) clearTimeout(idleState.idleTimer);
    idleState.idleTimer = setTimeout(checkIdle, IDLE_THRESHOLD_MS);

    const session = sessions.get(id);
    if (!session) return;

    const str = data.toString();
    const now = Date.now();

    // Only create inbox notifications if user is not actively using the session
    const activelyUsing = session.attaching || isActivelyUsing(session);
    const currentProcessTitle = session.processTitle || getProcessTitle();

    // Process OSC patterns for notifications (only if not actively using)
    if (!activelyUsing) {
      const oscContext: OscMatchContext = {
        sessionId: id,
        sessionName,
        processTitle: currentProcessTitle,
        xterm,
        now,
      };

      processOscPatterns(str, oscContext, (notifData) => {
        addInboxItem(createInboxNotification(
          id,
          sessionName,
          notifData.type,
          notifData.context,
          currentProcessTitle,
          notifData.exitCode
        ));
      });
    }

    // Check for semantic shell integration (OSC 133)
    // Command start
    if (OSC_133_CMD_START.test(str)) {
      osc133State.commandRunning = true;
      osc133State.commandStartTime = now;
      OSC_133_CMD_START.lastIndex = 0; // Reset regex state
    }

    // Command done - only notify if not actively using and command was running
    OSC_133_DONE_PATTERN.lastIndex = 0;
    const osc133DoneMatches = [...str.matchAll(OSC_133_DONE_PATTERN)];
    for (const match of osc133DoneMatches) {
      const exitCode = match[1] ? parseInt(match[1], 10) : 0;
      const commandDuration = osc133State.commandStartTime > 0
        ? now - osc133State.commandStartTime
        : 0;

      // Only notify for background sessions if:
      // - Non-zero exit (always notify on errors)
      // - OR command duration >= minCommandDurationMs
      const shouldNotify = !activelyUsing && (
        exitCode !== 0 ||
        (osc133State.commandRunning && commandDuration >= notificationConfig.minCommandDurationMs)
      );

      if (shouldNotify) {
        const context = getLastLines(xterm, 2) || `Command finished (exit ${exitCode})`;
        addInboxItem(createInboxNotification(
          id,
          sessionName,
          exitCode !== 0 ? 'exit' : 'osc',
          context,
          currentProcessTitle,
          exitCode !== 0 ? exitCode : undefined
        ));
        console.log(`[${sessionName}] OSC 133 command done: exit ${exitCode}, duration ${commandDuration}ms`);
      }
      osc133State.commandRunning = false;
      osc133State.commandStartTime = 0;
    }

    // Pass original data through unchanged to preserve all escape sequences
    // Our custom OSC 777 exit sequences are harmless - terminals ignore unknown OSC
    // Converting to string and back was corrupting cursor movement/screen control sequences

    if (session.attaching) {
      session.attachBuffer.push(Buffer.from(data));
      return;
    }

    // Feed data to xterm-headless for state tracking
    session.pendingWrites++;
    xterm.write(data, () => {
      session.pendingWrites--;
    });

    // Send to client (buffered - avoid framed protocol desync on backpressure)
    writeToClient(session, encodePTY(data));
  };
}

/**
 * Handles process exit and cleanup for a session.
 */
function handleProcessExit(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  socketPath: string,
  disposeDsr: () => void,
  getProcessTitle: () => string
): (code: number) => void {
  return (code) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    // Clean up parser hooks
    try { disposeDsr(); } catch {}

    // Prune old inbox items for this session so inbox stays bounded to active sessions.
    // Do this before adding the final exit notification so the user still sees the exit event.
    pruneInboxForSession(id);

    // Capture last lines for inbox before disposing xterm
    const context = getLastLines(xterm, 3);
    addInboxItem(createInboxNotification(
      id,
      sessionName,
      'exit',
      context || `Session ended (exit ${code})`,
      session?.processTitle || getProcessTitle(),
      code
    ));

    // Update session info with exit code
    session.info.exitCode = code;

    if (session.client) {
      writeToClient(session, encodeControl({ type: "exited", code }));
      try { session.client.end(); } catch {}
    }

    xterm.dispose();
    cleanupSessionResources(session);
    console.log(`[${sessionName}] exited (${code})`);
  };
}

/**
 * Sends cursor visibility and style state to the client.
 */
function sendCursorState(session: SessionData): void {
  // Access xterm internal API for cursor hidden state
  // Note: _core is not part of the public API but is stable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xtermInternal = session.xterm as { _core?: { coreService?: { isCursorHidden?: boolean } } };
  const isCursorHidden = xtermInternal._core?.coreService?.isCursorHidden;
  if (typeof isCursorHidden === "boolean") {
    writeToClient(session, encodePTY(Buffer.from(isCursorHidden ? "\x1b[?25l" : "\x1b[?25h")));
  }

  const cursorStyle = session.xterm.options.cursorStyle;
  const cursorBlink = session.xterm.options.cursorBlink;
  let cursorStyleParam: number | null = null;
  if (cursorStyle === "block") {
    cursorStyleParam = cursorBlink ? 2 : 1;
  } else if (cursorStyle === "underline") {
    cursorStyleParam = cursorBlink ? 4 : 3;
  } else if (cursorStyle === "bar") {
    cursorStyleParam = cursorBlink ? 6 : 5;
  }
  if (cursorStyleParam !== null) {
    writeToClient(session, encodePTY(Buffer.from(`\x1b[${cursorStyleParam} q`)));
  }
}

/**
 * Clears the attach timer for a session.
 */
function clearAttachTimer(session: SessionData): void {
  if (session.attachTimer) {
    clearTimeout(session.attachTimer);
    session.attachTimer = null;
  }
}

/**
 * Sends serialized terminal state to client during attach.
 */
function sendSerializedState(session: SessionData, sessionName: string): void {
  // Debug mode: skip xterm serialization to test if it's the issue
  const skipSerialize = process.env.TMUX_LITE_SKIP_SERIALIZE === '1';

  try {
    // Send reset first to clear any bad modes
    console.log(`[${sessionName}] sending TERM_RESET`);
    writeToClient(session, encodePTY(TERM_RESET));
    writeToClient(session, encodePTY(Buffer.from("\x1b[2J\x1b[H"))); // clear + home

    if (!skipSerialize) {
      // Get serialized terminal state (including modes) for consistent redraws
      // Limit scrollback to prevent oversized payloads
      const serialized = session.serialize.serialize({
        scrollback: SERIALIZE_SCROLLBACK_LINES,
      });
      const serializedBytes = Buffer.from(serialized);

      // Log size for debugging
      const sizeKB = Math.round(serializedBytes.length / 1024);
      if (serializedBytes.length > PTY_CHUNK_SIZE) {
        console.log(`[${sessionName}] serialized ${serializedBytes.length} bytes (${sizeKB}KB) - will send in chunks`);
      } else {
        console.log(`[${sessionName}] serialized ${serializedBytes.length} bytes (${sizeKB}KB)`);
      }

      // Send in chunks if too large for a single frame
      if (serializedBytes.length > PTY_CHUNK_SIZE) {
        let offset = 0;
        let chunkNum = 0;
        while (offset < serializedBytes.length) {
          const chunkEnd = Math.min(offset + PTY_CHUNK_SIZE, serializedBytes.length);
          const chunk = serializedBytes.subarray(offset, chunkEnd);
          writeToClient(session, encodePTY(chunk));
          chunkNum++;
          offset = chunkEnd;
        }
        console.log(`[${sessionName}] attached (restored ${serializedBytes.length} bytes in ${chunkNum} chunks)`);
      } else {
        writeToClient(session, encodePTY(serializedBytes));
        console.log(`[${sessionName}] attached (restored ${serializedBytes.length} bytes)`);
      }
    } else {
      console.log(`[${sessionName}] attached (serialization skipped for debugging)`);
    }
  } catch (e) {
    console.log(`[${sessionName}] serialize error:`, e);
    // Fallback: just send a reset
    writeToClient(session, encodePTY(TERM_RESET));
    writeToClient(session, encodePTY(Buffer.from("\x1b[2J\x1b[H")));
  }
}

/**
 * Creates the startAttach function that handles the attach process.
 */
function createStartAttach(sessionName: string): (session: SessionData) => void {
  return (session: SessionData) => {
    if (!session.attachPending || !session.client) return;
    session.attachPending = false;
    clearAttachTimer(session);

    // Wait for any pending xterm writes to complete
    const sendState = () => {
      if (session.pendingWrites > 0) {
        setTimeout(sendState, 10);
        return;
      }

      sendSerializedState(session, sessionName);
      sendCursorState(session);

      writeToClient(session, encodeControl({ type: "attach-ready", cols: session.xterm.cols, rows: session.xterm.rows }));

      const drainAttachBuffer = () => {
        const buffered = session.attachBuffer;
        session.attachBuffer = [];
        for (const chunk of buffered) {
          session.pendingWrites++;
          session.xterm.write(chunk, () => {
            session.pendingWrites--;
          });
          writeToClient(session, encodePTY(chunk));
        }
      };

      const attachStart = Date.now();
      const finalizeAttach = () => {
        if (session.attachBuffer.length > 0) {
          drainAttachBuffer();
        }

        if ((session.pendingWrites > 0 || session.attachBuffer.length > 0) &&
            Date.now() - attachStart < 200) {
          setTimeout(finalizeAttach, 10);
          return;
        }

        session.attaching = false;

        writeToClient(session, encodeControl({ type: "attached" }));

        // Set terminal title
        sendTitle(session, sessionName, session.processTitle);
      };

      finalizeAttach();
    };

    sendState();
  };
}

/**
 * Creates socket handlers for a session.
 */
function createSessionSocketHandlers(
  id: string,
  sessionName: string,
  proc: Bun.Subprocess,
  startAttach: (session: SessionData) => void
): {
  open: (socket: any) => void;
  data: (socket: any, data: Buffer) => void;
  drain: (socket: any) => void;
  close: (socket: any) => void;
} {
  return {
    open(socket) {
      const session = sessions.get(id);
      if (!session) return socket.end();

      // Kick existing client
      if (session.client) {
        writeToClient(session, encodeControl({ type: "kicked" }));
        session.client.end();
      }

      session.attaching = true;
      session.attachPending = true;
      session.attachBuffer = [];
      session.client = socket;
      session.clientWriter = createBufferedSocketWriter(socket);
      session.info.attached = true;
      session.lastAttached = Date.now(); // Record attach time for grace period
      session.ctrlBuffer = Buffer.alloc(0);
      clearAttachTimer(session);
      // Fallback timeout - client should send attach-init immediately, but just in case
      session.attachTimer = setTimeout(() => {
        if (session.attachPending) {
          console.log(`[${sessionName}] WARN: attach-init not received after 5s, starting attach anyway`);
          startAttach(session);
        }
      }, 5000);
    },

    data(socket, data) {
      const session = sessions.get(id);
      if (!session) return;

      const applyResize = (cols: number, rows: number) => {
        try {
          session.ptyTerminal.resize(cols, rows);
          session.xterm.resize(cols, rows);
          // Send SIGWINCH to process group so children (vim, etc.) get it
          try {
            process.kill(-proc.pid, "SIGWINCH");
          } catch {
            try {
              process.kill(proc.pid, "SIGWINCH");
            } catch {}
          }
        } catch {}
      };

      let buf = Buffer.from(data);

      // Prepend any buffered data
      if (session.ctrlBuffer.length > 0) {
        buf = Buffer.concat([session.ctrlBuffer, buf]);
      }

      // Parse frames using the new framed protocol
      let frames;
      let remaining;
      try {
        const result = parseFrames(buf);
        frames = result.frames;
        remaining = result.remaining;
      } catch (err) {
        // Protocol error - likely desync or corrupted data
        const msg = err instanceof Error ? err.message : 'Frame parse error';
        console.error(`[${sessionName}] Frame parse error: ${msg}`);
        // Close the client connection on protocol error
        socket.end();
        return;
      }
      // Copy remaining bytes - subarray references can become invalid when Bun reuses buffers
      session.ctrlBuffer = Buffer.from(remaining);

      for (const frame of frames) {
        if (frame.type === FrameType.CONTROL) {
          const ctrl = decodeControl(frame.payload) as SessionCtrl;
          if (ctrl.type === "resize" || ctrl.type === "attach-init") {
            applyResize(ctrl.cols, ctrl.rows);
            if (session.attaching && session.attachPending) {
              startAttach(session);
            }
          } else if (ctrl.type === "detach") {
            // Send reset before detaching to clean up client terminal
            writeToClient(session, encodePTY(TERM_RESET));
            session.client = null;
            session.clientWriter = null;
            session.info.attached = false;
            session.attaching = false;
            session.attachPending = false;
            clearAttachTimer(session);
            session.attachBuffer = [];
            session.lastDetached = Date.now(); // Record detach time for grace period
            socket.end();
            console.log(`[${sessionName}] detached`);
          }
        } else if (frame.type === FrameType.PTY) {
          // Workaround for Bun PTY Ctrl+C line-discipline behavior.
          // Auto mode respects raw-mode apps (ISIG off => pass ETX through).
          // Override with TMUX_LITE_CTRL_C_MODE=signal|byte.
          if (frame.payload.length === 1 && frame.payload[0] === ETX_BYTE) {
            const shouldSignal = terminalSignalsEnabled(session.ptyTerminal);
            if (shouldSignal) {
              const signaled = sendInterruptSignal(proc);
              if (!signaled) {
                session.ptyTerminal.write(frame.payload);
              }
            } else {
              session.ptyTerminal.write(frame.payload);
            }
          } else {
            // Raw PTY input - write to terminal
            session.ptyTerminal.write(frame.payload);
          }
          // Track last interaction time
          session.lastInteraction = Date.now();
        }
      }
    },

    drain(socket) {
      const session = sessions.get(id);
      if (session && session.client === socket) {
        flushClient(session);
      }
    },

    close(socket) {
      const session = sessions.get(id);
      if (session && session.client === socket) {
        session.client = null;
        session.clientWriter = null;
        session.info.attached = false;
        session.attaching = false;
        session.attachPending = false;
        clearAttachTimer(session);
        session.attachBuffer = [];
        console.log(`[${sessionName}] disconnected`);
      }
    }
  };
}

/**
 * Builds the shell environment with integration hooks.
 */
function buildShellEnvironment(
  id: string,
  shell: string,
  hooks?: SessionCreateHooks
): Record<string, string> {
  // Shell integration: report non-zero exit codes via OSC 777
  // This creates inbox notifications for failed commands
  const exitReporter = '__tl_report() { local e=$?; [[ $e -ne 0 ]] && printf "\\033]777;exit:%d\\007" "$e"; return $e; }';

  const shellEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TMUX_LITE: id,
    ...(hooks?.env ?? {}),
  };

  const shellName = shell.split('/').pop() ?? '';

  // Add PROMPT_COMMAND only for bash-compatible shells.
  if (shellName === 'bash' || shellName === 'rbash') {
    const existingPrompt = process.env.PROMPT_COMMAND || '';
    shellEnv.PROMPT_COMMAND = `${exitReporter}; __tl_report${existingPrompt ? '; ' + existingPrompt : ''}`;
  }

  return shellEnv;
}

function getShellInitScript(shell: string, hooks?: SessionCreateHooks): string | null {
  const shellInit = hooks?.shellInit;
  if (!shellInit) return null;

  const shellName = shell.split('/').pop() ?? '';
  const scriptParts: string[] = [];

  if (shellInit.all) {
    scriptParts.push(shellInit.all);
  }

  const isBashShell = shellName === 'bash' || shellName === 'rbash';
  const isZshShell = shellName === 'zsh';
  const isShShell = shellName === 'sh' || shellName === 'dash';

  if (isBashShell && shellInit.bash) {
    scriptParts.push(shellInit.bash);
  } else if (isZshShell && shellInit.zsh) {
    scriptParts.push(shellInit.zsh);
  } else if (isShShell && shellInit.sh) {
    scriptParts.push(shellInit.sh);
  }

  if (scriptParts.length === 0) {
    return null;
  }

  return `${scriptParts.join('\n')}\n`;
}

function cleanupFailedSessionCreation(
  sessionName: string,
  proc: Bun.Subprocess,
  xterm: XTerminal,
  disposeDsr: () => void,
  socketPath: string
): void {
  try { disposeDsr(); } catch {}
  try { proc.kill(9); } catch {}
  try { xterm.dispose(); } catch {}
  safeUnlink(socketPath);
  console.warn(`[${sessionName}] cleaned up failed session startup`);
}

// ============================================================================
// Main Session Creation
// ============================================================================

function createSession(
  name: string | undefined,
  cwd: string,
  options?: {
    hooks?: SessionCreateHooks;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }
): Session {
  const id = genId();
  const sessionName = name || `session-${id}`;
  const socketPath = getSessionSocketPath(id);
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }
  safeUnlink(socketPath);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Create xterm-headless for proper terminal state tracking
  const xterm = new XTerminal({
    cols,
    rows,
    // Keep stored scrollback bounded; match ghostty-web default (10k).
    // Note: attach serialization is additionally capped by SERIALIZE_SCROLLBACK_LINES.
    scrollback: 10_000,
    allowProposedApi: true,
  });

  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize);

  // Set up xterm event handlers for notifications (bell, title changes)
  const { getProcessTitle } = setupXtermEventHandlers(id, sessionName, xterm);

  // Initialize idle detection state
  const idleState: IdleDetectionState = {
    lastOutputTime: 0,
    outputSinceIdle: 0,
    idleTimer: null,
  };

  // Initialize OSC 133 state for shell integration
  const osc133State: Osc133State = {
    commandRunning: false,
    commandStartTime: 0,
  };

  // Create the idle checker function
  const checkIdle = createIdleChecker(id, sessionName, xterm, idleState, getProcessTitle);

  // Create PTY terminal with data handler
  const ptyDataHandler = createPtyDataHandler(
    id,
    sessionName,
    xterm,
    idleState,
    osc133State,
    checkIdle,
    getProcessTitle
  );

  const ptyTerminal = new Bun.Terminal({
    cols,
    rows,
    data: ptyDataHandler,
  });

  // Terminal query support (server-side): respond to DSR (CSI 6 n) with CPR.
  const disposeDsr = installDsrCprResponder(xterm, (data) => {
    try { ptyTerminal.write(data); } catch {}
  });

  // Spawn shell process (or custom command if provided)
  const shell = process.env.SHELL || "/bin/bash";
  const hooks = options?.hooks;
  const shellEnv = buildShellEnvironment(id, shell, hooks);

  const spawnCmd = options?.command
    ? [options.command, ...(options.args ?? [])]
    : [shell];
  const spawnEnv = options?.env
    ? { ...shellEnv, ...options.env }
    : shellEnv;

  const proc = Bun.spawn(spawnCmd, {
    terminal: ptyTerminal,
    cwd,
    env: spawnEnv,
  });

  const shellInitScript = getShellInitScript(shell, hooks);
  if (shellInitScript) {
    try {
      ptyTerminal.write(shellInitScript);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${sessionName}] failed to apply shell init hook: ${message}`);
    }
  }

  // Handle process exit
  proc.exited.then(handleProcessExit(id, sessionName, xterm, socketPath, disposeDsr, getProcessTitle));

  // Create session info
  const info: Session = {
    id,
    name: sessionName,
    socketPath,
    pid: proc.pid,
    attached: false,
    cwd,
    createdAt: Date.now(),
  };

  // Create attach handler
  const startAttach = createStartAttach(sessionName);

  // Create and bind socket handlers
  const socketHandlers = createSessionSocketHandlers(id, sessionName, proc, startAttach);

  // Create session socket
  let listener;
  try {
    listener = Bun.listen({
      unix: socketPath,
      socket: socketHandlers,
    });
  } catch (error) {
    cleanupFailedSessionCreation(sessionName, proc, xterm, disposeDsr, socketPath);
    throw error;
  }

  // Store session data
  sessions.set(id, {
    info,
    listener,
    ptyTerminal,
    xterm,
    serialize,
    proc,
    client: null,
    clientWriter: null,
    ctrlBuffer: Buffer.alloc(0),
    pendingWrites: 0,
    attaching: false,
    attachBuffer: [],
    attachPending: false,
      attachTimer: null,
      processTitle: '',
      lastInteraction: 0,  // No interaction yet
      lastDetached: 0,  // Never detached yet
      lastAttached: 0,  // Never attached yet (will be set on first attach)
    });

  console.log(`[${sessionName}] created (pid ${proc.pid})`);
  return info;
}

// Router server
routerListener = Bun.listen({
  unix: ROUTER_SOCKET,
  socket: {
    open(socket) {
      const socketState = getRouterSocketState(socket);
      socketState.writer = createBufferedSocketWriter(socket as any);
    },
    close(socket) {
      clearRouterSocketState(socket);
    },

    async data(socket, data) {
      const socketState = getRouterSocketState(socket);
      const combined = Buffer.concat([socketState.buffer, Buffer.from(data)]);
      let decoded;

      try {
        decoded = decodeRouterMessages(combined);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid request";
        if (socketState.writer) socketState.writer.write(encodeRouterMessage({ type: "error", message }));
        else socket.write(encodeRouterMessage({ type: "error", message }));
        socketState.buffer = Buffer.alloc(0);
        return;
      }

      socketState.buffer = decoded.remaining;

      for (const message of decoded.messages) {
        const cmd = message as Command;
        let res: Response;

        // Helper to get session info with current processTitle
        const getSessionInfo = (s: SessionData): Session => ({
          ...s.info,
          processTitle: s.processTitle || undefined,
        });

        switch (cmd.type) {
          case "list":
            res = {
              type: "sessions",
              sessions: Array.from(sessions.values()).map(getSessionInfo)
            };
            break;

          case "new":
            try {
              const session = createSession(cmd.name, cmd.cwd, {
                hooks: cmd.hooks,
                command: cmd.command,
                args: cmd.args,
                env: cmd.env,
              });
              res = { type: "session", session };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.error(`[server] createSession failed: ${errMsg}`);
              res = { type: "error", message: `Failed to create session: ${errMsg}` };
            }
            break;

          case "attach": {
            const s = sessions.get(cmd.id);
            if (!s) {
              res = { type: "error", message: `Session ${cmd.id} not found` };
            } else if (s.info.attached && !cmd.force) {
              res = { type: "already-attached", session: getSessionInfo(s) };
            } else {
              res = { type: "session", session: getSessionInfo(s) };
            }
            break;
          }

          case "kill": {
            const s = sessions.get(cmd.id);
            if (!s) {
              res = { type: "error", message: `Session ${cmd.id} not found` };
            } else {
              // Use SIGKILL to forcefully terminate - SIGTERM is often ignored by shells
              s.proc.kill(9);
              res = { type: "ok" };
            }
            break;
          }

          case "kill-server":
            console.log("Shutting down...");
            res = { type: "ok" };
            if (socketState.writer) socketState.writer.write(encodeRouterMessage(res));
            else socket.write(encodeRouterMessage(res));
            // Clean up socket file after sending response, before exit
            setTimeout(() => {
              shutdownServer();
              process.exit(0);
            }, 100);
            return;

          case "inbox":
            res = { type: "inbox", items: [...inbox] };
            break;

          case "inbox-clear":
            if (cmd.id) {
              const idx = inbox.findIndex(i => i.id === cmd.id);
              if (idx !== -1) inbox.splice(idx, 1);
            } else {
              inbox.length = 0;
            }
            broadcastTitleUpdate();
            res = { type: "ok" };
            break;

          case "inbox-read": {
            const item = inbox.find(i => i.id === cmd.id);
            if (item) item.read = true;
            broadcastTitleUpdate();
            res = { type: "ok" };
            break;
          }

          case "version":
            res = {
              type: "version",
              version: PACKAGE_VERSION,
              protocol: PROTOCOL_VERSION,
            };
            break;

          case "status": {
            const sessionList = Array.from(sessions.values());
            const attachedCount = sessionList.filter(s => s.info.attached).length;
            res = {
              type: "status",
              version: PACKAGE_VERSION,
              protocol: PROTOCOL_VERSION,
              pid: process.pid,
              uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
              sessions: sessionList.length,
              attached: attachedCount,
            };
            break;
          }

          default:
            res = { type: "error", message: "Unknown command" };
        }

        if (socketState.writer) socketState.writer.write(encodeRouterMessage(res));
        else socket.write(encodeRouterMessage(res));
      }
    },
    drain(socket) {
      const socketState = getRouterSocketState(socket);
      socketState.writer?.flush?.();
    }
  }
});

console.log("tmux-lite server running (xterm-headless)");
console.log(`Socket: ${ROUTER_SOCKET}\n`);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    shutdownServer();
    process.exit(0);
  });
}

process.on("exit", () => {
  shutdownServer();
});
