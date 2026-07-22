/**
 * Ticket #42.3: transport-layer chunking for oversize E2E data frames.
 *
 * Proves the durable fix: a pathologically large payload (6.68MB seen in the
 * field, and beyond) is split so no single wire frame approaches the relay's
 * 64MB transport cap, and reassembles byte-identically before decryption — with
 * E2E intact (chunking wraps ciphertext, plaintext round-trips through
 * createFrame → chunk → reassemble → openFrame).
 */

import { describe, expect, test } from 'bun:test';
import {
  chunkFrame,
  isChunkEnvelope,
  FrameChunkReassembler,
  FRAME_CHUNK_SIZE,
} from '../frame-chunk';
import { createFrame, openFrame } from '../frames';
import { RELAY_MAX_WS_PAYLOAD, RELAY_WS_PAYLOAD_WARN } from '../../../../relay/protocol';

function randomKey(): Uint8Array {
  // 32-byte AES-256-GCM symmetric key (createFrame requires exactly 32 bytes).
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

describe('chunkFrame / FrameChunkReassembler', () => {
  test('small frame is passed through unchunked (backward compatible)', () => {
    const frame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]);
    const chunks = chunkFrame(frame, FRAME_CHUNK_SIZE);
    expect(chunks).toHaveLength(1);
    expect(isChunkEnvelope(chunks[0]!)).toBe(false);
    expect(chunks[0]).toBe(frame); // returned as-is
  });

  test('a plain encrypted frame is never mistaken for a chunk envelope', () => {
    // streamId 0/1/2 ⇒ leading byte 0x00; chunk magic leads with 0xFF.
    for (const streamId of [0, 1, 2, 255, 65535]) {
      const buf = new Uint8Array(20);
      new DataView(buf.buffer).setUint32(0, streamId, false);
      crypto.getRandomValues(buf.subarray(4));
      expect(isChunkEnvelope(buf)).toBe(false);
    }
  });

  test('oversize frame splits into ordered chunks that reassemble byte-identically', () => {
    const size = Math.floor(6.68 * 1024 * 1024); // the field-observed 6.68MB
    const frame = new Uint8Array(size);
    crypto.getRandomValues(frame.subarray(0, 65536));
    for (let i = 65536; i < size; i += 1) frame[i] = (i * 31) & 0xff;

    const chunks = chunkFrame(frame, FRAME_CHUNK_SIZE);
    expect(chunks.length).toBeGreaterThan(1);

    // Every wire chunk stays UNDER 1MB (the design frame limit), and therefore
    // well below the relay warn (4MB) and the 64MB transport backstop.
    const ONE_MB = 1024 * 1024;
    for (const chunk of chunks) {
      expect(isChunkEnvelope(chunk)).toBe(true);
      // Exact base64 length of the wire payload, plus the ~60-byte JSON envelope.
      const base64Bytes = Math.ceil(chunk.length / 3) * 4;
      expect(base64Bytes + 64).toBeLessThan(ONE_MB);
      expect(base64Bytes).toBeLessThan(RELAY_WS_PAYLOAD_WARN);
      expect(base64Bytes).toBeLessThan(RELAY_MAX_WS_PAYLOAD);
    }

    const reasm = new FrameChunkReassembler();
    let out: Uint8Array | null = null;
    for (const chunk of chunks) {
      const r = reasm.receive(chunk);
      if (r.kind === 'frame') out = r.frame;
      else expect(r.kind).toBe('partial');
    }
    expect(out).not.toBeNull();
    expect(out!.length).toBe(frame.length);
    expect(Buffer.from(out!).equals(Buffer.from(frame))).toBe(true);
  });

  test('E2E round-trip: createFrame → chunk → reassemble → openFrame', () => {
    const key = randomKey();
    // A ~5MB plaintext (e.g. a big machine_snapshot) ⇒ >FRAME_CHUNK_SIZE frame.
    const plaintext = new Uint8Array(5 * 1024 * 1024);
    crypto.getRandomValues(plaintext.subarray(0, 65536));
    for (let i = 65536; i < plaintext.length; i += 1) plaintext[i] = (i * 7) & 0xff;

    const frame = createFrame(0, plaintext, key);
    const chunks = chunkFrame(frame, FRAME_CHUNK_SIZE);
    expect(chunks.length).toBeGreaterThan(1);

    const reasm = new FrameChunkReassembler();
    let reassembled: Uint8Array | null = null;
    for (const chunk of chunks) {
      const r = reasm.receive(chunk);
      if (r.kind === 'frame') reassembled = r.frame;
    }
    expect(reassembled).not.toBeNull();

    const opened = openFrame(reassembled!, key);
    expect(opened).not.toBeNull();
    expect(opened!.streamId).toBe(0);
    expect(Buffer.from(opened!.data).equals(Buffer.from(plaintext))).toBe(true);
  });

  test('reassembler handles interleaved messages and out-of-order chunks', () => {
    const frameA = new Uint8Array(3 * FRAME_CHUNK_SIZE);
    const frameB = new Uint8Array(2 * FRAME_CHUNK_SIZE + 10);
    frameA.fill(0xab);
    frameB.fill(0xcd);
    const a = chunkFrame(frameA, FRAME_CHUNK_SIZE);
    const b = chunkFrame(frameB, FRAME_CHUNK_SIZE);

    const reasm = new FrameChunkReassembler();
    // Interleave, and deliver A's chunks reversed.
    const order = [a[2]!, b[0]!, a[0]!, b[1]!, a[1]!];
    const results = order.map((c) => reasm.receive(c));
    const completed = results.filter((r) => r.kind === 'frame');
    // Only frame A completes within this order (B still missing a chunk).
    expect(completed).toHaveLength(1);
    expect((completed[0] as { frame: Uint8Array }).frame.length).toBe(frameA.length);
  });

  test('duplicate chunk is ignored; malformed header is rejected softly', () => {
    const frame = new Uint8Array(2 * FRAME_CHUNK_SIZE);
    frame.fill(0x11);
    const chunks = chunkFrame(frame, FRAME_CHUNK_SIZE);
    const reasm = new FrameChunkReassembler();
    expect(reasm.receive(chunks[0]!).kind).toBe('partial');
    expect(reasm.receive(chunks[0]!).kind).toBe('partial'); // duplicate seq
    expect(reasm.receive(chunks[1]!).kind).toBe('frame'); // completes

    // Malformed: magic present but seq >= total.
    const bad = new Uint8Array(16);
    bad[0] = 0xff; bad[1] = 0x43; bad[2] = 0x4b; bad[3] = 0x31;
    bad[8] = 0; bad[9] = 5; // seq=5
    bad[10] = 0; bad[11] = 2; // total=2
    expect(reasm.receive(bad).kind).toBe('error');
  });
});
