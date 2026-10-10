import { describe, expect, it, vi } from 'vitest';
import { beginLogin, cancelLogin, loginStateSchema, pollLogin, publicLogin, refreshCredential, respondLogin, type StoredOAuthCredential } from './index';

const credential: StoredOAuthCredential = { provider: 'anthropic', access: 'old-access', refresh: 'old-refresh', expires: 1, accountId: 'account', email: 'a@example.com', orgId: 'original-org' };

describe('portable refresh rotation safety', () => {
  it('preserves stored account identity even when refreshed metadata names another org', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600, account: { uuid: 'different' }, organization: { uuid: 'different-org' } }));
    const refreshed = await refreshCredential(credential, fetcher);
    expect(refreshed).toMatchObject({ access: 'new-access', refresh: 'rotated', accountId: 'account', orgId: 'original-org' });
  });
  it('does not replay a rotation whose network outcome is uncertain', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('secret request details'));
    await expect(refreshCredential(credential, fetcher)).rejects.toMatchObject({ kind: 'network', message: 'Provider request outcome is uncertain' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('classifies Cursor rejection through the same refresh failure contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider error', { status: 401 }));
    await expect(refreshCredential({ ...credential, provider: 'cursor' }, fetcher)).rejects.toMatchObject({ provider: 'cursor', kind: 'rejected', status: 401, message: 'Provider rejected request' });
  });
  it('rejects successful responses with missing tokens instead of committing a broken rotation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: '', expires_in: 3600 }));
    await expect(refreshCredential(credential, fetcher)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('does not send upstream OpenAI credentials through a GitSpace-owned refresh flow', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(refreshCredential({ ...credential, provider: 'openai' }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('durable cloud login secret and state boundaries', () => {
  it('round-trips private state while publishing neither verifier nor CSRF secret as fields', async () => {
    const transition = await beginLogin({ provider: 'google-gemini-cli' });
    const state = loginStateSchema.parse(JSON.parse(JSON.stringify(transition.state)));
    expect(state.kind).toBe('code');
    if (state.kind !== 'code') throw new Error('Expected code state');
    expect(publicLogin(state)).not.toHaveProperty('verifier');
    expect(publicLogin(state)).not.toHaveProperty('csrf');
    expect(JSON.stringify(publicLogin(state))).not.toContain(state.verifier);
    expect(new URL(state.authorizationUrl).searchParams.get('code_challenge')).not.toBe(state.verifier);
  });
  it('rejects mismatched callback state before making any token request', async () => {
    const transition = await beginLogin({ provider: 'google-antigravity' });
    if (transition.state.kind !== 'code') throw new Error('Expected code state');
    const fetcher = vi.fn<typeof fetch>();
    await expect(respondLogin(transition.state, { code: `${transition.state.redirectUri}?code=stolen&state=wrong` }, fetcher)).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('erases secrets on cancellation and refuses further polling', async () => {
    const transition = await beginLogin({ provider: 'cursor' });
    const cancelled = cancelLogin(transition.state);
    const fetcher = vi.fn<typeof fetch>();
    expect(cancelled.state).not.toHaveProperty('verifier');
    await expect(pollLogin(cancelled.state, fetcher)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects expired login before code exchange', async () => {
    const transition = await beginLogin({ provider: 'anthropic' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(respondLogin({ ...transition.state, expiresAt: '2000-01-01T00:00:00.000Z' }, { code: 'code#state' }, fetcher)).rejects.toMatchObject({ kind: 'expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('resumes device polling from serialized state and respects the next poll time', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ device_auth_id: 'secret-device', user_code: 'USER-CODE', interval: 5 }));
    const transition = await beginLogin({ provider: 'openai-codex' }, fetcher);
    const restored = loginStateSchema.parse(JSON.parse(JSON.stringify(transition.state)));
    await pollLogin(restored, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(transition.view)).not.toContain('secret-device');
  });
  it('exchanges Anthropic copy-code authorization with its registered redirect and keeps verifier private', async () => {
    const transition = await beginLogin({ provider: 'anthropic' });
    if (transition.state.kind !== 'code') throw new Error('Expected code state');
    const authorize = new URL(transition.state.authorizationUrl);
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, account: { uuid: 'account' }, organization: { uuid: 'org' } }));
    const result = await respondLogin(transition.state, { code: `authorization#${transition.state.csrf}` }, fetcher);
    expect(result.kind).toBe('complete');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://platform.claude.com/v1/oauth/token');
    const body = fetcher.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected JSON token exchange');
    expect(JSON.parse(body)).toMatchObject({ code: 'authorization', state: transition.state.csrf, code_verifier: transition.state.verifier, redirect_uri: authorize.searchParams.get('redirect_uri') });
    expect(JSON.stringify(result.view)).not.toContain(transition.state.verifier);
  });
});
