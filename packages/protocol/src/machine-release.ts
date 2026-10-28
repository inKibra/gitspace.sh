import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { machineNativePlatformSchema } from './deployment.js';

/**
 * The portable machine release a launch builds once for every platform: the machine and CLI JavaScript, and per
 * platform the upstream native files (Bun, `rg`, `git-lfs`) a computer runs it with. Natives are named by their upstream
 * release asset and SHA-256; the platform mirrors each asset under `nativeMirrorKey(sha256)` the first time a build
 * names it, and installs read the mirror. The manifest sits at `<dir>/portable.manifest.json` and names files at
 * `<dir>/portable/<path>` (`portableFileKey`).
 */

export const PORTABLE_MANIFEST_FILE = 'portable.manifest.json';
/** Entrypoints every portable release carries: the CLI, and the machine host, its workers and its updater. */
export const PORTABLE_ENTRYPOINTS = [
  'cli/gitspace.js',
  'machine/machine.js',
  'machine/machine-worker.js',
  'machine/host-runtime.js',
  'machine/machine-update.js',
  'machine/machine-bootstrap.js',
] as const;
const NATIVE_ASSET_MAX_BYTES = 256 * 1024 * 1024;
const PORTABLE_FILE_MAX_BYTES = 256 * 1024 * 1024;

export const MACHINE_NATIVE_NAMES = ['bun', 'rg', 'git-lfs'] as const;
export type MachineNativeName = typeof MACHINE_NATIVE_NAMES[number];
/** Upstream release download URL prefixes; the mirror copies nothing else. */
export const NATIVE_UPSTREAMS: Record<MachineNativeName, string> = {
  bun: 'https://github.com/oven-sh/bun/releases/download/',
  rg: 'https://github.com/BurntSushi/ripgrep/releases/download/',
  'git-lfs': 'https://github.com/git-lfs/git-lfs/releases/download/',
};
const PLATFORM_OS: Record<z.infer<typeof machineNativePlatformSchema>, 'darwin' | 'linux'> = {
  'darwin-arm64': 'darwin', 'darwin-x64': 'darwin', 'linux-arm64': 'linux', 'linux-x64': 'linux',
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const versionSchema = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u);
const pathSchema = z.string().min(1).max(1_024).refine(value =>
  !/[\\\x00-\x1f\x7f:]/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
'Expected a relative file path');

/** One upstream release asset and the executable inside it. */
export const machineNativeFileSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  /** The asset as upstream publishes it; the mirror stores exactly these bytes. */
  url: z.string().max(2_048).regex(/^https:\/\/github\.com\/[^?#\s]+$/u),
  sha256: sha256Schema,
  size: z.number().int().positive().max(NATIVE_ASSET_MAX_BYTES),
  /** Path of the executable inside the asset (a zip or gzip tar archive). */
  member: pathSchema,
  executable: z.object({ sha256: sha256Schema, size: z.number().int().positive().max(NATIVE_ASSET_MAX_BYTES) }).strict(),
  /** The oldest system the executable runs on: a glibc version on Linux (null when statically linked), a macOS version on macOS. */
  abi: z.discriminatedUnion('os', [
    z.object({ os: z.literal('linux'), glibc: versionSchema.nullable() }).strict(),
    z.object({ os: z.literal('darwin'), macos: versionSchema }).strict(),
  ]),
}).strict();
export type MachineNativeFile = z.infer<typeof machineNativeFileSchema>;

/** Every platform's natives, each named once. */
export const portableNativesSchema = z.record(machineNativePlatformSchema, z.object({
  bun: machineNativeFileSchema, rg: machineNativeFileSchema, 'git-lfs': machineNativeFileSchema,
}).strict()).superRefine((natives, context) => {
  for (const platform of machineNativePlatformSchema.options) {
    for (const name of MACHINE_NATIVE_NAMES) {
      const file = natives[platform][name];
      if (file.abi.os !== PLATFORM_OS[platform]) context.addIssue({ code: 'custom', path: [platform, name], message: `${name} for ${platform} declares a ${file.abi.os} ABI` });
      if (!file.url.startsWith(NATIVE_UPSTREAMS[name])) context.addIssue({ code: 'custom', path: [platform, name], message: `${name} for ${platform} is not an upstream ${name} release asset` });
    }
  }
});
export type PortableNatives = z.infer<typeof portableNativesSchema>;

export const portableFileSchema = z.object({ path: pathSchema, sha256: sha256Schema, size: z.number().int().nonnegative().max(PORTABLE_FILE_MAX_BYTES) }).strict();
export type PortableFile = z.infer<typeof portableFileSchema>;

