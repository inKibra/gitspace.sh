import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { parse } from 'yaml';
import { SettingsRevisionConflict, UserSettingsDO, type SettingsSnapshot } from '../src/user-settings.js';

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
      defaults: { machineId: 'machine-a', enterAction: 'steer' },
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

  it('stores the exact OMP file and rejects stale generations and invalid checksums', async () => {
    const stub = settingsStub(`omp-${crypto.randomUUID()}`);
    const content = 'cycleOrder:\n  - default\n';
    const bytes = new TextEncoder().encode(content);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const checksum = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const result = await stub.updateOmp('machine-a', { expectedGeneration: 0, content, checksum });
    expect(result).toMatchObject({ status: 'ok', value: { generation: 1, content, checksum, updatedBy: 'machine-a' } });
    expect(await stub.updateOmp('machine-b', { expectedGeneration: 0, content, checksum })).toEqual({ status: 'conflict', resource: 'omp-config', expected: 0, actual: 1 });
    await expect(Promise.resolve(stub.updateOmp('machine-b', { expectedGeneration: 1, content: `${content}# changed\n`, checksum }))).rejects.toThrow();
    expect(await stub.getOmp()).toMatchObject({ generation: 1, content, checksum, updatedBy: 'machine-a' });
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
  it('splits inference ownership without losing custom settings and retries after restart and later Advanced writes', async () => {
    const stub = settingsStub(`split-${crypto.randomUUID()}`);
    const content = [
      'modelRoles:',
      '  default: anthropic/claude-sonnet',
      '  custom-review: openai/review-model',
      'cycleOrder: [custom-review, default]',
      'agents:',
      '  custom-review: { modelRole: custom-review, maxTurns: 8 }',
      'providers:',
      '  custom: { baseUrl: "https://models.example.test", models: ["review-model"] }',
      'task:',
      '  agentModelOverrides: { reviewer: custom-review }',
      '  maxConcurrency: 3',
      'customAdvanced: { enabled: true, labels: [a, b] }',
      '',
    ].join('\n');
    await stub.updateOmp('machine-a', { expectedGeneration: 0, content, checksum: await checksum(content) });
    const prepared = await stub.prepareInferenceMigration();
    expect(prepared).toEqual({
      generation: 1,
      settings: {
        modelRoles: { default: 'anthropic/claude-sonnet', 'custom-review': 'openai/review-model' },
        cycleOrder: ['custom-review', 'default'],
        agents: { 'custom-review': { modelRole: 'custom-review', maxTurns: 8 } },
        providers: { custom: { baseUrl: 'https://models.example.test', models: ['review-model'] } },
        'task.agentModelOverrides': { reviewer: 'custom-review' },
      },
    });
    expect(await stub.getOmp()).toMatchObject({ generation: 1, content });
    const advanced = await runInDurableObject(stub, async (_instance, state) => {
      const restarted = new UserSettingsDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(restarted.prepareInferenceMigration()).toEqual(prepared);
      return restarted.finishInferenceMigration(prepared.generation);
    });
    expect(advanced.generation).toBe(2);
    expect(advanced.checksum).toBe(await checksum(advanced.content));
    expect(parse(advanced.content)).toEqual({ task: { maxConcurrency: 3 }, customAdvanced: { enabled: true, labels: ['a', 'b'] } });
    expect(await stub.finishInferenceMigration(prepared.generation)).toEqual(advanced);
    const next = 'task: { maxConcurrency: 5 }\ncustomAdvanced: { enabled: false }\n';
    const updated = await stub.updateOmp('machine-b', { expectedGeneration: 2, content: next, checksum: await checksum(next) });
    expect(updated).toMatchObject({ status: 'ok', value: { generation: 3, content: next } });
    expect(await stub.prepareInferenceMigration()).toEqual(prepared);
    expect(await stub.finishInferenceMigration(prepared.generation)).toMatchObject({ generation: 3, content: next });
    const recovery = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ original_content: string }>('SELECT original_content FROM omp_inference_migration WHERE id = 1').one().original_content);
    expect(recovery).toBe(content);
  });

  it('fences pending writes, preserves user/git changes, and rejects legacy inference edits after cutover', async () => {
    const stub = settingsStub(`fence-${crypto.randomUUID()}`);
    const content = 'modelRoles: { custom: provider/custom }\nadvanced: true\n';
    await stub.updateOmp('machine-a', { expectedGeneration: 0, content, checksum: await checksum(content) });
    const prepared = await stub.prepareInferenceMigration();
    const advancedOnly = 'advanced: false\n';
    await expect(stub.updateOmp('machine-b', { expectedGeneration: 1, content: advancedOnly, checksum: await checksum(advancedOnly) })).rejects.toThrow();
    await expect(stub.updateOmp('machine-b', { expectedGeneration: 1, content, checksum: await checksum(content) })).rejects.toThrow();
    expect(await stub.updateOmp('machine-b', { expectedGeneration: 0, content: advancedOnly, checksum: await checksum(advancedOnly) })).toEqual({ status: 'conflict', resource: 'omp-config', expected: 0, actual: 1 });
    await expect(runInDurableObject(stub, (instance) => instance.finishInferenceMigration(0))).rejects.toBeInstanceOf(SettingsRevisionConflict);
    expect(await stub.prepareInferenceMigration()).toEqual(prepared);
    const user = await stub.get('machine-a');
    expect(await stub.update('machine-b', { ...user, expectedRevision: user.revision, profile: { displayName: 'Updated during migration', handle: null } })).toMatchObject({ status: 'ok', value: { revision: 1 } });
    expect(await stub.updateGitIdentity('machine-b', {
      expectedGeneration: 0,
      privateKey: '-----BEGIN PRIVATE KEY-----\n'.padEnd(96, 'x'),
      publicKey: `ssh-ed25519 ${'A'.repeat(64)} gitspace`,
      fingerprint: `SHA256:${'a'.repeat(43)}`,
    })).toMatchObject({ status: 'ok', value: { generation: 1 } });
    const migrated = await stub.finishInferenceMigration(prepared.generation);
    await expect(stub.updateOmp('machine-b', { expectedGeneration: migrated.generation, content, checksum: await checksum(content) })).rejects.toThrow();
    expect(await stub.getOmp()).toEqual(migrated);
    expect(await stub.updateOmp('machine-b', { expectedGeneration: migrated.generation, content: advancedOnly, checksum: await checksum(advancedOnly) })).toMatchObject({ status: 'ok', value: { generation: migrated.generation + 1, content: advancedOnly } });
    expect(await stub.get('machine-a')).toMatchObject({ revision: 1, profile: { displayName: 'Updated during migration' } });
    expect(await stub.getGitIdentity()).toMatchObject({ generation: 1 });
  });

  it('checks the migration fence after an in-flight write finishes hashing', async () => {
    const stub = settingsStub(`inflight-${crypto.randomUUID()}`);
    const content = 'modelRoles: { custom: provider/custom }\n';
    const hash = await checksum(content);
    await runInDurableObject(stub, async (instance) => {
      const pending = instance.updateOmp('machine-a', { expectedGeneration: 0, content, checksum: hash });
      const rejected = expect(pending).rejects.toThrow();
      expect(instance.prepareInferenceMigration()).toEqual({ generation: 0, settings: {} });
      await rejected;
      expect(instance.getOmp().generation).toBe(0);
      const finished = await instance.finishInferenceMigration(0);
      expect(finished).toMatchObject({ generation: 0, content: '' });
      expect(await instance.finishInferenceMigration(0)).toEqual(finished);
    });
  });

  it.each([
    'providers:\n  custom:\n    apiKey: protected-legacy-secret\n',
    'providers:\n  custom:\n    headers:\n      Authorization: Bearer protected-legacy-secret\n',
    'providers.custom.apiKey: protected-legacy-secret\n',
    'providers: { custom: [protected-legacy-secret\n',
  ])('rejects unsafe legacy configuration without exposing values and retains recovery through repair: %i', async (content) => {
    const stub = settingsStub(`unsafe-${crypto.randomUUID()}`);
    const hash = await checksum(content);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO omp_config(id, generation, content, checksum, updated_at, updated_by)
        VALUES (1, 1, ?, ?, ?, 'legacy-machine')`, content, hash, new Date(0).toISOString());
    });
    for (const read of [
      () => stub.prepareInferenceMigration(),
      () => stub.getOmp(),
      () => stub.snapshot(),
      () => stub.watch(null),
    ]) {
      const error = await read().then(() => null, (failure: Error) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toContain('protected-legacy-secret');
    }
    await expect(stub.updateOmp('machine-a', { expectedGeneration: 1, content, checksum: hash })).rejects.toThrow();
    const retained = await runInDurableObject(stub, (_instance, state) => ({
      current: state.storage.sql.exec<{ content: string }>('SELECT content FROM omp_config WHERE id = 1').one().content,
      recovery: state.storage.sql.exec<{ original_content: string }>('SELECT original_content FROM omp_inference_migration WHERE id = 1').one().original_content,
    }));
    expect(retained).toEqual({ current: content, recovery: content });
    const safe = 'modelRoles: { custom: provider/custom }\nadvanced: true\n';
    expect(await stub.updateOmp('machine-a', { expectedGeneration: 1, content: safe, checksum: await checksum(safe) })).toMatchObject({ status: 'ok', value: { generation: 2 } });
    const prepared = await stub.prepareInferenceMigration();
    expect(prepared).toEqual({ generation: 2, settings: { modelRoles: { custom: 'provider/custom' } } });
    await stub.finishInferenceMigration(prepared.generation);
    expect(parse((await stub.getOmp()).content)).toEqual({ advanced: true });
    const afterRepair = await runInDurableObject(stub, (_instance, state) => ({
      recovery: state.storage.sql.exec<{ original_content: string }>('SELECT original_content FROM omp_inference_migration WHERE id = 1').one().original_content,
      events: JSON.stringify(state.storage.sql.exec('SELECT value_json FROM app_changes').toArray()),
    }));
    expect(afterRepair.recovery).toBe(content);
    expect(afterRepair.events).not.toContain('protected-legacy-secret');
  });

  it('never replays credential-bearing snapshots from before a repaired configuration', async () => {
    const stub = settingsStub(`replay-${crypto.randomUUID()}`);
    const content = 'advanced: true\n';
    await stub.updateOmp('machine-a', { expectedGeneration: 0, content, checksum: await checksum(content) });
    const snapshot = await stub.snapshot();
    await runInDurableObject(stub, (_instance, state) => {
      const unsafe = { ...snapshot, omp: { ...snapshot.omp, content: 'providers: { custom: { apiKey: protected-legacy-secret } }\n' } };
      state.storage.sql.exec('UPDATE app_changes SET value_json = ? WHERE resource = ?', JSON.stringify(unsafe), 'settings');
    });
    const next = 'advanced: false\n';
    await stub.updateOmp('machine-a', { expectedGeneration: 1, content: next, checksum: await checksum(next) });
    const subscription = await stub.watch(0);
    const reader = subscription.stream.getReader();
    try {
      // Events are newline-delimited; one chunk may carry both the resync marker and the snapshot.
      let buffered = '';
      while (buffered.split('\n').filter(Boolean).length < 2) buffered += new TextDecoder().decode((await reader.read()).value);
      const [first, second] = buffered.split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(first).toMatchObject({ type: 'resync', resource: 'settings' });
      expect(second).toMatchObject({ type: 'snapshot', value: { omp: { content: next, generation: 2 } } });
      expect(JSON.stringify([first, second])).not.toContain('protected-legacy-secret');
    } finally {
      subscription[Symbol.dispose]();
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it('publishes durable inference invalidations without changing settings revisions, and ignores delayed repeats', async () => {
    const stub = settingsStub(`invalidation-${crypto.randomUUID()}`);
    const initial = await stub.snapshot();
    const subscription = await stub.watch(null);
    const reader = subscription.stream.getReader();
    try {
      const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
      await stub.inferenceChanged(4);
      const changed = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as { cursor: number; value: SettingsSnapshot };
      expect(changed).toMatchObject({ type: 'change', previous: first.cursor, value: { ...initial, inferenceRevision: 4 } });
      await runInDurableObject(stub, async (_instance, state) => {
        const restarted = new UserSettingsDO(state, env);
        await state.blockConcurrencyWhile(async () => {});
        restarted.inferenceChanged(3);
        restarted.inferenceChanged(4);
        expect(restarted.snapshot()).toEqual({ ...initial, inferenceRevision: 4 });
        restarted.inferenceChanged(5);
      });
      const next = JSON.parse(new TextDecoder().decode((await reader.read()).value));
      expect(next).toMatchObject({ type: 'change', previous: changed.cursor, value: { ...initial, inferenceRevision: 5 } });
      expect(next.cursor).toBe(changed.cursor + 1);
    } finally {
      subscription[Symbol.dispose]();
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it('pushes the inference revision to authenticated websocket subscribers without advancing OMP generation', async () => {
    const userId = env.ACCOUNT_ID;
    const rootPrivateKey = new Uint8Array(32).fill(21);
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
    const response = await SELF.fetch(`https://auth.test/v1/settings/events?control=${encodeURIComponent(control)}`, { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const message = new Promise<unknown>((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
      const stub = settingsStub(userId);
      const before = await stub.snapshot();
      await stub.inferenceChanged(before.inferenceRevision + 1);
      expect(await message).toEqual({ type: 'settings.changed', userRevision: before.user.revision, ompGeneration: before.omp.generation, inferenceRevision: before.inferenceRevision + 1 });
      expect((await stub.getOmp()).generation).toBe(before.omp.generation);
    } finally {
      socket.close(1000, 'done');
    }
  });
});
