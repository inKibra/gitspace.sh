import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceProtocolBase64, encodeDeviceInviteToken, signDeviceInvite } from '@gitspace/protocol/device-grant';
import { accountHandleFromUrl, browserInvitationStatus, enrollmentTokenForLocation, recoverAccountBrowser } from './browser-enrollment.js';
import { currentDevice } from './device-session.js';

vi.mock('./device-session.js', () => ({ currentDevice: vi.fn(), deviceRejected: vi.fn() }));

const accountUrl = new URL('https://alice.gitspace.sh/');
const rootKey = new Uint8Array(32).fill(7);
const recoveryKey = `gsr_${deviceProtocolBase64.encode(rootKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
function invitation(enrollUrl = 'https://api.gitspace.sh'): string {
  return encodeDeviceInviteToken(signDeviceInvite({
    version: 1, userId: 'u-example', inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'],
    canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 300_000, grantTtlMs: null, enrollUrl,
  }, rootKey));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser enrollment account boundaries', () => {
  it('infers only a single account hostname, not central or lookalike hosts', () => {
    expect(accountHandleFromUrl(accountUrl)).toBe('alice');
    expect(accountHandleFromUrl(new URL('https://api.gitspace.sh'))).toBeNull();
    expect(accountHandleFromUrl(new URL('https://alice.gitspace.sh.attacker.test'))).toBeNull();
    expect(accountHandleFromUrl(new URL('https://workspace.alice.gitspace.sh'))).toBeNull();
  });

  it('accepts the account link but rejects another account and untrusted enrollment servers', () => {
    const token = invitation();
    expect(enrollmentTokenForLocation(`https://alice.gitspace.sh/#enroll=${token}`, accountUrl)).toBe(token);
    expect(() => enrollmentTokenForLocation(`https://bob.gitspace.sh/#enroll=${token}`, accountUrl)).toThrow(/account hostname/u);
    expect(() => enrollmentTokenForLocation(invitation('https://attacker.test'), accountUrl)).toThrow(/different deployment/u);
    expect(() => enrollmentTokenForLocation(invitation('http://api.gitspace.sh'), accountUrl)).toThrow(/HTTPS/u);
  });

  it('never sends a recovery request from an unsafe origin or for a mismatched hostname', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(recoverAccountBrowser('alice', recoveryKey, new URL('http://alice.gitspace.sh'))).rejects.toMatchObject({ code: 'UNSAFE_ORIGIN' });
    await expect(recoverAccountBrowser('alice', recoveryKey, new URL('https://attacker.test'))).rejects.toMatchObject({ code: 'UNSAFE_ORIGIN' });
    await expect(recoverAccountBrowser('bob', recoveryKey, accountUrl)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not bootstrap a missing or incomplete account during recovery', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      requests.push(input.pathname);
      return Response.json({ status: 'error', error: { code: 'ACCOUNT_NOT_FOUND', message: 'No account matches this recovery key and handle' } }, { status: 404 });
    }));
    await expect(recoverAccountBrowser('alice', recoveryKey, accountUrl)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(requests).toEqual(['/v1/accounts/recover']);
  });

  it('does not enroll when recovery returns a different account', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      requests.push(input.pathname);
      return Response.json({ status: 'ok', value: { userId: 'u-wrong-root', handle: 'alice', accountUrl: accountUrl.origin, apiUrl: 'https://api.gitspace.sh' } });
    }));
    await expect(recoverAccountBrowser('alice', recoveryKey, accountUrl)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect(requests).toEqual(['/v1/accounts/recover']);
  });

  it('sends browser invitation requests to the account host, even for a browser enrolled through the platform', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    if (!('privateKey' in keyPair)) throw new Error('Expected a key pair');
    vi.mocked(currentDevice).mockResolvedValue({ deviceId: '44444444-4444-4444-8444-444444444444', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0, userId: 'u-example', enrollUrl: 'https://gitspace.sh', canDelegate: true });
    vi.stubGlobal('window', { location: { href: 'https://alice.gitspace.sh/?settings=connections' } });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | Request) => {
      requests.push(input instanceof Request ? input.url : input.href);
      return Response.json({ status: 'ok', value: { inviteId: 'invite', expiresAt: 0, status: 'pending', deviceId: null } });
    }));
    await expect(browserInvitationStatus('invite')).resolves.toMatchObject({ status: 'pending' });
    expect(requests).toEqual(['https://alice.gitspace.sh/v1/devices/browser-invitations/status']);
  });
});
