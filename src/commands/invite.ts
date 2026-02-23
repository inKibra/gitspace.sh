import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { promptPassword } from '../utils/prompts.js';
import { keypairExists, loadKeypair, readRelayConfig } from '../core/identity.js';
import { createLocalDeviceCertificate, loadUserRootIdentity } from '../core/user-identity.js';
import { parseUserRootPublicKey } from '../lib/tmux-lite/crypto/user-identity.js';
import { createNodeRelaySigner } from '../session/adapters/node-remote.js';
import { deriveIdentityId } from '../lib/tmux-lite/crypto/identity.js';
import { RelayRequestClient, nodeRelaySocketAdapter } from '../relay-client/index.js';
import {
  createRootInviteToken,
  parseRootInviteToken,
  type RootInviteType,
} from '../lib/tmux-lite/crypto/root-invites.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';

type RelayRequestPayload = Record<string, unknown>;

function parseDuration(duration: string): { milliseconds: number; humanReadable: string } {
  const match = duration.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new SpacesError(
      `Invalid duration format: ${duration}\nExpected format: number + unit (h=hours, d=days, w=weeks).`,
      'USER_ERROR',
      1,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'h':
      return { milliseconds: value * 60 * 60 * 1000, humanReadable: value === 1 ? '1 hour' : `${value} hours` };
    case 'd':
      return { milliseconds: value * 24 * 60 * 60 * 1000, humanReadable: value === 1 ? '1 day' : `${value} days` };
    case 'w':
      return { milliseconds: value * 7 * 24 * 60 * 60 * 1000, humanReadable: value === 1 ? '1 week' : `${value} weeks` };
    default:
      throw new SpacesError('Unsupported duration unit', 'USER_ERROR', 1);
  }
}

function parseMaxUses(value: string | undefined): number | null {
  if (!value || value.trim() === '') {
    return 1;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'unlimited' || normalized === 'infinite' || normalized === 'inf') {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SpacesError('max-uses must be a positive integer or "unlimited".', 'USER_ERROR', 1);
  }
  return parsed;
}

function parseBase64Key(key: string, label: string): Uint8Array {
  const normalized = key.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new SpacesError(`${label} must be base64.`, 'USER_ERROR', 1);
  }

  const decoded = Buffer.from(normalized, 'base64');
  const reencoded = decoded.toString('base64');
  if (reencoded !== normalized) {
    throw new SpacesError(`${label} must be base64.`, 'USER_ERROR', 1);
  }

  const parsed = new Uint8Array(decoded);

  if (parsed.length !== 32) {
    throw new SpacesError(`${label} must be a 32-byte base64 key.`, 'USER_ERROR', 1);
  }

  return parsed;
}

function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function resolveRelayUrl(explicitRelayUrl?: string, inviteToken?: string): string {
  if (explicitRelayUrl?.trim()) {
    return explicitRelayUrl.trim();
  }

  if (inviteToken) {
    const parsedInvite = parseRootInviteToken(inviteToken);
    if (parsedInvite?.relayUrl) {
      return parsedInvite.relayUrl;
    }
  }

  const relayConfig = readRelayConfig();
  if (relayConfig?.relayUrl) {
    return relayConfig.relayUrl;
  }

  throw new SpacesError('Relay URL is required. Pass --relay <url>.', 'USER_ERROR', 1);
}

async function loadSignedClientContext(): Promise<{
  relaySigner: <T extends object>(message: T) => T;
  identityId: string;
  deviceCertificate: string;
}> {
  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  const password = await promptPassword('Enter password to unlock identity:');
  if (!password) {
    throw new SpacesError('Cancelled', 'USER_ERROR', 1);
  }

  const identity = await loadKeypair(password);
  if (!identity) {
    throw new SpacesError('Failed to unlock identity. Check your password.', 'USER_ERROR', 1);
  }

  const deviceCertificate = await createLocalDeviceCertificate(identity);
  return {
    relaySigner: createNodeRelaySigner(identity),
    identityId: identity.id,
    deviceCertificate,
  };
}

