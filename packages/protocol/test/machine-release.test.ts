import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { PORTABLE_ENTRYPOINTS, mirrorNatives, portableManifestSchema, verifiedNative, verifyPortableFiles, type MachineNativeFile, type NativeMirror, type PortableManifest } from '../src/machine-release.js';

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
function native(name: 'bun' | 'rg' | 'git-lfs', abi: MachineNativeFile['abi']): MachineNativeFile {
  const upstream = { bun: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/', rg: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/', 'git-lfs': 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/' }[name];
  return { version: name === 'bun' ? '1.4.0' : '1.0.0', url: `${upstream}${name}.zip`, sha256: digest('a'), size: 10, member: `${name}/${name}`, executable: { sha256: digest('b'), size: 20 }, abi };
}
const linux = { os: 'linux', glibc: '2.17' } as const;
const darwin = { os: 'darwin', macos: '13.0' } as const;
function manifest(): PortableManifest {
  return {
    schemaVersion: 1, bunVersion: '1.4.0',
    files: PORTABLE_ENTRYPOINTS.map((path, index) => ({ path, sha256: digest(String(index)), size: index + 1 })),
    natives: {
      'darwin-arm64': { bun: native('bun', darwin), rg: native('rg', darwin), 'git-lfs': native('git-lfs', darwin) },
      'darwin-x64': { bun: native('bun', darwin), rg: native('rg', darwin), 'git-lfs': native('git-lfs', darwin) },
      'linux-arm64': { bun: native('bun', linux), rg: native('rg', linux), 'git-lfs': native('git-lfs', linux) },
      'linux-x64': { bun: native('bun', linux), rg: { ...native('rg', linux), abi: { os: 'linux', glibc: null } }, 'git-lfs': native('git-lfs', linux) },
    },
  };
}

it('accepts a manifest naming every entrypoint and each platform\'s three natives', () => {
  expect(portableManifestSchema.safeParse(manifest()).success).toBe(true);
});

it('refuses natives whose ABI is for another platform', () => {
  const value = manifest();
  value.natives['linux-x64'].bun = native('bun', darwin);
  expect(portableManifestSchema.safeParse(value).success).toBe(false);
});

it('refuses a manifest missing a platform', () => {
  const { 'darwin-x64': _omitted, ...natives } = manifest().natives;
  expect(portableManifestSchema.safeParse({ ...manifest(), natives }).success).toBe(false);
});

it('refuses a native that is not its upstream project\'s release asset', () => {
  const value = manifest();
  value.natives['darwin-arm64'].rg = { ...native('rg', darwin), url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/rg.zip' };
  expect(portableManifestSchema.safeParse(value).success).toBe(false);
});

it('refuses a Bun native other than the release\'s Bun', () => {
  const value = manifest();
  value.natives['linux-arm64'].bun = { ...native('bun', linux), version: '1.3.9' };
  expect(portableManifestSchema.safeParse(value).success).toBe(false);
});

it('refuses a manifest without the CLI', () => {
  const value = manifest();
  expect(portableManifestSchema.safeParse({ ...value, files: value.files.filter(file => file.path !== 'cli/gitspace.js') }).success).toBe(false);
});

/** Verifies `value` against stored copies of its files, `change` applied to machine/machine.js (null: absent). */
function verifyStored(value: PortableManifest, change: (file: { sha256: string; size: number }) => { sha256: string; size: number } | null) {
  return verifyPortableFiles(value, async path => {
    const file = value.files.find(entry => entry.path === path)!;
    return path === 'machine/machine.js' ? change({ sha256: file.sha256, size: file.size }) : { sha256: file.sha256, size: file.size };
  });
}

it('refuses a stored file whose hash differs from its manifest', async () => {
  await expect(verifyStored(manifest(), file => ({ ...file, sha256: digest('f') }))).rejects.toThrow('machine/machine.js');
});

it('refuses a stored file whose size differs from its manifest', async () => {
  await expect(verifyStored(manifest(), file => ({ ...file, size: file.size + 1 }))).rejects.toThrow('machine/machine.js');
});

it('refuses a manifest naming a file that is not stored', async () => {
  await expect(verifyStored(manifest(), () => null)).rejects.toThrow('machine/machine.js');
});

/** Natives with distinct served bytes, and a mirror that, like the publishing bucket, reads a whole body before storing it. */
function mirrored() {
  const { natives } = manifest();
  const served = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [platform, files] of Object.entries(natives)) for (const file of Object.values(files)) {
    file.url = file.url.replace(/\.zip$/u, `-${platform}.zip`);
    const bytes = new TextEncoder().encode(`${file.url} ${crypto.randomUUID()}`);
    served.set(file.url, bytes);
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.size = bytes.byteLength;
  }
  const stored = new Map<string, Uint8Array>();
  const mirror: NativeMirror = {
    async has(sha256) { return stored.has(sha256); },
    async put(native, body) { stored.set(native.sha256, await new Response(verifiedNative(native, body)).bytes()); },
  };
  return { natives, served, stored, mirror, download: async (url: string) => new Response(served.get(url)) };
}

it('refuses a download whose bytes differ from the named SHA-256, keeping nothing', async () => {
  const { natives, served, stored, mirror, download } = mirrored();
  const target = natives['linux-arm64']['git-lfs'];
  served.set(target.url, new Uint8Array(target.size));
  await expect(mirrorNatives(natives, mirror, download)).rejects.toThrow(target.url);
  expect(stored.has(target.sha256)).toBe(false);
});

it('refuses a download shorter than the named size, keeping nothing', async () => {
  const { natives, served, stored, mirror, download } = mirrored();
  const target = natives['darwin-x64'].rg;
  served.set(target.url, served.get(target.url)!.subarray(1));
  await expect(mirrorNatives(natives, mirror, download)).rejects.toThrow(target.url);
  expect(stored.has(target.sha256)).toBe(false);
});
