/** A saved `Sha256State`: `<8 state words, hex>:<bytes hashed>:<pending bytes of the open block, hex>`. */
export const SHA256_STATE_PATTERN = /^[a-f0-9]{64}:(0|[1-9][0-9]{0,15}):(?:[a-f0-9]{2}){0,63}$/u;

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Incremental SHA-256 (FIPS 180-4) whose running state is a short string, for a file hashed in pieces: across requests
 * that each hold only their own part (the account), or a large `File` read slice by slice (the browser, where Web Crypto
 * hashes only whole buffers). Platform hashes cannot export their state.
 */
export class Sha256State {
  private readonly h: Uint32Array;
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private buffered: number;
  private length: number;

  constructor(state?: string) {
    if (state === undefined) {
      this.h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      this.length = 0;
      this.buffered = 0;
      return;
    }
    if (!SHA256_STATE_PATTERN.test(state)) throw new Error('SHA-256 state is malformed');
    const [words, length, tail] = state.split(':');
    this.h = Uint32Array.from({ length: 8 }, (_, index) => Number.parseInt(words!.slice(index * 8, index * 8 + 8), 16));
    this.length = Number(length);
    this.buffered = tail!.length / 2;
    if (this.buffered !== this.length % 64) throw new Error('SHA-256 state is malformed');
    for (let index = 0; index < this.buffered; index++) this.block[index] = Number.parseInt(tail!.slice(index * 2, index * 2 + 2), 16);
  }

  update(bytes: Uint8Array): this {
    let offset = 0;
    this.length += bytes.byteLength;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, bytes.byteLength);
      this.block.set(bytes.subarray(0, count), this.buffered);
      this.buffered += count;
      offset = count;
      if (this.buffered < 64) return this;
      this.compress(this.block, 0);
      this.buffered = 0;
    }
    for (; offset + 64 <= bytes.byteLength; offset += 64) this.compress(bytes, offset);
    this.block.set(bytes.subarray(offset), 0);
    this.buffered = bytes.byteLength - offset;
    return this;
  }

  /** The state to resume from with `new Sha256State(state)`. */
  save(): string {
    return `${Array.from(this.h, word => word.toString(16).padStart(8, '0')).join('')}:${this.length}:${Array.from(this.block.subarray(0, this.buffered), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  /** The digest of everything hashed so far, as `sha256:<hex>`; the state itself is unchanged. */
  digest(): `sha256:${string}` {
    const bits = this.length * 8;
    const padding = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.byteLength - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(padding.byteLength - 4, bits >>> 0);
    const final = new Sha256State(this.save());
    final.update(padding);
    return `sha256:${Array.from(final.h, word => word.toString(16).padStart(8, '0')).join('')}`;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4;
      w[index] = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let index = 16; index < 64; index++) {
      const x = w[index - 15]!, y = w[index - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) | 0;
    }
    const h = this.h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let index = 0; index < 64; index++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[index]! + w[index]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
}
