/**
 * Client diagnostics ring (docs/REPORT-A-PROBLEM.md, stage 1).
 *
 * A bounded in-memory ring of recent client-side errors, fed by the global
 * error hooks. This is the raw material a "report a problem" bundle draws
 * from — today it exists so that a blank page / freeze / failed transcript
 * load leaves a trace instead of vanishing. Dependency-free and browser-only.
 *
 * Nothing here throws: diagnostics must never be the reason the app breaks.
 */

export interface DiagnosticEntry {
  /** epoch ms */
  t: number;
  kind: 'error' | 'unhandledrejection' | 'console.error' | 'react' | 'rpc' | 'freeze';
  message: string;
  /** stack or extra context, already string-ified */
  detail?: string;
  /** originating surface hint, e.g. 'transcript', 'app', an RPC type */
  source?: string;
}

const RING_MAX = 200;
const ring: DiagnosticEntry[] = [];
let installed = false;

/** Append an entry; oldest drops past RING_MAX. Never throws. */
export function pushDiagnostic(entry: Omit<DiagnosticEntry, 't'>): void {
  try {
    ring.push({ t: Date.now(), ...entry });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  } catch { /* diagnostics must not break the app */ }
}

/** A copy of the current ring, oldest first. */
export function getDiagnosticsRing(): DiagnosticEntry[] {
  return ring.slice();
}

function toDetail(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Install the global capture hooks. Idempotent. Call once, before mount.
 * `Date.now()` is used directly (this is browser runtime, not a workflow).
 */
export function installClientDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Inspectable handle: the report dialog reads the ring from here, and it's a
  // useful console debugging hook (`__gsDiag.ring()`).
  (window as unknown as { __gsDiag?: unknown }).__gsDiag = {
    ring: getDiagnosticsRing,
    push: pushDiagnostic,
  };

  window.addEventListener('error', (e: ErrorEvent) => {
    pushDiagnostic({
      kind: 'error',
      message: e.message || 'window.onerror',
      detail: e.error ? toDetail(e.error) : `${e.filename}:${e.lineno}:${e.colno}`,
      source: 'window',
    });
    // Forward to PostHog error tracking when enabled (no-op otherwise). Not
    // the console.error tap — that's noisy and PostHog logs via console.error.
    void import('./analytics.web.js').then((a) => a.captureException(e.error ?? e.message));
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    pushDiagnostic({
      kind: 'unhandledrejection',
      message: e.reason instanceof Error ? e.reason.message : String(e.reason),
      detail: toDetail(e.reason),
      source: 'promise',
    });
    void import('./analytics.web.js').then((a) => a.captureException(e.reason));
  });

  // Tap console.error without swallowing it — the app's own error logging
  // (e.g. the transcript hooks) feeds the ring for free.
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    pushDiagnostic({
      kind: 'console.error',
      message: args.length > 0 ? String(args[0]) : 'console.error',
      detail: args.length > 1 ? args.slice(1).map(toDetail).join(' ') : undefined,
      source: 'console',
    });
    origError(...args);
  };
}
