import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeHostAbi } from '../src/executable-manifest.js';
import {
  GIT_LFS_DECLARATION, GIT_LFS_PATH, machineToolEnvironment, nativeFileDigest, prepareMachineNativeRuntime,
} from '../src/native-runtime.js';
import { distributionManifestSchema } from '../src/distribution.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-native-selection-'));
  roots.push(root);
  await mkdir(join(root, 'native'));
  const runtime = {
    version: 2, bunVersion: Bun.version, abi: nativeHostAbi(),
  };
  await writeFile(join(root, 'machine-native.json'), JSON.stringify(runtime));
  return { root, runtime };
}

async function gitLfsFixture(root: string) {
  await mkdir(join(root, 'native/bin'));
  const binary = join(root, GIT_LFS_PATH);
  const marker = join(root, 'git-lfs-executed');
  await writeFile(binary, `#!/bin/sh\nprintf lfs > '${marker}'\necho 'git-lfs/3.8.0 (bundled fixture)'\n`, { mode: 0o755 });
  await writeFile(join(root, GIT_LFS_DECLARATION), JSON.stringify({
    version: 1, path: GIT_LFS_PATH, ...await nativeFileDigest(binary),
    upstream: {
      version: '3.8.0', url: 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz',
      sha256: 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d', size: 5_909_255,
    },
  }));
  return { binary, marker };
}

async function ripgrepFixture(root: string) {
  await mkdir(join(root, 'native/bin'), { recursive: true });
  const binary = join(root, 'native/bin/rg');
  const marker = join(root, 'rg-executed');
  await writeFile(binary, `#!/bin/sh\nprintf rg > '${marker}'\necho 'ripgrep 14.1.1'\n`, { mode: 0o755 });
  await writeFile(join(root, 'native/ripgrep.json'), JSON.stringify({
    version: 1, path: 'native/bin/rg', ...await nativeFileDigest(binary),
    upstream: { version: '14.1.1', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz', sha256: 'a'.repeat(64), size: 1 },
  }));
  return { binary, marker };
}

it('rejects a distribution missing bundled ripgrep', () => {
  const digest = { sha256: 'a'.repeat(64), size: 1 };
  const files = ['host.js', 'rpc-probe.js', 'bin/bun', 'machine/machine.js', 'machine/machine-worker.js', 'machine/host-runtime.js', 'machine/machine-update.js', 'machine/machine-bootstrap.js', 'machine/machine-native.json', 'machine/native/git-lfs.json', 'machine/native/bin/git-lfs', 'machine.manifest.json'];
  expect(distributionManifestSchema.safeParse({
    schemaVersion: 1, release: 'fixture', platform: 'linux-x64', bunVersion: Bun.version, minimumGlibc: '2.17',
    client: digest, provenance: digest, runtime: { ...digest, files: files.map(path => ({ path, ...digest, mode: path.includes('/bin/') || path === 'bin/bun' ? 0o755 : 0o644 })) },
  }).success).toBe(false);
});

it('publishes prepared ripgrep instead of inherited stale selection', async () => {
  const { root } = await fixture();
  const { binary } = await ripgrepFixture(root);
  const prepared = await prepareMachineNativeRuntime(root);
  expect(machineToolEnvironment({ PATH: '', GITSPACE_RIPGREP_PATH: '/malicious/rg' }, prepared)).toMatchObject({ GITSPACE_RIPGREP_PATH: binary });
});

it('rejects tampered ripgrep bytes before execution', async () => {
  const { root } = await fixture();
  const { binary, marker } = await ripgrepFixture(root);
  await writeFile(binary, `#!/bin/sh\nprintf tampered > '${marker}'\necho 'ripgrep 14.1.1'\n`);
  await expect(prepareMachineNativeRuntime(root)).rejects.toThrow('integrity mismatch');
  expect(await Bun.file(marker).exists()).toBe(false);
});

describe('native generation selection', () => {
  it('rejects a newer native ABI before invoking the selected tool', async () => {
    const { root, runtime } = await fixture();
    const { marker } = await gitLfsFixture(root);
    runtime.abi.minimumVersion = '999.0';
    await writeFile(join(root, 'machine-native.json'), JSON.stringify(runtime));
    await expect(prepareMachineNativeRuntime(root)).rejects.toThrow('incompatible');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('runs git with the selected generation\'s verified Git LFS first on PATH', async () => {
    const { root } = await fixture();
    const { binary } = await gitLfsFixture(root);
    const decoyDirectory = join(root, 'global-bin');
    const decoyMarker = join(root, 'global-git-lfs-executed');
    await mkdir(decoyDirectory);
    await writeFile(join(decoyDirectory, 'git-lfs'), `#!/bin/sh\nprintf global > '${decoyMarker}'\necho 'git-lfs/global'\n`, { mode: 0o755 });
    const inherited = { ...process.env, PATH: `${decoyDirectory}:${process.env.PATH ?? ''}` };
    const native = await prepareMachineNativeRuntime(root);
    expect(native.gitLfs).toBe(binary);
    const child = Bun.spawn(['git', 'lfs', 'version'], {
      env: { ...inherited, ...machineToolEnvironment(inherited, native) }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toBe('git-lfs/3.8.0 (bundled fixture)\n');
    expect(await Bun.file(decoyMarker).exists()).toBe(false);
  });

  it('rejects tampered Git LFS bytes without executing them', async () => {
    const { root } = await fixture();
    const { binary, marker } = await gitLfsFixture(root);
    await writeFile(binary, `#!/bin/sh\nprintf tampered > '${marker}'\necho 'git-lfs/3.8.0 (tampered)'\n`);
    await expect(prepareMachineNativeRuntime(root)).rejects.toThrow('integrity mismatch');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('keeps generations that predate bundled Git LFS selectable, without a PATH entry', async () => {
    const { root } = await fixture();
    expect((await prepareMachineNativeRuntime(root)).gitLfs).toBeNull();
  });

  it('replaces a predecessor generation\'s tool directory instead of accumulating it', () => {
    const predecessor = { PATH: '/gen-a/native/bin:/usr/local/bin:/usr/bin', GITSPACE_MACHINE_TOOL_PATH: '/gen-a/native/bin' };
    const successor = machineToolEnvironment(predecessor, { gitLfs: '/gen-b/native/bin/git-lfs', ripgrep: '/gen-b/native/bin/rg' });
    expect(successor).toEqual({ PATH: '/gen-b/native/bin:/usr/local/bin:/usr/bin', GITSPACE_MACHINE_TOOL_PATH: '/gen-b/native/bin', GITSPACE_RIPGREP_PATH: '/gen-b/native/bin/rg' });
    expect(machineToolEnvironment(successor, { gitLfs: '/gen-b/native/bin/git-lfs', ripgrep: '/gen-b/native/bin/rg' })).toEqual(successor);
    // Rollback removes both the stale tool directory and the explicit ripgrep selection.
    expect(machineToolEnvironment(successor, { gitLfs: null, ripgrep: null })).toEqual({ PATH: '/usr/local/bin:/usr/bin', GITSPACE_MACHINE_TOOL_PATH: '', GITSPACE_RIPGREP_PATH: '' });
  });
});
