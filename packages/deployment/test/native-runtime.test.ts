import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeHostAbi } from '@gitspace/account-omp/manifest';
import { nativeFileDigest, prepareMachineNativeRuntime } from '../src/native-runtime.js';

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
});
