import { ed25519 } from '@noble/curves/ed25519.js';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import { SIGNED_REQUEST_EXPIRED_MESSAGE } from './server-clock.js';

export const RELAY_PROTOCOL_VERSION = 1 as const;
/** Liveness rides the relay's WebSocket auto-response: the fixed ping is answered without waking the relay. */
export const RELAY_HEARTBEAT_MODE = 'ping-v1';
export const RELAY_PING_MESSAGE = '{"version":1,"type":"ping"}';
export const RELAY_PONG_MESSAGE = '{"version":1,"type":"pong"}';
/** A machine sending `notices=notice-v1` understands `notice` messages; older machines never receive one. */
export const RELAY_NOTICE_MODE = 'notice-v1';
export const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const RELAY_HEARTBEAT_TIMEOUT_MS = 10_000;
export const RELAY_HEARTBEAT_LEASE_MS = 35_000;
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

const relayFrameMessageSchema = z.object({
  version: z.literal(RELAY_PROTOCOL_VERSION),
  type: z.literal('frame'),
  to: endpoint,
  payload: z.string().max(MAX_ROUTED_PAYLOAD_CHARS),
});

/** What changed in the cloud, never the changed state: the machine fetches the authoritative state over HTTP. */
export const RELAY_NOTICE_TOPICS = ['assignments', 'workspace.snapshot', 'release', 'devices', 'settings', 'environment'] as const;
export const relayNoticeTopicSchema = z.enum(RELAY_NOTICE_TOPICS);
export type RelayNoticeTopic = z.infer<typeof relayNoticeTopicSchema>;
export const relayNoticeSchema = z.object({
  topics: z.array(relayNoticeTopicSchema).min(1).max(RELAY_NOTICE_TOPICS.length),
  workspaceId: z.string().min(1).max(256).optional(),
});
export type RelayNotice = z.infer<typeof relayNoticeSchema>;
const relayNoticeMessageSchema = relayNoticeSchema.extend({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('notice') });
export type RelayNoticeMessage = z.infer<typeof relayNoticeMessageSchema>;

/** A machine resource changed to `cursor`; the relay tells the account's tabs watching it, which read it again. Only the
 * machine's own start resource has no workspace. */
export const machineLiveNoticeSchema = z.object({
  workspace: z.string().min(1).max(256).nullable(),
  resource: z.string().min(1).max(512),
  cursor: streamCursorSchema,
});
export type MachineLiveNotice = z.infer<typeof machineLiveNoticeSchema>;
const liveNoticeMessageSchema = machineLiveNoticeSchema.extend({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('live.notice') });
export type LiveNoticeMessage = z.infer<typeof liveNoticeMessageSchema>;
/** No tab watched the `live.notice` for `cursor`: unless a read has seen that change since, the machine stops observing the
 * resource until a tab reads it again. */
const liveUnwatchedMessageSchema = machineLiveNoticeSchema.extend({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('live.unwatched') });
export type LiveUnwatchedMessage = z.infer<typeof liveUnwatchedMessageSchema>;

export const relaySocketMessageSchema = z.discriminatedUnion('type', [
  relayFrameMessageSchema,
  liveNoticeMessageSchema,
  z.object({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('tunnel.websocket.open'), requestId }),
  z.object({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('tunnel.websocket.data'), requestId, data: z.string().max(MAX_ROUTED_PAYLOAD_CHARS), binary: z.boolean() }),
  z.object({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('tunnel.websocket.close'), requestId, code: z.number().int(), reason: z.string().max(123) }),
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
export type TunnelResponseMessage = Exclude<RelaySocketMessage, { type: 'frame' | 'live.notice' }>;

export const tunnelRequestMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('tunnel.websocket.data'), requestId, data: z.string().max(MAX_ROUTED_PAYLOAD_CHARS), binary: z.boolean() }),
  z.object({ version: z.literal(RELAY_PROTOCOL_VERSION), type: z.literal('tunnel.websocket.close'), requestId, code: z.number().int(), reason: z.string().max(123) }),
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
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal('tunnel.request.cancel'),
    requestId,
  }),
]);
export type TunnelRequestMessage = z.infer<typeof tunnelRequestMessageSchema>;
export const machineRelayMessageSchema = z.union([tunnelRequestMessageSchema, relayFrameMessageSchema, relayNoticeMessageSchema, liveUnwatchedMessageSchema]);
export type MachineRelayMessage = z.infer<typeof machineRelayMessageSchema>;

export class InvalidRelayMessage extends TaggedError('InvalidRelayMessage')<{
  message: string;
}> {}

export class InvalidRelayAuthorization extends TaggedError('InvalidRelayAuthorization')<{
  message: string;
  /** Validly signed, but outside the clock window: the signer may correct its clock and re-sign. */
  expired: boolean;
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
export function parseMachineRelayMessage(input: string): ResultType<MachineRelayMessage, InvalidRelayMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return Result.err(new InvalidRelayMessage({ message: 'Machine relay message is not valid JSON' }));
  }
  const parsed = machineRelayMessageSchema.safeParse(decoded);
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
  if (!match) return Result.err(new InvalidRelayAuthorization({ message: 'Missing or malformed relay authorization', expired: false }));
  const timestamp = Number(match[1]);
  const nonce = match[2]!;
  if (!Number.isSafeInteger(timestamp)) return Result.err(new InvalidRelayAuthorization({ message: 'Missing or malformed relay authorization', expired: false }));
  let verified: boolean;
  try {
    verified = ed25519.verify(
      base64ToBytes(match[3]!, true),
      authorizationPayload(timestamp, nonce, input.target),
      base64ToBytes(input.signingPublicKey, false),
    );
  } catch {
    return Result.err(new InvalidRelayAuthorization({ message: 'Relay authorization key or signature is invalid', expired: false }));
  }
  if (!verified) return Result.err(new InvalidRelayAuthorization({ message: 'Relay authorization signature is invalid', expired: false }));
  // Checked after the signature so only the holder of the key learns its clock is off.
  if (Math.abs((input.now ?? Date.now()) - timestamp) > input.maxSkewMs) {
    return Result.err(new InvalidRelayAuthorization({ message: SIGNED_REQUEST_EXPIRED_MESSAGE, expired: true }));
  }
  return Result.ok({ timestamp, nonce });
}
