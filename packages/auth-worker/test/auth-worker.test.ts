import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { HttpResponse, http } from 'msw';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createCredentialAccessRequest,
  credentialProtocolBase64,
  openCredentialFromVault,
  signCredentialAuthorityGrant,
} from '@gitspace/protocol';
import { refreshCredential } from '../src/providers.js';
import { network } from './network.js';

const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const machineExchangePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);


describe('CredentialVaultDO', () => {
  it('returns only a machine-sealed access token and rejects request replay', async () => {
    const vault = env.CREDENTIALS.getByName(`user-fresh-${crypto.randomUUID()}`);
    expect((await vault.bootstrap({
      userId: 'user-a',
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(vaultKey),
    })).status).toBe('ok');
    const grant = signCredentialAuthorityGrant({
      version: 1,
      userId: 'user-a',
      machineId: 'machine-a',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
      capabilities: ['credential.access'],
      generation: 1,
    }, rootPrivateKey);
    expect((await vault.registerDevice(grant)).status).toBe('ok');
    expect((await vault.putCredential({
      id: 'openai-primary',
      credential: {
        provider: 'openai-codex',
        refresh: 'refresh-secret',
        access: 'access-secret',
        expires: Date.now() + 60 * 60 * 1000,
      },
    })).status).toBe('ok');

    const request = createCredentialAccessRequest({
      userId: 'user-a',
      machineId: 'machine-a',
      credentialId: 'openai-primary',
      signingPrivateKey: machineSigningPrivateKey,
    });
    const response = await vault.getAccess(request);
    expect(response.status).toBe('ok');
    if (response.status === 'error') throw new Error(response.error.message);
    expect(JSON.stringify(response.value)).not.toContain('access-secret');
    expect(JSON.stringify(response.value)).not.toContain('refresh-secret');
    const context = `user-a\nmachine-a\nopenai-primary\n${request.nonce}\n1`;
    const plaintext = await openCredentialFromVault({
      envelope: response.value.envelope,
      machineExchangePrivateKey,
      context,
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({
      credentialId: 'openai-primary',
      provider: 'openai-codex',
      access: 'access-secret',
      revision: 1,
    });
    const replay = await vault.getAccess(request);
    expect(replay).toMatchObject({ status: 'error', error: { code: 'REQUEST_REPLAY' } });
  });

  it('refreshes an expired rotating token inside the Worker and atomically advances revision', async () => {
    const vault = env.CREDENTIALS.getByName(`user-refresh-${crypto.randomUUID()}`);
    await vault.bootstrap({
      userId: 'user-b',
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(vaultKey),
    });
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1,
      userId: 'user-b',
      machineId: 'machine-a',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
      capabilities: ['credential.access'],
      generation: 1,
    }, rootPrivateKey));
    await vault.putCredential({
      id: 'openai-primary',
      credential: {
        provider: 'openai-codex',
        refresh: 'refresh-old',
        access: 'access-old',
        expires: Date.now() - 1,
      },
    });
    network.use(http.post('https://auth.openai.com/oauth/token', () => HttpResponse.json({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 3600,
    })));

    const request = createCredentialAccessRequest({
      userId: 'user-b',
      machineId: 'machine-a',
      credentialId: 'openai-primary',
      signingPrivateKey: machineSigningPrivateKey,
    });
    const response = await vault.getAccess(request);
    expect(response.status).toBe('ok');
    if (response.status === 'error') throw new Error(response.error.message);
    expect(response.value.revision).toBe(2);
    const plaintext = await openCredentialFromVault({
      envelope: response.value.envelope,
      machineExchangePrivateKey,
      context: `user-b\nmachine-a\nopenai-primary\n${request.nonce}\n2`,
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({ access: 'access-new', revision: 2 });
  });
});

describe('portable refresh adapters', () => {
  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/oauth/token'],
    ['openai-codex', 'https://auth.openai.com/oauth/token'],
    ['google-gemini-cli', 'https://oauth2.googleapis.com/token'],
    ['google-antigravity', 'https://oauth2.googleapis.com/token'],
    ['cursor', 'https://api2.cursor.sh/auth/exchange_user_api_key'],
  ] as const)('refreshes %s using Worker-compatible fetch', async (provider, expectedUrl) => {
    let requestedUrl = '';
    const refreshed = await refreshCredential({
      provider,
      refresh: 'refresh-old',
      access: 'access-old',
      expires: 0,
      ...(provider.startsWith('google-') ? { projectId: 'project-a' } : {}),
    }, async (input) => {
      requestedUrl = String(input);
      const body = provider === 'cursor'
        ? { accessToken: 'access-new', refreshToken: 'refresh-new' }
        : { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(requestedUrl).toBe(expectedUrl);
    expect(refreshed).toMatchObject({ provider, access: 'access-new', refresh: 'refresh-new' });
    expect(refreshed.expires).toBeGreaterThan(Date.now());
  });
});
