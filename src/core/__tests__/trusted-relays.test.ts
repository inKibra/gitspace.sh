import { describe, expect, test } from 'bun:test';
import { isCloudReachableRelayUrl } from '../trusted-relays.js';

describe('isCloudReachableRelayUrl', () => {
  test('rejects IPv4 special-use ranges', () => {
    expect(isCloudReachableRelayUrl('ws://0.0.0.0:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://100.64.0.1:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://224.0.0.1:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://255.255.255.255:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('wss://93.184.216.34/ws')).toBe(true);
  });

  test('rejects IPv6 special-use ranges and mapped loopback', () => {
    expect(isCloudReachableRelayUrl('ws://[::]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://[ff02::1]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('ws://[::ffff:127.0.0.1]:4480/ws')).toBe(false);
    expect(isCloudReachableRelayUrl('wss://[::ffff:93.184.216.34]/ws')).toBe(true);
  });
});
