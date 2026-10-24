import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { Sha256State } from '../src/sha256-state.js';

it('hashes bytes split anywhere and resumed from saved state between pieces exactly as one pass does', () => {
  const bytes = Uint8Array.from({ length: 70_001 }, (_, index) => (index * 31 + 7) % 256);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 70_001]) {
    const whole = bytes.subarray(0, length);
    let state = new Sha256State().save();
    // Pieces that end inside, at and across 64-byte blocks; each resumes from the previous piece's saved state.
    for (let offset = 0, piece = 0; offset < length; piece++) {
      const size = [7, 64, 1, 130, 57][piece % 5]!;
      state = new Sha256State(state).update(whole.subarray(offset, offset + size)).save();
      offset += size;
    }
    expect(new Sha256State(state).digest()).toBe(`sha256:${createHash('sha256').update(whole).digest('hex')}`);
  }
  expect(() => new Sha256State(`${'0'.repeat(64)}:3:ab`)).toThrow('malformed');
});
