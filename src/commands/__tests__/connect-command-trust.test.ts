import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAndSaveKeypair } from '../../core/identity.js';
import { addTrustedRelay, getTrustedRelay } from '../../core/trusted-relays.js';

let promptConfirmQueue: boolean[] = [];
let promptPasswordValue: string | null = null;

mock.module('../../utils/prompts.js', () => ({
  promptPassword: async () => promptPasswordValue,
  promptConfirm: async () => {
    if (promptConfirmQueue.length === 0) {
      return true;
    }

    return promptConfirmQueue.shift() ?? true;
  },
  promptInput: async () => '',
  selectOne: async () => null,
}));

const { connectToRemote, listRemoteMachines } = await import('../connect.js');

let originalHome: string | undefined;
let testDir: string;

function setupEnv() {
  originalHome = process.env.HOME;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-connect-command-trust-'));
  process.env.HOME = testDir;

  promptConfirmQueue = [];
  promptPasswordValue = null;
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

function startRelayHealthServer(relayPublicKey: string) {
  return Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/health') {
        return new Response('Not found', { status: 404 });
      }

      return new Response(
        JSON.stringify({
          relayPublicKey,
          relayLabel: 'test-relay',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
}

describe('connect command relay trust flow', () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  test('connectToRemote rejects when --relay-pubkey mismatches health identity', async () => {
    const actualRelayPubkey = Buffer.from('relay-actual-pubkey').toString('base64');
    const expectedRelayPubkey = Buffer.from('relay-expected-pubkey').toString('base64');
    const server = startRelayHealthServer(actualRelayPubkey);
    const relayUrl = `ws://127.0.0.1:${server.port}/ws`;

    try {
      await expect(
        connectToRemote('machine-test', {
          relay: relayUrl,
          relayPubkey: expectedRelayPubkey,
          yes: true,
        }),
      ).rejects.toThrow(/does not match --relay-pubkey/i);

      expect(getTrustedRelay(relayUrl)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('connectToRemote auto-trusts IPv4-mapped localhost relays', async () => {
    const relayPubkey = Buffer.from('relay-unknown-pubkey').toString('base64');
    const server = startRelayHealthServer(relayPubkey);
    const relayUrl = `ws://[::ffff:127.0.0.1]:${server.port}/ws`;

    try {
      await connectToRemote('machine-test', {
        relay: relayUrl,
        yes: true,
      });

      expect(getTrustedRelay(relayUrl)?.publicKey).toBe(relayPubkey);
    } finally {
      server.stop(true);
    }
  });

  test('listRemoteMachines trusts relay via explicit --relay-pubkey', async () => {
    const relayPubkey = Buffer.from('relay-list-explicit-pubkey').toString('base64');
    const server = startRelayHealthServer(relayPubkey);
    const relayUrl = `ws://127.0.0.1:${server.port}/ws`;

    // Stop before opening directory socket.
    promptPasswordValue = null;

    try {
      await listRemoteMachines({
        relay: relayUrl,
        relayPubkey: relayPubkey,
        yes: true,
      });

      const trusted = getTrustedRelay(relayUrl);
      expect(trusted).not.toBeNull();
      expect(trusted?.publicKey).toBe(relayPubkey);
    } finally {
      server.stop(true);
    }
  });

  test('listRemoteMachines rejects relay key mismatch against trusted entry', async () => {
    const trustedPubkey = Buffer.from('relay-trusted-pubkey').toString('base64');
    const newPubkey = Buffer.from('relay-new-pubkey').toString('base64');
    const server = startRelayHealthServer(newPubkey);
    const relayUrl = `ws://127.0.0.1:${server.port}/ws`;

    addTrustedRelay(relayUrl, trustedPubkey, 'existing-relay');

    try {
      await expect(
        listRemoteMachines({
          relay: relayUrl,
          yes: true,
        }),
      ).rejects.toThrow(/relay identity mismatch/i);
    } finally {
      server.stop(true);
    }
  });

  test('listRemoteMachines fails cleanly when identity unlock password is wrong', async () => {
    const relayPubkey = Buffer.from('relay-list-invalid-password').toString('base64');
    const server = startRelayHealthServer(relayPubkey);
    const relayUrl = `ws://127.0.0.1:${server.port}/ws`;

    await generateAndSaveKeypair('correct-password', 'test-host');
    promptPasswordValue = 'wrong-password';

    try {
      await expect(
        listRemoteMachines({
          relay: relayUrl,
          relayPubkey,
          yes: true,
        }),
      ).rejects.toThrow(/invalid password|failed to unlock identity/i);
    } finally {
      server.stop(true);
    }
  });
});