async function sendRelayRequest<T>(
  relayUrl: string,
  createPayload: () => RelayRequestPayload,
  onMessage: (msg: Record<string, unknown>) => T | null,
): Promise<T> {
  const client = new RelayRequestClient({
    relayUrl,
    socketAdapter: nodeRelaySocketAdapter,
    timeoutMs: 20000,
  });

  try {
    return await client.sendRequest(createPayload, onMessage);
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const relayCodeMatch = message.match(/^\[([A-Z_]+)]\s+/);
    const relayCode = relayCodeMatch?.[1];
    const userErrorCodes = new Set([
      'FORBIDDEN',
      'UNAUTHORIZED',
      'NOT_FOUND',
      'INVALID_REQUEST',
      'IDENTITY_MISMATCH',
    ]);

    throw new SpacesError(
      message,
      relayCode && userErrorCodes.has(relayCode) ? 'USER_ERROR' : 'SYSTEM_ERROR',
      relayCode && userErrorCodes.has(relayCode) ? 1 : 2,
    );
  }
}

function parseTargetUserKey(user: string): { userRootId: string; signingKeyBase64: string } {
  let parsed: { userRootId: string; signingPublicKey: Uint8Array };
  try {
    parsed = parseUserRootPublicKey(user.trim());
  } catch (error) {
    throw new SpacesError(
      error instanceof Error ? error.message : 'Invalid user root public key format.',
      'USER_ERROR',
      1,
    );
  }
  return {
    userRootId: parsed.userRootId,
    signingKeyBase64: Buffer.from(parsed.signingPublicKey).toString('base64'),
  };
}

async function createInviteViaRelay(
  relayUrl: string,
  inviteToken: string,
): Promise<{ inviteId: string }> {
  const context = await loadSignedClientContext();

  return sendRelayRequest<{ inviteId: string }>(
    relayUrl,
    () => context.relaySigner({
      type: 'create_root_invite' as const,
      clientIdentityId: context.identityId,
      deviceCertificate: context.deviceCertificate,
      inviteToken,
    }),
    (msg) => {
      if (msg.type !== 'root_invite_created') {
        return null;
      }
      if (typeof msg.inviteId !== 'string') {
        throw new SpacesError('Invalid root_invite_created response', 'SYSTEM_ERROR', 2);
      }
      return { inviteId: msg.inviteId };
    },
  );
}

export async function createRelayUserInvite(user: string, options: {
  relay?: string;
  expires?: string;
  maxUses?: string;
  label?: string;
}): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError('User root identity is required. Run `gssh user identity init` first.', 'USER_ERROR', 1);
  }

  const relayUrl = resolveRelayUrl(options.relay);
  const target = parseTargetUserKey(user);
  const duration = parseDuration(options.expires ?? '24h');
  const maxUses = parseMaxUses(options.maxUses);

  const inviteToken = createRootInviteToken({
    type: 'relay-user',
    owner,
    relayUrl,
    targetUserRootSigningKey: target.signingKeyBase64,
    expiresAt: Date.now() + duration.milliseconds,
    maxUses,
    label: options.label,
  });
  const parsedInvite = parseRootInviteToken(inviteToken);
  if (!parsedInvite) {
    throw new SpacesError('Failed to build invite token', 'SYSTEM_ERROR', 2);
  }

  await createInviteViaRelay(relayUrl, inviteToken);

  logger.success('Relay-user invite created');
  logger.log(`  Invite ID: ${chalk.cyan(parsedInvite.inviteId)}`);
  logger.log(`  Target:    ${chalk.cyan(target.userRootId)}`);
  logger.log(`  Expires:   ${formatDate(parsedInvite.expiresAt)} (${duration.humanReadable})`);
  logger.log(`  Max uses:  ${parsedInvite.maxUses === null ? 'unlimited' : parsedInvite.maxUses}`);
  logger.log('');
  logger.bold('Invite Token:');
  logger.log(inviteToken);
}

