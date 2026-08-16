/**
 * Resilient problem-report submission (docs/REPORT-A-PROBLEM.md).
 *
 * The whole point of "report a problem" is that it works when things are
 * broken — including when the main relay WebSocket is wedged. So this is a
 * layered fallback that never loses the report:
 *
 *   1. redact CLIENT-side (the fallback paths skip the daemon's redactDeep)
 *   2. try the normal RPC over the WS, with a HARD timeout (no infinite spin)
 *   3. on timeout/failure → POST to the relay's /report endpoint (a fresh
 *      fetch, independent of the wedged WS; the relay is a separate process
 *      that survives a frozen daemon and enriches from disk)
 *   4. on that failure too → download the report locally so it's never lost
 */
import { redactDeep } from '../utils/redact.js';
import { getDiagnosticsRing } from './client-diagnostics.web.js';
import { VERSION } from '../version.generated.js';

const RPC_TIMEOUT_MS = 4000;

export type ReportOutcome =
  | { via: 'daemon'; path: string; issueUrl?: string; issueNumber?: number }
  | { via: 'relay'; path?: string; issueUrl?: string; issueNumber?: number }
  | { via: 'local'; filename: string };

interface SubmitParams {
  note: string;
  clientBundle: unknown;
  opts: { fileIssue?: boolean; projectName?: string };
  /** Backend RPC (the happy path). Undefined when no backend is connected. */
  report?: (note: string, clientBundle: unknown, opts?: { fileIssue?: boolean; projectName?: string }) => Promise<{ path: string; issueUrl?: string; issueNumber?: number }>;
  /** Relay HTTP origin for the fallback POST (ws→http of the relay URL). */
  relayHttpBase?: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('report RPC timed out')), ms)),
  ]);
}

function saveLocally(payload: unknown): { filename: string } {
  const filename = `gitspace-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename };
}

export async function submitProblemReport(params: SubmitParams): Promise<ReportOutcome> {
  // Redact the client bundle up front — every downstream path (daemon, relay,
  // or local file) then handles already-scrubbed data.
  const redactedBundle = redactDeep(params.clientBundle);
  const note = redactDeep(params.note) as string;

  // 1) Happy path: the daemon RPC, bounded so a wedged WS can't hang forever.
  if (params.report) {
    try {
      const r = await withTimeout(params.report(note, redactedBundle, params.opts), RPC_TIMEOUT_MS);
      return { via: 'daemon', path: r.path, issueUrl: r.issueUrl, issueNumber: r.issueNumber };
    } catch {
      /* fall through to the relay path */
    }
  }

  // 2) Relay fallback: a plain fetch bypasses the wedged WS; the relay spools
  //    it and enriches from disk even if the machine daemon is frozen.
  if (params.relayHttpBase) {
    try {
      const res = await withTimeout(fetch(`${params.relayHttpBase}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, projectName: params.opts.projectName, clientBundle: redactedBundle }),
      }), RPC_TIMEOUT_MS + 2000);
      if (res.ok) {
        const j = await res.json().catch(() => ({} as { path?: string; issueUrl?: string; issueNumber?: number }));
        const r = j as { path?: string; issueUrl?: string; issueNumber?: number };
        return { via: 'relay', path: r.path, issueUrl: r.issueUrl, issueNumber: r.issueNumber };
      }
    } catch {
      /* fall through to local */
    }
  }

  // 3) Last resort: never lose the report — hand the user the file.
  return { via: 'local', ...saveLocally({ v: 1, note, createdAt: new Date().toISOString(), client: redactedBundle }) };
}

/**
 * Assemble a diagnostic bundle WITHOUT the React app tree — the diagnostics
 * ring (which holds the crash's react entry, pushed by
 * ErrorBoundary.componentDidCatch) plus a raw `#root` DOM snapshot and a
 * timestamp. Every read is guarded; this must never throw, because it is
 * called from the last-line-of-defense error fallback.
 */
export function buildBrokenStateBundle(): unknown {
  let ring: unknown[] = [];
  try { ring = getDiagnosticsRing(); } catch { /* ignore */ }
  let domSnapshot = '';
  try { domSnapshot = (document.getElementById('root')?.outerHTML ?? '').slice(0, 250_000); } catch { /* ignore */ }
  let url = '';
  try { url = window.location.href; } catch { /* ignore */ }
  let userAgent = '';
  try { userAgent = navigator.userAgent; } catch { /* ignore */ }
  let viewport: { w: number; h: number; dpr: number } | undefined;
  try { viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }; } catch { /* ignore */ }
  return {
    version: VERSION,
    brokenState: true,
    url,
    userAgent,
    viewport,
    ring,
    domSnapshot,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Self-contained report path for the BROKEN screens (ErrorBoundary fallback,
 * connection-failed) where no backend RPC is available. Captures the crash
 * bundle synchronously from module state, then submits via the resilient
 * relay → local fallback with NO `report` RPC (the backend is down/unknown
 * here). Resolves with the outcome; never rejects for a lost report.
 */
export function reportFromBrokenState(
  note: string,
  opts: { relayHttpBase?: string | null; projectName?: string },
): Promise<ReportOutcome> {
  // Capture NOW (synchronously) so the crash evidence is snapshotted before
  // any await, reload, or further teardown can wipe the in-memory ring.
  const clientBundle = buildBrokenStateBundle();
  return submitProblemReport({
    note,
    clientBundle,
    opts: { fileIssue: true, projectName: opts.projectName },
    report: undefined,
    relayHttpBase: opts.relayHttpBase ?? null,
  });
}
