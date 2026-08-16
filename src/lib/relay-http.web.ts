/**
 * HTTP origin of the relay, for the report-a-problem fallback POST (a plain
 * fetch that bypasses a wedged WebSocket). Mirrors the relay descriptor: the
 * explicit VITE_RELAY_URL or the current host, ws→http/wss→https, `/ws` stripped.
 *
 * Deliberately self-contained — no app state, no hooks, no React context — so
 * it can be called from the two BROKEN screens where the normal app chrome is
 * gone: the ErrorBoundary fallback (a class component with no hooks/context)
 * and the connection-failed screen. Both import it from here alongside
 * app.web.tsx. Never throws (returns null on any failure).
 */
export function relayHttpBase(): string | null {
  try {
    const raw = import.meta.env.VITE_RELAY_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    return raw
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/ws\/?$/, '');
  } catch {
    return null;
  }
}
