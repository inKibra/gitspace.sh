import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

const keySchema = z.string().min(40).max(64);
const idSchema = z.string().min(1).max(160);

export const credentialAuthorityGrantSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  machineId: idSchema,
  signingPublicKey: keySchema,
  exchangePublicKey: keySchema,
  capabilities: z.array(z.enum(['credential.access', 'credential.refresh', 'storage.provision', 'storage.access', 'space.control'])).min(1),
  generation: z.number().int().positive(),
});
export type CredentialAuthorityGrant = z.infer<typeof credentialAuthorityGrantSchema>;

export const signedCredentialAuthorityGrantSchema = z.object({
  grant: credentialAuthorityGrantSchema,
  signature: z.string().min(64).max(128),
});
export type SignedCredentialAuthorityGrant = z.infer<typeof signedCredentialAuthorityGrantSchema>;

export const credentialAccessRequestSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  machineId: idSchema,
  credentialId: idSchema,
  timestamp: z.number().int().nonnegative(),
  nonce: z.uuid(),
  signature: z.string().min(64).max(128),
});
export type CredentialAccessRequest = z.infer<typeof credentialAccessRequestSchema>;

export const controlOperationSchema = z.enum([
  'storage.provision',
  'storage.credentials',
  'storage.binding',
  'secrets.list',
  'secrets.put',
  'secrets.delete',
  'secrets.materialize',
  'skills.list',
  'skills.update',
  'projects.list',
  'projects.put',
  'projects.remove',
  'projects.workspaces.locate',
  'mcp.connections.list',
  'mcp.connections.create',
  'mcp.connections.update',
  'mcp.connections.delete',
  'mcp.connections.status',
  'mcp.audit.append',
  'mcp.audit.list',
  'project.bootstrap',
  'project.get',
  'project.setLifecycle',
  'project.workspaces.list',
  'project.delete',
  'project.workspaces.put',
  'project.mcp.grants.list',
  'project.mcp.grants.put',
  'project.mcp.grants.delete',
  'project.operations.create',
  'project.operations.get',
  'project.sessions.get',
  'project.workspaces.remove',
  'project.sessions.list',
  'project.sessions.put',
  'project.artifacts.get',
  'project.artifacts.list',
  'project.artifacts.put',
  'project.promotions.get',
  'project.promotions.list',
  'project.promotions.put',
  'project.routes.list',
  'project.routes.lease',
  'project.routes.release',
  'project.operations.list',
  'project.operations.update',
  'project.events.append',
  'project.events.list',
  'project.events.latest',
  'devices.list',
  'devices.revoke',
  'deploy.stage',
  'deploy.launch',
  'deploy.status',
  'deploy.revert',
  'deploy.machineApplied',
  'space.bootstrap',
  'data.head',
  'data.get',
  'data.put',
  'catalog.space.put',
  'catalog.space.get',
  'catalog.space.list',
  'catalog.machine.put',
  'catalog.machine.list',
  'catalog.sandbox.create',
  'catalog.machine.sleep',
  'catalog.machine.resume',
  'catalog.machine.destroy',
  'catalog.machine.subscribe',
  'settings.get',
  'settings.update',
  'settings.omp.get',
  'settings.omp.update',
  'settings.handle.reserve',
  'settings.git.get',
  'settings.git.update',
  'settings.subscribe',
  'space.beginClose',
  'space.commitClosed',
  'space.abortClose',
  'space.beginOpen',
  'space.commitOpen',
  'space.failOpen',
  'space.get',
  'crons.list',
  'crons.create',
  'crons.update',
  'crons.delete',
  'crons.runNow',
  'crons.history',
  'crons.processDue',
  'crons.claimNext',
  'crons.completeRun',
  'inspector.bootstrap',
  'inspector.getOverview',
  'inspector.getGoal',
  'inspector.putGoal',
  'inspector.attachRequirementEvidence',
  'inspector.getWorkflow',
  'inspector.putWorkflow',
  'inspector.waiveWorkflowGate',
  'inspector.getRubric',
  'inspector.putRubric',
  'inspector.appendRubricJudgment',
  'inspector.listJournal',
  'inspector.startJournalPhase',
  'inspector.endJournalPhase',
  'inspector.appendJournalEntry',
  'inspector.getChangeGuide',
  'inspector.putChangeGuide',
  'inspector.markGuideSectionRead',
  'inspector.setGuideApproval',
  'inspector.listReviewThreads',
  'inspector.createReviewThread',
  'inspector.appendReviewMessage',
  'inspector.resolveReviewThread',
]);
export type ControlOperation = z.infer<typeof controlOperationSchema>;

export const signedControlRequestSchema = z.object({
  version: z.literal(1),
  userId: idSchema,
  machineId: idSchema,
  operation: controlOperationSchema,
  timestamp: z.number().int().nonnegative(),
  nonce: z.uuid(),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string().min(64).max(128),
});
export type SignedControlRequest = z.infer<typeof signedControlRequestSchema>;

export const sealedMachineCredentialSchema = z.object({
  version: z.literal(1),
  ephemeralPublicKey: keySchema,
  sealed: z.string().min(32),
});
export type SealedMachineCredential = z.infer<typeof sealedMachineCredentialSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function payload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonical(value)));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

