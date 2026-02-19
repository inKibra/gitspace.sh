import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlRelayIdentity,
  createCloudBootstrapToken,
  createCloudUnlockToken,
  ensureControlStore,
  consumeCloudBootstrapTokenForUnlock,
  consumeCloudRegisterPermit,
  getCloudWorkspaceByMachinePublicKey,
  getCloudWorkspace,
  getLatestCloudBootstrapToken,
  listCloudEvents,
  markCloudBootstrapReady,
  upsertCloudWorkspace,
  validateCloudBootstrapToken,
} from './store.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

describe('control relay identity pinning', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-control-relay-identity-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
    ensureControlStore();
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

  test('binds relay identity on first use', () => {
    const first = bindControlRelayIdentity({
      relayIdentityId: 'relay-id-1',
      relaySigningPublicKey: 'relay-signing-key-1',
      relayFingerprint: 'abcd:1234',
    });

    expect(first.bound).toBe(true);
    expect(first.relayIdentityId).toBe('relay-id-1');
  });

  test('re-binding same relay identity is a no-op', () => {
    bindControlRelayIdentity({
      relayIdentityId: 'relay-id-1',
      relaySigningPublicKey: 'relay-signing-key-1',
      relayFingerprint: 'abcd:1234',
    });

    const second = bindControlRelayIdentity({
      relayIdentityId: 'relay-id-1',
      relaySigningPublicKey: 'relay-signing-key-1',
      relayFingerprint: 'abcd:1234',
    });

    expect(second.bound).toBe(false);
  });

  test('mismatched relay identity is rejected', () => {
    bindControlRelayIdentity({
      relayIdentityId: 'relay-id-1',
      relaySigningPublicKey: 'relay-signing-key-1',
      relayFingerprint: 'abcd:1234',
    });

    expect(() =>
      bindControlRelayIdentity({
        relayIdentityId: 'relay-id-2',
        relaySigningPublicKey: 'relay-signing-key-2',
        relayFingerprint: 'wxyz:9999',
      })
    ).toThrow(/relay identity mismatch/i);
  });
});

