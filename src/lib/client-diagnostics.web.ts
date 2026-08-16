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

import { setClientDiagnosticsSink, type ClientDiagnostic } from './client-diagnostics-sink.js';

export interface DiagnosticEntry extends ClientDiagnostic {
  /** epoch ms */
  t: number;
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
 * Record a failed RPC command into the ring (kind 'rpc'). Call sites are the
 * UI layers that awaited an engine/backend command and caught the rejection —
 * this is what makes "the prompt RPC failed silently" reconstructable from a
 * problem report. Never throws.
 */
export function recordRpcFailure(command: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  let detail = toDetail(error);
  if (context) {
    try { detail = `${detail} · ${JSON.stringify(context)}`; } catch { /* ignore */ }
  }
  pushDiagnostic({ kind: 'rpc', message: `${command} failed: ${message}`.slice(0, 500), detail: detail.slice(0, 1000), source: command });
}

/**
 * Route transport diagnostics (oversize-send / close / ledger) into the ring so
 * they ride in the problem-report bundle. Structured entry (kind 'transport');
 * the human console lines the guard/close helpers also emit are tapped
 * separately as 'console.warn'. Never throws. (ticket #42.4)
 */
export function installBrowserTransportDiagnostics(): void {
  void import('./tmux-lite/transport-diagnostics.js')
    .then((mod) => {
      mod.setTransportDiagnosticSink((diagnostic) => {
        pushDiagnostic({
          kind: 'transport',
          message: diagnostic.kind === 'transport-oversize-send'
            ? `oversize ${diagnostic.type} ${(diagnostic.size / (1024 * 1024)).toFixed(2)}MB on ${diagnostic.socket}`
            : `close ${diagnostic.role} ${diagnostic.socket} code=${diagnostic.code ?? 'none'} abnormal=${diagnostic.abnormal}`,
          detail: (() => { try { return JSON.stringify(diagnostic); } catch { return String(diagnostic.kind); } })(),
          source: 'transport',
        });
      });
    })
    .catch(() => undefined);
}

/**
 * Install the global capture hooks. Idempotent. Call once, before mount.
 * `Date.now()` is used directly (this is browser runtime, not a workflow).
 */
export function installClientDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Shared (DOM-less) code reports through the sink rather than importing this
  // module — see client-diagnostics-sink.ts for why that edge is inverted.
  setClientDiagnosticsSink({ pushDiagnostic, recordRpcFailure });

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

  // Tap console.{error,warn,log,info} without swallowing — this is the
  // breadcrumb trail (the "chain of events"), not just crashes, so a report
  // has context even when nothing threw. Each is length-capped by the ring.
  const tap = (level: 'error' | 'warn' | 'log' | 'info', kind: DiagnosticEntry['kind']) => {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushDiagnostic({
        kind,
        message: (args.length > 0 ? String(args[0]) : `console.${level}`).slice(0, 500),
        detail: args.length > 1 ? args.slice(1).map(toDetail).join(' ').slice(0, 1000) : undefined,
        source: 'console',
      });
      orig(...args);
    };
  };
  tap('error', 'console.error');
  tap('warn', 'console.warn');
  tap('log', 'console.log');
  tap('info', 'console.log');

  // User-action breadcrumbs — the actual "chain of events leading up to the
  // report." A quiet app logs nothing to console, so without this the ring is
  // empty; clicks + navigations are what let an agent replay what happened.
  window.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest('button, a, [role="button"], [role="tab"], input, label');
    if (!el) return;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || (el as HTMLInputElement).name || el.tagName).trim().slice(0, 80);
    pushDiagnostic({ kind: 'click', message: label, source: el.tagName.toLowerCase() });
  }, { capture: true });

  let lastHref = window.location.href;
  const recordNav = () => {
    if (window.location.href === lastHref) return;
    pushDiagnostic({ kind: 'nav', message: window.location.pathname + window.location.search, source: 'location' });
    lastHref = window.location.href;
  };
  window.addEventListener('popstate', recordNav);
  const origPush = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => { origPush(...args); recordNav(); };
}
