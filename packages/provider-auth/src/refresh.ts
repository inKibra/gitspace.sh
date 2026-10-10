// Protocols ported from the repository's pinned 18.2.11 portable OAuth patch.
import { z } from 'zod';
import type { StoredOAuthCredential, WorkerOAuthProvider } from './schemas';

import { oauthClient } from './catalog';
export class ProviderRefreshError extends Error {
  constructor(readonly provider: WorkerOAuthProvider, readonly kind: 'network' | 'rejected' | 'invalid-response', message: string, readonly status?: number) {
    super(message); this.name = 'ProviderRefreshError';
  }
}
const objectSchema = z.record(z.string(), z.unknown());
export const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive().finite(), id_token: z.string().optional(), account: z.object({ uuid: z.string().optional(), email_address: z.string().optional() }).optional(), organization: z.object({ uuid: z.string().optional() }).optional() });
export const cursorTokenSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().optional() });
/** Never includes provider response bodies, tokens or request URLs in errors. */
export async function request(provider: WorkerOAuthProvider, url: string, init: RequestInit, fetcher: typeof fetch, pendingStatuses: readonly number[] = []): Promise<Record<string, unknown> | null> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new ProviderRefreshError(provider, 'network', 'Provider request outcome is uncertain'); }
  if (pendingStatuses.includes(response.status)) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new ProviderRefreshError(provider, 'rejected', 'Provider rejected request', response.status); }
  if (Number(response.headers.get('content-length')) > 65_536) { await response.body?.cancel(); throw new ProviderRefreshError(provider, 'invalid-response', 'Provider response too large', response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderRefreshError(provider, 'invalid-response', 'Provider response is empty', response.status);
  let text = ''; let size = 0; const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { text += decoder.decode(); break; }
      size += chunk.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new ProviderRefreshError(provider, 'invalid-response', 'Provider response too large', response.status); }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof ProviderRefreshError) throw error;
    throw new ProviderRefreshError(provider, 'network', 'Provider response interrupted; outcome is uncertain', response.status);
  } finally { reader.releaseLock(); }
  try { return objectSchema.parse(JSON.parse(text)); }
  catch { throw new ProviderRefreshError(provider, 'invalid-response', 'Provider returned invalid JSON', response.status); }
}
export function parseProvider<S extends z.ZodType>(provider: WorkerOAuthProvider, schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProviderRefreshError(provider, 'invalid-response', 'Provider response missing required fields', 200);
  return parsed.data;
}
export function jwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try { return objectSchema.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))))); }
  catch { return {}; }
}
export function cursorExpiry(token: string): number {
  const exp = jwt(token).exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 - 300_000 : Date.now() + 3_600_000;
}
export async function refreshCredential(credential: StoredOAuthCredential, fetcher: typeof fetch = fetch): Promise<StoredOAuthCredential> {
  const provider = credential.provider;
  if (provider === 'cursor') {
    const data = parseProvider(provider, cursorTokenSchema, await request(provider, 'https://api2.cursor.sh/auth/exchange_user_api_key', { method: 'POST', headers: { Authorization: `Bearer ${credential.refresh}`, 'Content-Type': 'application/json' }, body: '{}' }, fetcher));
    return { ...credential, access: data.accessToken, refresh: data.refreshToken || credential.refresh, expires: cursorExpiry(data.accessToken) };
  }
  const anthropic = provider === 'anthropic';
  const fields = { grant_type: 'refresh_token', refresh_token: credential.refresh, ...oauthClient(provider) };
  const url = anthropic ? 'https://api.anthropic.com/v1/oauth/token' : provider === 'openai-codex' ? 'https://auth.openai.com/oauth/token' : 'https://oauth2.googleapis.com/token';
  const data = parseProvider(provider, tokenSchema, await request(provider, url, { method: 'POST', headers: anthropic ? { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'anthropic-sdk-typescript/0.94.0 userOAuthProvider' } : { 'content-type': 'application/x-www-form-urlencoded' }, body: anthropic ? JSON.stringify(fields) : new URLSearchParams(fields) }, fetcher));
  if (provider === 'openai-codex' && !data.refresh_token) throw new ProviderRefreshError(provider, 'invalid-response', 'Provider omitted rotated refresh token', 200);
  return { ...credential, access: data.access_token, refresh: data.refresh_token || credential.refresh, expires: Date.now() + data.expires_in * 1000 - (provider === 'openai-codex' ? 0 : 300_000) };
}
