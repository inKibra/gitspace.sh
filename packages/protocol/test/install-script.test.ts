import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installScript } from '../src/install-script.js';

// Answers --version for the installer's check and records any other invocation.
const client = '#!/bin/sh\n[ "$1" = --version ] && exit 0\nprintf \'%s\\n\' "$@" > "$GITSPACE_TEST_RECORD"\n';
const clientSha = createHash('sha256').update(client).digest('hex');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

/** Pipes the installer served for `/distribution/v1` of a local origin to `sh -s -- …args`, as `curl … | sh` does. */
async function install(args: string[], channelSha = clientSha) {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (/^\/distribution\/v1\/stable\/[a-z0-9-]+\.txt$/u.test(path)) return new Response(`gitspace-distribution-v1\nr1\n${channelSha}\n`);
      if (/^\/distribution\/v1\/releases\/r1\/[a-z0-9-]+\/gitspace$/u.test(path)) return new Response(client);
      return new Response('Not found', { status: 404 });
    },
  });
  const home = await mkdtemp(join(tmpdir(), 'gitspace-install-script-'));
  cleanup.push(async () => { server.stop(true); await rm(home, { recursive: true, force: true }); });
  const record = join(home, 'record');
  const child = Bun.spawn(['sh', '-s', '--', ...args], {
    stdin: new Blob([installScript(`http://127.0.0.1:${server.port}/distribution/v1`)]),
    env: { PATH: process.env.PATH ?? '', HOME: home, GITSPACE_TEST_RECORD: record },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr, requested, installed: join(home, '.local/bin/gitspace'), setup: existsSync(record) ? await readFile(record, 'utf8') : null };
}

it('installs the verified client from its distribution base, then pairs with the given token and label', async () => {
  const result = await install(['--pair', 'gsp_token', '--label', 'Desk']);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.requested).toEqual([expect.stringMatching(/^\/distribution\/v1\/stable\//u), expect.stringMatching(/^\/distribution\/v1\/releases\/r1\//u)]);
  expect(await readFile(result.installed, 'utf8')).toBe(client);
  expect(result.setup).toBe('machine\nsetup\n--pair\ngsp_token\n--label\nDesk\n');
});

it('installs without pairing when no token is given', async () => {
  const result = await install([]);
  expect(result.exitCode).toBe(0);
  expect(existsSync(result.installed)).toBe(true);
  expect(result.setup).toBeNull();
});

it('neither installs nor pairs a client that fails the channel SHA-256', async () => {
  const result = await install(['--pair', 'gsp_token'], 'b'.repeat(64));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('failed SHA256 verification');
  expect(existsSync(result.installed)).toBe(false);
  expect(result.setup).toBeNull();
});

it('refuses a label without a pairing token before downloading anything', async () => {
  const result = await install(['--label', 'Desk']);
  expect(result.exitCode).not.toBe(0);
  expect(result.requested).toEqual([]);
});
