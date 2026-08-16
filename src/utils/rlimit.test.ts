import { describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { raiseFileDescriptorLimit } from './rlimit.js';

const RLIMIT_NOFILE = process.platform === 'darwin' ? 8 : 7;

function loadLibc() {
  const candidates =
    process.platform === 'darwin' ? ['libSystem.B.dylib', 'libSystem.dylib'] : ['libc.so.6', 'libc.so'];
  for (const name of candidates) {
    try {
      return dlopen(name, {
        getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      });
    } catch {
      /* next */
    }
  }
  return null;
}

function readSoftHard(): { soft: bigint; hard: bigint } {
  const lib = loadLibc()!;
  const rl = new BigUint64Array(2);
  const rc = lib.symbols.getrlimit(RLIMIT_NOFILE, ptr(rl));
  expect(rc).toBe(0);
  return { soft: rl[0]!, hard: rl[1]! };
}

describe('raiseFileDescriptorLimit', () => {
  test('reports the current limits without throwing', () => {
    const r = raiseFileDescriptorLimit(16384);
    expect(r.ok).toBe(true);
    expect(typeof r.hard).toBe('number');
    expect(typeof r.soft).toBe('number');
  });

  test('raises a deliberately-lowered soft limit back toward the target', () => {
    const lib = loadLibc();
    if (!lib) {
      // No libc (unexpected on Linux/macOS) — nothing to assert.
      return;
    }
    const { hard } = readSoftHard();

    // Lower the soft limit to a macOS-like 256 (lowering never needs privilege).
    const lowered = new BigUint64Array([256n, hard]);
    expect(lib.symbols.setrlimit(RLIMIT_NOFILE, ptr(lowered))).toBe(0);
    expect(readSoftHard().soft).toBe(256n);

    const target = hard > 8192n ? 8192 : Number(hard);
    const r = raiseFileDescriptorLimit(target);
    expect(r.ok).toBe(true);
    expect(r.raised).toBe(true);

    const after = readSoftHard();
    // Soft is raised to min(target, hard) and strictly above the lowered 256.
    expect(after.soft).toBeGreaterThan(256n);
    const expected = BigInt(target) < hard ? BigInt(target) : hard;
    expect(after.soft).toBe(expected);
  });

  test('never sets the soft limit above the hard limit', () => {
    const { hard } = readSoftHard();
    // Ask for an absurdly large target; result must be clamped to hard.
    const r = raiseFileDescriptorLimit(Number.MAX_SAFE_INTEGER);
    expect(r.ok).toBe(true);
    const after = readSoftHard();
    expect(after.soft).toBeLessThanOrEqual(hard);
  });
});