describe('cloud bootstrap tokens', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-bootstrap-token-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
    ensureControlStore();

    upsertCloudWorkspace({
      id: 'ws-bootstrap-1',
      provider: 'sprites',
      providerWorkspaceId: 'sprite-1',
      status: 'bootstrapping',
      repo: 'owner/repo',
      branch: 'main',
    });
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

  test('creates bootstrap token and persists pending state', () => {
    const issued = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    expect(issued.token.length).toBeGreaterThan(20);
    expect(issued.tokenId.length).toBeGreaterThan(10);

    const latest = getLatestCloudBootstrapToken('ws-bootstrap-1');
    expect(latest).toBeDefined();
    expect(latest?.workspaceId).toBe('ws-bootstrap-1');
    expect(latest?.state).toBe('pending');
    expect(latest?.consumedAt).toBeUndefined();

    const validated = validateCloudBootstrapToken(issued.token, 'ws-bootstrap-1');
    expect(validated).toBeDefined();
    expect(validated?.workspaceId).toBe('ws-bootstrap-1');
  });

  test('consumes bootstrap token during unlock and mints one-time register permit', () => {
    const issued = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    const unlock = consumeCloudBootstrapTokenForUnlock({
      token: issued.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-signing-pub',
    });

    expect(unlock).toBeDefined();
    expect(unlock?.workspaceId).toBe('ws-bootstrap-1');
    expect(unlock?.registerPermit.length).toBeGreaterThan(20);

    const secondUnlock = consumeCloudBootstrapTokenForUnlock({
      token: issued.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-signing-pub',
    });
    expect(secondUnlock).toBeNull();

    const register = consumeCloudRegisterPermit({
      registerPermit: unlock!.registerPermit,
      workspaceId: 'ws-bootstrap-1',
      machineId: 'machine-xyz',
      machineSigningPublicKey: 'machine-signing-pub',
    });
    expect(register).toBeDefined();

    const replayRegister = consumeCloudRegisterPermit({
      registerPermit: unlock!.registerPermit,
      workspaceId: 'ws-bootstrap-1',
      machineId: 'machine-xyz',
      machineSigningPublicKey: 'machine-signing-pub',
    });
    expect(replayRegister).toBeNull();

    markCloudBootstrapReady('ws-bootstrap-1');

    const ws = getCloudWorkspace('ws-bootstrap-1');
    expect(ws?.status).toBe('ready');
    expect(ws?.machineId).toBe('machine-xyz');
    expect(ws?.machinePublicKey).toBe('machine-signing-pub');

    const events = listCloudEvents({ workspaceId: 'ws-bootstrap-1' });
    expect(events.some((e) => e.eventType === 'machine_registered')).toBe(true);
  });

  test('can look up workspace by machine public key', () => {
    const issued = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    const unlock = consumeCloudBootstrapTokenForUnlock({
      token: issued.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-pub-by-key',
    });

    consumeCloudRegisterPermit({
      registerPermit: unlock!.registerPermit,
      workspaceId: 'ws-bootstrap-1',
      machineId: 'machine-by-key',
      machineSigningPublicKey: 'machine-pub-by-key',
    });
    markCloudBootstrapReady('ws-bootstrap-1');

    const ws = getCloudWorkspaceByMachinePublicKey('machine-pub-by-key');
    expect(ws).toBeDefined();
    expect(ws?.id).toBe('ws-bootstrap-1');
  });

  test('creates unlock token with explicit unlock event', () => {
    const issued = createCloudUnlockToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    expect(issued.tokenId.length).toBeGreaterThan(10);

    const events = listCloudEvents({ workspaceId: 'ws-bootstrap-1' });
    expect(events.some((e) => e.eventType === 'unlock_token_issued')).toBe(true);
  });

  test('expired bootstrap token cannot be consumed', async () => {
    const issued = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const consumed = consumeCloudBootstrapTokenForUnlock({
      token: issued.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-signing-expired',
    });
    expect(consumed).toBeNull();
  });

  test('token cannot be consumed by a different machine key once workspace key is established', () => {
    const first = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    const firstConsume = consumeCloudBootstrapTokenForUnlock({
      token: first.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-pub-1',
    });
    expect(firstConsume).toBeDefined();

    consumeCloudRegisterPermit({
      registerPermit: firstConsume!.registerPermit,
      workspaceId: 'ws-bootstrap-1',
      machineId: 'machine-1',
      machineSigningPublicKey: 'machine-pub-1',
    });
    markCloudBootstrapReady('ws-bootstrap-1');

    const second = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    const secondConsume = consumeCloudBootstrapTokenForUnlock({
      token: second.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-pub-2',
    });
    expect(secondConsume).toBeNull();
  });

  test('register permit is bound to workspace and machine signing key', () => {
    const issued = createCloudBootstrapToken({
      workspaceId: 'ws-bootstrap-1',
      ownerIdentityId: 'owner-abc',
      ttlMs: 5 * 60 * 1000,
    });

    const unlock = consumeCloudBootstrapTokenForUnlock({
      token: issued.token,
      workspaceId: 'ws-bootstrap-1',
      machineSigningPublicKey: 'machine-signing-pub',
    });
    expect(unlock).toBeDefined();

    const wrongWorkspace = consumeCloudRegisterPermit({
      registerPermit: unlock!.registerPermit,
      workspaceId: 'ws-other',
      machineId: 'machine-1',
      machineSigningPublicKey: 'machine-signing-pub',
    });
    expect(wrongWorkspace).toBeNull();

    const wrongKey = consumeCloudRegisterPermit({
      registerPermit: unlock!.registerPermit,
      workspaceId: 'ws-bootstrap-1',
      machineId: 'machine-1',
      machineSigningPublicKey: 'machine-signing-other',
    });
    expect(wrongKey).toBeNull();
  });
});
