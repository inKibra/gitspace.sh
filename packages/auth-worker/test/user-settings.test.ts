import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HandleRegistryDO, UserSettingsDO } from '../src/user-settings.js';

function settingsStub(userId: string): DurableObjectStub<UserSettingsDO> {
  return env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(userId));
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

  it('stores the exact OMP file and rejects stale generations', async () => {
    const stub = settingsStub(`omp-${crypto.randomUUID()}`);
    const content = 'cycleOrder:\n  - default\n';
    const bytes = new TextEncoder().encode(content);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const checksum = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const result = await stub.updateOmp('machine-a', { expectedGeneration: 0, content, checksum });
    expect(result).toMatchObject({ status: 'ok', value: { generation: 1, content, checksum, updatedBy: 'machine-a' } });
    expect(await stub.updateOmp('machine-b', { expectedGeneration: 0, content: `${content}# stale\n`, checksum })).toEqual({ status: 'conflict', resource: 'omp-config', expected: 0, actual: 1 });
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


  it('coordinates globally unique handles', async () => {
    const handle = `brad-${crypto.randomUUID().slice(0, 8)}`;
    const stub: DurableObjectStub<HandleRegistryDO> = env.USER_HANDLES.get(env.USER_HANDLES.idFromName(handle));
    expect(await stub.claim('user-a')).toEqual({ claimed: true, owner: 'user-a', created: true });
    expect(await stub.claim('user-b')).toEqual({ claimed: false, owner: 'user-a', created: false });
    await stub.release('user-a');
    expect(await stub.claim('user-b')).toEqual({ claimed: true, owner: 'user-b', created: true });
  });
});
