import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { NATIVE_UPSTREAMS, mirrorNatives, nativeMirrorKey, type MachineNativeFile, type MachineNativeName, type PortableNatives } from '@gitspace/protocol/machine-release';
import { releasesNativeMirror } from '../src/native-mirror.js';

const hex = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** A release's twelve natives, each distinct, and the bytes upstream serves at each URL. */
async function release() {
  const served = new Map<string, Uint8Array<ArrayBuffer>>();
  const native = async (platform: string, name: MachineNativeName, abi: MachineNativeFile['abi']): Promise<MachineNativeFile> => {
    const bytes = new TextEncoder().encode(`${name} for ${platform} ${crypto.randomUUID()}`);
    const url = `${NATIVE_UPSTREAMS[name]}v1/${platform}-${name}.zip`;
    served.set(url, bytes);
    return { version: name === 'bun' ? '1.4.0' : '1.0.0', url, sha256: await hex(bytes), size: bytes.byteLength, member: name, executable: { sha256: await hex(bytes), size: bytes.byteLength }, abi };
  };
  const tools = async (platform: string, abi: MachineNativeFile['abi']) => ({ bun: await native(platform, 'bun', abi), rg: await native(platform, 'rg', abi), 'git-lfs': await native(platform, 'git-lfs', abi) });
  const darwin = { os: 'darwin', macos: '13.0' } as const;
  const linux = { os: 'linux', glibc: '2.17' } as const;
  const natives: PortableNatives = {
    'darwin-arm64': await tools('darwin-arm64', darwin), 'darwin-x64': await tools('darwin-x64', darwin),
    'linux-arm64': await tools('linux-arm64', linux), 'linux-x64': await tools('linux-x64', linux),
  };
  const downloads: string[] = [];
  const download = async (url: string) => {
    downloads.push(url);
    const bytes = served.get(url);
    return bytes ? new Response(bytes) : new Response('Not found', { status: 404 });
  };
  return { natives, served, downloads, download };
}

it('stores each named native under its SHA-256 and copies none the mirror already holds', async () => {
  const { natives, served, downloads, download } = await release();
  const mirror = releasesNativeMirror(env.RELEASES);
  const copied = await mirrorNatives(natives, mirror, download);
  expect(copied).toHaveLength(12);
  for (const files of Object.values(natives)) for (const file of Object.values(files)) {
    const stored = await env.RELEASES.get(nativeMirrorKey(file.sha256));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(served.get(file.url));
  }
  expect(await mirrorNatives(natives, mirror, download)).toEqual([]);
  expect(downloads).toHaveLength(12);
});

it('refuses a download whose bytes differ from the named SHA-256 and stores nothing', async () => {
  const { natives, served, download } = await release();
  const target = natives['linux-x64'].rg;
  served.set(target.url, new TextEncoder().encode('x'.repeat(target.size)));
  await expect(mirrorNatives(natives, releasesNativeMirror(env.RELEASES), download)).rejects.toThrow();
  expect(await env.RELEASES.head(nativeMirrorKey(target.sha256))).toBeNull();
});
