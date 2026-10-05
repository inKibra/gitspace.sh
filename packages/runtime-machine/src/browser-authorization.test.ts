import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineBrowser } from './browser.js';
import { browserTestAuthority } from './browser-test-support.js';
import { RuntimeBrowserArgumentsSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from './journal.js';

test('missing verifier, missing signature, disabled machine and edited signed arguments fail before relay access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-auth-')), authority = await browserTestAuthority();
  const local = { rootPath: directory } as LocalAttachment;
  const args = RuntimeBrowserArgumentsSchema.parse({ action: 'open', source: 'headless', url: 'https://example.test' });
  const signed = await authority.dispatch(args, { type: 'prepare', args, groupId: crypto.randomUUID() });
  const missingVerifier = new MachineBrowser({ directory, enabled: true });
  const disabled = new MachineBrowser({ directory, enabled: false, verifyAuthorization: authority.verifyAuthorization });
  const browser = new MachineBrowser({ directory, enabled: true, verifyAuthorization: authority.verifyAuthorization });
  try {
    await expect(missingVerifier.execute(signed, local, AbortSignal.timeout(1000))).rejects.toThrow('Signed');
    await expect(disabled.execute(signed, local, AbortSignal.timeout(1000))).rejects.toThrow('unavailable');
    const unsigned = { ...signed, browserAuthorization: undefined };
    await expect(browser.execute(unsigned, local, AbortSignal.timeout(1000))).rejects.toThrow('Signed');
    const edited = { ...signed, args: { ...args, url: 'https://different.test' } };
    await expect(browser.execute(edited, local, AbortSignal.timeout(1000))).rejects.toThrow('arguments');
  } finally { await Promise.all([missingVerifier.close(), disabled.close(), browser.close()]); await rm(directory, { recursive: true, force: true }); }
});
