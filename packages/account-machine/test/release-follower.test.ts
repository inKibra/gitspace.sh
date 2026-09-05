import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashArtifactPath } from '@gitspace/deployment';
import { createExecutableArtifactManifest, executableManifestPath, sha256 } from '@gitspace/account-omp/manifest';
import type { DeploymentStatus, ReleaseRecord } from '@gitspace/protocol';
import { EXECUTABLE_CHUNK_BYTES } from '@gitspace/protocol/deployment';
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

function release(sha: string, machine: { key: string; hash: `sha256:${string}`; size: number } | null, frontend: { key: string; hash: `sha256:${string}`; size: number } | null, omp: { key: string; hash: `sha256:${string}`; size: number } | null = null): ReleaseRecord {
  return {
    sha,
    label: `release ${sha}`,
    workspaceId: 'workspace-a',
    builtBy: 'machine-a',
    createdAt: new Date().toISOString(),
    artifacts: { worker: null, machine, omp, frontend },
    worker: null,
    omp: omp ? { upstreamVersion: '18.1.10', bunVersion: Bun.version, packages: { '@oh-my-pi/pi-coding-agent': '18.1.10' }, patches: [] } : null,
    status: { worker: 'skipped', frontend: frontend ? 'applied' : 'skipped', machines: {}, omps: {} },
    error: null,
  };
}

interface FakeHost {
  url: string;
  token: string;
  launches: EnvironmentLaunchRequest[];
  channels: Array<'machine' | 'frontend'>;
  status: EnvironmentStatus;
  answer: 'applied' | 'failed';
}

function fakeHost(answer: 'applied' | 'failed'): FakeHost {
  const host: FakeHost = {
    url: '',
    token: 'control-token',
    launches: [],
    channels: [],
    status: { machineHash: null, frontendHash: null, machineReleaseSha: null, ompReleaseSha: null, frontendReleaseSha: null, lastLaunch: null },
    answer,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${host.token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.pathname === '/__environment/status') return Response.json(host.status);
      if (url.pathname === '/__environment/channel' && request.method === 'POST') {
        const { target } = await request.json() as { target: 'machine' | 'frontend' };
        host.channels.push(target);
        const hash = target === 'machine' ? hashOf(new TextEncoder().encode('initial-machine')) : null;
        host.status = {
          ...host.status,
          machineHash: target === 'machine' ? hash : host.status.machineHash,
          machineReleaseSha: target === 'machine' ? null : host.status.machineReleaseSha,
          frontendHash: target === 'frontend' ? null : host.status.frontendHash,
          frontendReleaseSha: target === 'frontend' ? null : host.status.frontendReleaseSha,
        };
        return Response.json({ status: 'applied', hash, error: null });
      }
      if (url.pathname === '/__environment/launch' && request.method === 'POST') {
        const input = await request.json() as EnvironmentLaunchRequest;
        host.launches.push(input);
        const actual = await hashArtifactPath(input.path);
        if (actual !== input.hash) return Response.json({ status: 'failed', hash: input.hash, error: `hash mismatch ${actual}` }, { status: 409 });
        if (host.answer === 'failed') return Response.json({ status: 'failed', hash: input.hash, error: 'health probe failed' }, { status: 409 });
        host.status = {
          ...host.status,
          machineHash: input.target === 'machine' ? input.hash : host.status.machineHash,
          frontendHash: input.target === 'frontend' ? input.hash : host.status.frontendHash,
          machineReleaseSha: input.target === 'machine' ? input.sha : host.status.machineReleaseSha,
          ompReleaseSha: input.target === 'omp' ? input.sha : host.status.ompReleaseSha,
          frontendReleaseSha: input.target === 'frontend' ? input.sha : host.status.frontendReleaseSha,
          lastLaunch: { sha: input.sha, entrypoint: input.entrypoint, target: input.target, status: 'applied', error: null },
        };
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
  const reports: Array<{ sha: string; target: 'machine' | 'omp'; generation: string; status: 'applied' | 'failed'; error?: string }> = [];
  const channelReports: Array<{ target: 'machine' | 'omp'; generation: string }> = [];
  return {
    reports,
    channelReports,
    reportMachineChannelApplied: async (input: { target: 'machine' | 'omp'; generation: string }) => { channelReports.push(input); },
    deploymentStatus: async () => status,
    reportMachineApplied: async (input: { sha: string; target: 'machine' | 'omp'; generation: string; status: 'applied' | 'failed'; error?: string }) => {
      reports.push(input);
      const record = status.releases.find((candidate) => candidate.sha === input.sha)!;
      (input.target === 'omp' ? record.status.omps : record.status.machines)['machine-a'] = input.status;
      return record;
    },
  };
}

async function executable(sha: string, target: 'machine' | 'omp', files: Record<string, string | Uint8Array>) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-executable-fixture-'));
  roots.push(root);
  const path = join(root, 'payload');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), content);
  }
  const { manifest, manifestHash } = await createExecutableArtifactManifest(path, target, target === 'omp'
    ? { upstreamVersion: '18.1.10', bunVersion: Bun.version, packages: {}, patches: [] }
    : null);
  const key = releaseObjectKeys(sha)[target];
  const bytes = new Uint8Array(await readFile(executableManifestPath(path)));
  const objects: Record<string, Uint8Array> = { [key]: bytes };
  for (const file of manifest.files) {
    const content = new Uint8Array(await readFile(join(path, file.path)));
    let offset = 0;
    for (const chunk of file.chunks) {
      objects[chunk.key] = content.slice(offset, offset + chunk.size);
      offset += chunk.size;
    }
  }
  return { manifest, objects, artifact: { key, hash: manifestHash, size: bytes.byteLength } };
}

