import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createRelayAuthorization, credentialProtocolBase64 } from '@gitspace/protocol';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { network } from './network.js';

const path = '/v1/accounts/recover';

interface RecoveryKey {
  privateKey: Uint8Array;
  rootPublicKey: string;
  userId: string;
}

async function recoveryKey(): Promise<RecoveryKey> {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = Uint8Array.from(ed25519.getPublicKey(privateKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  const userId = `u-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { privateKey, rootPublicKey: credentialProtocolBase64.encode(publicKey), userId };
}

function recover(key: RecoveryKey, handle: string): Promise<Response> {
  return SELF.fetch(`https://gitspace.sh${path}`, {
    method: 'POST',
    headers: { authorization: createRelayAuthorization(key.privateKey, path), 'content-type': 'application/json' },
    body: JSON.stringify({ rootPublicKey: key.rootPublicKey, handle }),
  });
}

describe('account recovery', () => {
  it('answers 404 ACCOUNT_NOT_FOUND for a recovery key with no account', async () => {
    const response = await recover(await recoveryKey(), 'nobody-here');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('answers 409 ACCOUNT_INCOMPLETE while the account is provisioning and after provisioning failed', async () => {
    const key = await recoveryKey();
    const registry = env.ACCOUNTS.getByName('global');
    await registry.upsertProvisioning({ userId: key.userId, handle: 'half-made' });

    const provisioning = await recover(key, 'half-made');
    expect(provisioning.status).toBe(409);
    expect(await provisioning.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_INCOMPLETE' } });

    await registry.markFailed({ userId: key.userId, message: 'tenant bootstrap failed' });
    const failed = await recover(key, 'half-made');
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_INCOMPLETE' } });
  });

  it('returns the account endpoints for an active account the platform has not blocked', async () => {
    const key = await recoveryKey();
    const registry = env.ACCOUNTS.getByName('global');
    await registry.upsertProvisioning({ userId: key.userId, handle: 'settled' });
    await registry.markActive({ userId: key.userId, release: 'stable' });
    network.use(http.get('https://platform.test/__platform/operator/tenants/settled', () => HttpResponse.json({
      control: { status: 'active', reason: null, updatedAt: null },
      credits: null,
      usage: { records: 0, debitedMicros: 0 },
      deployment: { active: null, uploadedAt: null, appliedMigrationTag: null },
    })));

    const response = await recover(key, 'settled');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      value: {
        userId: key.userId,
        handle: 'settled',
        relayUrl: 'https://settled.gssh.dev',
        accountUrl: 'https://settled.gitspace.sh',
        apiUrl: 'https://settled.gitspace.sh',
      },
    });
  });
});
