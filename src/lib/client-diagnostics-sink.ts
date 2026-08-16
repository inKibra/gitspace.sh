/**
 * Registration point for the browser diagnostics ring.
 *
 * `client-diagnostics.web.ts` needs DOM lib types; the code that FEEDS it —
 * notably `session/backends/remote-session-backend.ts` — is shared with the
 * Node/TUI build and typechecks in a DOM-less program. It used to bridge that
 * with a `typeof window` guard around a dynamic `import('…​.web.js')`, which
 * does not work: a dynamic import still drags the module into the TypeScript
 * program, so every DOM reference inside it became an error in the root
 * program. That went unnoticed only because a bloated local `node_modules`
 * leaked DOM globals; CI, installing from the lockfile, failed.
 *
 * So the edge is inverted. The browser REGISTERS a sink here at startup, and
 * shared code reports into it. No shared module names a `.web` module, and
 * reporting is a no-op wherever no browser installed one.
 */

/** Ring entry, minus the timestamp the ring stamps on arrival. */
export interface ClientDiagnostic {
  kind: 'error' | 'unhandledrejection' | 'console.error' | 'console.warn' | 'console.log' | 'react' | 'rpc' | 'freeze' | 'click' | 'nav' | 'transport';
  message: string;
  /** stack or extra context, already string-ified */
  detail?: string;
  /** originating surface hint, e.g. 'transcript', 'app', an RPC type */
  source?: string;
}

export interface ClientDiagnosticsSink {
  pushDiagnostic(entry: ClientDiagnostic): void;
  recordRpcFailure(command: string, error: unknown, context?: Record<string, unknown>): void;
}

let sink: ClientDiagnosticsSink | null = null;

/** Install the browser ring as the process-wide sink; `null` uninstalls. */
export function setClientDiagnosticsSink(next: ClientDiagnosticsSink | null): void {
  sink = next;
}

/** Report an entry to the browser ring, if one is installed. Never throws. */
export function reportClientDiagnostic(entry: ClientDiagnostic): void {
  try {
    sink?.pushDiagnostic(entry);
  } catch { /* diagnostics must not break the app */ }
}

/** Report a failed RPC to the browser ring, if one is installed. Never throws. */
export function reportRpcFailure(command: string, error: unknown, context?: Record<string, unknown>): void {
  try {
    sink?.recordRpcFailure(command, error, context);
  } catch { /* diagnostics must not break the app */ }
}
