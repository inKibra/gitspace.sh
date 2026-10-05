import { z } from 'zod';
import { RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeToolDispatch, type RuntimeToolResult } from './base.js';
import { RuntimeDispatchIdentitySchema, RuntimeExecutorReceiptSchema, RuntimeReceiptAcknowledgementSchema, type RuntimeExecutorReceipt } from './execution-contracts.js';

/** RFC 8785 uses ECMAScript number serialization and UTF-16 code unit key order. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') { for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); if (n >= 0xd800 && n <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode'); } else if (n >= 0xdc00 && n <= 0xdfff) throw new Error('Invalid Unicode'); } return JSON.stringify(value); }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) entries.push(canonicalJson(value[index]));
    return `[${entries.join(',')}]`;
  }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return `{${Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new Error('Not canonical JSON');
}
const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array): string => {
  const encoded = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index++) {
    const high = bytes[index]! >>> 4, low = bytes[index]! & 15;
    encoded[index * 2] = high < 10 ? high + 48 : high + 87;
    encoded[index * 2 + 1] = low < 10 ? low + 48 : low + 87;
  }
  return new TextDecoder().decode(encoded);
};
const unhex = (value: string): Uint8Array<ArrayBuffer> => {
  // Callers supply schema-validated lowercase hex. Do not allocate one string
  // per ciphertext byte: full receipts must fit within Worker memory limits.
  const decoded = new Uint8Array(value.length / 2);
  for (let index = 0; index < decoded.length; index++) {
    const high = value.charCodeAt(index * 2), low = value.charCodeAt(index * 2 + 1);
    decoded[index] = ((high < 58 ? high - 48 : high - 87) << 4) | (low < 58 ? low - 48 : low - 87);
  }
  return decoded;
};
export async function receiptDigest(value: unknown): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(canonicalJson(value))))); }
export async function dispatchIdentity(dispatch: RuntimeToolDispatch) { const { projectId, workspaceId, machineId, attachmentId, generation, conversationId, taskId, requestId, attemptId } = dispatch; return RuntimeDispatchIdentitySchema.parse({ projectId, workspaceId, machineId, attachmentId, generation, conversationId, taskId, requestId, attemptId, fingerprint: { algorithm: 'sha256', encoding: 'rfc8785', digest: await receiptDigest(dispatch) } }); }
export const RuntimeReceiptTransportSchema = z.strictObject({ receipt: RuntimeExecutorReceiptSchema, ciphertext: z.string().refine(value => value.length % 2 === 0 && !/[^a-f0-9]/u.test(value), 'Expected even-length lowercase hex').optional() });
export type RuntimeReceiptTransport = z.infer<typeof RuntimeReceiptTransportSchema>;
export const RuntimeReceiptControlSchema = z.strictObject({ op: z.enum(['observe', 'cancel', 'ack']), dispatch: RuntimeToolDispatchSchema, acknowledgement: RuntimeReceiptAcknowledgementSchema.optional() });
async function key(secret: string) { const bytes = Uint8Array.from(atob(secret.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function sealReceipt(dispatch: RuntimeToolDispatch, result: RuntimeToolResult, secret: string): Promise<RuntimeReceiptTransport> {
  const identity = await dispatchIdentity(dispatch); const nonce = crypto.getRandomValues(new Uint8Array(12)); const plain = utf8.encode(canonicalJson(result)); const receiptId = crypto.randomUUID(); const now = new Date().toISOString();
  const aad = { receiptId, dispatch: identity, completedAt: now };
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(canonicalJson(aad)) }, await key(secret), plain));
  const ciphertext = encrypted.slice(0, -16); const tag = encrypted.slice(-16);
  const digest = async (bytes: Uint8Array<ArrayBuffer>) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  return RuntimeReceiptTransportSchema.parse({ receipt: { version: 1, receiptId, dispatch: identity, observedAt: now, completedAt: now, state: 'terminal', result, output: { objectId: receiptId, encryption: { algorithm: 'AES-256-GCM', keyId: dispatch.attachmentId, nonce: hex(nonce), tag: hex(tag) }, ciphertext: { sha256: await digest(ciphertext), bytes: ciphertext.length }, plaintext: { sha256: await digest(plain), bytes: plain.length, encoding: 'runtime-tool-result-json-v1' } } }, ciphertext: hex(ciphertext) });
}
export async function verifyReceipt(dispatch: RuntimeToolDispatch, candidate: unknown, secret: string): Promise<RuntimeExecutorReceipt> {
  const envelope = RuntimeReceiptTransportSchema.parse(candidate); const receipt = envelope.receipt;
  if (canonicalJson(receipt.dispatch) !== canonicalJson(await dispatchIdentity(dispatch))) throw new Error('Receipt dispatch identity mismatch');
  if (receipt.state !== 'terminal') return receipt;
  if (envelope.ciphertext === undefined || receipt.output.encryption.keyId !== dispatch.attachmentId || receipt.output.objectId !== receipt.receiptId) throw new Error('Receipt output missing or misbound');
  const ciphertext = unhex(envelope.ciphertext); const output = receipt.output;
  const digest = async (bytes: Uint8Array<ArrayBuffer>) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (ciphertext.length !== output.ciphertext.bytes || await digest(ciphertext) !== output.ciphertext.sha256) throw new Error('Ciphertext digest mismatch');
  const encrypted = new Uint8Array(ciphertext.length + 16); encrypted.set(ciphertext); encrypted.set(unhex(output.encryption.tag), ciphertext.length);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(output.encryption.nonce), additionalData: utf8.encode(canonicalJson({ receiptId: receipt.receiptId, dispatch: receipt.dispatch, completedAt: receipt.completedAt })) }, await key(secret), encrypted));
  if (plain.length !== output.plaintext.bytes || await digest(plain) !== output.plaintext.sha256) throw new Error('Plaintext digest mismatch');
  const result = RuntimeToolResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  if (canonicalJson(result) !== canonicalJson(receipt.result)) throw new Error('Receipt result differs from authenticated output');
  return receipt;
}
