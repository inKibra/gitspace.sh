/**
 * Browser authentication hook for gitspace.sh API.
 *
 * Manages the OAuth redirect flow:
 * 1. startLogin() redirects to api.gitspace.sh/auth/github?return_to=<origin>
 * 2. GitHub OAuth happens on github.com
 * 3. Worker redirects back to <origin>/#token=gst_xxx
 * 4. handleCallbackToken() reads token from URL fragment, stores in localStorage
 *
 * The token is used for API calls (identity backup fetch, etc.).
 */

import { useState, useCallback } from 'react';

const AUTH_TOKEN_KEY = 'gssh.auth.token.v1';
const API_BASE = 'https://api.gitspace.sh';

function isValidToken(token: string): boolean {
  return token.startsWith('gst_') && token.length >= 20;
}

export interface AuthState {
  /** The Bearer token, or null if not logged in */
  token: string | null;
  /** Whether we're currently processing a callback */
  loading: boolean;
}

/**
 * Read the stored auth token from localStorage.
 */
function getStoredToken(): string | null {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token && isValidToken(token)) {
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check the URL fragment for an OAuth callback token.
 * Returns the token and cleans the fragment if found.
 */
function consumeCallbackToken(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;

  const match = hash.match(/^#\/?token=(gst_[a-f0-9]+)$/);
  if (!match) return null;

  const token = match[1];
  if (!isValidToken(token)) return null;

  // Clear the fragment from the URL without triggering navigation
  history.replaceState(null, '', window.location.pathname + window.location.search);

  return token;
}

/**
 * Synchronously consume the OAuth callback token from the URL fragment
 * and persist it BEFORE the first render, so that components see
 * `isLoggedIn === true` on their initial render (no flash of login screen).
 */
function consumeAndPersistCallbackToken(): string | null {
  const callbackToken = consumeCallbackToken();
  if (callbackToken) {
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, callbackToken);
    } catch {
      return callbackToken;
    }
    return callbackToken;
  }
  return getStoredToken();
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(() => ({
    token: consumeAndPersistCallbackToken(),
    loading: false,
  }));

  /**
   * Start the GitHub OAuth redirect flow.
   */
  const startLogin = useCallback(() => {
    const returnTo = encodeURIComponent(
      `${window.location.origin}${window.location.pathname}${window.location.search}`,
    );
    window.location.href = `${API_BASE}/auth/github?return_to=${returnTo}`;
  }, []);

  /**
   * Clear the stored token and log out.
   */
  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setState({ token: null, loading: false });
  }, []);

  /**
   * Make an authenticated fetch request to the API.
   */
  const fetchWithAuth = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const token = state.token ?? getStoredToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);

    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  }, [state.token]);

  return {
    token: state.token,
    isLoggedIn: state.token !== null,
    loading: state.loading,
    startLogin,
    logout,
    fetchWithAuth,
  };
}
