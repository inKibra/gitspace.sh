import { describe, expect, test } from 'bun:test';
import { addTrustedRelay, getTrustedRelay, isCloudReachableRelayUrl } from '../trusted-relays.js';
import { afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let originalHome: string | undefined;
let testDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-trusted-relays-'));
  process.env.HOME = testDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('isCloudReachableRelayUrl', () => {
  test('rejects IPv4 special-use ranges', () => {
    expect(isCloudReachableRelayUrl('ws://0.0.0.0:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://100.64.0.1:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://224.0.0.1:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://255.255.255.255:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('wss://93.184.216.34/ws')).toBe(true);
    expect(isCloudReachableRelayUrl('wss://192.0.3.1/ws')).toBe(true);
  });

  test('rejects IPv6 special-use ranges and mapped loopback', () => {
    expect(isCloudReachableRelayUrl('ws://[::]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://[ff02::1]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://[::ffff:127.0.0.1]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('wss://[::ffff:93.184.216.34]/ws')).toBe(true);
  });

  test('normalizes relay URLs with and without /ws consistently', () => {
    addTrustedRelay('ws://relay.example.test/ws', 'pubkey-1', 'relay');

    expect(getTrustedRelay('ws://relay.example.test')).not.toBeNull();
    expect(getTrustedRelay('wss://relay.example.test/ws/')).not.toBeNull();
  });

  test('preserves path case while normalizing host and protocol', () => {
    addTrustedRelay('ws://Relay.EXAMPLE.test/RelayA', 'pubkey-case', 'relay');

    expect(getTrustedRelay('wss://relay.example.test/RelayA')).not.toBeNull();
    expect(getTrustedRelay('wss://relay.example.test/relaya')).toBeNull();
  });
});
