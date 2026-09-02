import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashArtifactPath } from '@gitspace/deployment';
import type { DeploymentStatus, ReleaseRecord } from '@gitspace/protocol';
import { ReleaseFollower, releaseObjectKeys, type EnvironmentLaunchRequest, type EnvironmentStatus } from '../src/index.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.stop(true);
});

function hashOf(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

function release(sha: string, machine: { key: string; hash: `sha256:${string}`; size: number } | null, frontend: { key: string; hash: `sha256:${string}`; size: number } | null): ReleaseRecord {
  return {
    sha,
    label: `release ${sha}`,
    workspaceId: 'workspace-a',
    builtBy: 'machine-a',
    createdAt: new Date().toISOString(),
    artifacts: { worker: null, machine, frontend },
    worker: null,
    status: { worker: 'skipped', frontend: frontend ? 'applied' : 'skipped', machines: {} },
    error: null,
  };
}

interface FakeHost {
  url: string;
  token: string;
  launches: EnvironmentLaunchRequest[];
  status: EnvironmentStatus;
  answer: 'applied' | 'failed';
}

function fakeHost(answer: 'applied' | 'failed'): FakeHost {
  const host: FakeHost = {
    url: '',
    token: 'control-token',
    launches: [],
    status: { machineHash: null, frontendHash: null, releaseSha: null, lastLaunch: null },
    answer,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${host.token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.pathname === '/__environment/status') return Response.json(host.status);
      if (url.pathname === '/__environment/launch' && request.method === 'POST') {
        const input = await request.json() as EnvironmentLaunchRequest;
        host.launches.push(input);
        const actual = await hashArtifactPath(input.path);
        if (actual !== input.hash) return Response.json({ status: 'failed', hash: input.hash, error: `hash mismatch ${actual}` }, { status: 409 });
        if (host.answer === 'failed') return Response.json({ status: 'failed', hash: input.hash, error: 'health probe failed' }, { status: 409 });
        host.status = { ...host.status, releaseSha: input.sha, lastLaunch: { sha: input.sha, entrypoint: input.entrypoint, status: 'applied', error: null } };
        return Response.json({ status: 'applied', hash: input.hash, error: null });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  host.url = `http://127.0.0.1:${server.port}`;
  return host;
}

function fakeAuthority(status: DeploymentStatus) {
  const reports: Array<{ sha: string; generation: string; status: 'applied' | 'failed'; error?: string }> = [];
  return {
    reports,
    deploymentStatus: async () => status,
    reportMachineApplied: async (input: { sha: string; generation: string; status: 'applied' | 'failed'; error?: string }) => {
      reports.push(input);
      const record = status.releases.find((candidate) => candidate.sha === input.sha)!;
      record.status.machines['machine-a'] = input.status;
      return record;
    },
  };
}

describe('release follower', () => {
  it('downloads the machine bundle and migrations, verifies them, and asks the host to swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-'));
    roots.push(root);
    const sha = 'abc123';
    const keys = releaseObjectKeys(sha);
    const bundle = new TextEncoder().encode('console.log("machine v2")');
    const migrations = new TextEncoder().encode(JSON.stringify({ files: [
      { path: 'meta/_journal.json', content: '{"entries":[]}' },
      { path: '0000_init.sql', content: 'CREATE TABLE t (id TEXT);' },
    ] }));
    const objects: Record<string, Uint8Array> = { [keys.machine]: bundle, [keys.machineMigrations]: migrations };
    const fetched: string[] = [];
    const status: DeploymentStatus = {
      desired: { sha, targets: ['machine'], updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, { key: keys.machine, hash: hashOf(bundle), size: bundle.byteLength }, null)],
    };
    const authority = fakeAuthority(status);
    const host = fakeHost('applied');
    const follower = new ReleaseFollower({
      authority,
      blobs: {
        get: async (key, expectedHash) => {
          fetched.push(key);
          const bytes = objects[key] ?? null;
          if (bytes && expectedHash && hashOf(bytes) !== expectedHash) throw new Error('integrity');
          return bytes;
        },
      },
      machineId: 'machine-a',
      environmentRoot: root,
      hostUrl: host.url,
      controlToken: host.token,
      runningSha: null,
      generation: 'sha256:' + 'a'.repeat(64),
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    follower.stop();

    expect(fetched).toEqual([keys.machine, keys.machineMigrations]);
    expect(host.launches).toHaveLength(1);
    const launch = host.launches[0]!;
    expect(launch.entrypoint).toBe('machine-daemon');
    expect(launch.sha).toBe(sha);
    expect(launch.path).toBe(join(root, 'candidates', `machine-${sha}`));
    expect(await readFile(join(launch.path, 'machine.js'), 'utf8')).toBe('console.log("machine v2")');
    expect(await readFile(join(launch.path, 'drizzle', '0000_init.sql'), 'utf8')).toBe('CREATE TABLE t (id TEXT);');
    expect(launch.hash).toBe(await hashArtifactPath(launch.path));
    // The old generation never reports success; the successor does, on start.
    expect(authority.reports).toEqual([]);

    // A successor started from the release reports applied and does nothing else while desired matches.
    const successor = new ReleaseFollower({
      authority,
      blobs: { get: async () => { throw new Error('no downloads expected'); } },
      machineId: 'machine-a',
      environmentRoot: root,
      hostUrl: host.url,
      controlToken: host.token,
      runningSha: sha,
      generation: 'sha256:' + 'b'.repeat(64),
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await successor.start();
    successor.stop();
    expect(authority.reports).toEqual([{ sha, generation: 'sha256:' + 'b'.repeat(64), status: 'applied' }]);
    expect(host.launches).toHaveLength(1);
  });

  it('reports a rolled-back swap as failed once and stops retrying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-'));
    roots.push(root);
    const sha = 'def456';
    const keys = releaseObjectKeys(sha);
    const bundle = new TextEncoder().encode('throw new Error("boom")');
    const migrations = new TextEncoder().encode(JSON.stringify({ files: [] }));
    const objects: Record<string, Uint8Array> = { [keys.machine]: bundle, [keys.machineMigrations]: migrations };
    const status: DeploymentStatus = {
      desired: { sha, targets: ['machine'], updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, { key: keys.machine, hash: hashOf(bundle), size: bundle.byteLength }, null)],
    };
    const authority = fakeAuthority(status);
    const host = fakeHost('failed');
    const follower = new ReleaseFollower({
      authority,
      blobs: { get: async (key) => objects[key] ?? null },
      machineId: 'machine-a',
      environmentRoot: root,
      hostUrl: host.url,
      controlToken: host.token,
      runningSha: null,
      generation: 'sha256:' + 'a'.repeat(64),
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    await follower.nudge();
    follower.stop();
    expect(host.launches).toHaveLength(1);
    expect(authority.reports).toEqual([{ sha, generation: 'sha256:' + 'a'.repeat(64), status: 'failed', error: 'health probe failed' }]);
    expect(status.releases[0]!.status.machines['machine-a']).toBe('failed');
  });

  it('materializes the frontend tree from its manifest and launches it by tree hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-'));
    roots.push(root);
    const sha = 'fe0001';
    const keys = releaseObjectKeys(sha);
    const files: Record<string, Uint8Array> = {
      'index.html': new TextEncoder().encode('<html>v2</html>'),
      'assets/app.js': new TextEncoder().encode('console.log(2)'),
    };
    const objects: Record<string, Uint8Array> = {};
    const manifest = { files: [] as Array<{ path: string; hash: string; size: number }> };
    for (const [path, bytes] of Object.entries(files)) {
      objects[`${keys.frontend}/${path}`] = bytes;
      manifest.files.push({ path, hash: hashOf(bytes), size: bytes.byteLength });
    }
    objects[keys.frontendManifest] = new TextEncoder().encode(JSON.stringify(manifest));
    // Expected tree hash: build the same tree once to learn it.
    const expectedRoot = mkdtempSync(join(tmpdir(), 'gitspace-frontend-expected-'));
    roots.push(expectedRoot);
    for (const [path, bytes] of Object.entries(files)) await Bun.write(join(expectedRoot, path), bytes);
    const treeHash = await hashArtifactPath(expectedRoot);
    const status: DeploymentStatus = {
      desired: { sha, targets: ['frontend'], updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, null, { key: keys.frontend, hash: treeHash, size: 0 })],
    };
    const authority = fakeAuthority(status);
    const host = fakeHost('applied');
    const follower = new ReleaseFollower({
      authority,
      blobs: { get: async (key) => objects[key] ?? null },
      machineId: 'machine-a',
      environmentRoot: root,
      hostUrl: host.url,
      controlToken: host.token,
      runningSha: null,
      generation: null,
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    expect(host.launches).toHaveLength(1);
    expect(host.launches[0]).toMatchObject({ entrypoint: 'frontend', sha, hash: treeHash, path: join(root, 'candidates', `frontend-${sha}`) });
    // Once the host serves that tree, nothing is re-launched.
    host.status = { ...host.status, frontendHash: treeHash };
    await follower.nudge();
    follower.stop();
    expect(host.launches).toHaveLength(1);
    expect(authority.reports).toEqual([]);
  });
});
