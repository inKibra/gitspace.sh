import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import type { CompiledAuthValue } from '@oh-my-pi/pi-catalog/compat/auth-types';
import type { WorkerOAuthProvider } from './schemas';

function clientValue(provider: WorkerOAuthProvider, field: string, metadata: CompiledAuthValue | undefined): string {
  if (!metadata?.value || metadata.hook || metadata.env?.length) throw new Error(`Catalog OAuth client ${field} is missing or unsupported for ${provider}`);
  let value: string;
  try { value = metadata.encoding === 'base64' ? atob(metadata.value) : metadata.value; }
  catch { throw new Error(`Catalog OAuth client ${field} has invalid encoding for ${provider}`); }
  if (!value.trim()) throw new Error(`Catalog OAuth client ${field} is empty for ${provider}`);
  return value;
}

/** Cursor uses its catalog custom flow, which intentionally has no OAuth client fields. */
export function requireCursorPolicy(): void {
  const login = authPolicyFor('cursor')?.login;
  if (login?.kind !== 'custom' || login.hook !== 'cursor') throw new Error('Catalog OAuth login policy is missing or unsupported for cursor');
}

/** The device flow uses the same registered Codex client as its canonical code policy. */
export function oauthClient(provider: Exclude<WorkerOAuthProvider, 'cursor'>): { client_id: string } & Record<string, string> {
  const login = authPolicyFor(provider)?.login;
  if (login?.kind !== 'oauth-code') throw new Error(`Catalog OAuth login policy is missing or unsupported for ${provider}`);
  const client_id = clientValue(provider, 'id', login.clientId);
  if (provider === 'google-gemini-cli' || provider === 'google-antigravity') {
    return { client_id, client_secret: clientValue(provider, 'secret', login.clientSecret) };
  }
  return { client_id };
}
