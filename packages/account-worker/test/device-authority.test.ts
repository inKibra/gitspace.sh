import { describe, expect, it, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding, createSignedControlRequest, credentialProtocolBase64, signDeviceInvite, signRpcRequest,
  SIGNED_UPLOAD_MAX_AGE_MS, type DeviceGrantRecord,
} from '@gitspace/protocol';
import { DeviceAuthorityCache, DeviceVerifier, type DeviceAuthoritySnapshot, type DeviceRegistrySnapshot, type MachineCredential } from '../src/device-authority.js';
import { tenantRootPrivateKey as rootKey } from './setup.js';

const userId = 'u-device-authority';
const machineKey = ed25519.utils.randomSecretKey();
const deviceKey = ed25519.utils.randomSecretKey();
const machine: MachineCredential = {
  machineId: 'machine', generation: 1, grant: null, capabilities: ['storage.access'],
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
  exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(x25519.utils.randomSecretKey())),
};
const invite = signDeviceInvite({
  version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'],
  canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://test.gitspace.sh',
}, rootKey);
const binding = createDeviceBinding({
  inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), label: 'Browser', boundAt: Date.now(),
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(deviceKey)), signingPrivateKey: deviceKey,
});
const device: DeviceGrantRecord = { invite, binding, generation: 1, revokedAt: null };

function registry(devices: DeviceGrantRecord[], machines: MachineCredential[] = [machine]): DeviceRegistrySnapshot {
  return { userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootKey)), machines, devices };
}

function snapshot(value: DeviceRegistrySnapshot): DeviceAuthoritySnapshot {
  const now = Date.now();
  return {
    registry: value,
    account: {
      authorization: { status: 'active', checkedAt: now, refreshAt: now + 15_000, expiresAt: now + 60_000 },
      record: { userId, handle: 'test', status: 'active', reason: null, createdAt: now, updatedAt: now, tenantHostname: 'test.gitspace.sh', tenantRelease: null, tenantProvisionedAt: now, lastError: null },
    },
  };
}

function verifier(value: DeviceRegistrySnapshot): DeviceVerifier {
  return new DeviceVerifier({
    userId: value.userId,
    rootPublicKey: value.rootPublicKey,
    machine: (machineId) => value.machines.find((candidate) => candidate.machineId === machineId) ?? null,
    device: (deviceId) => value.devices.find((candidate) => candidate.binding.deviceId === deviceId) ?? null,
  });
}

describe('signed request window', () => {
  const now = Date.now();
  const control = (offsetMs: number, signingPrivateKey = machineKey) => createSignedControlRequest({
    userId, machineId: machine.machineId, operation: 'settings.get', payload: {}, signingPrivateKey, timestamp: now + offsetMs,
  });

  it('admits machine controls within 60 seconds of the verifier clock in either direction', () => {
    const current = verifier(registry([device]));
    for (const offset of [-59_000, 59_000]) {
      expect(current.authorizeControl(control(offset), 'storage.access', 60_000, now)).toEqual({ status: 'ok', value: { machineId: 'machine', generation: 1 } });
    }
    for (const offset of [-61_000, 61_000]) {
      expect(current.authorizeControl(control(offset), 'storage.access', 60_000, now)).toMatchObject({ status: 'error', error: { code: 'REQUEST_EXPIRED', message: 'Signed request expired' } });
    }
    // Only a validly signed proof learns its clock is off.
    expect(current.authorizeControl(control(-61_000, ed25519.utils.randomSecretKey()), 'storage.access', 60_000, now)).toMatchObject({ error: { code: 'DEVICE_UNAUTHORIZED' } });
    // A buffered upload keeps its own longer window.
    const upload = createSignedControlRequest({ userId, machineId: 'machine', operation: 'data.put', payload: {}, signingPrivateKey: machineKey, timestamp: now - 10 * 60_000 });
    expect(current.authorizeControl(upload, 'storage.access', SIGNED_UPLOAD_MAX_AGE_MS, now)).toMatchObject({ status: 'ok' });
  });

  it('admits device requests within 60 seconds and reports only the clock as expired', () => {
    const current = verifier(registry([device]));
    const body = new TextEncoder().encode('{"v":1}');
    const request = (offsetMs: number) => current.authorizeRequest({
      header: signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: deviceKey, method: 'POST', path: '/rpc', body, timestamp: now + offsetMs }),
      method: 'POST', target: '/rpc', body, capabilities: ['rpc.read'], accountScope: true,
    }, now);
    expect(request(-59_000)).toMatchObject({ status: 'ok', value: { device: { deviceId: binding.deviceId, generation: 1 } } });
    expect(request(61_000)).toMatchObject({ status: 'error', error: { code: 'REQUEST_EXPIRED' } });
  });
});

describe('isolate device authority cache', () => {
  it('serves one load per refresh period and replaces it with one background load', async () => {
    let now = Date.now();
    let loads = 0;
    const cache = new DeviceAuthorityCache(async () => { loads++; return snapshot(registry([device])); }, { now: () => now });
    const first = await cache.current();
    expect(first).not.toBeNull();
    now += 29_000;
    expect(await cache.current()).toBe(first);
    expect(loads).toBe(1);
    now += 2_000;
    // A copy older than the refresh period is still served while a single load replaces it.
    expect(await Promise.all([cache.current(), cache.current(), cache.current()])).toEqual([first, first, first]);
    expect(loads).toBe(2);
    await vi.waitFor(async () => expect(await cache.current()).not.toBe(first));
    expect(loads).toBe(2);
  });

  it('applies a revocation once the cached registry refreshes', async () => {
    let now = Date.now();
    let current = registry([device]);
    const cache = new DeviceAuthorityCache(async () => snapshot(current), { now: () => now });
    expect((await cache.current())?.device(binding.deviceId, now)).toMatchObject({ deviceId: binding.deviceId });
    current = registry([{ ...device, generation: 2, revokedAt: now }]);
    now += 10_000;
    expect((await cache.current())?.device(binding.deviceId, now)).toMatchObject({ deviceId: binding.deviceId });
    now += 21_000;
    await cache.current();
    await vi.waitFor(async () => expect((await cache.current())?.device(binding.deviceId, now)).toBeNull());
  });

  it('fails closed once the last successful load is two minutes old, then recovers', async () => {
    let now = Date.now();
    let available = true;
    const cache = new DeviceAuthorityCache(async () => {
      if (!available) throw new Error('Vault unavailable');
      return snapshot(registry([device]));
    }, { now: () => now });
    expect(await cache.current()).not.toBeNull();
    available = false;
    now += 119_000;
    expect(await cache.current()).not.toBeNull();
    now += 1_000;
    expect(await cache.current()).toBeNull();
    available = true;
    expect(await cache.current()).not.toBeNull();
  });

  it('looks up a credential missing from the cache in a load that starts after the request', async () => {
    const now = Date.now();
    let current = registry([]);
    const cache = new DeviceAuthorityCache(async () => snapshot(current), { now: () => now });
    expect((await cache.current())?.device(binding.deviceId, now)).toBeNull();
    current = registry([device]);
    expect((await cache.refreshed())?.device(binding.deviceId, now)).toMatchObject({ deviceId: binding.deviceId });
  });

  it('never serves a view the vault invalidated, even when the reload fails', async () => {
    const now = Date.now();
    let available = true;
    const cache = new DeviceAuthorityCache(async () => {
      if (!available) throw new Error('Vault unavailable');
      return snapshot(registry([device]));
    }, { now: () => now });
    expect(await cache.current()).not.toBeNull();
    available = false;
    cache.invalidate();
    expect(await cache.current()).toBeNull();
  });
});
