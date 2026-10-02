import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeHostAbi } from '@gitspace/account-omp/manifest';
import {
  GIT_LFS_DECLARATION, GIT_LFS_PATH, machineToolEnvironment, nativeFileDigest, prepareMachineNativeRuntime,
} from '../src/native-runtime.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-native-selection-'));
  roots.push(root);
  await mkdir(join(root, 'native'));
  const binary = join(root, 'native/walgit');
  const marker = join(root, 'executed');
  await writeFile(binary, `#!/bin/sh\nprintf release > '${marker}'\necho walgit-release\n`, { mode: 0o755 });
  const runtime = {
    version: 1, bunVersion: Bun.version, abi: nativeHostAbi(),
    walgit: { source: 'release', path: 'native/walgit', ...await nativeFileDigest(binary), provenance: null },
  };
  await writeFile(join(root, 'machine-native.json'), JSON.stringify(runtime));
  return { root, binary, marker, runtime };
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

describe('native generation selection', () => {
  it('rejects tampered payload bytes without executing them', async () => {
    const { root, binary, marker } = await fixture();
    await writeFile(binary, '#!/bin/sh\necho walgit-tampered\n');
    await expect(prepareMachineNativeRuntime(root)).rejects.toThrow('integrity mismatch');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('rejects a newer native ABI before invoking the selected tool', async () => {
    const { root, marker, runtime } = await fixture();
    runtime.abi.minimumVersion = '999.0';
    await writeFile(join(root, 'machine-native.json'), JSON.stringify(runtime));
    await expect(prepareMachineNativeRuntime(root)).rejects.toThrow('incompatible');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('executes only the declared release or environment tool despite inherited global selection', async () => {
    const { root, marker, runtime } = await fixture();
    const environmentBinary = join(root, 'environment-walgit');
    const decoy = join(root, 'global-walgit');
    await writeFile(environmentBinary, `#!/bin/sh\nprintf environment > '${marker}'\necho walgit-environment\n`, { mode: 0o755 });
    await writeFile(decoy, `#!/bin/sh\nprintf global > '${marker}'\necho walgit-global\n`, { mode: 0o755 });
    for (const source of ['release', 'environment']) {
      if (source === 'environment') {
        await writeFile(join(root, 'machine-native.json'), JSON.stringify({
          ...runtime, walgit: { source, path: environmentBinary, ...await nativeFileDigest(environmentBinary) },
        }));
      }
      const child = Bun.spawn([process.execPath, '--eval', `
        import { prepareMachineNativeRuntime } from ${JSON.stringify(join(import.meta.dir, '../src/native-runtime.ts'))};
        await prepareMachineNativeRuntime(${JSON.stringify(root)});
      `], { env: { ...process.env, GITSPACE_WALGIT_BINARY: decoy }, stdout: 'pipe', stderr: 'pipe' });
      const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`Native selection child failed: ${error}`);
      expect(await readFile(marker, 'utf8')).toBe(source);
    }
  });

  it('runs git with the selected generation\'s verified Git LFS first on PATH', async () => {
    const { root } = await fixture();
    const { binary } = await gitLfsFixture(root);
    const native = await prepareMachineNativeRuntime(root);
    expect(native.gitLfs).toBe(binary);
    const child = Bun.spawn(['git', 'lfs', 'version'], {
      env: { ...process.env, ...machineToolEnvironment(process.env, native) }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toBe('git-lfs/3.8.0 (bundled fixture)\n');
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
    const successor = machineToolEnvironment(predecessor, { gitLfs: '/gen-b/native/bin/git-lfs' });
    expect(successor).toEqual({ PATH: '/gen-b/native/bin:/usr/local/bin:/usr/bin', GITSPACE_MACHINE_TOOL_PATH: '/gen-b/native/bin' });
    expect(machineToolEnvironment(successor, { gitLfs: '/gen-b/native/bin/git-lfs' })).toEqual(successor);
    // Rolling back to a generation without Git LFS drops the stale successor directory.
    expect(machineToolEnvironment(successor, { gitLfs: null })).toEqual({ PATH: '/usr/local/bin:/usr/bin', GITSPACE_MACHINE_TOOL_PATH: '' });
  });
});
