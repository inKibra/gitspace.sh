import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { clearEnrolledBrowserIdentity, loadEnrolledBrowserIdentity, storeEnrolledBrowserIdentity } from '../../lib/storage/identity-store.web.js';
import { generateIdentity, serializeIdentity } from '../../session/crypto/identity.web.js';

mock.module('../../hooks/useAuth.web.ts', () => ({
  useAuth: () => ({
    token: null,
    isLoggedIn: false,
    startLogin: () => {},
    logout: () => {},
  }),
}));

const { useIdentityGate } = await import('./useIdentityGate.web.js');

async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

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

    await waitFor(() => readyCalls.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readyCalls).toEqual([freshIdentity.id]);
    expect(loadEnrolledBrowserIdentity()?.identity.id).toBe(freshIdentity.id);
    expect(new URL(window.location.href).searchParams.get('enroll')).toBeNull();
  });
});
