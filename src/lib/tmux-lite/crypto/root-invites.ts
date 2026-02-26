import { randomUUID } from 'node:crypto';
import { deriveIdentityId, sign, verify } from './identity.js';
import type { UserRootIdentity } from '../../../types/identity.js';

export const ROOT_INVITE_TOKEN_PREFIX = 'gssh-invite';

export type RootInviteType = 'relay-machine';

interface RootInviteBase {
  version: 1;
  type: RootInviteType;
  inviteId: string;
  ownerUserRootId: string;
  ownerUserRootSigningKey: string;
  relayUrl: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number | null;
  label?: string;
}

export interface RelayMachineInviteToken extends RootInviteBase {
  type: 'relay-machine';
  targetMachineId: string;
  targetMachineSigningKey: string;
  targetMachineKeyExchangeKey: string;
  signature: string;
}

export type RootInviteToken = RelayMachineInviteToken;

type UnsignedRootInvite = Omit<RelayMachineInviteToken, 'signature'>;

export type CreateRootInviteInput = {
  type: 'relay-machine';
  owner: UserRootIdentity;
  relayUrl: string;
  targetMachineSigningKey: string;
  targetMachineKeyExchangeKey: string;
  expiresAt: number;
  maxUses: number | null;
  label?: string;
  inviteId?: string;
};

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalizeForSigning(value: object): string {
  return JSON.stringify(sortValue(value));
}

function encodeToken(token: RootInviteToken): string {
  return `${ROOT_INVITE_TOKEN_PREFIX}:${Buffer.from(JSON.stringify(token), 'utf-8').toString('base64url')}`;
}

function decodeToken(encoded: string): string | null {
  const trimmed = encoded.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith(`${ROOT_INVITE_TOKEN_PREFIX}:`)) {
    return null;
  }

  const value = trimmed.slice(ROOT_INVITE_TOKEN_PREFIX.length + 1);
  if (!value) {
    return null;
  }

  try {
    return Buffer.from(value, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
}

function decodeBase64Key(key: string): Uint8Array | null {
  try {
    const bytes = new Uint8Array(Buffer.from(key, 'base64'));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function decodeBase64Signature(signature: string): Uint8Array | null {
  try {
    const bytes = new Uint8Array(Buffer.from(signature, 'base64'));
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

function deriveIdFromBase64SigningKey(key: string): string | null {
  const bytes = decodeBase64Key(key);
  if (!bytes) {
    return null;
  }

  try {
    return deriveIdentityId(bytes);
  } catch {
    return null;
  }
}

function verifyInviteSignature(token: RootInviteToken): boolean {
  const signatureBytes = decodeBase64Signature(token.signature);
  const ownerSigningKeyBytes = decodeBase64Key(token.ownerUserRootSigningKey);
  if (!signatureBytes || !ownerSigningKeyBytes) {
    return false;
  }

  const { signature, ...unsigned } = token;
  const canonical = canonicalizeForSigning(unsigned);
  const payload = new TextEncoder().encode(canonical);
  return verify(payload, signatureBytes, ownerSigningKeyBytes);
}

function signUnsignedInvite(unsigned: UnsignedRootInvite, owner: UserRootIdentity): string {
  const canonical = canonicalizeForSigning(unsigned);
  const signature = sign(new TextEncoder().encode(canonical), owner.signing.secretKey);
  return Buffer.from(signature).toString('base64');
}

export function createRootInviteToken(input: CreateRootInviteInput): string {
  const inviteId = input.inviteId ?? randomUUID();
  const ownerSigningKey = Buffer.from(input.owner.signing.publicKey).toString('base64');

  const targetMachineId = deriveIdFromBase64SigningKey(input.targetMachineSigningKey);
  if (!targetMachineId) {
    throw new Error('Invalid target machine signing key');
  }

  const keyExchangeKey = decodeBase64Key(input.targetMachineKeyExchangeKey);
  if (!keyExchangeKey) {
    throw new Error('Invalid target machine key exchange key');
  }

  const unsigned: UnsignedRootInvite = {
    version: 1,
    type: 'relay-machine',
    inviteId,
    ownerUserRootId: input.owner.id,
    ownerUserRootSigningKey: ownerSigningKey,
    relayUrl: input.relayUrl,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    maxUses: input.maxUses,
    label: input.label,
    targetMachineId,
    targetMachineSigningKey: input.targetMachineSigningKey,
    targetMachineKeyExchangeKey: input.targetMachineKeyExchangeKey,
  };

  const signature = signUnsignedInvite(unsigned, input.owner);
  return encodeToken({ ...unsigned, signature });
}

function hasBaseInviteShape(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    value.type === 'relay-machine' &&
    typeof value.inviteId === 'string' &&
    typeof value.ownerUserRootId === 'string' &&
    typeof value.ownerUserRootSigningKey === 'string' &&
    typeof value.relayUrl === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.expiresAt === 'number' &&
    (value.maxUses === null || typeof value.maxUses === 'number') &&
    (value.label === undefined || typeof value.label === 'string') &&
    typeof value.targetMachineId === 'string' &&
    typeof value.targetMachineSigningKey === 'string' &&
    typeof value.targetMachineKeyExchangeKey === 'string' &&
    typeof value.signature === 'string'
  );
}

function parseInviteObject(obj: Record<string, unknown>): RootInviteToken | null {
  if (!hasBaseInviteShape(obj)) {
    return null;
  }

  return {
    version: 1,
    type: 'relay-machine',
    inviteId: obj.inviteId as string,
    ownerUserRootId: obj.ownerUserRootId as string,
    ownerUserRootSigningKey: obj.ownerUserRootSigningKey as string,
    relayUrl: obj.relayUrl as string,
    createdAt: obj.createdAt as number,
    expiresAt: obj.expiresAt as number,
    maxUses: obj.maxUses as number | null,
    label: obj.label as string | undefined,
    targetMachineId: obj.targetMachineId as string,
    targetMachineSigningKey: obj.targetMachineSigningKey as string,
    targetMachineKeyExchangeKey: obj.targetMachineKeyExchangeKey as string,
    signature: obj.signature as string,
  };
}

function validateInviteClaims(token: RootInviteToken): boolean {
  const ownerUserRootId = deriveIdFromBase64SigningKey(token.ownerUserRootSigningKey);
  if (!ownerUserRootId || ownerUserRootId !== token.ownerUserRootId) {
    return false;
  }

  const derivedMachineId = deriveIdFromBase64SigningKey(token.targetMachineSigningKey);
  if (!derivedMachineId || derivedMachineId !== token.targetMachineId) {
    return false;
  }

  const machineKex = decodeBase64Key(token.targetMachineKeyExchangeKey);
  if (!machineKex) {
    return false;
  }

  return true;
}

export function parseRootInviteToken(encoded: string): RootInviteToken | null {
  const json = decodeToken(encoded);
  if (!json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const token = parseInviteObject(parsed as Record<string, unknown>);
  if (!token) {
    return null;
  }

  if (!validateInviteClaims(token)) {
    return null;
  }

  if (!verifyInviteSignature(token)) {
    return null;
  }

  return token;
}

export function isRootInviteExpired(invite: Pick<RootInviteToken, 'expiresAt'>): boolean {
  return Date.now() > invite.expiresAt;
}
