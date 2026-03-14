import { useState, useCallback, useEffect } from 'react';
import type { SessionBackend } from '../session/backend.js';

/**
 * Persists the last-selected agent session ID per workspace.
 *
 * - Web: localStorage (synchronous init)
 * - TUI: SessionBackend.getAgentSessionPreference (async init via useEffect)
 *
 * Both write paths are used on persist so the value is available to either context.
 * Preferences are best-effort — failures are silently swallowed.
 */

export interface UsePersistedAgentSessionResult {
  /** The persisted session ID for this workspace, or null if none */
  lastSessionId: string | null;
  /** Persist a new session selection */
  persist: (sessionId: string) => void;
  /** Clear the persisted selection */
  clear: () => void;
}

function readFromLocalStorage(workspaceId: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(`gssh:agent-session:${workspaceId}`);
    }
  } catch { /* non-fatal */ }
  return null;
}

function writeToLocalStorage(workspaceId: string, sessionId: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`gssh:agent-session:${workspaceId}`, sessionId);
    }
  } catch { /* non-fatal */ }
}

function removeFromLocalStorage(workspaceId: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`gssh:agent-session:${workspaceId}`);
    }
  } catch { /* non-fatal */ }
}

export function usePersistedAgentSession(
  workspaceId: string,
  backend: SessionBackend | null,
): UsePersistedAgentSessionResult {
  // Initialize from localStorage synchronously (web context).
  // In TUI (Bun), localStorage is unavailable — this returns null.
  const [lastSessionId, setLastSessionId] = useState<string | null>(() => {
    if (!workspaceId) return null;
    return readFromLocalStorage(workspaceId);
  });

  // Async init from backend for TUI disk persistence.
  // If localStorage already had a value (web), this is a no-op.
  useEffect(() => {
    if (!workspaceId || !backend) return;
    // Skip async load if localStorage already provided a value
    const fromLs = readFromLocalStorage(workspaceId);
    if (fromLs !== null) return;

    let cancelled = false;
    void backend.getAgentSessionPreference(workspaceId).then((pref) => {
      if (!cancelled && pref) {
        setLastSessionId(pref);
      }
    });
    return () => { cancelled = true; };
  }, [workspaceId, backend]);

  const persist = useCallback(
    (sessionId: string) => {
      if (!workspaceId) return;
      setLastSessionId(sessionId);
      writeToLocalStorage(workspaceId, sessionId);
      void backend?.setAgentSessionPreference(workspaceId, sessionId);
    },
    [workspaceId, backend],
  );

  const clear = useCallback(() => {
    if (!workspaceId) return;
    setLastSessionId(null);
    removeFromLocalStorage(workspaceId);
  }, [workspaceId]);

  return { lastSessionId, persist, clear };
}
