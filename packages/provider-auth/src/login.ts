import { z } from 'zod';
import { beginLoginInputSchema, loginResponseSchema, type LoginState, type LoginTransition, type LoginView, type StoredOAuthCredential } from './schemas';
import { request, parseProvider, tokenSchema, cursorTokenSchema, jwt, cursorExpiry, ProviderRefreshError } from './refresh';
import { oauthClient } from './catalog';
import { discoverProject, pollProject } from './project';

/** Login errors share the sanitized provider failure contract. */
export class ProviderLoginError extends Error {
  constructor(readonly kind: 'expired' | 'cancelled' | 'invalid-state' | 'invalid-response', message: string) { super(message); this.name = 'ProviderLoginError'; }
}
function active(state: LoginState): void {
  if (state.kind === 'cancelled') throw new ProviderLoginError('cancelled', 'Login was cancelled');
  if (state.kind === 'complete') throw new ProviderLoginError('invalid-state', 'Login already completed');
  if (Date.parse(state.expiresAt) <= Date.now()) throw new ProviderLoginError('expired', 'Login expired; start again');
}
export function publicLogin(state: LoginState): LoginView {
  const base = { provider: state.provider, expiresAt: state.expiresAt };
  switch (state.kind) {
    case 'code': return { ...base, kind: 'code', authorizationUrl: state.authorizationUrl, prompt: state.provider === 'anthropic' ? 'After signing in, paste the code#state shown by Anthropic.' : 'After consent, copy the entire final redirect URL from the address bar, even if localhost cannot connect.' };
    case 'device': return { ...base, kind: 'device', authorizationUrl: state.authorizationUrl, userCode: state.userCode, nextPollAt: state.nextPollAt };
    case 'cursor': return { ...base, kind: 'poll', authorizationUrl: state.authorizationUrl, nextPollAt: state.nextPollAt };
    case 'project': return { ...base, kind: 'poll', nextPollAt: state.nextPollAt };
    case 'project-input': return { ...base, kind: 'project-input', prompt: 'Enter the Google Cloud project ID authorized for this account.' };
    case 'complete': return { ...base, kind: 'complete' };
    case 'cancelled': return { ...base, kind: 'cancelled' };
  }
}
export function pending(state: LoginState): LoginTransition { return { kind: 'pending', state, view: publicLogin(state) }; }
export function completed(state: LoginState, credential: StoredOAuthCredential): LoginTransition {
  const done: LoginState = { kind: 'complete', provider: state.provider, expiresAt: state.expiresAt };
  return { kind: 'complete', state: done, view: publicLogin(done), credential };
}
export function cancelLogin(state: LoginState): LoginTransition {
  return pending({ kind: 'cancelled', provider: state.provider, expiresAt: state.expiresAt });
}
export async function beginLogin(input: z.input<typeof beginLoginInputSchema>, fetcher: typeof fetch = fetch): Promise<LoginTransition> {
  const { provider, projectId } = beginLoginInputSchema.parse(input);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  if (provider === 'openai-codex') {
    const data = parseProvider(provider, z.object({ device_auth_id: z.string().min(1), user_code: z.string().min(1), interval: z.union([z.number().positive(), z.string().regex(/^\d+$/)]).optional() }), await request(provider, 'https://auth.openai.com/api/accounts/deviceauth/usercode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oauthClient(provider)) }, fetcher));
    const intervalMs = Math.max(5, Number(data.interval ?? 5)) * 1000 + 3000;
    return pending({ kind: 'device', provider, expiresAt, deviceAuthId: data.device_auth_id, userCode: data.user_code, intervalMs, nextPollAt: new Date(Date.now() + 5000).toISOString(), authorizationUrl: 'https://auth.openai.com/codex/device' });
  }
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (provider === 'cursor') {
    const uuid = crypto.randomUUID();
    return pending({ kind: 'cursor', provider, expiresAt, uuid, verifier, intervalMs: 1000, nextPollAt: new Date(Date.now() + 1000).toISOString(), authorizationUrl: `https://cursor.com/loginDeepControl?${new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' })}` });
  }
  const csrf = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const redirectUri = provider === 'anthropic' ? 'https://platform.claude.com/oauth/code/callback' : provider === 'google-gemini-cli' ? 'http://127.0.0.1:8085/oauth2callback' : 'http://127.0.0.1:51121/oauth-callback';
  const params = new URLSearchParams({ response_type: 'code', client_id: oauthClient(provider).client_id, redirect_uri: redirectUri, state: csrf, code_challenge: challenge, code_challenge_method: 'S256' });
  if (provider === 'anthropic') { params.set('code', 'true'); params.set('scope', 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'); }
  else { params.set('access_type', 'offline'); params.set('prompt', 'consent'); params.set('scope', 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile' + (provider === 'google-antigravity' ? ' https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs' : '')); }
  return pending({ kind: 'code', provider, expiresAt, verifier, csrf, redirectUri, projectId, authorizationUrl: `${provider === 'anthropic' ? 'https://claude.ai/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth'}?${params}` });
}
async function exchange(state: LoginState, code: string, verifier: string, redirectUri: string, csrf: string | undefined, fetcher: typeof fetch): Promise<StoredOAuthCredential> {
  const provider = state.provider;
  if (provider === 'cursor') throw new ProviderLoginError('invalid-state', 'Cursor does not exchange codes');
  const anthropic = provider === 'anthropic';
  const fields = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, ...oauthClient(provider), ...(anthropic ? { state: csrf ?? '' } : {}) };
  const token = parseProvider(provider, tokenSchema, await request(provider, anthropic ? 'https://platform.claude.com/v1/oauth/token' : provider === 'openai-codex' ? 'https://auth.openai.com/oauth/token' : 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': anthropic ? 'application/json' : 'application/x-www-form-urlencoded' }, body: anthropic ? JSON.stringify(fields) : new URLSearchParams(fields) }, fetcher));
  if (!token.refresh_token) throw new ProviderRefreshError(provider, 'invalid-response', 'Login did not provide offline refresh access', 200);
  const credential: StoredOAuthCredential = { provider, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 - (provider === 'openai-codex' ? 0 : 300_000) };
  if (anthropic) {
    credential.accountId = token.account?.uuid; credential.email = token.account?.email_address; credential.orgId = token.organization?.uuid;
    if (!credential.accountId || !credential.orgId) {
      const bootstrap = parseProvider(provider, z.object({ oauth_account: z.object({ account_uuid: z.string().min(1), account_email: z.string().optional(), organization_uuid: z.string().min(1) }) }), await request(provider, 'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8', { headers: { Authorization: `Bearer ${credential.access}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.280' } }, fetcher));
      credential.accountId ??= bootstrap.oauth_account.account_uuid; credential.orgId ??= bootstrap.oauth_account.organization_uuid; credential.email ??= bootstrap.oauth_account.account_email;
    }
  } else if (provider === 'openai-codex') {
    const claims = z.object({ 'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional(), 'https://api.openai.com/profile': z.object({ email: z.string().optional() }).optional(), email: z.string().optional() });
    const access = parseProvider(provider, claims, jwt(credential.access)); const id = parseProvider(provider, claims, jwt(token.id_token ?? ''));
    credential.accountId = access['https://api.openai.com/auth']?.chatgpt_account_id ?? id['https://api.openai.com/auth']?.chatgpt_account_id;
    credential.orgId = credential.accountId;
    credential.email = access['https://api.openai.com/profile']?.email ?? id['https://api.openai.com/profile']?.email ?? id.email;
    if (!credential.accountId) throw new ProviderRefreshError(provider, 'invalid-response', 'Codex token omitted account identity', 200);
  } else {
    const profile = parseProvider(provider, z.object({ id: z.string().min(1), email: z.string().min(1) }), await request(provider, 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json', { headers: { Authorization: `Bearer ${credential.access}` } }, fetcher));
    credential.accountId = profile.id; credential.email = profile.email;
  }
  return credential;
}
export async function respondLogin(state: LoginState, input: z.input<typeof loginResponseSchema>, fetcher: typeof fetch = fetch): Promise<LoginTransition> {
  active(state); const value = loginResponseSchema.parse(input).code.trim();
  if (state.kind === 'project-input') return discoverProject(state, { ...state.credential, projectId: value }, fetcher);
  if (state.kind !== 'code') throw new ProviderLoginError('invalid-state', 'This login is not waiting for a code');
  let code: string | null = null; let csrf: string | null = null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const url = new URL(value); const redirect = new URL(state.redirectUri);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw new ProviderLoginError('invalid-response', 'Callback URL does not match this login');
    code = url.searchParams.get('code'); csrf = url.searchParams.get('state');
  } else if (state.provider === 'anthropic') { const parts = value.split('#'); code = parts[0] ?? null; csrf = parts[1] ?? null; }
  if (!code || csrf !== state.csrf) throw new ProviderLoginError('invalid-response', 'Missing authorization code or mismatched OAuth state');
  const credential = await exchange(state, code, state.verifier, state.redirectUri, state.csrf, fetcher);
  if (state.provider === 'google-gemini-cli' || state.provider === 'google-antigravity') return discoverProject(state, { ...credential, projectId: state.projectId }, fetcher);
  return completed(state, credential);
}
export async function pollLogin(state: LoginState, fetcher: typeof fetch = fetch): Promise<LoginTransition> {
  active(state);
  if (state.kind === 'code' || state.kind === 'project-input') return pending(state);
  if (state.kind === 'complete' || state.kind === 'cancelled') throw new ProviderLoginError('invalid-state', 'Login is terminal');
  if (Date.parse(state.nextPollAt) > Date.now()) return pending(state);
  if (state.kind === 'project') return pollProject(state, fetcher);
  if (state.kind === 'cursor') {
    const raw = await request('cursor', `https://api2.cursor.sh/auth/poll?${new URLSearchParams({ uuid: state.uuid, verifier: state.verifier })}`, {}, fetcher, [404]);
    if (raw === null) { const intervalMs = Math.min(10_000, state.intervalMs * 1.2); return pending({ ...state, intervalMs, nextPollAt: new Date(Date.now() + intervalMs).toISOString() }); }
    const token = parseProvider('cursor', cursorTokenSchema, raw);
    const sub = jwt(token.accessToken).sub;
    if (!token.refreshToken || typeof sub !== 'string' || !sub.trim()) throw new ProviderRefreshError('cursor', 'invalid-response', 'Cursor token omitted refresh token or account identity', 200);
    return completed(state, { provider: 'cursor', access: token.accessToken, refresh: token.refreshToken, expires: cursorExpiry(token.accessToken), accountId: sub.split('|').at(-1) });
  }
  const raw = await request('openai-codex', 'https://auth.openai.com/api/accounts/deviceauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_auth_id: state.deviceAuthId, user_code: state.userCode }) }, fetcher, [403, 404]);
  if (raw === null) return pending({ ...state, nextPollAt: new Date(Date.now() + state.intervalMs).toISOString() });
  const token = parseProvider('openai-codex', z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) }), raw);
  return completed(state, await exchange(state, token.authorization_code, token.code_verifier, 'https://auth.openai.com/deviceauth/callback', undefined, fetcher));
}
