import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRelayFingerprint,
  getTrustedRelay,
  addTrustedRelay,
} from '../../core/trusted-relays.js';
import type { RelayIdentityProbe } from '../connect.js';

let originalHome: string | undefined;
let testDir: string;

async function loadConnectModule() {
  return import(`../connect.js?test=${Date.now()}`);
}

function setupEnv() {
  originalHome = process.env.HOME;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-connect-relay-trust-'));
  process.env.HOME = testDir;
}

function teardownEnv() {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

function makeProbe(publicKey: string, label?: string): RelayIdentityProbe {
  return {
    publicKey,
    fingerprint: computeRelayFingerprint(publicKey),
    label,
  };
}

describe('fetchRelayIdentity', () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  test('reads relay identity from health endpoint', async () => {
    const relayPublicKey = Buffer.from('relay-public-key-1').toString('base64');
    const relayFingerprint = computeRelayFingerprint(relayPublicKey);

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        return new Response(
          JSON.stringify({
            relayPublicKey,
            relayFingerprint,
            relayLabel: 'test-relay',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      const { fetchRelayIdentity } = await loadConnectModule();
      const relay = await fetchRelayIdentity(`ws://127.0.0.1:${server.port}/ws`);
      expect(relay).toEqual({
        publicKey: relayPublicKey,
        fingerprint: relayFingerprint,
        label: 'test-relay',
      });
    } finally {
      server.stop(true);
    }
  });

  test('computes fingerprint when health response omits it', async () => {
    const relayPublicKey = Buffer.from('relay-public-key-2').toString('base64');

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        return new Response(
          JSON.stringify({ relayPublicKey }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      const { fetchRelayIdentity } = await loadConnectModule();
      const relay = await fetchRelayIdentity(`ws://127.0.0.1:${server.port}/ws`);
      expect(relay.publicKey).toBe(relayPublicKey);
      expect(relay.fingerprint).toBe(computeRelayFingerprint(relayPublicKey));
    } finally {
      server.stop(true);
    }
  });

  test('throws when health endpoint does not provide relay public key', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    try {
      const { fetchRelayIdentity } = await loadConnectModule();
      await expect(
        fetchRelayIdentity(`ws://127.0.0.1:${server.port}/ws`),
      ).rejects.toThrow(/did not provide relayPublicKey/i);
    } finally {
      server.stop(true);
    }
  });
});

describe('verifyClientRelayTrust', () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  test('trusts relay when explicit --relay-pubkey matches', async () => {
    const relayUrl = 'wss://relay-explicit.example.test/ws';
    const relayPublicKey = Buffer.from('relay-pub-match').toString('base64');

    const { verifyClientRelayTrust } = await loadConnectModule();
    await verifyClientRelayTrust(relayUrl, makeProbe(relayPublicKey, 'example'), {
      relayPubkey: relayPublicKey,
    });

    const trusted = getTrustedRelay(relayUrl);
    expect(trusted).not.toBeNull();
    expect(trusted?.publicKey).toBe(relayPublicKey);
  });

  test('rejects relay when explicit --relay-pubkey mismatches', async () => {
    const relayUrl = 'wss://relay-explicit-mismatch.example.test/ws';
    const expectedPublicKey = Buffer.from('expected-key').toString('base64');
    const actualPublicKey = Buffer.from('actual-key').toString('base64');

    const { verifyClientRelayTrust } = await loadConnectModule();
    await expect(
      verifyClientRelayTrust(relayUrl, makeProbe(actualPublicKey), {
        relayPubkey: expectedPublicKey,
      }),
    ).rejects.toThrow(/does not match --relay-pubkey/i);

    expect(getTrustedRelay(relayUrl)).toBeNull();
  });

  test('auto-trusts localhost relay', async () => {
    const relayUrl = 'ws://127.0.0.1:4480/ws';
    const relayPublicKey = Buffer.from('localhost-key').toString('base64');

    const { verifyClientRelayTrust } = await loadConnectModule();
    await verifyClientRelayTrust(relayUrl, makeProbe(relayPublicKey));

    const trusted = getTrustedRelay(relayUrl);
    expect(trusted).not.toBeNull();
    expect(trusted?.publicKey).toBe(relayPublicKey);
  });

  test('rejects trusted relay key mismatch', async () => {
    const relayUrl = 'wss://relay-known-mismatch.example.test/ws';
    const originalKey = Buffer.from('original-key').toString('base64');
    const unexpectedKey = Buffer.from('unexpected-key').toString('base64');

    addTrustedRelay(relayUrl, originalKey, 'relay-one');

    const { verifyClientRelayTrust } = await loadConnectModule();
    await expect(
      verifyClientRelayTrust(relayUrl, makeProbe(unexpectedKey), { yes: true }),
    ).rejects.toThrow(/relay identity mismatch/i);
  });

  test('rejects inconsistent fingerprint metadata from health endpoint', async () => {
    const relayPublicKey = Buffer.from('relay-public-key-3').toString('base64');

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        return new Response(
          JSON.stringify({
            relayPublicKey,
            relayFingerprint: 'wrong:fingerprint',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      const { fetchRelayIdentity } = await loadConnectModule();
      await expect(fetchRelayIdentity(`ws://127.0.0.1:${server.port}/ws`)).rejects.toThrow(/inconsistent identity metadata/i);
    } finally {
      server.stop(true);
    }
  });

  test('rejects unknown relay non-interactively with --yes', async () => {
    const relayUrl = 'wss://relay-yes.example.test/ws';
    const relayPublicKey = Buffer.from('new-key').toString('base64');

    const { verifyClientRelayTrust } = await loadConnectModule();
    await expect(
      verifyClientRelayTrust(relayUrl, makeProbe(relayPublicKey), { yes: true })
    ).rejects.toThrow(/interactive approval or --relay-pubkey/i);

    expect(getTrustedRelay(relayUrl)).toBeNull();
  });
});
