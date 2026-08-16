/**
 * Transport-layer chunking for oversize E2E data frames (ticket #42.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * The relay routes OPAQUE, E2E-encrypted `data` frames between machine and
 * client. The relay's Bun.serve enforces `maxPayloadLength` (RELAY_MAX_WS_PAYLOAD
 * = 64MB) at the uWebSockets TRANSPORT layer: a single frame over that cap is
 * closed with `1006 "Received too big message"` BEFORE any app code runs,
 * dropping the whole session to "Disconnected — waiting for relay". A single
 * legit payload (e.g. a full `machine_snapshot`, which grows with workspace and
 * agent-session count) can approach or exceed that cap — a 6.68MB snapshot frame
 * was observed in the field.
 *
 * THE FIX
 * -------
 * No single frame should be pathologically large. This module splits an
 * already-encrypted frame's bytes into ordered chunks that each ride as their
 * own `data` message (each far below the relay cap), and reassembles them on the
 * receiver BEFORE decryption. E2E is preserved: chunking wraps the ciphertext
 * bytes; the relay still sees opaque base64 it cannot inspect, and the plaintext
 * is only ever decrypted after full reassembly.
 *
 * WHY THE ENVELOPE LIVES IN THE PAYLOAD BYTES
 * -------------------------------------------
 * The relay reconstructs each forwarded `data` message from validated fields
 * (`{type, connectionId?, data}`) and DROPS any sibling metadata. So chunk
 * metadata cannot be a sibling of `data` — it must be embedded in the bytes that
 * become `data`. A chunk envelope is therefore a byte prefix on the wire payload.
 *
 * COLLISION SAFETY (chunk vs. plain frame)
 * ----------------------------------------
 * A plain encrypted frame (crypto/frames.ts) begins with a 4-byte big-endian
 * `streamId` (0 = master, 1+ = per-session). Real streamIds are small, so the
 * first byte is always 0x00. The chunk magic's first byte is 0xFF, which a plain
 * frame's leading byte can never be — so `isChunkEnvelope` is unambiguous and a
 * non-chunk payload passes straight through untouched (backward compatible: only
 * oversize frames are ever chunked).
 */

/** Chunk envelope magic: 0xFF 'C' 'K' '1'. First byte 0xFF can never be a plain
 *  frame's streamId high byte (streamIds are small ⇒ leading byte 0x00). */
const MAGIC0 = 0xff;
const MAGIC1 = 0x43; // 'C'
const MAGIC2 = 0x4b; // 'K'
const MAGIC3 = 0x31; // '1' (envelope version)

/** Envelope header: magic(4) + msgId(4, u32 BE) + seq(2, u16 BE) + total(2, u16 BE). */
const HEADER_LENGTH = 12;

/**
 * Default max bytes of ciphertext per chunk.
 *
 * 512KB raw ⇒ ~683KB base64 on the wire (plus a ~60-byte JSON envelope), which
 * keeps every `data` frame UNDER 1MB. This deliberately matches the 1MB
 * "maximum frame size" the rest of the system is built around — see
 * tmux-lite/protocol.ts `MAX_FRAME_SIZE` ("Matches relay protocol limit for
 * consistency across all transport paths"), the PTY chunker
 * (`PTY_CHUNK_SIZE = 512KB`, "well under the 1MB limit"), and the share-read
 * streamer (≤512KB "relay protocol caps messages at 1MB").
 *
 * WHY 1MB, NOT THE 64MB Bun.serve BACKSTOP: the local relay's `maxPayloadLength`
 * is a generous 64MB backstop, but a real deployment's machine↔relay path can
 * pass through hops with a ~1MB frame limit (the design limit above). A 6.68MB
 * machine_snapshot exceeded that and 1006'd the whole session. Bounding to
 * <1MB keeps oversize frames safe on EVERY transport path, not just the local
 * 64MB one.
 */
export const FRAME_CHUNK_SIZE = 512 * 1024;

/** Max chunks per message (u16). 65535 * 2MB ≈ 128GB — a non-constraint. */
const MAX_CHUNKS = 0xffff;

/** Safety bound on a single reassembled message (guards receiver memory). */
const MAX_REASSEMBLED_BYTES = 128 * 1024 * 1024;

/** Max concurrent in-flight (incomplete) messages tracked per reassembler. */
const MAX_INFLIGHT_MESSAGES = 8;

/** True if `bytes` is a chunk envelope (vs. a plain encrypted frame). */
export function isChunkEnvelope(bytes: Uint8Array): boolean {
  return (
    bytes.length >= HEADER_LENGTH &&
    bytes[0] === MAGIC0 &&
    bytes[1] === MAGIC1 &&
    bytes[2] === MAGIC2 &&
    bytes[3] === MAGIC3
  );
}

let nextMsgId = (Math.random() * 0xffffffff) >>> 0;
function allocMsgId(): number {
  nextMsgId = (nextMsgId + 1) >>> 0;
  return nextMsgId;
}

/**
 * Split an encrypted frame into wire payloads.
 *
 * Returns `[frame]` unchanged when it fits in one chunk (backward compatible —
 * small frames are never wrapped). Otherwise returns N chunk envelopes, each
 * carrying up to `maxChunkBytes` of the original bytes, that reassemble to the
 * exact input.
 */
