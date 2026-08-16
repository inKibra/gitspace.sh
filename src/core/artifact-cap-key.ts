/**
 * Machine-local keypair for artifact capabilities (docs/ARTIFACT-PROTOCOL.md
 * Phase 3). Node-only companion to the browser-safe artifact-cap.ts.
 *
 * Caps are minted and verified on the SAME machine today (trigger scopes,
 * CLI checks), so a dedicated lazily-created keypair carries the same trust
 * as the filesystem it lives on. Share links (Phase 5) bind to the machine's
 * REGISTERED signing key instead, because the relay verifies those against
 * the registration record — this key never leaves the machine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { generateSigningKeypair } from '../lib/tmux-lite/crypto/identity.js';
import { getIdentityRoot } from './paths.js';

export interface ArtifactCapKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function keyFilePath(): string {
  return join(getIdentityRoot(), 'artifact-cap-key.json');
}

/** Load (or lazily create, 0600) the machine's artifact-cap keypair. */
export function getOrCreateArtifactCapKeypair(): ArtifactCapKeypair {
  const path = keyFilePath();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { publicKey: string; secretKey: string };
    return {
      publicKey: Uint8Array.from(Buffer.from(raw.publicKey, 'base64')),
      secretKey: Uint8Array.from(Buffer.from(raw.secretKey, 'base64')),
    };
  }
  const pair = generateSigningKeypair();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({
    publicKey: Buffer.from(pair.publicKey).toString('base64'),
    secretKey: Buffer.from(pair.secretKey).toString('base64'),
  }, null, 2), { mode: 0o600 });
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}
