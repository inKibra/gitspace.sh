import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { CONTROL_SOCKET_PROTOCOL, createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { parse } from 'yaml';
import { UserSettingsDO, type SettingsSnapshot } from '../src/user-settings.js';
import { tenantRootPrivateKey } from './setup.js';

function settingsStub(userId: string): DurableObjectStub<UserSettingsDO> {
  return env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(userId));
}

async function checksum(content: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('canonical user settings', () => {
  it('persists profile updates with compare-and-swap revisions', async () => {
    const stub = settingsStub(`settings-${crypto.randomUUID()}`);
    const initial = await stub.get('machine-a');
    expect(initial).toMatchObject({ revision: 0, onboardingComplete: false, profile: { handle: null } });
    const result = await stub.update('machine-a', {
      expectedRevision: 0,
      onboardingComplete: true,
      profile: { displayName: 'Brad', handle: null },
      git: { authorName: 'Brad', authorEmail: 'brad@example.com' },
      defaults: { machineId: 'machine-a', enterAction: 'steer', appearance: 'system' },
    });
    expect(result).toMatchObject({ status: 'ok', value: { revision: 1, onboardingComplete: true, updatedBy: 'machine-a' } });
    expect(await stub.update('machine-b', {
      expectedRevision: 0,
      onboardingComplete: false,
      profile: { displayName: '', handle: null },
      git: { authorName: '', authorEmail: '' },
      defaults: { machineId: null, enterAction: 'queue', appearance: 'system' },
    })).toEqual({ status: 'conflict', resource: 'user-settings', expected: 0, actual: 1 });
  });

  it('stores runtime configuration and rejects stale generations and invalid checksums', async () => {
    const stub = settingsStub(`omp-${crypto.randomUUID()}`);
    const content = '{"toolExecution":"sequential"}';
    const bytes = new TextEncoder().encode(content);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const checksum = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const result = await stub.updateRuntime('machine-a', { expectedGeneration: 0, content, checksum });
    expect(result).toMatchObject({ status: 'ok', value: { generation: 1, content, checksum, updatedBy: 'machine-a' } });
    expect(await stub.updateRuntime('machine-b', { expectedGeneration: 0, content, checksum })).toEqual({ status: 'conflict', resource: 'runtime-config', expected: 0, actual: 1 });
    await expect(Promise.resolve(stub.updateRuntime('machine-b', { expectedGeneration: 1, content: `${content}# changed\n`, checksum }))).rejects.toThrow();
    expect(await stub.getRuntime()).toMatchObject({ generation: 1, content, checksum, updatedBy: 'machine-a' });
  });
  it('stores one shared Git SSH identity for the user fleet', async () => {
    const stub = settingsStub(`git-${crypto.randomUUID()}`);
    expect(await stub.getGitIdentity()).toBeNull();
    const stored = await stub.updateGitIdentity('machine-a', {
      expectedGeneration: 0,
      privateKey: '-----BEGIN PRIVATE KEY-----\\n'.padEnd(96, 'x'),
      publicKey: `ssh-ed25519 ${'A'.repeat(64)} gitspace`,
      fingerprint: `SHA256:${'a'.repeat(43)}`,
    });
    expect(stored).toMatchObject({ status: 'ok', value: { generation: 1, updatedBy: 'machine-a' } });
    expect(await stub.getGitIdentity()).toMatchObject({ generation: 1, publicKey: `ssh-ed25519 ${'A'.repeat(64)} gitspace` });
    const rotated = await stub.updateGitIdentity('machine-b', {
      expectedGeneration: 1,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n'.padEnd(96, 'y'),
      publicKey: `ssh-ed25519 ${'B'.repeat(64)} gitspace`,
      fingerprint: `SHA256:${'b'.repeat(43)}`,
    });
    expect(rotated).toMatchObject({ status: 'ok', value: { generation: 2, updatedBy: 'machine-b' } });
  });

});

describe('inference settings migration', () => {
  it('preserves original input and migrates profile ownership independently of active runtime edits', async () => {
    const stub = settingsStub(`split-${crypto.randomUUID()}`);
    const content = 'modelRoles: { custom: openai/custom }\ncompaction: { enabled: false }\nunsupportedLegacy: true\n';
    const hash = await checksum(content);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO omp_config VALUES (1, 4, ?, ?, ?, 'legacy')", content, hash, new Date(0).toISOString());
      state.storage.sql.exec('DELETE FROM runtime_config');
      new UserSettingsDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
    });
    expect(JSON.parse((await stub.getRuntime()).content)).toEqual({ compaction: { enabled: false } });
    const prepared = await stub.prepareInferenceMigration();
    expect(prepared).toEqual({ generation: 4, settings: { modelRoles: { custom: 'openai/custom' } } });
    const migrated = await stub.finishInferenceMigration(4);
    expect(parse(migrated.content)).toEqual({ compaction: { enabled: false }, unsupportedLegacy: true });
    expect(await stub.finishInferenceMigration(4)).toEqual(migrated);
    const edited = await stub.setRuntime('browser', { expectedGeneration: 4, path: 'toolExecution', valueJson: '"sequential"' });
    expect(edited).toMatchObject({ status: 'ok', value: { generation: 5 } });
    expect(await stub.finishInferenceMigration(4)).toEqual(migrated);
    const original = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ original_content: string }>('SELECT original_content FROM omp_inference_migration').one().original_content);
    expect(original).toBe(content);
  });
  it('keeps credentials and unsupported fields out of active configuration', async () => {
    const stub = settingsStub(`restricted-${crypto.randomUUID()}`);
    for (const path of ['modelRoles', 'auth.broker.token', 'theme']) await expect(Promise.resolve(stub.setRuntime('browser', { expectedGeneration: 0, path, valueJson: '"secret"' }))).rejects.toThrow();
    await expect(Promise.resolve(stub.setRuntime('browser', { expectedGeneration: 0, path: 'retry.maxRetries', valueJson: '-1' }))).rejects.toThrow();
    expect((await stub.getRuntime()).generation).toBe(0);
  });
  it('retains credential-bearing legacy input privately and blocks inference migration', async () => {
    const stub = settingsStub(`unsafe-${crypto.randomUUID()}`);
    const content = 'providers: { custom: { apiKey: protected-legacy-secret } }\n';
    const hash = await checksum(content);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("INSERT INTO omp_config VALUES (1, 1, ?, ?, ?, 'legacy')", content, hash, new Date(0).toISOString()));
    const failure = await stub.prepareInferenceMigration().then(() => null, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toContain('protected-legacy-secret');
    expect(JSON.stringify(await stub.snapshot())).not.toContain('protected-legacy-secret');
    const original = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ original_content: string }>('SELECT original_content FROM omp_inference_migration').one().original_content);
    expect(original).toBe(content);
  });

  it('takes durable inference invalidations without changing settings revisions, and ignores delayed repeats', async () => {
    const stub = settingsStub(`invalidation-${crypto.randomUUID()}`);
    const initial = await stub.snapshot();
    await stub.inferenceChanged(4);
    expect(await stub.snapshot()).toEqual({ ...initial, inferenceRevision: 4 });
    await runInDurableObject(stub, async (_instance, state) => {
      const restarted = new UserSettingsDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      restarted.inferenceChanged(3);
      restarted.inferenceChanged(4);
      expect(restarted.snapshot()).toEqual({ ...initial, inferenceRevision: 4 });
      restarted.inferenceChanged(5);
    });
    expect(await stub.snapshot()).toEqual({ ...initial, inferenceRevision: 5 });
  });

  it('pushes the inference revision to authenticated websocket subscribers without advancing runtime generation', async () => {
    const userId = env.ACCOUNT_ID;
    // The tenant's vault is rooted in the tenant key the Worker is deployed with.
    const rootPrivateKey = tenantRootPrivateKey;
    const signingPrivateKey = new Uint8Array(32).fill(22);
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(23)),
    });
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1, userId, machineId: 'inference-subscriber', generation: 1, capabilities: ['storage.access'],
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(24))),
    }, rootPrivateKey));
    const signed = createSignedControlRequest({ userId, machineId: 'inference-subscriber', operation: 'settings.subscribe', payload: {}, signingPrivateKey });
    const control = btoa(JSON.stringify(signed)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const response = await SELF.fetch('https://auth.test/v1/settings/events', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `${CONTROL_SOCKET_PROTOCOL}${control}` } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const message = new Promise<unknown>((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
      const stub = settingsStub(userId);
      const before = await stub.snapshot();
      await stub.inferenceChanged(before.inferenceRevision + 1);
      expect(await message).toEqual({ type: 'settings.changed', userRevision: before.user.revision, runtimeGeneration: before.runtime.generation, inferenceRevision: before.inferenceRevision + 1 });
      expect((await stub.getRuntime()).generation).toBe(before.runtime.generation);
    } finally {
      socket.close(1000, 'done');
    }
  });
});