export async function createRelayMachineInvite(options: {
  relay?: string;
  machineSigningKey: string;
  machineKeyExchangeKey: string;
  expires?: string;
  maxUses?: string;
  label?: string;
}): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError('User root identity is required. Run `gssh user identity init` first.', 'USER_ERROR', 1);
  }

  parseBase64Key(options.machineSigningKey, 'Machine signing key');
  parseBase64Key(options.machineKeyExchangeKey, 'Machine key exchange key');

  const relayUrl = resolveRelayUrl(options.relay);
  const duration = parseDuration(options.expires ?? '24h');
  const maxUses = parseMaxUses(options.maxUses);

  const inviteToken = createRootInviteToken({
    type: 'relay-machine',
    owner,
    relayUrl,
    targetMachineSigningKey: options.machineSigningKey,
    targetMachineKeyExchangeKey: options.machineKeyExchangeKey,
    expiresAt: Date.now() + duration.milliseconds,
    maxUses,
    label: options.label,
  });
  const parsedInvite = parseRootInviteToken(inviteToken);
  if (!parsedInvite || parsedInvite.type !== 'relay-machine') {
    throw new SpacesError('Failed to build relay-machine invite token', 'SYSTEM_ERROR', 2);
  }

  await createInviteViaRelay(relayUrl, inviteToken);

  logger.success('Relay-machine invite created');
  logger.log(`  Invite ID: ${chalk.cyan(parsedInvite.inviteId)}`);
  logger.log(`  Machine:   ${chalk.cyan(parsedInvite.targetMachineId)}`);
  logger.log(`  Expires:   ${formatDate(parsedInvite.expiresAt)} (${duration.humanReadable})`);
  logger.log(`  Max uses:  ${parsedInvite.maxUses === null ? 'unlimited' : parsedInvite.maxUses}`);
  logger.log('');
  logger.bold('Invite Token:');
  logger.log(inviteToken);
  logger.log('');
  logger.dim('Enroll command:');
  logger.dim(`  gssh machine enroll --invite "${inviteToken}"`);
}

export async function createMachineUserInvite(
  machineId: string,
  user: string,
  options: {
    relay?: string;
    expires?: string;
    maxUses?: string;
    label?: string;
  },
): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError('User root identity is required. Run `gssh user identity init` first.', 'USER_ERROR', 1);
  }

  const relayUrl = resolveRelayUrl(options.relay);
  const target = parseTargetUserKey(user);
  const duration = parseDuration(options.expires ?? '24h');
  const maxUses = parseMaxUses(options.maxUses);

  const inviteToken = createRootInviteToken({
    type: 'machine-user',
    owner,
    relayUrl,
    machineId,
    targetUserRootSigningKey: target.signingKeyBase64,
    expiresAt: Date.now() + duration.milliseconds,
    maxUses,
    label: options.label,
  });
  const parsedInvite = parseRootInviteToken(inviteToken);
  if (!parsedInvite || parsedInvite.type !== 'machine-user') {
    throw new SpacesError('Failed to build machine-user invite token', 'SYSTEM_ERROR', 2);
  }

  await createInviteViaRelay(relayUrl, inviteToken);

  logger.success('Machine-user invite created');
  logger.log(`  Invite ID: ${chalk.cyan(parsedInvite.inviteId)}`);
  logger.log(`  Machine:   ${chalk.cyan(parsedInvite.machineId)}`);
  logger.log(`  Target:    ${chalk.cyan(target.userRootId)}`);
  logger.log(`  Expires:   ${formatDate(parsedInvite.expiresAt)} (${duration.humanReadable})`);
  logger.log(`  Max uses:  ${parsedInvite.maxUses === null ? 'unlimited' : parsedInvite.maxUses}`);
  logger.log('');
  logger.bold('Invite Token:');
  logger.log(inviteToken);
}

