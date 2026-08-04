/**
 * Real secrets backend for tests, pointed at a per-process temp file.
 *
 * `utils/secrets.ts` ships a file-backed store (GSSH_TEST_SECRETS_FILE) that
 * short-circuits Bun.secrets at every read/write/delete, so tests can exercise
 * the real unified-blob format, cache invalidation and legacy-migration paths.
 *
 * Use this instead of `mock.module('../secrets', ...)`. `mock.module` replaces a
 * module wholesale with an object literal that TypeScript cannot check against
 * the real export list, so a fake silently loses any export added later — and
 * the failure surfaces as `SyntaxError: Export named 'x' not found` at import
 * time, killing the whole file before a single assertion runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as SecretsModule from '../utils/secrets.js';

const storeDir = mkdtempSync(join(tmpdir(), 'gitspace-test-secrets-'));

/** Backing file for the temp store. Recreated on demand by the real module. */
export const secretsStoreFile = join(storeDir, 'secrets.json');

process.env.GSSH_TEST_RUNTIME = '1';
process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = '1';
process.env.GSSH_TEST_SECRETS_FILE = secretsStoreFile;

// `secrets.ts` freezes GSSH_TEST_SECRETS_FILE into module-level consts when it
// evaluates, and ESM evaluates static dependencies BEFORE this module's body
// runs — a static import would therefore bind the real keychain backend before
// the env above is set. Deferring the load is the only ordering that reaches
// the file backend, so this dynamic import is load-order-critical, not optional.
export const secrets: typeof SecretsModule = await import('../utils/secrets.js');

/**
 * Drop every stored secret and the in-process cache.
 *
 * Import this module before anything that pulls `utils/secrets.js`, so the file
 * backend wins the race described above.
 */
export function resetSecretsStore(): void {
  rmSync(secretsStoreFile, { force: true });
  secrets.clearSecretsCache();
}