describe('release follower', () => {
  it('downloads the machine bundle and migrations, verifies them, and asks the host to swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-'));
    roots.push(root);
    const sha = 'abc123';
    const { artifact, manifest, objects } = await executable(sha, 'machine', {
      'machine.js': 'console.log("machine v2")',
      'machine.js.map': '{"sources":[]}',
      'drizzle/meta/_journal.json': '{"entries":[]}',
      'drizzle/0000_init.sql': 'CREATE TABLE t (id TEXT);',
      'pi_natives.node': 'native-sidecar',
    });
    const fetched: string[] = [];
    const status: DeploymentStatus = {
      desired: { worker: null, machine: sha, omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, artifact, null)],
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
      runningMachineSha: null,
      generation: 'sha256:' + 'a'.repeat(64),
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    follower.stop();

    expect(fetched).toEqual([artifact.key, ...manifest.files.flatMap((file) => file.chunks.map((chunk) => chunk.key))]);
    expect(host.launches).toHaveLength(1);
    const launch = host.launches[0]!;
    expect(launch.entrypoint).toBe('machine-daemon');
    expect(launch.sha).toBe(sha);
    expect(launch.path).toBe(join(root, 'candidates', `machine-${artifact.hash.slice(7)}`));
    expect(await readFile(join(launch.path, 'machine.js'), 'utf8')).toBe('console.log("machine v2")');
    expect(await readFile(join(launch.path, 'drizzle', '0000_init.sql'), 'utf8')).toBe('CREATE TABLE t (id TEXT);');
    expect(launch.hash).toBe(await hashArtifactPath(launch.path));
    expect(launch.applies).toEqual(['machine']);
    expect(await readFile(join(launch.path, 'pi_natives.node'), 'utf8')).toBe('native-sidecar');
    // The candidate must not report success before the stable host commits its generation.
    expect(authority.reports).toEqual([]);

    // A successor started from the release reports applied and does nothing else while desired matches.
    host.status.machineHash = null;
    const successor = new ReleaseFollower({
      authority,
      blobs: { get: async () => { throw new Error('no downloads expected'); } },
      machineId: 'machine-a',
      environmentRoot: root,
      hostUrl: host.url,
      controlToken: host.token,
      runningMachineSha: sha,
      generation: manifest.treeHash,
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await successor.start();
    expect(authority.reports).toEqual([]);
    host.status.machineHash = manifest.treeHash;
    await successor.nudge();
    successor.stop();
    expect(authority.reports).toEqual([{ sha, target: 'machine', generation: manifest.treeHash, status: 'applied' }]);
    expect(host.launches).toHaveLength(1);
  });

  it('activates OMP without a host and reports applied only after the old children drain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-omp-follower-'));
    roots.push(root);
    const sha = 'omp789';
    const { artifact, manifest, objects } = await executable(sha, 'omp', { 'omp.js': 'console.log("omp")' });
    const status: DeploymentStatus = {
      desired: { worker: null, machine: 'machine456', omp: sha, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: { 'machine-a': { sha: 'machine456', ompSha: null, generation: 'old' } } },
      releases: [release(sha, null, null, artifact)],
    };
    const authority = fakeAuthority(status);
    let running = { sha: null as string | null, hash: 'old-omp', draining: 0 };
    const activations: Array<{ path: string; hash: string; sha: string; manifestHash: string }> = [];
    const follower = new ReleaseFollower({
      authority,
      blobs: { get: async (key) => objects[key] ?? null },
      machineId: 'machine-a', environmentRoot: root, hostUrl: null, controlToken: null,
      runningMachineSha: 'machine456', generation: null,
      omp: {
        activateChannel: async () => { throw new Error('No channel activation expected'); },
        status: () => running,
        activate: async (input) => {
          activations.push(input);
          running = { sha: input.sha, hash: input.hash, draining: 1 };
          return running;
        },
      },
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    expect(activations).toEqual([{
      path: join(root, 'candidates', `omp-${artifact.hash.slice(7)}`),
      hash: manifest.treeHash, sha, manifestHash: artifact.hash,
    }]);
    expect(authority.reports).toEqual([]);
    await follower.nudge();
    expect(authority.reports).toEqual([]);
    expect(activations).toHaveLength(1);
    running = { ...running, draining: 0 };
    await follower.nudge();
    await follower.nudge();
    follower.stop();
    expect(authority.reports).toEqual([{ sha, target: 'omp', generation: manifest.treeHash, status: 'applied' }]);
    expect(status.current.machines['machine-a']?.sha).toBe('machine456');
  });

  it('restores channel targets independently and reports OMP only after custom children drain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-channel-follower-'));
    roots.push(root);
    const status: DeploymentStatus = {
      desired: { worker: null, machine: null, omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [],
    };
    const authority = fakeAuthority(status);
    const host = fakeHost('applied');
    host.status.machineReleaseSha = 'custom-machine';
    host.status.frontendReleaseSha = 'custom-frontend';
    let running = { sha: 'custom-omp' as string | null, hash: 'custom-omp-tree', draining: 1 };
    const follower = new ReleaseFollower({
      authority, blobs: { get: async () => { throw new Error('Channel does not download account releases'); } },
      machineId: 'machine-a', environmentRoot: root, hostUrl: host.url, controlToken: host.token,
      runningMachineSha: 'custom-machine', generation: null,
      omp: {
        status: () => running,
        activate: async () => { throw new Error('No custom activation expected'); },
        activateChannel: async () => {
          running = { sha: null, hash: 'channel-omp-tree', draining: 1 };
          return running;
        },
      },
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    expect(host.channels).toEqual(['frontend', 'machine']);
    expect(host.status.frontendHash).toBeNull();
    expect(authority.channelReports).toEqual([]);
    await follower.nudge();
    expect(host.channels).toEqual(['frontend', 'machine']);
    expect(authority.channelReports).toEqual([]);
    running = { ...running, draining: 0 };
    await follower.nudge();
    follower.stop();
    expect(authority.channelReports).toEqual([{ target: 'omp', generation: 'channel-omp-tree' }]);
    const successor = new ReleaseFollower({
      authority, blobs: { get: async () => null }, machineId: 'machine-a', environmentRoot: root,
      hostUrl: host.url, controlToken: host.token, runningMachineSha: null, generation: host.status.machineHash,
      onError: (error) => { throw error; },
    });
    await successor.start();
    successor.stop();
    expect(authority.channelReports).toEqual([
      { target: 'omp', generation: 'channel-omp-tree' },
      { target: 'machine', generation: host.status.machineHash! },
    ]);
  });

  it('reassembles a native library crossing the object chunk boundary without truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-chunk-follower-'));
    roots.push(root);
    const native = new Uint8Array(EXECUTABLE_CHUNK_BYTES + 7).fill(0x61);
    native.set(new TextEncoder().encode('lastEnd'), EXECUTABLE_CHUNK_BYTES);
    const { artifact, manifest, objects } = await executable('chunked', 'machine', { 'machine.js': 'console.log(1)', 'native.node': native });
    const authority = fakeAuthority({
      desired: { worker: null, machine: 'chunked', omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release('chunked', artifact, null)],
    });
    const host = fakeHost('applied');
    const follower = new ReleaseFollower({
      authority, blobs: { get: async (key) => objects[key] ?? null }, machineId: 'machine-a', environmentRoot: root,
      hostUrl: host.url, controlToken: host.token, runningMachineSha: null, generation: null,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    follower.stop();
    expect(manifest.files.find((file) => file.path === 'native.node')!.chunks.map((chunk) => chunk.size)).toEqual([EXECUTABLE_CHUNK_BYTES, 7]);
    const restored = await readFile(join(host.launches[0]!.path, 'native.node'));
    expect(restored.byteLength).toBe(native.byteLength);
    expect(sha256(restored)).toBe(sha256(native));
  });

  it('rejects unauthenticated migration bytes even if blob storage ignores the expected hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-corrupt-'));
    roots.push(root);
    const sha = 'corrupt';
    const { artifact, manifest, objects } = await executable(sha, 'machine', {
      'machine.js': 'console.log("safe")', 'drizzle/0000_init.sql': 'CREATE TABLE t(id TEXT);',
    });
    const migration = manifest.files.find((file) => file.path.endsWith('.sql'))!;
    objects[migration.chunks[0]!.key] = new TextEncoder().encode('DROP TABLE t;');
    const status: DeploymentStatus = {
      desired: { worker: null, machine: sha, omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, artifact, null)],
    };
    const authority = fakeAuthority(status);
    const host = fakeHost('applied');
    const errors: unknown[] = [];
    const follower = new ReleaseFollower({
      authority, blobs: { get: async (key) => objects[key] ?? null },
      machineId: 'machine-a', environmentRoot: root, hostUrl: host.url, controlToken: host.token,
      runningMachineSha: null, generation: 'old', onError: (error) => { errors.push(error); },
    });
    await follower.nudge();
    follower.stop();
    expect(host.launches).toEqual([]);
    expect(authority.reports[0]).toMatchObject({ target: 'machine', status: 'failed' });
    expect(String(errors[0])).toContain('integrity mismatch');
  });

  it('rejects incompatible authenticated envelopes before downloading runtime files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-incompatible-'));
    roots.push(root);
    const sha = 'incompatible';
    const built = await executable(sha, 'omp', { 'omp.js': 'console.log("omp")' });
    built.manifest.compatibility.bunVersion = '0.0.0';
    built.manifest.omp!.bunVersion = '0.0.0';
    const bytes = new TextEncoder().encode(JSON.stringify(built.manifest));
    built.objects[built.artifact.key] = bytes;
    const artifact = { ...built.artifact, hash: sha256(bytes), size: bytes.byteLength };
    const status: DeploymentStatus = {
      desired: { worker: null, machine: null, omp: sha, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, null, null, artifact)],
    };
    const fetched: string[] = [];
    const authority = fakeAuthority(status);
    const follower = new ReleaseFollower({
      authority,
      blobs: { get: async (key) => { fetched.push(key); return built.objects[key] ?? null; } },
      machineId: 'machine-a', environmentRoot: root, hostUrl: null, controlToken: null,
      runningMachineSha: null, generation: null,
      omp: {
        status: () => ({ sha: null, hash: 'old', draining: 0 }),
        activateChannel: async () => { throw new Error('No channel activation expected'); },
        activate: async () => { throw new Error('must not activate'); },
      },
    });
    await follower.nudge();
    follower.stop();
    expect(fetched).toEqual([artifact.key]);
    expect(authority.reports[0]).toMatchObject({ target: 'omp', status: 'failed', error: expect.stringContaining('incompatible') });
  });

  it('reports a rolled-back swap as failed once and stops retrying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-follower-'));
    roots.push(root);
    const sha = 'def456';
    const { artifact, objects } = await executable(sha, 'machine', { 'machine.js': 'throw new Error("boom")' });
    const status: DeploymentStatus = {
      desired: { worker: null, machine: sha, omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: null, version: null }, machines: {} },
      releases: [release(sha, artifact, null)],
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
      runningMachineSha: null,
      generation: 'sha256:' + 'a'.repeat(64),
      intervalMs: 60_000,
      onError: (error) => { throw error; },
    });
    await follower.nudge();
    await follower.nudge();
    follower.stop();
    expect(host.launches).toHaveLength(1);
    expect(authority.reports).toEqual([{ sha, target: 'machine', generation: 'sha256:' + 'a'.repeat(64), status: 'failed', error: 'health probe failed' }]);
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
      desired: { worker: null, machine: null, omp: null, frontend: sha, updatedAt: new Date().toISOString() },
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
      runningMachineSha: null,
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
