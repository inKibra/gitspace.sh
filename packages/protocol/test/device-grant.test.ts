import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding,
  decodeDeviceInviteToken,
  decodeSignedRpcHeader,
  deviceProtocolBase64,
  encodeDeviceInviteToken,
  inputWithinScope,
  requiredCapability,
  signDeviceInvite,
  signRpcRequest,
  verifyDeviceGrantRecord,
  verifyRpcSignature,
  encodeApiKey,
  decodeApiKey,
  scopeContains,
  type DeviceGrantRecord,
} from '../src/device-grant.js';

const rootPrivate = new Uint8Array(32).fill(7);
const rootPublic = ed25519.getPublicKey(rootPrivate);
const devicePrivate = new Uint8Array(32).fill(9);
const devicePublic = ed25519.getPublicKey(devicePrivate);
const NOW = 1_800_000_000_000;

function record(overrides: Partial<{ grantTtlMs: number | null; revokedAt: number | null; boundAt: number }> = {}): DeviceGrantRecord {
  const invite = signDeviceInvite({
    version: 1, userId: 'user-a', inviteId: '11111111-1111-4111-8111-111111111111', kind: 'browser', label: 'Laptop', scope: { kind: 'user' },
    capabilities: ['rpc.read', 'rpc.write'], canDelegate: true, issuedAt: NOW - 1_000, expiresAt: NOW + 600_000, grantTtlMs: overrides.grantTtlMs ?? null, enrollUrl: 'https://control.example',
  }, rootPrivate);
  const binding = createDeviceBinding({
    inviteId: invite.invite.inviteId, deviceId: '22222222-2222-4222-8222-222222222222', signingPublicKey: deviceProtocolBase64.encode(devicePublic),
    label: 'Chrome on laptop', boundAt: overrides.boundAt ?? NOW, signingPrivateKey: devicePrivate,
  });
  return { invite, binding, generation: 1, revokedAt: overrides.revokedAt ?? null };
}

