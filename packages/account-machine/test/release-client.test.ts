import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReleaseRecord } from '@gitspace/protocol';
import { MACHINE_NATIVE_NAMES, NATIVE_UPSTREAMS, PORTABLE_ENTRYPOINTS, portableFileKey } from '@gitspace/protocol/machine-release';
import { followReleaseClient } from '../src/release-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A portable release whose client prints its arguments, and the account's verified blob store holding it. Only the
 *  client's bytes are stored: the other entrypoints are listed so that the manifest is whole. */
function portableRelease(sha: string) {
  const portableKey = `releases/${sha}/portable.manifest.json`;
  const objects: Record<string, Uint8Array> = {};
  const client = new TextEncoder().encode('console.log(["release client", ...process.argv.slice(2)].join(" "));\n');
  objects[portableFileKey(portableKey, 'cli/gitspace.js')] = client;
  const pins = (abi: { os: 'linux'; glibc: null } | { os: 'darwin'; macos: string }) => Object.fromEntries(MACHINE_NATIVE_NAMES.map(name => [name, {
    version: name === 'bun' ? Bun.version : '1.0.0', url: `${NATIVE_UPSTREAMS[name]}v1.0.0/${name}.zip`, sha256: 'a'.repeat(64), size: 1, member: name, executable: { sha256: 'b'.repeat(64), size: 1 }, abi,
  }]));
  const linux = pins({ os: 'linux', glibc: null });
  const darwin = pins({ os: 'darwin', macos: '13.0' });
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, bunVersion: Bun.version,
    files: PORTABLE_ENTRYPOINTS.map(path => path === 'cli/gitspace.js' ? { path, sha256: hex(client), size: client.byteLength } : { path, sha256: 'c'.repeat(64), size: 1 }),
    natives: { 'darwin-arm64': darwin, 'darwin-x64': darwin, 'linux-arm64': linux, 'linux-x64': linux },
  }));
  objects[portableKey] = manifest;
  const record: ReleaseRecord = {
    sha, label: sha, source: null, builtBy: 'machine-a', createdAt: new Date().toISOString(),
    artifacts: { worker: null, machine: null, frontend: null, portable: { key: portableKey, hash: `sha256:${hex(manifest)}`, size: manifest.byteLength } },
    worker: null, status: { worker: 'skipped', frontend: 'skipped', machines: {} }, error: null,
  };
  const blobs = {
    get: async (key: string, hash: string) => {
      const bytes = objects[key] ?? null;
      if (bytes && `sha256:${hex(bytes)}` !== hash) throw new Error(`${key} does not match ${hash}`);
      return bytes;
    },
  };
  return { record, blobs };
}

function computer() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-release-client-'));
  roots.push(root);
  return { root, environment: { GITSPACE_INSTALL_DIR: join(root, 'bin'), GITSPACE_DATA_DIR: join(root, 'share') } };
}

describe('release client', () => {
  it('points an installed gitspace command at the release\'s client, and installs none where there is no command', async () => {
    const { record, blobs } = portableRelease('c'.repeat(40));
    const installed = computer();
    mkdirSync(installed.environment.GITSPACE_INSTALL_DIR);
    // The command an earlier install left: a client that no longer matches the account.
    writeFileSync(join(installed.environment.GITSPACE_INSTALL_DIR, 'gitspace'), '#!/bin/sh\necho old client\n', { mode: 0o755 });
    expect(await followReleaseClient(record, blobs, installed.environment)).toBe(true);
    expect((await Bun.$`${join(installed.environment.GITSPACE_INSTALL_DIR, 'gitspace')} machine start`.text()).trim()).toBe('release client machine start');

    const bare = computer();
    expect(await followReleaseClient(record, blobs, bare.environment)).toBe(false);
    expect(existsSync(bare.environment.GITSPACE_INSTALL_DIR)).toBe(false);
    expect(existsSync(bare.environment.GITSPACE_DATA_DIR)).toBe(false);
  });
});
