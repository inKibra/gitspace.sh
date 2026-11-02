import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BrowserRelaySupervisor } from '../src/browser-relay.js';
import { extensionFiles, relayCommandAllowed } from '@gitspace/browser-extension';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('installs account-targeted extension without opening a localhost relay or creating machine pairing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-extension-')); roots.push(root);
  const installer = new BrowserRelaySupervisor({ environmentRoot: join(root, 'environment'), privateRoot: join(root, 'private'), machineId: 'machine', accountUrl: 'https://account.gitspace.test', enabled: true });
  const status = await installer.setup();
  expect(status.endpoint).toBe('https://account.gitspace.test');
  expect(status.owned).toBe(false); expect(status.pairingCode).toBeNull();
  const manifest = JSON.parse(await readFile(join(installer.extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['<all_urls>', 'https://account.gitspace.test/*']);
  await expect(installer.unpair()).rejects.toThrow('account Browser settings');
});
it('rewrites an installed folder to exactly the release\'s files, its build file naming the build its service worker runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-extension-')); roots.push(root);
  const installer = new BrowserRelaySupervisor({ environmentRoot: join(root, 'environment'), privateRoot: join(root, 'private'), machineId: 'machine', accountUrl: 'https://account.gitspace.test', enabled: true });
  await installer.setup();
  // A file an earlier release had, and that one's build.
  await writeFile(join(installer.extensionPath, 'retired.js'), 'retired');
  await writeFile(join(installer.extensionPath, 'build.txt'), 'f'.repeat(32));
  await installer.setup();
  expect((await readdir(installer.extensionPath)).sort()).toEqual(Object.keys(extensionFiles('https://account.gitspace.test')).sort());
  const build = await readFile(join(installer.extensionPath, 'build.txt'), 'utf8');
  expect(build).toMatch(/^[a-f0-9]{32}$/u);
  expect((await readFile(join(installer.extensionPath, 'background.js'), 'utf8')).split('\n', 1)[0]).toBe(`const GITSPACE_EXTENSION_BUILD = "${build}";`);
});
it('retains scoped CDP and origin admission at the extension boundary', () => {
  const grant = { origins: ['example.test'] };
  expect(relayCommandAllowed(grant, 'target', 'session', 'Page.navigate', { url: 'https://example.test/private' }, 'session')).toBe(true);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Page.navigate', { url: 'https://attacker.test/' }, 'session')).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Target.closeTarget', { targetId: 'other' })).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Runtime.evaluate', { expression: '1' }, 'other')).toBe(false);
  expect(relayCommandAllowed(grant, 'target', 'session', 'Browser.getVersion', {})).toBe(false);
});
