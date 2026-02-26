/**
 * Cloud provider configuration helpers.
 *
 * Provider secrets (e.g. the Sprites.dev API token) are stored in the global
 * keychain under well-known keys using the existing setSecret/getSecret API.
 * This module owns those key names and provides typed accessors.
 */

import { deleteSecret, getSecret, setSecret } from '../../utils/secrets.js';
import { SpacesError } from '../../types/errors.js';

// ── Well-known keychain keys ─────────────────────────────────────────────────

/** Keychain key under which the Sprites.dev API token is stored. */
export const SPRITES_TOKEN_KEY = 'cloud:sprites_token';

// ── Sprites token ────────────────────────────────────────────────────────────

/**
 * Retrieve the stored Sprites.dev API token, or null if none is configured.
 */
export async function getSpritesToken(): Promise<string | null> {
  return getSecret(SPRITES_TOKEN_KEY);
}

/**
 * Store the Sprites.dev API token in the global keychain.
 * Throws SpacesError if the token is blank.
 */
export async function setSpritesToken(token: string): Promise<void> {
  if (!token || !token.trim()) {
    throw new SpacesError(
      'Sprites token cannot be empty.',
      'USER_ERROR',
      1
    );
  }
  await setSecret(SPRITES_TOKEN_KEY, token.trim());
}

/**
 * Remove the Sprites.dev API token from the keychain.
 * Returns true if the token existed and was removed, false if it was absent.
 */
export async function clearSpritesToken(): Promise<boolean> {
  return deleteSecret(SPRITES_TOKEN_KEY);
}
