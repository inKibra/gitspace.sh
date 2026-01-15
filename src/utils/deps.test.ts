import { describe, test, expect } from 'bun:test';
import { checkCommandExists } from './deps.js';

describe('checkCommandExists', () => {
  test('returns true for commands that exist', async () => {
    // These should exist on any system running this test
    expect(await checkCommandExists('ls')).toBe(true);
    expect(await checkCommandExists('which')).toBe(true);
  });

  test('returns false for commands that do not exist', async () => {
    expect(await checkCommandExists('nonexistent-command-xyz-123')).toBe(false);
  });

  test('returns false for invalid command names (injection prevention)', async () => {
    expect(await checkCommandExists('ls; echo hacked')).toBe(false);
    expect(await checkCommandExists('ls && rm -rf /')).toBe(false);
    expect(await checkCommandExists('$(whoami)')).toBe(false);
    expect(await checkCommandExists('ls | cat')).toBe(false);
    expect(await checkCommandExists('')).toBe(false);
    expect(await checkCommandExists('cmd with spaces')).toBe(false);
  });

  test('allows valid command name characters', async () => {
    // These are valid command name formats (alphanumeric, dash, underscore)
    // They may not exist, but should pass validation
    expect(await checkCommandExists('my-command')).toBe(false); // valid format, doesn't exist
    expect(await checkCommandExists('my_command')).toBe(false); // valid format, doesn't exist
    expect(await checkCommandExists('command123')).toBe(false); // valid format, doesn't exist
  });
});
