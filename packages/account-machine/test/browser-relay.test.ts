import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRelaySupervisor } from '../src/browser-relay.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BrowserRelaySupervisor', () => {
  it('installs the real extension shape and reports the relay waiting for Chrome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-relay-'));
    roots.push(root);
    const binary = join(root, 'omp');
    await writeFile(binary, `#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args[0] === 'config') process.exit(0);
if (args[0] === 'browser-relay' && args[1] === 'install') {
  const path = args[args.indexOf('--dir') + 1];
  await mkdir(path, { recursive: true });
  await writeFile(path + '/manifest.json', '{}');
  process.exit(0);
}
if (args[0] === 'browser-relay' && args[1] === 'serve') {
  const port = Number(args[args.indexOf('--port') + 1]);
  Bun.serve({ port, hostname: '127.0.0.1', fetch(request) {
    return new URL(request.url).pathname === '/json/version'
      ? Response.json({ error: 'relay extension is not connected' }, { status: 503 })
      : Response.json([]);
  }});
}
`, { mode: 0o755 });
    await chmod(binary, 0o755);
    const relay = new BrowserRelaySupervisor({ environmentRoot: root, binaryPath: binary, port: 20_000 + Math.floor(Math.random() * 10_000) });

    expect(await relay.status()).toMatchObject({ state: 'stopped', installed: false });
    expect(await relay.setup()).toMatchObject({ state: 'waiting', installed: true });
    await expect(relay.test()).rejects.toThrow('enable the GitSpace Browser Relay extension');
    expect(await relay.stop()).toMatchObject({ state: 'stopped', installed: true });
  });

  it('reports the connected browser name and version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-relay-'));
    roots.push(root);
    await mkdir(join(root, '.browser-relay', 'extension'), { recursive: true });
    await writeFile(join(root, '.browser-relay', 'extension', 'manifest.json'), '{}');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ Browser: 'Chrome/140.0.7339.128' }),
    });
    try {
      const relay = new BrowserRelaySupervisor({ environmentRoot: root, port: server.port });
      expect(await relay.status()).toMatchObject({
        state: 'connected',
        browserName: 'Chrome',
        browserVersion: '140.0.7339.128',
      });
    } finally {
      server.stop(true);
    }
  });
});