export function signCredentialAuthorityGrant(
  grant: CredentialAuthorityGrant,
  rootSigningPrivateKey: Uint8Array,
): SignedCredentialAuthorityGrant {
  const parsed = credentialAuthorityGrantSchema.parse(grant);
  return { grant: parsed, signature: toBase64(ed25519.sign(payload(parsed), rootSigningPrivateKey)) };
}

export function verifyCredentialAuthorityGrant(
  input: SignedCredentialAuthorityGrant,
  rootSigningPublicKey: Uint8Array,
): CredentialAuthorityGrant | null {
  const parsed = signedCredentialAuthorityGrantSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return ed25519.verify(fromBase64(parsed.data.signature), payload(parsed.data.grant), rootSigningPublicKey)
      ? parsed.data.grant
      : null;
  } catch {
    return null;
  }
}

function accessRequestPayload(input: Omit<CredentialAccessRequest, 'signature'>): Uint8Array {
  return payload(input);
}

export function createCredentialAccessRequest(input: {
  userId: string;
  machineId: string;
  credentialId: string;
  signingPrivateKey: Uint8Array;
  timestamp?: number;
  nonce?: string;
}): CredentialAccessRequest {
  const unsigned = {
    version: 1 as const,
    userId: input.userId,
    machineId: input.machineId,
    credentialId: input.credentialId,
    timestamp: input.timestamp ?? Date.now(),
    nonce: input.nonce ?? crypto.randomUUID(),
  };
  return credentialAccessRequestSchema.parse({
    ...unsigned,
    signature: toBase64(ed25519.sign(accessRequestPayload(unsigned), input.signingPrivateKey)),
  });
}

export function verifyCredentialAccessRequest(input: CredentialAccessRequest, signingPublicKey: Uint8Array): boolean {
  const parsed = credentialAccessRequestSchema.safeParse(input);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  try {
    return ed25519.verify(fromBase64(signature), accessRequestPayload(unsigned), signingPublicKey);
  } catch {
    return false;
  }
}

export function createSignedControlRequest(input: {
  userId: string;
  machineId: string;
  operation: ControlOperation;
  payload: Record<string, unknown>;
  signingPrivateKey: Uint8Array;
  timestamp?: number;
  nonce?: string;
}): SignedControlRequest {
  const unsigned = {
    version: 1 as const,
    userId: input.userId,
    machineId: input.machineId,
    operation: input.operation,
    timestamp: input.timestamp ?? Date.now(),
    nonce: input.nonce ?? crypto.randomUUID(),
    payload: input.payload,
  };
  return signedControlRequestSchema.parse({
    ...unsigned,
    signature: toBase64(ed25519.sign(payload(unsigned), input.signingPrivateKey)),
  });
}

export function verifySignedControlRequest(input: SignedControlRequest, signingPublicKey: Uint8Array): boolean {
  const parsed = signedControlRequestSchema.safeParse(input);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  try {
    return ed25519.verify(fromBase64(signature), payload(unsigned), signingPublicKey);
  } catch {
    return false;
  }
}

async function recordKey(sharedSecret: Uint8Array, context: string): Promise<CryptoKey> {
  const bytes = hkdf(sha256, sharedSecret, new TextEncoder().encode('gitspace-credential-vault-v1'), new TextEncoder().encode(context), 32);
  return crypto.subtle.importKey('raw', ownedBuffer(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealCredentialForMachine(input: {
  plaintext: Uint8Array;
  machineExchangePublicKey: Uint8Array;
  context: string;
  ephemeralPrivateKey?: Uint8Array;
}): Promise<SealedMachineCredential> {
  const privateKey = input.ephemeralPrivateKey ?? crypto.getRandomValues(new Uint8Array(32));
  const publicKey = x25519.getPublicKey(privateKey);
  const shared = x25519.getSharedSecret(privateKey, input.machineExchangePublicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(nonce),
    additionalData: ownedBuffer(new TextEncoder().encode(input.context)),
  }, await recordKey(shared, input.context), ownedBuffer(input.plaintext));
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return { version: 1, ephemeralPublicKey: toBase64(publicKey), sealed: toBase64(sealed) };
}

export async function openCredentialFromVault(input: {
  envelope: SealedMachineCredential;
  machineExchangePrivateKey: Uint8Array;
  context: string;
}): Promise<Uint8Array> {
  const envelope = sealedMachineCredentialSchema.parse(input.envelope);
  const sealed = fromBase64(envelope.sealed);
  if (sealed.byteLength <= 12) throw new Error('Sealed credential is malformed');
  const shared = x25519.getSharedSecret(input.machineExchangePrivateKey, fromBase64(envelope.ephemeralPublicKey));
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(sealed.subarray(0, 12)),
    additionalData: ownedBuffer(new TextEncoder().encode(input.context)),
  }, await recordKey(shared, input.context), ownedBuffer(sealed.subarray(12)));
  return new Uint8Array(plaintext);
}

export const credentialProtocolBase64 = { encode: toBase64, decode: fromBase64 } as const;
