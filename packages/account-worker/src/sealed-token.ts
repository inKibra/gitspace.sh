import { createHmac } from 'node:crypto';

/**
 * Sealed tokens: JSON encrypted (AES-GCM) under the vault's key for a scope no stored object takes (objects' scopes are
 * `space:<id>` and `lfs:<id>`), so a token shares no key with stored bytes, names nothing readable, and cannot be
 * altered or extended. Each kind of token has its own key scope and authenticated context, so one kind never opens as
 * another.
 */
export interface SealedTokenKind { scope: string; context: string }

async function sealingKey(env: Env, kind: SealedTokenKind): Promise<{ bytes: Uint8Array; key: CryptoKey }> {
  const bytes = new Uint8Array(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(kind.scope));
  return { bytes, key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}

/** A base64url token holding `value`. A `stable` token's nonce is an HMAC of the value under a key derived from the
 * sealing key (a synthetic IV; the AES key itself never keys the HMAC), so one value always seals to one token, which
 * shows only that two tokens hold the same value; any other token's nonce is random. */
export async function sealToken(env: Env, kind: SealedTokenKind, value: unknown, { stable = false }: { stable?: boolean } = {}): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const { bytes, key } = await sealingKey(env, kind);
  const nonceKey = stable ? createHmac('sha256', bytes).update('sealed-token-nonce-key').digest() : null;
  const nonce = nonceKey ? createHmac('sha256', nonceKey).update(`${kind.context}\0`).update(body).digest().subarray(0, 12) : crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(kind.context) }, key, body));
  return Buffer.concat([nonce, sealed]).toString('base64url');
}

/** The JSON a token of this kind holds; throws for anything else. */
export async function openToken(env: Env, kind: SealedTokenKind, token: string): Promise<unknown> {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.byteLength <= 12 + 16) throw new Error('Malformed token');
  const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(kind.context) }, (await sealingKey(env, kind)).key, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(body));
}
