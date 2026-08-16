/**
 * Server-side (Bun/node serve daemon) sink for transport diagnostics
 * (ticket #42.4). Node-only — imports the trace ring, so the browser bundle
 * must NEVER import this file (it imports the browser-safe
 * `transport-diagnostics.ts` instead and registers its own pushDiagnostic sink).
 *
 * Routing the machine-side diagnostics through `writeTraceLog` is what carries
 * them into the problem-report bundle: `buildProblemReport()` embeds
 * `getTraceRing()` as `report.server.traceRing`, and the same events are also
 * appended to the on-disk JSONL the relay tails when the daemon is frozen. So a
 * Mac user's captured report contains the machine-side oversize-send / close /
 * ledger events, not just the client ring.
 */

import { setTransportDiagnosticSink, type TransportDiagnostic } from './transport-diagnostics.js';
import { writeTraceLog } from '../../utils/trace-log.js';

let installed = false;

/**
 * Register the process-wide server sink. Idempotent — safe to call from every
 * server module that produces transport diagnostics (machine-relay-client,
 * remote-session-backend when run under node/TUI). No-op in the browser.
 */
export function installServerTransportDiagnostics(): void {
  if (installed) return;
  // `'window' in globalThis` rather than `typeof window`: this file is in the
  // DOM-less root program, where a bare `window` is an undeclared name.
  if ('window' in globalThis) return;
  installed = true;
  setTransportDiagnosticSink((diagnostic: TransportDiagnostic) => {
    // writeTraceLog pushes to the in-memory ring (report.server.traceRing, the
    // fast path) AND appends the on-disk JSONL (the freeze-safe path the relay
    // tails). Human console lines are already logged at the call site by the
    // guard/close helpers, which the report's daemonLogTail also captures.
    writeTraceLog(diagnostic.kind, diagnostic as unknown as Record<string, unknown>);
  });
}
