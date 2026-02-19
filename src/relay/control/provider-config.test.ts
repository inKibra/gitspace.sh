/**
 * Provider config tests.
 *
 * getSpritesToken / setSpritesToken / clearSpritesToken wrap
 * global keychain secrets under a well-known key ('cloud:sprites_token').
 * We can't hit the real macOS keychain in CI, so we test the module
 * in isolation by monkey-patching the imported secret helpers.
 *
 * The module under test is src/relay/control/provider-config.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ── mock the secrets module ──────────────────────────────────────────────────

// We mock bun's module system before importing the module under test.
const mockGetSecret = mock(async (_key: string): Promise<string | null> => null);
const mockSetSecret = mock(async (_key: string, _value: string): Promise<void> => {});
const mockDeleteSecret = mock(async (_key: string): Promise<boolean> => true);

mock.module('../../utils/secrets.js', () => ({
  getSecret: mockGetSecret,
  setSecret: mockSetSecret,
  deleteSecret: mockDeleteSecret,
}));

// Import AFTER mocking
const { getSpritesToken, setSpritesToken, clearSpritesToken, SPRITES_TOKEN_KEY } = await import(
  './provider-config.js'
);

describe('provider config – Sprites token', () => {
  beforeEach(() => {
    mockGetSecret.mockClear();
    mockSetSecret.mockClear();
    mockDeleteSecret.mockClear();
  });

  afterEach(() => {
    mockGetSecret.mockClear();
    mockSetSecret.mockClear();
    mockDeleteSecret.mockClear();
  });

  test('SPRITES_TOKEN_KEY is the expected keychain key', () => {
    expect(SPRITES_TOKEN_KEY).toBe('cloud:sprites_token');
  });

  test('getSpritesToken returns null when no token is stored', async () => {
    mockGetSecret.mockImplementation(async () => null);
    const token = await getSpritesToken();
    expect(token).toBeNull();
    expect(mockGetSecret).toHaveBeenCalledWith(SPRITES_TOKEN_KEY);
  });

  test('getSpritesToken returns the stored token', async () => {
    mockGetSecret.mockImplementation(async () => 'sprites-tok-abc123');
    const token = await getSpritesToken();
    expect(token).toBe('sprites-tok-abc123');
  });

  test('setSpritesToken stores the token under the correct key', async () => {
    await setSpritesToken('sprites-tok-xyz');
    expect(mockSetSecret).toHaveBeenCalledWith(SPRITES_TOKEN_KEY, 'sprites-tok-xyz');
  });

  test('setSpritesToken rejects empty token', async () => {
    await expect(setSpritesToken('')).rejects.toThrow(/empty/i);
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  test('setSpritesToken rejects whitespace-only token', async () => {
    await expect(setSpritesToken('   ')).rejects.toThrow(/empty/i);
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  test('clearSpritesToken deletes the token from keychain', async () => {
    await clearSpritesToken();
    expect(mockDeleteSecret).toHaveBeenCalledWith(SPRITES_TOKEN_KEY);
  });

  test('clearSpritesToken returns true when token was present', async () => {
    mockDeleteSecret.mockImplementation(async () => true);
    const removed = await clearSpritesToken();
    expect(removed).toBe(true);
  });

  test('clearSpritesToken returns false when token was already absent', async () => {
    mockDeleteSecret.mockImplementation(async () => false);
    const removed = await clearSpritesToken();
    expect(removed).toBe(false);
  });
});
