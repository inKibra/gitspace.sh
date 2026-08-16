const DEFAULT_TRACE_FILE = 'gitspace-runtime-trace.jsonl';

// Continuous on-disk trace (docs/REPORT-A-PROBLEM.md). Every event is appended
// as it happens — log-level, not a periodic flush — so a frozen daemon leaves
// the full lead-up on disk. Rotated by SIZE so retention spans a long time
// window (a slow human report still finds the events) while disk stays bounded.
const MAX_TRACE_BYTES = 4 * 1024 * 1024; // rotate at 4MB; one .1 backup kept

function isServerRuntime(): boolean {
  // See transport-diagnostics-server.ts: no DOM lib in this program.
  return !('window' in globalThis);
}

function getWorkspaceRootFallback(): string {
  return process.env.GITSPACE_WORKSPACE_ROOT?.trim()
    || process.env.GITSPACE_HOME?.trim()
    || `${process.env.HOME?.trim() || process.cwd()}/gitspace`;
}

function getTraceLogPath(): string {
  const explicit = process.env.GITSPACE_TRACE_FILE?.trim();
  if (explicit) return explicit;
  return `${getWorkspaceRootFallback()}/.agent/${DEFAULT_TRACE_FILE}`;
}

/** Bounded in-memory ring of recent trace events — the FAST path when the
 *  daemon is responsive (the report reads it directly). The on-disk JSONL is
 *  the freeze-safe path the relay tails when the daemon can't answer. */
export interface TraceRingEntry { ts: string; event: string; details?: Record<string, unknown> }
const TRACE_RING_MAX = 400;
const traceRing: TraceRingEntry[] = [];

/** A copy of the recent server trace events, oldest first. */
export function getTraceRing(): TraceRingEntry[] {
  return traceRing.slice();
}

// Synchronous fs, resolved once. Sync append is deliberate: it writes BEFORE a
// freeze can strand a buffered async write. Trace events fire on command/
// snapshot/agent boundaries (not per-keystroke), so the cost is sub-ms.
let fsMod: typeof import('node:fs') | null = null;
let pathMod: typeof import('node:path') | null = null;
let traceDirReady = false;

function ensureFs(): boolean {
  if (fsMod && pathMod) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fsMod = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pathMod = require('node:path');
    return true;
  } catch {
    return false;
  }
}

function rotateIfNeeded(fs: typeof import('node:fs'), tracePath: string): void {
  try {
    const st = fs.statSync(tracePath);
    if (st.size < MAX_TRACE_BYTES) return;
    // Keep exactly one backup; the tail reader stitches both for a long window.
    try { fs.rmSync(`${tracePath}.1`, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tracePath, `${tracePath}.1`);
  } catch { /* no file yet, or stat failed — nothing to rotate */ }
}

export function writeTraceLog(event: string, details?: Record<string, unknown>): void {
  if (!isServerRuntime()) return;
  const ts = new Date().toISOString();
  try {
    traceRing.push({ ts, event, ...(details ? { details } : {}) });
    if (traceRing.length > TRACE_RING_MAX) traceRing.splice(0, traceRing.length - TRACE_RING_MAX);
  } catch { /* never affect the observed path */ }

  if (!ensureFs() || !fsMod || !pathMod) return;
  const fs = fsMod;
  try {
    const tracePath = getTraceLogPath();
    if (!traceDirReady) {
      const dir = pathMod.dirname(tracePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      traceDirReady = true;
    }
    rotateIfNeeded(fs, tracePath);
    fs.appendFileSync(tracePath, `${JSON.stringify({ ts, pid: process.pid, event, ...(details ?? {}) })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Tracing must never affect the runtime path it is observing.
  }
}

/**
 * The recent on-disk trace as text (current file + one rotated backup, tail-
 * capped). This is what the relay reads to reconstruct the server-side chain
 * of events when the daemon is frozen and can't hand over its in-memory ring.
 */
export function readRecentTraceFromDisk(maxBytes = 512 * 1024): string {
  if (!ensureFs() || !fsMod) return '';
  const fs = fsMod;
  const tracePath = getTraceLogPath();
  const parts: string[] = [];
  for (const p of [`${tracePath}.1`, tracePath]) {
    try { parts.push(fs.readFileSync(p, 'utf8')); } catch { /* absent */ }
  }
  const joined = parts.join('');
  return joined.length > maxBytes ? joined.slice(joined.length - maxBytes) : joined;
}

export function getRuntimeTraceLogPath(): string {
  if (!isServerRuntime()) return '';
  return getTraceLogPath();
}