export async function listInvites(options: {
  relay?: string;
  type?: RootInviteType;
  json?: boolean;
}): Promise<void> {
  if (
    options.type !== undefined &&
    options.type !== 'relay-user' &&
    options.type !== 'relay-machine' &&
    options.type !== 'machine-user'
  ) {
    throw new SpacesError('Invalid invite type. Use relay-user, relay-machine, or machine-user.', 'USER_ERROR', 1);
  }

  const relayUrl = resolveRelayUrl(options.relay);
  const context = await loadSignedClientContext();

  type InviteListItem = {
    inviteId: string;
    inviteType: RootInviteType;
    relayUrl: string;
    label?: string;
    maxUses: number | null;
    usedCount: number;
    expiresAt: string;
    createdAt: string;
    revokedAt?: string;
    targetUserRootId?: string;
    machineId?: string;
  };

  const response = await sendRelayRequest<{ invites: InviteListItem[] }>(
    relayUrl,
    () => context.relaySigner({
      type: 'list_root_invites' as const,
      clientIdentityId: context.identityId,
      deviceCertificate: context.deviceCertificate,
      inviteType: options.type,
    }),
    (msg) => {
      if (msg.type !== 'root_invite_list') {
        return null;
      }
      if (!Array.isArray(msg.invites)) {
        throw new SpacesError('Invalid root_invite_list response', 'SYSTEM_ERROR', 2);
      }
      return { invites: msg.invites as InviteListItem[] };
    },
  );

  if (options.json) {
    logger.log(JSON.stringify(response.invites, null, 2));
    return;
  }

  if (response.invites.length === 0) {
    logger.info('No invites found.');
    return;
  }

  logger.bold('Invites:');
  logger.log('');
  for (const invite of response.invites) {
    logger.log(`${chalk.cyan(invite.inviteId)}  ${invite.inviteType}`);
    logger.log(`  Uses:    ${invite.usedCount}/${invite.maxUses === null ? '∞' : invite.maxUses}`);
    logger.log(`  Expires: ${invite.expiresAt}`);
    if (invite.machineId) {
      logger.log(`  Machine: ${invite.machineId}`);
    }
    if (invite.targetUserRootId) {
      logger.log(`  User:    ${invite.targetUserRootId}`);
    }
    if (invite.label) {
      logger.log(`  Label:   ${invite.label}`);
    }
    if (invite.revokedAt) {
      logger.log(`  Status:  revoked (${invite.revokedAt})`);
    }
    logger.log('');
  }
}

export async function revokeInvite(inviteId: string, options: { relay?: string }): Promise<void> {
  const relayUrl = resolveRelayUrl(options.relay);
  const context = await loadSignedClientContext();

  await sendRelayRequest<void>(
    relayUrl,
    () => context.relaySigner({
      type: 'revoke_root_invite' as const,
      clientIdentityId: context.identityId,
      deviceCertificate: context.deviceCertificate,
      inviteId,
    }),
    (msg) => {
      if (msg.type !== 'root_invite_revoked') {
        return null;
      }
      return undefined;
    },
  );

  logger.success(`Revoked invite ${inviteId}`);
}

export async function acceptInviteForUser(
  token: string,
  options: { relay?: string } = {},
): Promise<void> {
  const parsedInvite = parseRootInviteToken(token);
  if (!parsedInvite) {
    throw new SpacesError('Invalid invite token format or signature.', 'USER_ERROR', 1);
  }

  if (parsedInvite.type === 'relay-machine') {
    throw new SpacesError(
      'This is a machine enrollment invite. Use `gssh machine enroll --invite <token>`.',
      'USER_ERROR',
      1,
    );
  }

  const relayUrl = resolveRelayUrl(options.relay, token);
  const context = await loadSignedClientContext();

  type AcceptedResult = {
    inviteId: string;
    inviteType: RootInviteType;
    granted: 'relay' | 'machine';
    machineId?: string;
  };

  const result = await sendRelayRequest<AcceptedResult>(
    relayUrl,
    () => context.relaySigner({
      type: 'accept_root_invite' as const,
      clientIdentityId: context.identityId,
      deviceCertificate: context.deviceCertificate,
      inviteToken: token,
    }),
    (msg) => {
      if (msg.type !== 'root_invite_accepted') {
        return null;
      }
      if (
        typeof msg.inviteId !== 'string' ||
        (msg.inviteType !== 'relay-user' && msg.inviteType !== 'relay-machine' && msg.inviteType !== 'machine-user') ||
        (msg.granted !== 'relay' && msg.granted !== 'machine')
      ) {
        throw new SpacesError('Invalid root_invite_accepted response', 'SYSTEM_ERROR', 2);
      }

      return {
        inviteId: msg.inviteId,
        inviteType: msg.inviteType,
        granted: msg.granted,
        machineId: typeof msg.machineId === 'string' ? msg.machineId : undefined,
      };
    },
  );

  if (result.granted === 'relay') {
    logger.success('Relay access granted');
    logger.log(`  Invite: ${result.inviteId}`);
    return;
  }

  logger.success('Machine access granted');
  logger.log(`  Invite:  ${result.inviteId}`);
  if (result.machineId) {
    logger.log(`  Machine: ${result.machineId}`);
  }
}

export function deriveMachineIdFromSigningKey(signingKeyBase64: string): string {
  const signingBytes = parseBase64Key(signingKeyBase64, 'Machine signing key');
  return deriveIdentityId(signingBytes);
}
