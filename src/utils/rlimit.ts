/**
 * Raise RLIMIT_NOFILE (max open file descriptors) toward the hard limit.
 *
 * Long-running daemons that spawn PTYs, agent workers, and their bash-tool
 * children accumulate open fds. On macOS the default soft limit is only 256
 * (`ulimit -n`), so a busy session eventually fails a `posix_spawn` /
 * `openSync` with EBADF/EMFILE. Bun exposes no native setrlimit, so we call
 * libc's getrlimit(2)/setrlimit(2) directly via bun:ffi.
 *
 * This is best-effort: every failure path is swallowed and reported, never
 * thrown — a daemon must not die over a resource-limit tweak.
 */

import { dlopen, FFIType, ptr } from 'bun:ffi';

// RLIMIT_NOFILE differs per platform — using the wrong constant would resize
// the WRONG limit (e.g. RLIMIT_STACK), so these must be exact.
//   Linux  <bits/resource.h>: RLIMIT_NOFILE = 7
//   macOS  <sys/resource.h> : RLIMIT_NOFILE = 8
const RLIMIT_NOFILE = process.platform === 'darwin' ? 8 : 7;

/** A generous soft target; we never exceed the hard limit. */
export const DEFAULT_NOFILE_TARGET = 16384;

export interface RaiseNofileResult {
  ok: boolean;
  raised: boolean;
  /** Soft limit after the call (or the observed soft limit on failure). */
  soft?: number;
  /** Hard limit (ceiling we clamp to). */
  hard?: number;
  reason?: string;
}

type LibcHandle = {
  symbols: {
    getrlimit: (resource: number, rlim: number) => number;
    setrlimit: (resource: number, rlim: number) => number;
  };
};

let libcHandle: LibcHandle | null | undefined;

function loadLibc(): LibcHandle | null {
  if (libcHandle !== undefined) return libcHandle;
  const candidates =
    process.platform === 'darwin'
      ? ['libSystem.B.dylib', 'libSystem.dylib']
      : ['libc.so.6', 'libc.so'];
  const signature = {
    getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  } as const;
  for (const name of candidates) {
    try {
      libcHandle = dlopen(name, signature) as unknown as LibcHandle;
      return libcHandle;
    } catch {
      /* try next candidate */
    }
  }
  libcHandle = null;
  return libcHandle;
}

/**
 * Raise the soft RLIMIT_NOFILE to min(hard, target). Idempotent and cheap;
 * safe to call at every daemon/worker boot. Returns a description of what
 * happened for logging.
 */
export function raiseFileDescriptorLimit(target = DEFAULT_NOFILE_TARGET): RaiseNofileResult {
  let lib: LibcHandle | null;
  try {
    lib = loadLibc();
  } catch (err) {
    return { ok: false, raised: false, reason: `dlopen threw: ${String(err)}` };
  }
  if (!lib) return { ok: false, raised: false, reason: 'libc not loadable' };

  try {
    // struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; } — two 64-bit words
    // on both Linux and macOS.
    const rlim = new BigUint64Array(2);
    const rlimPtr = ptr(rlim);

    if (lib.symbols.getrlimit(RLIMIT_NOFILE, rlimPtr) !== 0) {
      return { ok: false, raised: false, reason: 'getrlimit failed' };
    }

    const cur = rlim[0]!;
    const hard = rlim[1]!;
    const targetBig = BigInt(target);
    // Clamp to the hard limit; if hard is "infinity" (a very large sentinel)
    // targetBig is smaller and wins anyway.
    const desired = targetBig < hard ? targetBig : hard;

    const softNum = cur > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(cur);
    const hardNum = hard > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(hard);

    if (desired <= cur) {
      return { ok: true, raised: false, soft: softNum, hard: hardNum };
    }

    // macOS caps NOFILE at kern.maxfilesperproc; a too-high setrlimit returns
    // EINVAL. Try the desired value, then back off to progressively smaller
    // safe ceilings rather than giving up.
    const attempts: bigint[] = [desired];
    for (const fallback of [10240n, 4096n, 1024n]) {
      if (fallback > cur && fallback < desired) attempts.push(fallback);
    }
    for (const attempt of attempts) {
      rlim[0] = attempt;
      rlim[1] = hard;
      if (lib.symbols.setrlimit(RLIMIT_NOFILE, ptr(rlim)) === 0) {
        const newSoft = attempt > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(attempt);
        return { ok: true, raised: true, soft: newSoft, hard: hardNum };
      }
    }
    return { ok: false, raised: false, soft: softNum, hard: hardNum, reason: 'setrlimit failed for all targets' };
  } catch (err) {
    return { ok: false, raised: false, reason: `ffi call threw: ${String(err)}` };
  }
}

/**
 * Convenience wrapper for boot sites: raise the limit and log the outcome on
 * one line. Never throws.
 */
export function raiseFileDescriptorLimitAtBoot(label: string, target = DEFAULT_NOFILE_TARGET): RaiseNofileResult {
  const result = raiseFileDescriptorLimit(target);
  try {
    if (result.raised) {
      console.error(`[${label}] raised RLIMIT_NOFILE soft limit to ${result.soft} (hard ${result.hard})`);
    } else if (result.ok) {
      console.error(`[${label}] RLIMIT_NOFILE soft limit already ${result.soft} (hard ${result.hard}); no change`);
    } else {
      console.error(`[${label}] could not raise RLIMIT_NOFILE: ${result.reason ?? 'unknown'}`);
    }
  } catch {
    /* logging must never break boot */
  }
  return result;
}
