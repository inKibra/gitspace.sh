import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_METADATA_MARKER, installScript } from '../src/install-script.js';

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Stands in for Bun: answers the launcher's --version check and records how the client was run otherwise.
const bun = encoder.encode('#!/bin/sh\nclient=$1; shift\n[ "$1" = --version ] && exit 0\nprintf \'%s\\n\' "$client" "$@" > "$GITSPACE_TEST_RECORD"\n');
const client = encoder.encode('console.log("client");\n');
const member = 'bun-test/bun';

/** A zip holding `member` stored (uncompressed), as `unzip -p` reads Bun's release archives. */
function zip(name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const path = encoder.encode(name);
  const crc = Bun.hash.crc32(content);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 10, true); local.setUint32(14, crc, true);
  local.setUint32(18, content.byteLength, true); local.setUint32(22, content.byteLength, true); local.setUint16(26, path.byteLength, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 0x031e, true); central.setUint16(6, 10, true); central.setUint32(16, crc, true);
  central.setUint32(20, content.byteLength, true); central.setUint32(24, content.byteLength, true); central.setUint16(28, path.byteLength, true);
  central.setUint32(38, 0o100755 << 16, true);
  const centralOffset = 30 + path.byteLength + content.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
  end.setUint32(12, 46 + path.byteLength, true); end.setUint32(16, centralOffset, true);
  return new Uint8Array(Buffer.concat([new Uint8Array(local.buffer), path, content, new Uint8Array(central.buffer), path, new Uint8Array(end.buffer)]));
}
const archive = zip(member, bun);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

/** Pipes the installer served for `/distribution/v1` of a local origin to `sh -s -- …args`, as `curl … | sh` does.
 * `served` replaces what the account answers for one path. */
async function install(args: string[], served: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  const requested: string[] = [];
  const metadata = `${INSTALL_METADATA_MARKER}\nr1\n${'c'.repeat(64)}\nbun ${sha256(archive)} ${archive.byteLength} ${sha256(bun)} ${bun.byteLength} ${member}\ncli ${sha256(client)} ${client.byteLength}\n`;
  const files: Record<string, Uint8Array<ArrayBuffer>> = { [`/distribution/v1/natives/${sha256(archive)}`]: archive, '/distribution/v1/releases/r1/cli/gitspace.js': client, ...served };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (/^\/distribution\/v1\/install\/[a-z0-9-]+\.txt$/u.test(path)) return new Response(metadata);
      const file = files[path];
      return file ? new Response(file) : new Response('Not found', { status: 404 });
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
  return {
    exitCode, stderr, requested, launcher: join(home, '.local/bin/gitspace'),
    bun: join(home, `.local/share/gitspace/bun/${sha256(bun)}/bun`), client: join(home, '.local/share/gitspace/releases/r1/gitspace.js'),
    setup: existsSync(record) ? await readFile(record, 'utf8') : null,
  };
}

it('installs the account release\'s client on its pinned Bun, then pairs with the given token and label', async () => {
  const result = await install(['--pair', 'gsp_token', '--label', 'Desk']);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.requested).toEqual([expect.stringMatching(/^\/distribution\/v1\/install\//u), expect.stringMatching(/^\/distribution\/v1\/natives\//u), '/distribution/v1/releases/r1/cli/gitspace.js']);
  expect(new Uint8Array(await readFile(result.bun))).toEqual(bun);
  expect(new Uint8Array(await readFile(result.client))).toEqual(client);
  expect(await readFile(result.launcher, 'utf8')).toBe(`#!/bin/sh\nexec '${result.bun}' '${result.client}' "$@"\n`);
  expect(result.setup).toBe(`${result.client}\nmachine\nsetup\n--pair\ngsp_token\n--label\nDesk\n`);
});

it('installs without pairing when no token is given', async () => {
  const result = await install([]);
  expect(result.exitCode).toBe(0);
  expect(existsSync(result.launcher)).toBe(true);
  expect(result.setup).toBeNull();
});

it('installs nothing and pairs nothing when Bun or the client is not what the account pinned', async () => {
  const tampered = await install(['--pair', 'gsp_token'], { [`/distribution/v1/natives/${sha256(archive)}`]: zip(member, encoder.encode('#!/bin/sh\nexit 0\n')) });
  expect(tampered.exitCode).not.toBe(0);
  expect(tampered.stderr).toContain('The Bun archive failed SHA256 verification');
  expect(existsSync(tampered.launcher)).toBe(false);
  expect(tampered.setup).toBeNull();
  const client = await install(['--pair', 'gsp_token'], { '/distribution/v1/releases/r1/cli/gitspace.js': encoder.encode('console.log("other");\n') });
  expect(client.exitCode).not.toBe(0);
  expect(client.stderr).toContain('The client failed SHA256 verification');
  expect(existsSync(client.launcher)).toBe(false);
});

it('refuses a label without a pairing token before downloading anything', async () => {
  const result = await install(['--label', 'Desk']);
  expect(result.exitCode).not.toBe(0);
  expect(result.requested).toEqual([]);
});