export function chunkFrame(
  frame: Uint8Array,
  maxChunkBytes: number = FRAME_CHUNK_SIZE,
): Uint8Array[] {
  if (frame.length <= maxChunkBytes) {
    return [frame];
  }

  const total = Math.ceil(frame.length / maxChunkBytes);
  if (total > MAX_CHUNKS) {
    throw new Error(
      `chunkFrame: frame too large (${frame.length} bytes needs ${total} chunks, max ${MAX_CHUNKS})`,
    );
  }

  const msgId = allocMsgId();
  const out: Uint8Array[] = [];
  for (let seq = 0; seq < total; seq += 1) {
    const start = seq * maxChunkBytes;
    const end = Math.min(start + maxChunkBytes, frame.length);
    const payload = frame.subarray(start, end);
    const envelope = new Uint8Array(HEADER_LENGTH + payload.length);
    envelope[0] = MAGIC0;
    envelope[1] = MAGIC1;
    envelope[2] = MAGIC2;
    envelope[3] = MAGIC3;
    // msgId u32 BE
    envelope[4] = (msgId >>> 24) & 0xff;
    envelope[5] = (msgId >>> 16) & 0xff;
    envelope[6] = (msgId >>> 8) & 0xff;
    envelope[7] = msgId & 0xff;
    // seq u16 BE
    envelope[8] = (seq >>> 8) & 0xff;
    envelope[9] = seq & 0xff;
    // total u16 BE
    envelope[10] = (total >>> 8) & 0xff;
    envelope[11] = total & 0xff;
    envelope.set(payload, HEADER_LENGTH);
    out.push(envelope);
  }
  return out;
}

interface PendingMessage {
  total: number;
  received: number;
  bytes: number;
  parts: (Uint8Array | undefined)[];
  updatedAt: number;
}

export type ReassembleResult =
  /** Not a chunk (or a completed single frame): use `frame` directly. */
  | { kind: 'frame'; frame: Uint8Array }
  /** A chunk was buffered; the message is not yet complete. */
  | { kind: 'partial' }
  /** A malformed chunk was dropped (connection kept alive). */
  | { kind: 'error'; message: string };

/**
 * Stateful reassembler for one logical peer (one connection / one session).
 *
 * Feed every decoded wire payload through `receive`. Non-chunk payloads return
 * `{kind:'frame'}` immediately and unchanged. Chunk payloads are buffered until
 * the final chunk arrives, then the concatenated frame is returned as
 * `{kind:'frame'}`. Bounds concurrent in-flight messages and total buffered
 * bytes to protect receiver memory.
 */
export class FrameChunkReassembler {
  private pending = new Map<number, PendingMessage>();

  receive(bytes: Uint8Array): ReassembleResult {
    if (!isChunkEnvelope(bytes)) {
      return { kind: 'frame', frame: bytes };
    }

    const msgId =
      ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
    const seq = ((bytes[8] << 8) | bytes[9]) >>> 0;
    const total = ((bytes[10] << 8) | bytes[11]) >>> 0;
    const payload = bytes.subarray(HEADER_LENGTH);

    if (total === 0 || seq >= total) {
      return { kind: 'error', message: `bad chunk header seq=${seq} total=${total}` };
    }

    let entry = this.pending.get(msgId);
    if (!entry) {
      // Evict the oldest in-flight message if we're tracking too many.
      if (this.pending.size >= MAX_INFLIGHT_MESSAGES) {
        let oldestId: number | undefined;
        let oldestAt = Infinity;
        for (const [id, m] of this.pending) {
          if (m.updatedAt < oldestAt) {
            oldestAt = m.updatedAt;
            oldestId = id;
          }
        }
        if (oldestId !== undefined) this.pending.delete(oldestId);
      }
      entry = { total, received: 0, bytes: 0, parts: new Array(total), updatedAt: Date.now() };
      this.pending.set(msgId, entry);
    }

    if (entry.total !== total) {
      this.pending.delete(msgId);
      return { kind: 'error', message: `chunk total mismatch for msg=${msgId}` };
    }
    if (entry.parts[seq] !== undefined) {
      // Duplicate chunk — ignore, stay partial.
      return { kind: 'partial' };
    }

    entry.parts[seq] = payload;
    entry.received += 1;
    entry.bytes += payload.length;
    entry.updatedAt = Date.now();

    if (entry.bytes > MAX_REASSEMBLED_BYTES) {
      this.pending.delete(msgId);
      return { kind: 'error', message: `reassembled message exceeds ${MAX_REASSEMBLED_BYTES} bytes` };
    }

    if (entry.received < entry.total) {
      return { kind: 'partial' };
    }

    // Complete — concatenate in order.
    const full = new Uint8Array(entry.bytes);
    let offset = 0;
    for (let i = 0; i < entry.total; i += 1) {
      const part = entry.parts[i];
      if (!part) {
        this.pending.delete(msgId);
        return { kind: 'error', message: `missing chunk ${i} for msg=${msgId}` };
      }
      full.set(part, offset);
      offset += part.length;
    }
    this.pending.delete(msgId);
    return { kind: 'frame', frame: full };
  }

  /** Drop all buffered partial messages (call on disconnect). */
  reset(): void {
    this.pending.clear();
  }
}
