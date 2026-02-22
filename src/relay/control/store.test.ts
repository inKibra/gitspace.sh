import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlOwner,
  ensureControlStore,
  getControlDbPath,
  listCloudWorkspaces,
} from './store.js';
import {
  consumeRootInviteToken,
  getRootInviteByToken,
  listRootInvites,
  registerRootInvite,
  revokeRootInvite,
} from '../auth/store.js';
import { createRootInviteToken, parseRootInviteToken } from '../../lib/tmux-lite/crypto/root-invites.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../../lib/tmux-lite/crypto/user-identity.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

describe('control store', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-control-store-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDirOverride === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDirOverride;
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  test('initializes sqlite control store with default metadata', () => {
    const meta = ensureControlStore();

    expect(existsSync(getControlDbPath())).toBe(true);
    expect(meta.schemaVersion).toBe(4);
    expect(meta.createdAt.length).toBeGreaterThan(0);
    expect(meta.updatedAt.length).toBeGreaterThan(0);
    expect(meta.ownerIdentityId).toBeUndefined();
  });

  test('binds owner once and rejects different owner identity', () => {
    const first = bindControlOwner('owner-1');
    expect(first.bound).toBe(true);
    expect(first.ownerIdentityId).toBe('owner-1');

    const second = bindControlOwner('owner-1');
    expect(second.bound).toBe(false);

    expect(() => bindControlOwner('owner-2')).toThrow(/owner mismatch/i);
  });

  test('lists cloud workspaces as empty by default', () => {
    ensureControlStore();
    const workspaces = listCloudWorkspaces();
    expect(workspaces).toEqual([]);
  });

  test('registers and lists root invites', () => {
    ensureControlStore();
    const owner = mnemonicToUserIdentity(generateMnemonic());
    const target = mnemonicToUserIdentity(generateMnemonic());
    const token = createRootInviteToken({
      type: 'relay-user',
      owner,
      relayUrl: 'wss://relay.example.test/ws',
      targetUserRootSigningKey: Buffer.from(target.signing.publicKey).toString('base64'),
      expiresAt: Date.now() + 60_000,
      maxUses: 2,
      label: 'test invite',
    });
    const parsed = parseRootInviteToken(token);
    expect(parsed).not.toBeNull();

    const created = registerRootInvite({
      inviteId: parsed!.inviteId,
      ownerUserRootId: parsed!.ownerUserRootId,
      inviteType: parsed!.type,
      relayUrl: parsed!.relayUrl,
      token,
      maxUses: parsed!.maxUses,
      expiresAt: new Date(parsed!.expiresAt).toISOString(),
      label: parsed!.label,
      targetUserRootId: parsed!.type === 'relay-user' ? parsed!.targetUserRootId : undefined,
    });

    expect(created.ownerUserRootId).toBe(owner.id);
    expect(created.maxUses).toBe(2);

    const listed = listRootInvites(owner.id, { includeExpired: true, includeRevoked: true });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.inviteId).toBe(created.inviteId);
  });

  test('looks up and consumes root invites', () => {
    ensureControlStore();
    const owner = mnemonicToUserIdentity(generateMnemonic());
    const target = mnemonicToUserIdentity(generateMnemonic());
    const token = createRootInviteToken({
      type: 'relay-user',
      owner,
      relayUrl: 'wss://relay.example.test/ws',
      targetUserRootSigningKey: Buffer.from(target.signing.publicKey).toString('base64'),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
    });
    const parsed = parseRootInviteToken(token);
    expect(parsed).not.toBeNull();

    registerRootInvite({
      inviteId: parsed!.inviteId,
      ownerUserRootId: parsed!.ownerUserRootId,
      inviteType: parsed!.type,
      relayUrl: parsed!.relayUrl,
      token,
      maxUses: parsed!.maxUses,
      expiresAt: new Date(parsed!.expiresAt).toISOString(),
      targetUserRootId: parsed!.type === 'relay-user' ? parsed!.targetUserRootId : undefined,
    });

    const valid = getRootInviteByToken(parsed!.inviteId, parsed!.ownerUserRootId, token);
    expect(valid).not.toBeNull();

    const consumed = consumeRootInviteToken(parsed!.inviteId, parsed!.ownerUserRootId, token);
    expect(consumed).not.toBeNull();
    expect(consumed?.usedCount).toBe(1);

    const secondConsume = consumeRootInviteToken(parsed!.inviteId, parsed!.ownerUserRootId, token);
    expect(secondConsume).toBeNull();
  });

  test('revoked root invite cannot be looked up by token', () => {
    ensureControlStore();
    const owner = mnemonicToUserIdentity(generateMnemonic());
    const target = mnemonicToUserIdentity(generateMnemonic());
    const token = createRootInviteToken({
      type: 'relay-user',
      owner,
      relayUrl: 'wss://relay.example.test/ws',
      targetUserRootSigningKey: Buffer.from(target.signing.publicKey).toString('base64'),
      expiresAt: Date.now() + 60_000,
      maxUses: null,
    });
    const parsed = parseRootInviteToken(token);
    expect(parsed).not.toBeNull();

    const created = registerRootInvite({
      inviteId: parsed!.inviteId,
      ownerUserRootId: parsed!.ownerUserRootId,
      inviteType: parsed!.type,
      relayUrl: parsed!.relayUrl,
      token,
      maxUses: parsed!.maxUses,
      expiresAt: new Date(parsed!.expiresAt).toISOString(),
      targetUserRootId: parsed!.type === 'relay-user' ? parsed!.targetUserRootId : undefined,
    });

    const revoked = revokeRootInvite(owner.id, created.inviteId);
    expect(revoked).toBe(true);

    const lookup = getRootInviteByToken(parsed!.inviteId, parsed!.ownerUserRootId, token);
    expect(lookup).toBeNull();
  });
});
