import { ed25519 } from '@noble/curves/ed25519.js';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { z } from 'zod';

export const ARTIFACT_ENCRYPTION_VERSION = 1 as const;
export const ARTIFACT_NONCE_BYTES = 12;
export const RELAY_PROTOCOL_VERSION = 1 as const;
export const TUNNEL_CHUNK_BYTES = 32 * 1024;
export const MAX_ROUTED_PAYLOAD_CHARS = 900_000;

const endpointId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const endpoint = z.string().min(3).max(140).regex(/^(machine|client):[A-Za-z0-9._-]+$/);
const requestId = z.uuid();
const headerPairs = z.array(z.tuple([z.string().min(1).max(256), z.string().max(8_192)])).max(100);
const encodedChunk = z.string().max(Math.ceil(TUNNEL_CHUNK_BYTES * 4 / 3) + 8);

export const socketAttachmentSchema = z.object({
  role: z.enum(['machine', 'client']),
  id: endpointId,
});
export type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

export const relaySocketMessageSchema = z.discriminatedUnion('type', [
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('frame'),
    to: endpoint,
    payload: z.string().max(MAX_ROUTED_PAYLOAD_CHARS),
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.response.start'),
    requestId,
    status: z.number().int().min(100).max(599),
    headers: headerPairs,
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.response.chunk'),
    requestId,
    data: encodedChunk,
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.response.end'),
    requestId,
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.response.error'),
    requestId,
    message: z.string().min(1).max(2_000),
  }),
]);
export type RelaySocketMessage = z.infer<typeof relaySocketMessageSchema>;
export type TunnelResponseMessage = Exclude<RelaySocketMessage, { type: 'frame' }>;

export const tunnelRequestMessageSchema = z.discriminatedUnion('type', [
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.request.start'),
    requestId,
    method: z.string().min(1).max(32),
    path: z.string().min(1).max(8_192),
    headers: headerPairs,
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.request.chunk'),
    requestId,
    data: encodedChunk,
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.request.end'),
    requestId,
  }),
]);
export type TunnelRequestMessage = z.infer<typeof tunnelRequestMessageSchema>;

export class InvalidRelayMessage extends TaggedError('InvalidRelayMessage')<{
  message: string;
}> {}

export class InvalidRelayAuthorization extends TaggedError('InvalidRelayAuthorization')<{
  message: string;
}> {}

export function parseRelaySocketMessage(input: string): ResultType<RelaySocketMessage, InvalidRelayMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return Result.err(new InvalidRelayMessage({ message: 'Relay message is not valid JSON' }));
  }
  const parsed = relaySocketMessageSchema.safeParse(decoded);
  if (!parsed.success) {
    return Result.err(new InvalidRelayMessage({ message: z.prettifyError(parsed.error) }));
  }
  return Result.ok(parsed.data);
}
export function parseTunnelRequestMessage(input: string): ResultType<TunnelRequestMessage, InvalidRelayMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return Result.err(new InvalidRelayMessage({ message: 'Tunnel request is not valid JSON' }));
  }
  const parsed = tunnelRequestMessageSchema.safeParse(decoded);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(new InvalidRelayMessage({ message: z.prettifyError(parsed.error) }));
}


export function endpointTag(attachment: SocketAttachment): string {
  return `endpoint:${attachment.role}:${attachment.id}`;
}

function bytesToBase64(bytes: Uint8Array, urlSafe: boolean): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += TUNNEL_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + TUNNEL_CHUNK_BYTES));
  }
  const encoded = btoa(binary);
  return urlSafe ? encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') : encoded;
}

