import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  RELAY_PROTOCOL_VERSION,
  TUNNEL_CHUNK_BYTES,
  createRelayAuthorization,
  decodeTunnelChunk,
  decryptArtifactBytes,
  encodeTunnelChunk,
  encryptArtifactBytes,
  parseRelaySocketMessage,
  verifyRelayAuthorization,
} from '../src/index.js';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = btoa(String.fromCharCode(...ed25519.getPublicKey(privateKey)));

describe('relay authorization', () => {
  it('signs the exact path and rejects replay against another target', () => {
    const now = 1_800_000_000_000;
    const target = '/ws?role=machine&id=darktop';
    const header = createRelayAuthorization(privateKey, target, now, '12345678-1234-4234-8234-123456789abc');

    expect(verifyRelayAuthorization({ header, signingPublicKey: publicKey, target, now, maxSkewMs: 60_000 }).status).toBe('ok');
    expect(verifyRelayAuthorization({ header, signingPublicKey: publicKey, target: '/ws?role=client&id=browser', now, maxSkewMs: 60_000 }).status).toBe('error');
  });

  it('rejects expired signatures', () => {
    const issuedAt = 1_800_000_000_000;
    const target = '/ws?role=machine&id=darktop';
    const header = createRelayAuthorization(privateKey, target, issuedAt, '12345678-1234-4234-8234-123456789abc');
    expect(verifyRelayAuthorization({
      header,
      signingPublicKey: publicKey,
      target,
      now: issuedAt + 60_001,
      maxSkewMs: 60_000,
    }).status).toBe('error');
  });
});

describe('relay messages', () => {
  it('accepts opaque routed frames and rejects oversized payloads', () => {
    const accepted = parseRelaySocketMessage(JSON.stringify({
      version: RELAY_PROTOCOL_VERSION,
      type: 'frame',
      to: 'client:browser',
      payload: 'ciphertext',
    }));
    expect(accepted.status).toBe('ok');

    const rejected = parseRelaySocketMessage(JSON.stringify({
      version: RELAY_PROTOCOL_VERSION,
      type: 'frame',
      to: 'client:browser',
      payload: 'x'.repeat(900_001),
    }));
    expect(rejected.status).toBe('error');
  });

  it('round-trips bounded tunnel chunks', () => {
    const bytes = Uint8Array.from({ length: TUNNEL_CHUNK_BYTES }, (_, index) => index % 251);
    expect(decodeTunnelChunk(encodeTunnelChunk(bytes))).toEqual(bytes);
    expect(() => encodeTunnelChunk(new Uint8Array(TUNNEL_CHUNK_BYTES + 1))).toThrow(/exceeds/);
  });
});

describe('artifact encryption', () => {
  it('stores authenticated ciphertext and round-trips only with the client key', async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const plaintext = new TextEncoder().encode('private artifact payload');
    const sealed = await encryptArtifactBytes(
      plaintext,
      key,
      Uint8Array.from({ length: 12 }, (_, index) => index),
    );
    expect(new TextDecoder().decode(sealed)).not.toContain('private artifact payload');
    expect(await decryptArtifactBytes(sealed, key)).toEqual(plaintext);
    await expect(decryptArtifactBytes(sealed, new Uint8Array(32))).rejects.toThrow();
  });
});
