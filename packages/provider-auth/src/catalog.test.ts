import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompiledAuthProvider } from '@oh-my-pi/pi-catalog/compat/auth-types';
import { mock } from 'bun:test';
import type { StoredOAuthCredential } from './schemas';

// Capture the real catalog before installing the process-isolated module mock.
const { authPolicyFor: canonicalPolicy } = await import('@oh-my-pi/pi-catalog/compat/auth');
const supplied = { missing: false, missingClient: false, missingSecret: false, wrongKind: false, id: crypto.randomUUID(), secret: crypto.randomUUID() };
mock.module('@oh-my-pi/pi-catalog/compat/auth', () => {
  return { authPolicyFor(provider: string): CompiledAuthProvider | undefined {
    const policy = canonicalPolicy(provider);
    if (supplied.missing || !policy) return undefined;
    if (supplied.wrongKind) return { ...policy, login: { kind: 'custom', hook: 'unsupported' } };
    if (policy.login?.kind !== 'oauth-code') return policy;
    return { ...policy, login: { ...policy.login,
      clientId: supplied.missingClient ? undefined : { value: btoa(supplied.id), encoding: 'base64' },
      clientSecret: supplied.missingSecret ? undefined : { value: supplied.secret },
    } };
  } };
});
// Import after mock registration so both login and refresh exercise the supplied catalog.
const { beginLogin, pollLogin, refreshCredential, respondLogin } = await import('./index');

afterEach(() => { supplied.missing = false; supplied.missingClient = false; supplied.missingSecret = false; supplied.wrongKind = false; });
const providers = ['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'cursor'] as const;
function stored(provider: StoredOAuthCredential['provider']): StoredOAuthCredential { return { provider, access: 'access', refresh: 'refresh', expires: 1 }; }
function fields(init: RequestInit | undefined): Record<string, unknown> {
  if (init?.body instanceof URLSearchParams) return Object.fromEntries(init.body);
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  throw new Error('Expected token body');
}

describe('catalog-owned OAuth client metadata', () => {
  for (const provider of providers.filter(p => p !== 'cursor')) {
    it(`${provider} uses supplied catalog metadata for authorization, exchange and refresh`, async () => {
      const beginFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ device_auth_id: 'device', user_code: 'code' }));
      const begin = await beginLogin({ provider }, beginFetch);
      if (begin.state.kind === 'code') expect(new URL(begin.state.authorizationUrl).searchParams.get('client_id')).toBe(supplied.id);
      else expect(fields(beginFetch.mock.calls[0]?.[1]).client_id).toBe(supplied.id);
      const exchangeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
      if (begin.state.kind === 'code') {
        await expect(respondLogin(begin.state, { code: provider === 'anthropic' ? `code#${begin.state.csrf}` : `${begin.state.redirectUri}?code=code&state=${begin.state.csrf}` }, exchangeFetch)).rejects.toMatchObject({ kind: 'rejected' });
      } else if (begin.state.kind === 'device') {
        exchangeFetch.mockResolvedValueOnce(Response.json({ authorization_code: 'code', code_verifier: 'verifier' }));
        await expect(pollLogin({ ...begin.state, nextPollAt: new Date(0).toISOString() }, exchangeFetch)).rejects.toMatchObject({ kind: 'rejected' });
      } else throw new Error('Expected code or device login');
      const exchanged = fields(exchangeFetch.mock.calls.at(-1)?.[1]);
      expect(exchanged.client_id).toBe(supplied.id);
      if (provider.startsWith('google-')) expect(exchanged.client_secret).toBe(supplied.secret);
      const refreshFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }));
      await refreshCredential(stored(provider), refreshFetch);
      const refreshed = fields(refreshFetch.mock.calls[0]?.[1]);
      expect(refreshed.client_id).toBe(supplied.id);
      if (provider.startsWith('google-')) expect(refreshed.client_secret).toBe(supplied.secret);
      else expect(refreshed).not.toHaveProperty('client_secret');
    });
  }
  for (const provider of providers) {
    it(`${provider} fails missing login policy before login or refresh network access`, async () => {
      supplied.missing = true;
      const fetcher = vi.fn<typeof fetch>();
      await expect(beginLogin({ provider }, fetcher)).rejects.toThrow(/catalog.*policy/i);
      await expect(refreshCredential(stored(provider), fetcher)).rejects.toThrow(/catalog.*policy/i);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }
  for (const provider of providers.filter(p => p !== 'cursor')) {
    it(`${provider} rejects missing client metadata and incompatible login policy before network`, async () => {
      const fetcher = vi.fn<typeof fetch>();
      supplied.missingClient = true;
      await expect(beginLogin({ provider }, fetcher)).rejects.toThrow(/catalog.*client/i);
      await expect(refreshCredential(stored(provider), fetcher)).rejects.toThrow(/catalog.*client/i);
      supplied.missingClient = false; supplied.wrongKind = true;
      await expect(beginLogin({ provider }, fetcher)).rejects.toThrow(/catalog.*policy/i);
      await expect(refreshCredential(stored(provider), fetcher)).rejects.toThrow(/catalog.*policy/i);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }
  for (const provider of ['google-gemini-cli', 'google-antigravity'] as const) {
    it(`${provider} rejects absent required secret instead of falling back`, async () => {
      supplied.missingSecret = true;
      const fetcher = vi.fn<typeof fetch>();
      await expect(beginLogin({ provider }, fetcher)).rejects.toThrow(/catalog.*client/i);
      await expect(refreshCredential(stored(provider), fetcher)).rejects.toThrow(/catalog.*client/i);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }
  it('contains no canonical OAuth client literals, encoded or decoded, including tests', async () => {
    const catalog = { authPolicyFor: canonicalPolicy };
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(directory).filter(name => name.endsWith('.ts')).map(name => readFileSync(`${directory}/${name}`, 'utf8'));
    for (const provider of providers) {
      const login = catalog.authPolicyFor(provider)?.login;
      if (login?.kind !== 'oauth-code') continue;
      for (const metadata of [login.clientId, login.clientSecret]) {
        if (!metadata?.value) continue;
        const decoded = metadata.encoding === 'base64' ? atob(metadata.value) : metadata.value;
        for (const source of sources) {
          expect(source.includes(decoded), `${provider} decoded client literal`).toBe(false);
          expect(source.includes(btoa(decoded)), `${provider} encoded client literal`).toBe(false);
        }
      }
    }
  });
});
