export function isReplayDebugEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem('gssh:debug:replay') === '1'
      || new URLSearchParams(window.location.search).has('debugReplay');
  } catch {
    return false;
  }
}

export function replayDebug(message: string, details?: Record<string, unknown>): void {
  if (!isReplayDebugEnabled()) {
    return;
  }

  if (details) {
    console.debug(`[replay:web] ${message}`, details);
  } else {
    console.debug(`[replay:web] ${message}`);
  }
}
