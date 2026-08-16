import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { clearEnrolledBrowserIdentity, loadEnrolledBrowserIdentity, storeEnrolledBrowserIdentity } from '../../lib/storage/identity-store.web.js';
import { generateIdentity, serializeIdentity } from '../../session/crypto/identity.web.js';

let authToken: string | null = null;
let logoutCalls = 0;

mock.module('../../hooks/useAuth.web.ts', () => ({
  useAuth: () => ({
    token: authToken,
    isLoggedIn: authToken !== null,
    startLogin: () => {},
    logout: () => {
      logoutCalls += 1;
      authToken = null;
    },
  }),
}));

const { useIdentityGate } = await import('./useIdentityGate.web.js');


beforeAll(() => {
  setupTestDom();
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  mock.restore();
  teardownTestDom();
});

beforeEach(() => {
  localStorage.clear();
  clearEnrolledBrowserIdentity();
  window.location.href = 'http://localhost/';
  authToken = null;
  logoutCalls = 0;
});

describe('useIdentityGate dev enrollment bootstrap', () => {
  it('prefers the enrollment token over stale enrolled local storage', async () => {
    const staleIdentity = generateIdentity('stale-browser');
    storeEnrolledBrowserIdentity({
      identity: serializeIdentity(staleIdentity),
      deviceCert: 'stale-device-cert',
    });

    const freshIdentity = generateIdentity('fresh-browser');
    const fetchMock = mock(async () => new Response(JSON.stringify({
      identity: serializeIdentity(freshIdentity),
      deviceCert: 'fresh-device-cert',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    window.location.href = 'http://localhost/?enroll=current-dev-token';
    const readyCalls: string[] = [];

    renderHook(() => useIdentityGate((identity) => {
      readyCalls.push(identity.id);
    }));

    await waitFor(() => {
      expect(readyCalls.length).toBeGreaterThan(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readyCalls).toEqual([freshIdentity.id]);
    expect(loadEnrolledBrowserIdentity()?.identity.id).toBe(freshIdentity.id);
    expect(new URL(window.location.href).searchParams.get('enroll')).toBeNull();
  });
});

describe('useIdentityGate logout', () => {
  it('clears cloud recovery state and returns to login', async () => {
    authToken = 'gst_1234567890abcdef1234';
    Object.defineProperty(globalThis, 'fetch', {
      value: mock(async () => new Response(null, { status: 404 })),
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useIdentityGate(() => {}));

    await waitFor(() => {
      expect(result.current.step).toBe('no-backup');
    });

    act(() => {
      result.current.logout();
    });

    expect(logoutCalls).toBe(1);
    expect(result.current.step).toBe('login');
    expect(result.current.error).toBeNull();
  });
});
