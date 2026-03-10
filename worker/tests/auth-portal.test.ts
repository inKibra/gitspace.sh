import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkerHarness } from './helpers/worker-harness';
import { createWorkerHarness } from './helpers/worker-harness';

let harness: WorkerHarness;

function getSessionIdFromCookie(setCookie: string | null): string | null {
  const match = setCookie?.match(/session=([^;]+)/);
  return match?.[1] ?? null;
}

beforeEach(async () => {
  harness = await createWorkerHarness();
});

afterEach(async () => {
  await harness?.dispose();
});

describe('worker portal auth routes', () => {
  test('starts GitHub OAuth with expected redirect parameters', async () => {
    const response = await harness.request('/auth/github', { redirect: 'manual' });

    expect(response.status).toBe(302);

    const location = response.headers.get('Location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe(harness.upstream.githubOauthBase);
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('github-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.gitspace.sh/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  test('callback creates a session cookie and logout clears it', async () => {
    const callback = await harness.request('/auth/github/callback?code=test-code', {
      redirect: 'manual',
      headers: {
        'CF-Connecting-IP': '127.0.0.1',
        'User-Agent': 'worker-test-agent',
      },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('https://gitspace.sh/dashboard');

    const setCookie = callback.headers.get('Set-Cookie');
    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');

    const sessionId = getSessionIdFromCookie(setCookie);
    expect(sessionId).toBeTruthy();
    const resolvedSessionId = sessionId!;

    const db = await harness.mf.getD1Database('DB');
    const session = await db
      .prepare('SELECT id, ip_address, user_agent FROM sessions WHERE id = ?')
      .bind(resolvedSessionId)
      .first<{ id: string; ip_address: string | null; user_agent: string | null }>();

    expect(session).not.toBeNull();
    expect(session?.id).toBe(resolvedSessionId);
    expect(session?.ip_address).toBe('127.0.0.1');
    expect(session?.user_agent).toBe('worker-test-agent');

    const logout = await harness.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `session=${resolvedSessionId}`,
      },
    });

    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');

    const deleted = await db
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .bind(resolvedSessionId)
      .first();
    expect(deleted).toBeNull();
  });
});
