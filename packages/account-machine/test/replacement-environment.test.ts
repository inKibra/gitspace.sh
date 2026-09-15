import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentPlan, DeploymentJournal, hashArtifactPath } from '@gitspace/deployment';
import { ReplacementEnvironment, environmentLaunchResponseSchema, environmentStatusSchema } from '../src/index.js';
import { nativeHostAbi } from '@gitspace/account-omp/manifest';
import { nativeFileDigest } from '../../deployment/src/native-runtime.js';

const roots: string[] = [];
const environments: ReplacementEnvironment[] = [];
afterEach(async () => {
  for (const environment of environments.splice(0)) await environment.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function nativeFixture(path: string): Promise<void> {
  await mkdir(join(path, 'native'), { recursive: true });
  const binary = join(path, 'native/walgit');
  await writeFile(binary, '#!/bin/sh\necho walgit-test\n', { mode: 0o755 });
  await writeFile(join(path, 'machine-native.json'), JSON.stringify({
    version: 1, bunVersion: Bun.version, abi: nativeHostAbi(),
    walgit: { source: 'release', path: 'native/walgit', ...await nativeFileDigest(binary), provenance: null },
  }));
}

describe('replacement environment host routes', () => {
  it('swaps a frontend release through /__environment/launch and reports it in /__environment/status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'test-environment',
      root,
      repositoryRoot: root,
      rpcPort: 0,
      webPort: 0,
      machineId: 'machine-a',
      artifactKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      ompAgentDir: join(root, 'omp'),
      controlToken: 'control-token',
    });
    environments.push(environment);
    const candidate = join(root, 'candidates', 'frontend-rel-1');
    await mkdir(join(candidate, 'assets'), { recursive: true });
    await writeFile(join(candidate, 'index.html'), '<html>release 1</html>');
    await writeFile(join(candidate, 'assets', 'app.js'), 'console.log(1)');
    const hash = await hashArtifactPath(candidate);

    const unauthorized = await fetch(`${environment.hostUrl}/__environment/status`);
    expect(unauthorized.status).toBe(401);
    const before = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(before).toEqual({ machineHash: null, frontendHash: null, machineReleaseSha: null, ompReleaseSha: null, frontendReleaseSha: null, lastLaunch: null });

    const launched = await fetch(`${environment.hostUrl}/__environment/launch`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ entrypoint: 'frontend', target: 'frontend', applies: ['frontend'], path: candidate, hash, sha: 'rel-1' }),
    });
    expect(launched.status).toBe(200);
    expect(environmentLaunchResponseSchema.parse(await launched.json())).toEqual({ status: 'applied', hash, error: null });
    const after = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(after).toEqual({ machineHash: null, frontendHash: hash, machineReleaseSha: null, ompReleaseSha: null, frontendReleaseSha: 'rel-1', lastLaunch: { sha: 'rel-1', entrypoint: 'frontend', target: 'frontend', status: 'applied', error: null } });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>release 1</html>');

    // A tampered artifact fails verification at stage; the engine reports the failure instead of throwing.
    await writeFile(join(candidate, 'index.html'), '<html>tampered</html>');
    const tampered = await fetch(`${environment.hostUrl}/__environment/launch`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ entrypoint: 'frontend', target: 'frontend', applies: ['frontend'], path: candidate, hash: `sha256:${'f'.repeat(64)}`, sha: 'rel-2' }),
    });
    expect(tampered.status).toBe(409);
    const failure = environmentLaunchResponseSchema.parse(await tampered.json());
    expect(failure.status).toBe('failed');
    expect(failure.error).toContain('hash mismatch');
    const final = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(final.frontendHash).toBe(hash);
    expect(final.lastLaunch).toMatchObject({ sha: 'rel-2', entrypoint: 'frontend', target: 'frontend', status: 'failed' });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>release 1</html>');
  });

  it('keeps OMP identity independent of machine replacement and rejects OMP host launches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-machine-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'test-machine-environment',
      root,
      repositoryRoot: root,
      rpcPort: 0,
      webPort: 0,
      machineId: 'machine-a',
      artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'),
      controlToken: 'control-token',
    });
    environments.push(environment);
    const candidate = join(root, 'candidates', 'machine-rel-1');
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'machine.js'), `
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => Response.json(new URL(request.url).pathname === '/__control/retire' ? { stopMode: 'replace' } : { status: 'ok' }),
      });
      console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
    `);
    await nativeFixture(candidate);
    const hash = await hashArtifactPath(candidate);
    await environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: candidate, hash, dependsOn: [] }],
      releaseSha: 'machine-rel-1',
      revision: 'machine-rel-1',
      dirty: false,
    });
    expect(environment.status()).toMatchObject({ machineHash: hash, machineReleaseSha: 'machine-rel-1', ompReleaseSha: null });

    for (const request of [
      { target: 'omp', applies: ['machine'] },
      { target: 'machine', applies: ['machine', 'omp'] },
    ]) {
      const rejected = await fetch(`${environment.hostUrl}/__environment/launch`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'machine-daemon', ...request, path: candidate, hash, sha: 'omp-rel-2' }),
      });
      expect(rejected.status).toBe(409);
      expect(environmentLaunchResponseSchema.parse(await rejected.json()).status).toBe('failed');
      expect(environment.status()).toMatchObject({
        machineHash: hash,
        machineReleaseSha: 'machine-rel-1',
        ompReleaseSha: null,
        lastLaunch: { sha: 'omp-rel-2', target: request.target, status: 'failed' },
      });
    }
  });

  it('restores retained channel frontend bytes without changing another target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-channel-frontend-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'test-channel-frontend',
      root,
      repositoryRoot: root,
      rpcPort: 0,
      webPort: 0,
      machineId: 'machine-a',
      artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'),
      controlToken: 'control-token',
    });
    environments.push(environment);
    const channel = join(root, 'channel-candidate');
    await mkdir(channel);
    await writeFile(join(channel, 'index.html'), '<html>channel</html>');
    const channelHash = await hashArtifactPath(channel);
    await environment.deploy({
      artifacts: [{ entrypoint: 'frontend', path: channel, hash: channelHash, dependsOn: [] }],
      releaseSha: null,
      revision: 'channel',
      dirty: false,
    });
    await rm(channel, { recursive: true });
    const custom = join(root, 'custom-candidate');
    await mkdir(custom);
    await writeFile(join(custom, 'index.html'), '<html>custom</html>');
    const customHash = await hashArtifactPath(custom);
    await environment.deploy({
      artifacts: [{ entrypoint: 'frontend', path: custom, hash: customHash, dependsOn: [] }],
      releaseSha: 'custom-frontend',
      releaseTargets: ['frontend'],
      revision: 'custom-frontend',
      dirty: false,
    });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>custom</html>');
    const unauthorized = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST',
      body: JSON.stringify({ target: 'frontend' }),
    });
    expect(unauthorized.status).toBe(401);
    const headers = { authorization: 'Bearer control-token', 'content-type': 'application/json' };
    const unavailable = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST', headers, body: JSON.stringify({ target: 'machine' }),
    });
    expect(unavailable.status).toBe(409);
    expect(environmentLaunchResponseSchema.parse(await unavailable.json())).toMatchObject({ status: 'failed', hash: null });
    expect(environment.status()).toMatchObject({ frontendHash: customHash, frontendReleaseSha: 'custom-frontend' });

    const restored = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST', headers, body: JSON.stringify({ target: 'frontend' }),
    });
    expect(restored.status).toBe(200);
    expect(environmentLaunchResponseSchema.parse(await restored.json())).toEqual({ status: 'applied', hash: channelHash, error: null });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>channel</html>');
    expect(environment.status()).toMatchObject({
      frontendHash: channelHash,
      frontendReleaseSha: null,
      machineHash: null,
      ompReleaseSha: null,
      lastLaunch: { sha: null, target: 'frontend', status: 'applied' },
    });
    const rejectedOmp = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST', headers, body: JSON.stringify({ target: 'omp' }),
    });
    expect(rejectedOmp.status).toBe(400);
  });

  it('restarts identical machine bytes with channel identity and no inherited custom release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-channel-machine-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'test-channel-machine',
      root,
      repositoryRoot: root,
      rpcPort: 0,
      webPort: 0,
      machineId: 'machine-a',
      artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'),
      controlToken: 'control-token',
      environment: { GITSPACE_MACHINE_RELEASE_SHA: 'stale-custom', GITSPACE_RELEASE_SHA: 'legacy-custom' },
    });
    environments.push(environment);
    const candidate = join(root, 'machine-candidate');
    await mkdir(candidate);
    await writeFile(join(candidate, 'machine.js'), `
      await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/machine-boot.json', JSON.stringify({
        pid: process.pid,
        sha: process.env.GITSPACE_MACHINE_RELEASE_SHA ?? null,
        legacySha: process.env.GITSPACE_RELEASE_SHA ?? null,
      }));
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => Response.json(new URL(request.url).pathname === '/__control/retire' ? { stopMode: 'replace' } : { status: 'ok' }) });
      console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
    `);
    await nativeFixture(candidate);
    const hash = await hashArtifactPath(candidate);
    const artifact = { entrypoint: 'machine-daemon' as const, path: candidate, hash, dependsOn: [] };
    await environment.deploy({ artifacts: [artifact], releaseSha: null, revision: 'channel', dirty: false });
    const initial = JSON.parse(await readFile(join(root, 'machine-boot.json'), 'utf8'));
    expect(initial).toMatchObject({ sha: null, legacySha: null });

    await environment.deploy({ artifacts: [artifact], releaseSha: 'custom-machine', revision: 'custom-machine', dirty: false });
    const custom = JSON.parse(await readFile(join(root, 'machine-boot.json'), 'utf8'));
    expect(custom).toMatchObject({ sha: 'custom-machine', legacySha: null });
    expect(custom.pid).not.toBe(initial.pid);
    const restored = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'machine' }),
    });
    expect(restored.status).toBe(200);
    expect(environmentLaunchResponseSchema.parse(await restored.json())).toEqual({ status: 'applied', hash, error: null });
    const channel = JSON.parse(await readFile(join(root, 'machine-boot.json'), 'utf8'));
    expect(channel).toMatchObject({ sha: null, legacySha: null });
    expect(channel.pid).not.toBe(custom.pid);
    expect(environment.status()).toMatchObject({ machineHash: hash, machineReleaseSha: null, ompReleaseSha: null });
  });

  it('boots selected machine code after host restart and preserves an explicit channel rollback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-machine-restart-'));
    roots.push(root);
    const options = {
      id: 'restart-test', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    };
    for (const label of ['channel', 'selected']) {
      const path = join(root, label);
      await mkdir(path);
      await writeFile(join(path, 'machine.js'), `
        await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/executed-code', ${JSON.stringify(label)});
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => Response.json(new URL(request.url).pathname === '/__control/retire' ? { stopMode: 'replace' } : { status: 'ok' }) });
        console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
      `);
      await nativeFixture(path);
    }
    const channelPath = join(root, 'channel');
    const selectedPath = join(root, 'selected');
    let environment = new ReplacementEnvironment(options);
    environments.push(environment);
    await environment.bootMachine(channelPath);
    await environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: selectedPath, hash: await hashArtifactPath(selectedPath), dependsOn: [] }],
      releaseSha: 'account-selected', revision: 'account-selected', dirty: false,
    });
    expect(await readFile(join(root, 'executed-code'), 'utf8')).toBe('selected');
    await environment.close();
    environments.pop();

    environment = new ReplacementEnvironment(options);
    environments.push(environment);
    await environment.bootMachine(channelPath);
    expect(await readFile(join(root, 'executed-code'), 'utf8')).toBe('selected');
    expect(environment.status().machineReleaseSha).toBe('account-selected');
    const rollback = await fetch(`${environment.hostUrl}/__environment/channel`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'machine' }),
    });
    expect(rollback.status).toBe(200);
    expect(await readFile(join(root, 'executed-code'), 'utf8')).toBe('channel');
    await environment.close();
    environments.pop();

    environment = new ReplacementEnvironment(options);
    environments.push(environment);
    await environment.bootMachine(channelPath);
    expect(await readFile(join(root, 'executed-code'), 'utf8')).toBe('channel');
    expect(environment.status().machineReleaseSha).toBeNull();
  });

  it('rejects incompatible natives before drain and restores state when successor health fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-rollback-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'native-rollback', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    for (const [label, healthy] of [['previous', true], ['next', false], ['updated', true]] as const) {
      const path = join(root, label);
      await nativeFixture(path);
      await writeFile(join(path, 'machine.js'), `
        import { Database } from 'bun:sqlite';
        const root = process.env.GITSPACE_ENVIRONMENT_ROOT;
        const db = new Database(root + '/gitspace.db');
        db.run('CREATE TABLE IF NOT EXISTS native_rollback_test(value TEXT)');
        if (${healthy}) db.run(\"INSERT INTO native_rollback_test SELECT 'preserved' WHERE NOT EXISTS (SELECT 1 FROM native_rollback_test)\");
        else db.run(\"UPDATE native_rollback_test SET value = 'failed-successor'\");
        await Bun.write(root + '/observed-state', db.query('SELECT value FROM native_rollback_test').get().value);
        db.close();
        await Bun.write(root + '/observed-pid', String(process.pid));
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new URL(request.url).pathname === '/__control/retire'
          ? Response.json({ stopMode: 'replace' })
          : new Response('health', { status: ${healthy ? 200 : 500} }) });
        console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
      `);
    }
    const previous = join(root, 'previous');
    const next = join(root, 'next');
    const previousHash = await hashArtifactPath(previous);
    await environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: previous, hash: previousHash, dependsOn: [] }],
      releaseSha: 'previous', revision: 'previous', dirty: false,
    });
    const pid = await readFile(join(root, 'observed-pid'), 'utf8');
    const nativePath = join(next, 'machine-native.json');
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    await writeFile(nativePath, JSON.stringify({ ...native, abi: { ...native.abi, arch: process.arch === 'x64' ? 'arm64' : 'x64' } }));
    await expect(environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: next, hash: await hashArtifactPath(next), dependsOn: [] }],
      releaseSha: 'incompatible', revision: 'incompatible', dirty: false,
    })).rejects.toThrow('incompatible');
    expect(await readFile(join(root, 'observed-pid'), 'utf8')).toBe(pid);
    expect(environment.status().machineHash).toBe(previousHash);

    await writeFile(nativePath, JSON.stringify(native));
    await expect(environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: next, hash: await hashArtifactPath(next), dependsOn: [] }],
      releaseSha: 'unhealthy', revision: 'unhealthy', dirty: false,
    })).rejects.toThrow();
    expect(environment.status().machineHash).toBe(previousHash);
    expect(await readFile(join(root, 'observed-state'), 'utf8')).toBe('preserved');
    // Rollback must leave the stable host journal usable for the next replacement.
    const updated = join(root, 'updated');
    const updatedHash = await hashArtifactPath(updated);
    await environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: updated, hash: updatedHash, dependsOn: [] }],
      releaseSha: 'updated', revision: 'updated', dirty: false,
    });
    expect(environment.status()).toMatchObject({ machineHash: updatedHash, machineReleaseSha: 'updated' });
    expect(await readFile(join(root, 'observed-state'), 'utf8')).toBe('preserved');
  });

  it('includes committed WAL pages in a runtime database checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-wal-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'wal-checkpoint', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    const database = new Database(join(root, 'gitspace.db'));
    try {
      database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE possession(space TEXT, holder TEXT, generation INTEGER);');
      database.query('INSERT INTO possession VALUES (?, ?, ?)').run('space-a', 'machine-a', 3);
      const checkpoint = await environment.machineHost.checkpointDatabase();
      const snapshot = new Database(join(checkpoint, 'gitspace.db'), { readonly: true });
      try {
        expect(snapshot.query('SELECT * FROM possession').all()).toEqual([{ space: 'space-a', holder: 'machine-a', generation: 3 }]);
      } finally {
        snapshot.close();
        await environment.machineHost.releaseDatabaseCheckpoint(checkpoint);
      }
    } finally {
      database.close();
    }
  });

  it('preserves an interrupted deployment journal when separating it from runtime rollback state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-journal-'));
    roots.push(root);
    const path = join(root, 'frontend');
    await mkdir(path);
    await writeFile(join(path, 'index.html'), 'retained frontend');
    const plan = await createDeploymentPlan({
      source: { projectId: 'gitspace', revision: 'migration', dirty: false },
      target: { environmentId: 'journal-migration', kind: 'sandbox', expectedGeneration: 'none|none' },
      candidateArtifacts: [{ entrypoint: 'frontend', path, hash: await hashArtifactPath(path), dependsOn: [] }],
      currentHashes: {}, authority: { kind: 'sandbox', environmentId: 'journal-migration' },
    });
    if (plan.status === 'error') throw plan.error;
    const legacy = new DeploymentJournal(join(root, 'gitspace.db'));
    const begun = legacy.begin(plan.value);
    if (begun.status === 'error') throw begun.error;
    legacy.recordStep(plan.value.id, 'frontend', 0, 'committed');
    const interrupted = legacy.transition(plan.value.id, 'finalizing');
    const steps = legacy.steps(plan.value.id);
    legacy.close();
    const environment = new ReplacementEnvironment({
      id: 'journal-migration', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    const migrated = new DeploymentJournal(join(root, 'deployment.db'));
    try {
      expect(migrated.load(plan.value.id)).toEqual(interrupted);
      expect(migrated.steps(plan.value.id)).toEqual(steps);
      const checkpoint = await environment.machineHost.checkpointDatabase();
      await environment.machineHost.restoreDatabase(checkpoint);
      await environment.machineHost.releaseDatabaseCheckpoint(checkpoint);
      migrated.transition(plan.value.id, 'committed');
      expect(migrated.load(plan.value.id)?.state).toBe('committed');
    } finally {
      migrated.close();
    }
  });

  it('keeps the predecessor reachable when retirement does not acknowledge retained ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-retire-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'retire-refusal', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    const previous = join(root, 'previous');
    await nativeFixture(previous);
    await writeFile(join(previous, 'machine.js'), `
      await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/pid', String(process.pid));
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new URL(request.url).pathname === '/__control/retire'
        ? Response.json({ error: 'Checkpoint preparation is active' }, { status: 409 })
        : Response.json({ status: 'ok' }) });
      console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
    `);
    const hash = await hashArtifactPath(previous);
    const artifact = { entrypoint: 'machine-daemon' as const, path: previous, hash, dependsOn: [] };
    await environment.deploy({ artifacts: [artifact], releaseSha: 'previous', revision: 'previous', dirty: false });
    const pid = await readFile(join(root, 'pid'), 'utf8');
    await expect(environment.deploy({ artifacts: [artifact], releaseSha: 'next', revision: 'next', dirty: false })).rejects.toThrow('retirement failed');
    expect(environment.status()).toMatchObject({ machineHash: hash, machineReleaseSha: 'previous' });
    expect(await readFile(join(root, 'pid'), 'utf8')).toBe(pid);
    // This notification crosses the stable RPC proxy, proving admissions were restored.
    await environment.publishCodeVersion(hash);
  });

  it('keeps a predecessor alive and fenced when graceful shutdown times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-shutdown-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'shutdown-timeout', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    const previous = join(root, 'previous');
    await nativeFixture(previous);
    await writeFile(join(previous, 'machine.js'), `
      process.on('SIGTERM', () => {});
      await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/pid', String(process.pid));
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => Response.json(
        new URL(request.url).pathname === '/__control/retire' ? { stopMode: 'replace' } : { status: 'ok' }) });
      console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
    `);
    const hash = await hashArtifactPath(previous);
    const artifact = { entrypoint: 'machine-daemon' as const, path: previous, hash, dependsOn: [] };
    await environment.deploy({ artifacts: [artifact], releaseSha: 'previous', revision: 'previous', dirty: false });
    const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
    const originalSetTimeout = globalThis.setTimeout;
    const deadline = spyOn(globalThis, 'setTimeout').mockImplementation(
      (handler, delay, ...args) => originalSetTimeout(handler, delay === 120_000 ? 30 : delay, ...args),
    );
    try {
      await expect(environment.deploy({ artifacts: [artifact], releaseSha: 'next', revision: 'next', dirty: false })).rejects.toThrow();
      expect(process.kill(pid, 0)).toBe(true);
      expect(Number(await readFile(join(root, 'pid'), 'utf8'))).toBe(pid);
      expect(environment.status()).toMatchObject({ machineHash: hash, machineReleaseSha: 'previous' });
      await expect(environment.publishCodeVersion(hash)).rejects.toThrow();
    } finally {
      deadline.mockRestore();
      process.kill(pid, 'SIGKILL');
    }
  });

  it('reaps a live candidate that closes stdout before readiness before rolling back its database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-native-readiness-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'readiness-failure', root, repositoryRoot: root, rpcPort: 0, webPort: 0,
      machineId: 'machine-a', artifactKey: new Uint8Array(32).fill(1),
      ompAgentDir: join(root, 'omp'), controlToken: 'control-token',
    });
    environments.push(environment);
    const previous = join(root, 'previous');
    await nativeFixture(previous);
    await writeFile(join(previous, 'machine.js'), `
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => Response.json(new URL(request.url).pathname === '/__control/retire' ? { stopMode: 'replace' } : { status: 'ok' }) });
      console.log('GitSpace RPC ready at http://127.0.0.1:' + server.port + '/rpc');
    `);
    const hash = await hashArtifactPath(previous);
    await environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: previous, hash, dependsOn: [] }],
      releaseSha: 'previous', revision: 'previous', dirty: false,
    });
    const candidate = join(root, 'candidate');
    await nativeFixture(candidate);
    await writeFile(join(candidate, 'machine.js'), `
      import { closeSync } from 'node:fs';
      await Bun.write(process.env.GITSPACE_ENVIRONMENT_ROOT + '/failed-pid', String(process.pid));
      closeSync(1);
      Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('not ready') });
    `);
    await expect(environment.deploy({
      artifacts: [{ entrypoint: 'machine-daemon', path: candidate, hash: await hashArtifactPath(candidate), dependsOn: [] }],
      releaseSha: 'candidate', revision: 'candidate', dirty: false,
    })).rejects.toThrow('readiness failed');
    const pid = Number(await readFile(join(root, 'failed-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(environment.status()).toMatchObject({ machineHash: hash, machineReleaseSha: 'previous' });
    await environment.publishCodeVersion(hash);
  });
});