function base64ToBytes(encoded: string, urlSafe: boolean): Uint8Array {
  const normalized = urlSafe
    ? encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    : encoded;
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeTunnelChunk(bytes: Uint8Array): string {
  if (bytes.byteLength > TUNNEL_CHUNK_BYTES) throw new RangeError(`Tunnel chunk exceeds ${TUNNEL_CHUNK_BYTES} bytes`);
  return bytesToBase64(bytes, false);
}

export function decodeTunnelChunk(encoded: string): Uint8Array {
  const decoded = base64ToBytes(encoded, false);
  if (decoded.byteLength > TUNNEL_CHUNK_BYTES) throw new RangeError(`Tunnel chunk exceeds ${TUNNEL_CHUNK_BYTES} bytes`);
  return decoded;
}

function authorizationPayload(timestamp: number, nonce: string, target: string): Uint8Array {
  return new TextEncoder().encode(`${timestamp}\n${nonce}\n${target}`);
}

export function createRelayAuthorization(
  signingPrivateKey: Uint8Array,
  target: string,
  now = Date.now(),
  nonce = crypto.randomUUID(),
): string {
  const signature = ed25519.sign(authorizationPayload(now, nonce, target), signingPrivateKey);
  return `GitSpace ${now}.${nonce}.${bytesToBase64(signature, true)}`;
}

export function verifyRelayAuthorization(input: {
  header: string | null;
  signingPublicKey: string;
  target: string;
  now?: number;
  maxSkewMs: number;
}): ResultType<{ timestamp: number; nonce: string }, InvalidRelayAuthorization> {
  const match = /^GitSpace (\d+)\.([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/u.exec(input.header ?? '');
  if (!match) return Result.err(new InvalidRelayAuthorization({ message: 'Missing or malformed relay authorization' }));
  const timestamp = Number(match[1]);
  const nonce = match[2]!;
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > input.maxSkewMs) {
    return Result.err(new InvalidRelayAuthorization({ message: 'Relay authorization expired' }));
  }
  try {
    const verified = ed25519.verify(
      base64ToBytes(match[3]!, true),
      authorizationPayload(timestamp, nonce, input.target),
      base64ToBytes(input.signingPublicKey, false),
    );
    return verified
      ? Result.ok({ timestamp, nonce })
      : Result.err(new InvalidRelayAuthorization({ message: 'Relay authorization signature is invalid' }));
  } catch {
    return Result.err(new InvalidRelayAuthorization({ message: 'Relay authorization key or signature is invalid' }));
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

export async function encryptArtifactBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce = crypto.getRandomValues(new Uint8Array(ARTIFACT_NONCE_BYTES)),
): Promise<Uint8Array> {
  if (key.byteLength !== 32) throw new RangeError('Artifact encryption key must be 32 bytes');
  if (nonce.byteLength !== ARTIFACT_NONCE_BYTES) throw new RangeError(`Artifact nonce must be ${ARTIFACT_NONCE_BYTES} bytes`);
  const cryptoKey = await crypto.subtle.importKey('raw', ownedBuffer(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce) },
    cryptoKey,
    ownedBuffer(plaintext),
  );
  const sealed = new Uint8Array(1 + nonce.byteLength + ciphertext.byteLength);
  sealed[0] = ARTIFACT_ENCRYPTION_VERSION;
  sealed.set(nonce, 1);
  sealed.set(new Uint8Array(ciphertext), 1 + nonce.byteLength);
  return sealed;
}

export async function decryptArtifactBytes(sealed: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.byteLength !== 32) throw new RangeError('Artifact encryption key must be 32 bytes');
  if (sealed.byteLength <= 1 + ARTIFACT_NONCE_BYTES || sealed[0] !== ARTIFACT_ENCRYPTION_VERSION) {
    throw new Error('Unsupported or malformed encrypted artifact');
  }
  const nonce = sealed.subarray(1, 1 + ARTIFACT_NONCE_BYTES);
  const ciphertext = sealed.subarray(1 + ARTIFACT_NONCE_BYTES);
  const cryptoKey = await crypto.subtle.importKey('raw', ownedBuffer(key), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce) },
    cryptoKey,
    ownedBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export * from './agent-activity.js';
export * from './credential-vault.js';
export * from './device-grant.js';
export * from './machine-pairing.js';
export * from './client.js';
export * from './routed-transport.js';
export * from './deployment.js';
export * from './environment-contract.js';
export * from './cron-contract.js';
export * from './inspector-contract.js';
export * from './mcp-contract.js';
export * from './rpc-contract.js';
export * from './project-authority.js';
export * from './rpc-crypto.js';
export * from './skills-contract.js';
export * from './space-checkpoint.js';
export * from './user-settings.js';
export * from './workspace-status.js';
export * from './dependency-graph.js';
