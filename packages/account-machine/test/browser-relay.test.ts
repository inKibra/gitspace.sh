import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BrowserRelaySupervisor } from '../src/browser-relay.js';
import { relayCommandAllowed } from '../src/browser-relay-extension.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('installs account-targeted extension without opening a localhost relay or creating machine pairing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-extension-')); roots.push(root);
  const installer = new BrowserRelaySupervisor({ environmentRoot: join(root, 'environment'), privateRoot: join(root, 'private'), machineId: 'machine', accountUrl: 'https://account.gitspace.test', enabled: true });
  const status = await installer.setup();
  expect(status.endpoint).toBe('https://account.gitspace.test');
  expect(status.owned).toBe(false); expect(status.pairingCode).toBeNull();
  const manifest = JSON.parse(await readFile(join(installer.extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['https://account.gitspace.test/*']);
  await expect(installer.unpair()).rejects.toThrow('account Browser settings');
});
it('retains scoped CDP and origin admission at the extension boundary', () => {
  const grant = { origins: ['example.test'] };
  expect(relayCommandAllowed(grant, 'target', 'session', 'Page.navigate', { url: 'https://example.test/private' }, 'session')).toBe(true);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Page.navigate', { url: 'https://attacker.test/' }, 'session')).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Target.closeTarget', { targetId: 'other' })).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Runtime.evaluate', { expression: '1' }, 'other')).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Browser.getVersion', {})).toBe(false);
});
