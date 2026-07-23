/**
 * Code-version identity for stale-daemon detection.
 *
 * The relay client + E2E session manager (the frame-chunking send path) run
 * INSIDE the tmux-lite daemon (serve-runtime.ts), and ensureServer() reuses an
 * already-running daemon without reloading its code. To catch a daemon still
 * executing OLD code, the daemon captures this value at boot and reports it; the
 * CLI compares it against the value computed NOW and recycles on a mismatch.
 *
 * Two regimes:
 *   - Compiled binary (prod): a real BUILD_ID baked in at build time (git sha +
 *     version). Both daemon and client derive it from their own binary, so a
 *     reinstall changes it → mismatch → recycle. A true version match.
 *   - From source (dev): there is no meaningful build identity, so the dev
 *     supervisor (scripts/dev.ts) mints a random token per stack launch into
 *     GITSPACE_CODE_VERSION. A stack restart yields a new token, so any daemon
 *     that survived from a previous run mismatches and is recycled. Without the
 *     token (casual user-typed commands, or a manual from-source run) this
 *     returns null → "unknown" → reuse, so nothing churns.
 */

import { VERSION, BUILD_ID } from "../../version.generated.js";

/** True when running as a compiled single-file binary rather than `bun <file>`. */
function isCompiledBinary(): boolean {
  return !process.execPath.endsWith("bun");
}

/**
 * The code-version identity for the current process, or null when it can't be
 * meaningfully determined (dev-from-source with no explicit token). Callers MUST
 * treat null as "don't police staleness — reuse the daemon".
 */
export function getCodeVersion(): string | null {
  const override = process.env.GITSPACE_CODE_VERSION?.trim();
  if (override) return override;
  if (isCompiledBinary()) return `${VERSION}+${BUILD_ID}`;
  return null;
}
