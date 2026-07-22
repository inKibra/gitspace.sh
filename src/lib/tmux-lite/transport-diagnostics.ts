/**
 * Self-diagnosing WebSocket transport instrumentation (ticket #42.4).
 *
 * WHY THIS EXISTS
 * ---------------
 * An oversize-frame / `1006 "Received too big message"` disconnect used to leave
 * exactly one line in the log — the bare `1006` — with no side, no direction, no
 * frame size, no payload type, no producer. Three wrong turns were spent theory-
 * chasing a 6.68MB `machine_snapshot` that chunking (frame-chunk.ts) now splits
 * safely. This module makes the NEXT such condition a ONE-LINE read instead of a
 * theory-chase: every send/recv boundary keeps a rolling ledger, an oversize
 * logical send is flagged AT THE SOURCE naming the producer, and any abnormal
 * close dumps code + reason + last-frame + ledger from that end's OWN view.
 *
 * ENVIRONMENT
 * -----------
 * Loaded in BOTH the browser bundle (client, `remote-session-backend`) and the
 * Bun/node serve daemon (machine, `machine-relay-client` / `session-handler`).
 * It is therefore dependency-light and browser-safe: NO node-only imports (no
 * Buffer, no fs, no trace-log). Diagnostics are routed out through a pluggable
 * sink each environment registers (browser → client-diagnostics ring; server →
 * trace-log + console), so the two ends behave identically.
 *
 * E2E SAFETY
 * ----------
 * Frames are E2E-encrypted. The ledger/guard work at the SEND/RECV boundary
 * where the byte SIZE and an OUTER routing `type` are known. Nothing here
 * decrypts. On the SEND side the machine/client knows the logical message
 * `type` it is about to encrypt (a routing type, e.g. `machine_snapshot`/`pty`/
 * `pong` — not plaintext), which is what makes "name the producer" possible. On
 * the RECV side only the frame size + outer envelope type are recorded.
 */

/**
 * 1MB — mirror of tmux-lite/protocol.ts `MAX_FRAME_SIZE` and the relay protocol
 * limit. Kept as a LOCAL constant (not imported) so this module stays
 * browser-safe: protocol.ts pulls in `Buffer` and the full frame codec. Any
 * logical payload above this bound is flagged by the send-side guard — with
 * chunking it will NOT 1006, but it means a producer is emitting a >1MB logical
 * frame (a new snapshot field, a new payload) that deserves a look at the source.
 */
export const MAX_FRAME_SIZE_BYTES = 1024 * 1024;

/** Default rolling ledger depth kept per socket. */
export const DEFAULT_LEDGER_DEPTH = 20;

export type FrameDirection = 'send' | 'recv';
export type TransportRole = 'machine' | 'client';

export interface FrameLedgerEntry {
  /** epoch ms */
  at: number;
  dir: FrameDirection;
  /** wire/logical byte size of the frame */
  size: number;
  /** best-effort payload/routing type (see peekFrameType) */
  type: string;
}

export type TransportDiagnostic =
  | {
      kind: 'transport-oversize-send';
      /** socket label (connectionId / machineId) */
      socket: string;
      role: TransportRole;
      size: number;
      /** inner data/message type, e.g. machine_snapshot / pty / pong */
      type: string;
      maxFrameSize: number;
      willChunk: boolean;
    }
  | {
      kind: 'transport-close';
      role: TransportRole;
      socket: string;
      code?: number;
      reason?: string;
      lastSent: FrameLedgerEntry | null;
      lastRecv: FrameLedgerEntry | null;
      uptimeMs: number;
      /** true for 1006 / any non-normal (non-1000/1001) close */
      abnormal: boolean;
      /** rolling frame ledger — populated on abnormal close, else empty */
      ledger: FrameLedgerEntry[];
    };

// ── Diagnostic sink ─────────────────────────────────────────────────────────
// Each environment registers ONE sink per process. The browser routes to the
// client-diagnostics ring (→ report bundle); the server routes to trace-log +
// console (→ report.server.traceRing + daemonLogTail). Emitting never throws.

type TransportDiagnosticSink = (diagnostic: TransportDiagnostic) => void;
let sink: TransportDiagnosticSink | null = null;

/** Register (or clear, with null) the process-wide transport diagnostic sink. */
export function setTransportDiagnosticSink(fn: TransportDiagnosticSink | null): void {
  sink = fn;
}

function emitDiagnostic(diagnostic: TransportDiagnostic): void {
  try {
    sink?.(diagnostic);
  } catch {
    // Diagnostics must never be the reason the transport breaks.
  }
}

/** Default human log — console.warn. Overridable per call so the daemon can use
 *  its own `logger`. */
function defaultLog(message: string): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(message);
  } catch {
    /* ignore */
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Best-effort peek of a JSON `type` field from frame/message bytes — the SAME
 * technique the relay uses (server.ts message handler). Encrypted frames won't
 * parse as JSON, so they fall back to `fallback` (default `'data'`, the outer
 * relay envelope type). Never throws.
 */
export function peekFrameType(bytes: Uint8Array | string, fallback = 'data'): string {
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    const obj = JSON.parse(text) as { type?: unknown };
    return typeof obj?.type === 'string' ? obj.type : fallback;
  } catch {
    return fallback;
  }
}

/** True for an abnormal WS close: 1006 or ANY non-normal code (not 1000/1001).
 *  `undefined` (no code) is treated as normal. */