describe('device grants', () => {
  it('verifies the root -> invite -> binding chain and rejects tampering', () => {
    const verified = verifyDeviceGrantRecord(record(), rootPublic, NOW);
    expect(verified).toMatchObject({ deviceId: '22222222-2222-4222-8222-222222222222', kind: 'browser', capabilities: ['rpc.read', 'rpc.write'], expiresAt: null });
    const otherRoot = ed25519.getPublicKey(new Uint8Array(32).fill(8));
    expect(verifyDeviceGrantRecord(record(), otherRoot, NOW)).toBeNull();
    const widened = record();
    widened.invite.invite.capabilities = ['rpc.read', 'rpc.write', 'fleet.control'];
    expect(verifyDeviceGrantRecord(widened, rootPublic, NOW)).toBeNull();
    const swappedKey = record();
    swappedKey.binding.signingPublicKey = deviceProtocolBase64.encode(ed25519.getPublicKey(new Uint8Array(32).fill(3)));
    expect(verifyDeviceGrantRecord(swappedKey, rootPublic, NOW)).toBeNull();
  });

  it('honours revocation, grant TTL, and invite expiry at bind time', () => {
    expect(verifyDeviceGrantRecord(record({ revokedAt: NOW - 1 }), rootPublic, NOW)).toBeNull();
    expect(verifyDeviceGrantRecord(record({ revokedAt: NOW + 1 }), rootPublic, NOW)).not.toBeNull();
    expect(verifyDeviceGrantRecord(record({ grantTtlMs: 1_000 }), rootPublic, NOW + 999)?.expiresAt).toBe(NOW + 1_000);
    expect(verifyDeviceGrantRecord(record({ grantTtlMs: 1_000 }), rootPublic, NOW + 1_000)).toBeNull();
    expect(verifyDeviceGrantRecord(record({ boundAt: NOW + 700_000 }), rootPublic, NOW + 700_001)).toBeNull();
  });

  it('round-trips invite tokens', () => {
    const invite = record().invite;
    expect(decodeDeviceInviteToken(encodeDeviceInviteToken(invite))).toEqual(invite);
    expect(decodeDeviceInviteToken('not-a-token')).toBeNull();
  });

  it('signs and verifies requests over method, path, and body', () => {
    const body = new TextEncoder().encode('{"v":1,"batch":[]}');
    const header = decodeSignedRpcHeader(signRpcRequest({ deviceId: '22222222-2222-4222-8222-222222222222', method: 'post', path: '/rpc', body, signingPrivateKey: devicePrivate }))!;
    expect(header.deviceId).toBe('22222222-2222-4222-8222-222222222222');
    expect(verifyRpcSignature(header, { method: 'POST', path: '/rpc', body }, devicePublic)).toBe(true);
    expect(verifyRpcSignature(header, { method: 'POST', path: '/rpc', body: new TextEncoder().encode('{"v":1,"batch":[1]}') }, devicePublic)).toBe(false);
    expect(verifyRpcSignature(header, { method: 'POST', path: '/rpc?x=1', body }, devicePublic)).toBe(false);
    expect(verifyRpcSignature({ ...header, timestamp: header.timestamp + 1 }, { method: 'POST', path: '/rpc', body }, devicePublic)).toBe(false);
  });

  it('derives capabilities from procedure kind with agent and fleet exceptions', () => {
    expect(requiredCapability('bootstrap', 'query')).toBe('rpc.read');
    expect(requiredCapability('events', 'subscription')).toBe('rpc.read');
    expect(requiredCapability('workspace.create', 'mutation')).toBe('rpc.write');
    expect(requiredCapability('session.prompt', 'mutation')).toBe('session.prompt');
    expect(requiredCapability('machine.destroy', 'mutation')).toBe('fleet.control');
    expect(requiredCapability('machine.events', 'subscription')).toBe('rpc.read');
    expect(requiredCapability('devices.revoke', 'mutation')).toBe('devices.manage');
  });

  it('confines scoped grants to their project or workspace', () => {
    const projectOf = (workspaceId: string) => (workspaceId === 'ws-a' ? 'project-a' : null);
    expect(inputWithinScope({ kind: 'user' }, { projectId: 'anything' })).toBe(true);
    expect(inputWithinScope({ kind: 'project', projectId: 'project-a' }, { projectId: 'project-a' })).toBe(true);
    expect(inputWithinScope({ kind: 'project', projectId: 'project-a' }, { projectId: 'project-b' })).toBe(false);
    expect(inputWithinScope({ kind: 'project', projectId: 'project-a' }, { workspaceId: 'ws-a' }, projectOf)).toBe(true);
    expect(inputWithinScope({ kind: 'project', projectId: 'project-a' }, {})).toBe(false);
    expect(inputWithinScope({ kind: 'workspace', workspaceId: 'ws-a' }, { spaceId: 'ws-a' })).toBe(true);
    expect(inputWithinScope({ kind: 'workspace', workspaceId: 'ws-a' }, { workspaceId: 'ws-b' })).toBe(false);
  });

  it('verifies delegated grants through their issuer and caps them by the issuer', () => {
    const browser = record();
    const clientPrivate = new Uint8Array(32).fill(11);
    const mint = (capabilities: Array<'rpc.read' | 'rpc.write' | 'fleet.control'>, scope: { kind: 'user' } | { kind: 'project'; projectId: string } = { kind: 'project', projectId: 'p1' }): DeviceGrantRecord => {
      const invite = signDeviceInvite({
        version: 1, userId: 'user-a', inviteId: '33333333-3333-4333-8333-333333333333', kind: 'client', label: 'CI', scope, capabilities, canDelegate: false,
        issuedAt: NOW, expiresAt: NOW + 60_000, grantTtlMs: 86_400_000, enrollUrl: 'https://control.example',
      }, devicePrivate, { kind: 'device', deviceId: browser.binding.deviceId });
      const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: '44444444-4444-4444-8444-444444444444', signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(clientPrivate)), label: 'CI', boundAt: NOW + 1, signingPrivateKey: clientPrivate });
      return { invite, binding, generation: 1, revokedAt: null };
    };
    const resolve = (issuer: DeviceGrantRecord) => (deviceId: string) => (deviceId === issuer.binding.deviceId ? issuer : null);
    expect(verifyDeviceGrantRecord(mint(['rpc.read']), rootPublic, NOW + 2, resolve(browser))).toMatchObject({ kind: 'client', capabilities: ['rpc.read'], expiresAt: NOW + 1 + 86_400_000 });
    // No resolver, unknown issuer, revoked issuer, capability escalation, and non-delegating issuer all fail.
    expect(verifyDeviceGrantRecord(mint(['rpc.read']), rootPublic, NOW + 2)).toBeNull();
    expect(verifyDeviceGrantRecord(mint(['rpc.read']), rootPublic, NOW + 2, () => null)).toBeNull();
    expect(verifyDeviceGrantRecord(mint(['rpc.read']), rootPublic, NOW + 2, resolve({ ...browser, revokedAt: NOW }))).toBeNull();
    expect(verifyDeviceGrantRecord(mint(['rpc.read', 'fleet.control']), rootPublic, NOW + 2, resolve(browser))).toBeNull();
    const nonDelegating = { ...browser, invite: signDeviceInvite({ ...browser.invite.invite, canDelegate: false }, rootPrivate) };
    expect(verifyDeviceGrantRecord(mint(['rpc.read']), rootPublic, NOW + 2, resolve(nonDelegating))).toBeNull();
  });

  it('contains delegated scopes', () => {
    expect(scopeContains({ kind: 'user' }, { kind: 'workspace', workspaceId: 'w' })).toBe(true);
    expect(scopeContains({ kind: 'project', projectId: 'p' }, { kind: 'project', projectId: 'p' })).toBe(true);
    expect(scopeContains({ kind: 'project', projectId: 'p' }, { kind: 'workspace', workspaceId: 'w' })).toBe(false);
    expect(scopeContains({ kind: 'project', projectId: 'p' }, { kind: 'user' })).toBe(false);
    expect(scopeContains({ kind: 'workspace', workspaceId: 'w' }, { kind: 'workspace', workspaceId: 'w' })).toBe(true);
  });

  it('round-trips API keys', () => {
    const key = { version: 1 as const, deviceId: '44444444-4444-4444-8444-444444444444', signingPrivateKey: deviceProtocolBase64.encode(new Uint8Array(32).fill(11)), rpcUrl: 'http://127.0.0.1:4510/rpc', enrollUrl: 'https://control.example' };
    const encoded = encodeApiKey(key);
    expect(encoded.startsWith('gsk_')).toBe(true);
    expect(decodeApiKey(encoded)).toEqual(key);
    expect(decodeApiKey('sk_nope')).toBeNull();
  });
});
