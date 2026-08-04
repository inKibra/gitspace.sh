import { describe, expect, it, beforeEach } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resetSecretsStore, secrets, secretsStoreFile } from '../secrets-store.js';

describe('real temp secrets store', () => {
  beforeEach(() => resetSecretsStore());

  it('round-trips through the real module against a temp file', async () => {
    expect(await secrets.getProjectSecret('demo', 'A')).toBeNull();
    await secrets.setProjectSecret('demo', 'A', 'one');
    expect(await secrets.getProjectSecret('demo', 'A')).toBe('one');
    expect(existsSync(secretsStoreFile)).toBe(true);
    expect(readFileSync(secretsStoreFile, 'utf-8')).toContain('com.gitspace:secrets');
    expect(await secrets.deleteProjectSecret('demo', 'A')).toBe(true);
    expect(await secrets.getProjectSecret('demo', 'A')).toBeNull();
  });

  it('isolates between resets', async () => {
    expect(await secrets.getProjectSecret('demo', 'A')).toBeNull();
  });
});