export const portableManifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** The Bun every platform runs the JavaScript on, and that built it. */
  bunVersion: versionSchema,
  files: z.array(portableFileSchema).min(1).max(10_000),
  natives: portableNativesSchema,
}).strict().superRefine((manifest, context) => {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (paths.has(file.path)) context.addIssue({ code: 'custom', message: `Duplicate portable file ${file.path}` });
    paths.add(file.path);
  }
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) context.addIssue({ code: 'custom', message: `Portable file is also a directory: ${path}` });
    }
  }
  for (const entrypoint of PORTABLE_ENTRYPOINTS) if (!paths.has(entrypoint)) context.addIssue({ code: 'custom', message: `Portable release is missing ${entrypoint}` });
  for (const platform of machineNativePlatformSchema.options) {
    const bun = manifest.natives[platform].bun;
    if (bun.version !== manifest.bunVersion) context.addIssue({ code: 'custom', message: `Bun for ${platform} is ${bun.version}, not ${manifest.bunVersion}` });
  }
});
export type PortableManifest = z.infer<typeof portableManifestSchema>;

/** A portable release's files sit beside its manifest: `<dir>/portable.manifest.json` names `<dir>/portable/<path>`. */
export function portableFileKey(manifestKey: string, path: string): string {
  if (!manifestKey.endsWith(`/${PORTABLE_MANIFEST_FILE}`)) throw new Error(`Portable manifest key must end in /${PORTABLE_MANIFEST_FILE}`);
  return `${manifestKey.slice(0, -PORTABLE_MANIFEST_FILE.length)}portable/${pathSchema.parse(path)}`;
}

/** Checks every file the manifest names against what `stored` reports for it (null: absent). */
export async function verifyPortableFiles(manifest: PortableManifest, stored: (path: string) => Promise<{ sha256: string; size: number } | null>): Promise<void> {
  for (const file of manifest.files) {
    const actual = await stored(file.path);
    if (!actual) throw new Error(`Portable release file is missing: ${file.path}`);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new Error(`Portable release file does not match its manifest: ${file.path}`);
  }
}

export const NATIVE_MIRROR_PREFIX = 'natives/sha256/';
export function nativeMirrorKey(digest: string): string {
  return `${NATIVE_MIRROR_PREFIX}${sha256Schema.parse(digest)}`;
}

/** Where natives are mirrored, by SHA-256. */
export interface NativeMirror {
  has(sha256: string): Promise<boolean>;
  /** Stores `body`, exactly `native.size` bytes, at `nativeMirrorKey(native.sha256)`. `body` fails before its last bytes
   * when they differ from `native`; a store whose body failed holds nothing. */
  put(native: MachineNativeFile, body: ReadableStream<Uint8Array>): Promise<void>;
}

/** Passes bytes through while hashing them, holding back the newest chunk: the last bytes are released only once the
 * whole stream matched `native`'s SHA-256 and size. */
function verifyingNative(native: MachineNativeFile): TransformStream<Uint8Array, Uint8Array> {
  const hash = sha256.create();
  let size = 0;
  let pending: Uint8Array | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > native.size) throw new Error(`${native.url} is larger than its pinned ${native.size} bytes`);
      hash.update(chunk);
      if (pending) controller.enqueue(pending);
      pending = chunk;
    },
    flush(controller) {
      if (size !== native.size || bytesToHex(hash.digest()) !== native.sha256) throw new Error(`${native.url} does not match its pinned SHA-256 and size`);
      if (pending) controller.enqueue(pending);
    },
  });
}

/** Copies every upstream asset `natives` names that the mirror lacks, each checked against its SHA-256 and size as it
 * passes. Returns the SHA-256 of each asset copied. */
export async function mirrorNatives(natives: PortableNatives, mirror: NativeMirror, download: (url: string) => Promise<Response>): Promise<string[]> {
  const unique = new Map<string, MachineNativeFile>();
  for (const files of Object.values(portableNativesSchema.parse(natives))) for (const file of Object.values(files)) unique.set(file.sha256, file);
  const copied: string[] = [];
  for (const native of unique.values()) {
    if (await mirror.has(native.sha256)) continue;
    const response = await download(native.url);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Cannot download ${native.url}: HTTP ${response.status}`);
    }
    await mirror.put(native, response.body.pipeThrough(verifyingNative(native)));
    copied.push(native.sha256);
  }
  return copied;
}
