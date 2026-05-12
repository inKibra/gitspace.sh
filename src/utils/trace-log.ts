const DEFAULT_TRACE_FILE = 'gitspace-runtime-trace.jsonl';


function isServerRuntime(): boolean {
  return typeof window === 'undefined';
}

function traceEnabled(): boolean {
  if (!isServerRuntime()) return false;
  const value = process.env.GITSPACE_TRACE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
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

export function writeTraceLog(event: string, details?: Record<string, unknown>): void {
  if (!traceEnabled()) return;
  void (async () => {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tracePath = getTraceLogPath();
      const dir = path.dirname(tracePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const payload = {
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...(details ?? {}),
      };
      fs.appendFileSync(tracePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Tracing must never affect the runtime path it is observing.
    }
  })();
}

export function getRuntimeTraceLogPath(): string {
  if (!isServerRuntime()) return '';
  return getTraceLogPath();
}