export function isAbnormalClose(code?: number): boolean {
  if (code === undefined) return false;
  return code !== 1000 && code !== 1001;
}

/**
 * Rolling per-socket frame ledger: a bounded (default 20) record of recent
 * frames in both directions, plus the last frame each way. Bounded memory; call
 * `reset()` on reconnect. Cheap: a small array of tiny records, no per-frame
 * allocation storms.
 */
export class FrameLedger {
  private readonly depth: number;
  private readonly entries: FrameLedgerEntry[] = [];
  private lastSentEntry: FrameLedgerEntry | null = null;
  private lastRecvEntry: FrameLedgerEntry | null = null;

  constructor(depth: number = DEFAULT_LEDGER_DEPTH) {
    this.depth = Math.max(1, depth);
  }

  record(dir: FrameDirection, size: number, type: string): void {
    const entry: FrameLedgerEntry = { at: Date.now(), dir, size, type };
    this.entries.push(entry);
    if (this.entries.length > this.depth) {
      this.entries.splice(0, this.entries.length - this.depth);
    }
    if (dir === 'send') this.lastSentEntry = entry;
    else this.lastRecvEntry = entry;
  }

  get lastSent(): FrameLedgerEntry | null {
    return this.lastSentEntry;
  }

  get lastRecv(): FrameLedgerEntry | null {
    return this.lastRecvEntry;
  }

  /** A copy of the current ledger, oldest first. */
  snapshot(): FrameLedgerEntry[] {
    return this.entries.slice();
  }

  reset(): void {
    this.entries.length = 0;
    this.lastSentEntry = null;
    this.lastRecvEntry = null;
  }
}

/**
 * Send-side oversize guard (invariant / early-warning). If a logical payload
 * exceeds MAX_FRAME_SIZE, log a structured warning + emit a
 * `transport-oversize-send` diagnostic naming the producer. Returns true iff it
 * fired. With chunking this will NOT 1006 — it flags any producer emitting a
 * >1MB logical frame at the SOURCE. Cheap (a single size compare) below the cap.
 */
export function guardOversizeSend(opts: {
  socket: string;
  role: TransportRole;
  size: number;
  type: string;
  willChunk?: boolean;
  log?: (message: string) => void;
}): boolean {
  if (opts.size <= MAX_FRAME_SIZE_BYTES) return false;
  const willChunk = opts.willChunk ?? true;
  (opts.log ?? defaultLog)(
    `[transport] OVERSIZE logical send · socket=${opts.socket} role=${opts.role} ` +
      `type=${opts.type} size=${mb(opts.size)} > maxFrame=${mb(MAX_FRAME_SIZE_BYTES)} ` +
      `(willChunk=${willChunk})`,
  );
  emitDiagnostic({
    kind: 'transport-oversize-send',
    socket: opts.socket,
    role: opts.role,
    size: opts.size,
    type: opts.type,
    maxFrameSize: MAX_FRAME_SIZE_BYTES,
    willChunk,
  });
  return true;
}

function fmtEntry(entry: FrameLedgerEntry | null): string {
  if (!entry) return 'none';
  const ageMs = Date.now() - entry.at;
  return `{type=${entry.type} size=${mb(entry.size)} ${ageMs}ms-ago}`;
}

/**
 * Close-summary helper. Builds the `transport-close` diagnostic from this end's
 * OWN view (code, reason, last frame each way, uptime, ledger), logs it, and
 * emits it. On an ABNORMAL close the full rolling ledger is dumped to the log
 * and included in the diagnostic; on a normal close the ledger is omitted (kept
 * cheap). Returns the diagnostic. Never throws.
 */
export function summarizeClose(opts: {
  role: TransportRole;
  socket: string;
  code?: number;
  reason?: string;
  ledger: FrameLedger;
  startedAtMs: number;
  log?: (message: string) => void;
}): Extract<TransportDiagnostic, { kind: 'transport-close' }> {
  const abnormal = isAbnormalClose(opts.code);
  const log = opts.log ?? defaultLog;
  const lastSent = opts.ledger.lastSent;
  const lastRecv = opts.ledger.lastRecv;
  const uptimeMs = opts.startedAtMs > 0 ? Date.now() - opts.startedAtMs : 0;
  const ledgerSnapshot = abnormal ? opts.ledger.snapshot() : [];

  const diagnostic: Extract<TransportDiagnostic, { kind: 'transport-close' }> = {
    kind: 'transport-close',
    role: opts.role,
    socket: opts.socket,
    code: opts.code,
    reason: opts.reason,
    lastSent,
    lastRecv,
    uptimeMs,
    abnormal,
    ledger: ledgerSnapshot,
  };

  log(
    `[transport] close · role=${opts.role} socket=${opts.socket} ` +
      `code=${opts.code ?? 'none'} reason=${opts.reason || 'none'} ` +
      `abnormal=${abnormal} uptimeMs=${uptimeMs} ` +
      `lastSent=${fmtEntry(lastSent)} lastRecv=${fmtEntry(lastRecv)}`,
  );
  if (abnormal && ledgerSnapshot.length > 0) {
    log(
      `[transport] ledger(${ledgerSnapshot.length}) for ${opts.socket}: ` +
        ledgerSnapshot
          .map((entry) => `${entry.dir}:${entry.type}:${(entry.size / 1024).toFixed(0)}KB`)
          .join(' '),
    );
  }

  emitDiagnostic(diagnostic);
  return diagnostic;
}
