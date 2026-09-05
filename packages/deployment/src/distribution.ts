import { z } from 'zod';

/** Native dependency graphs are built on each target, never cross-labelled. Linux artifacts use glibc, not musl. */
export const DISTRIBUTION_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;
export const DISTRIBUTION_BUN_VERSION = '1.4.0';
export const distributionPlatformSchema = z.enum(DISTRIBUTION_PLATFORMS);
export type DistributionPlatform = z.infer<typeof distributionPlatformSchema>;
export const distributionReleaseSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = z.object({ sha256, size: z.number().int().positive().max(32 * 1024 ** 3) }).strict();
const safePath = z.string().min(1).max(4096).refine((value) =>
  !/[\\\x00-\x1f\x7f:]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
'Expected a relative regular-file path');
export const distributionFileSchema = z.object({
  path: safePath,
  sha256,
  size: z.number().int().nonnegative().max(32 * 1024 ** 3),
  mode: z.union([z.literal(0o644), z.literal(0o755)]),
}).strict();
export type DistributionFile = z.infer<typeof distributionFileSchema>;

/** stable/<platform>.json authenticates the immutable releases/<release>/<platform>/manifest.json over HTTPS. */
export const distributionChannelSchema = z.object({
  schemaVersion: z.literal(1),
  release: distributionReleaseSchema,
  platform: distributionPlatformSchema,
  manifest: digest.extend({ size: z.number().int().positive().max(16 * 1024 ** 2) }),
}).strict();
export type DistributionChannel = z.infer<typeof distributionChannelSchema>;

/** runtime.bin.gz is gzip of the regular files' bytes concatenated in this exact inventory order; no tar headers or links. */
export const distributionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  release: distributionReleaseSchema,
  platform: distributionPlatformSchema,
  bunVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  minimumGlibc: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u).nullable(),
  client: digest,
  runtime: digest.extend({ files: z.array(distributionFileSchema).min(1).max(100_000) }),
  provenance: digest,
}).strict().superRefine((manifest, context) => {
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.runtime.files) {
    if (paths.has(file.path) || file.path === 'distribution-manifest.json') {
      context.addIssue({ code: 'custom', message: `Duplicate or reserved runtime path: ${file.path}` });
    }
    paths.add(file.path);
    total += file.size;
  }
  for (const name of paths) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) context.addIssue({ code: 'custom', message: `Runtime file is also a directory: ${name}` });
    }
  }
  for (const required of ['host.js', 'host-runtime.js', 'rpc-probe.js', 'omp-launcher.js', 'bin/bun', 'bin/omp', 'bin/walgit', 'machine/machine.js', 'machine/machine-worker.js', 'machine.manifest.json', 'omp/omp.js', 'omp/omp-worker.js', 'omp.manifest.json']) {
    if (!paths.has(required)) context.addIssue({ code: 'custom', message: `Runtime is missing ${required}` });
  }
  for (const binary of ['bin/bun', 'bin/omp', 'bin/walgit']) {
    if (manifest.runtime.files.find((file) => file.path === binary)?.mode !== 0o755) {
      context.addIssue({ code: 'custom', message: `${binary} must be executable` });
    }
  }
  if (total > 32 * 1024 ** 3) context.addIssue({ code: 'custom', message: 'Runtime exceeds the unpacked size limit' });
  if (manifest.platform.startsWith('linux-') !== (manifest.minimumGlibc !== null)) {
    context.addIssue({ code: 'custom', message: 'Linux distributions must declare their native glibc requirement' });
  }
});
export type DistributionManifest = z.infer<typeof distributionManifestSchema>;

export function currentDistributionPlatform(): DistributionPlatform {
  const platform = `${process.platform}-${process.arch}`;
  const parsed = distributionPlatformSchema.safeParse(platform);
  if (!parsed.success) {
    throw new Error(`GitSpace has no prebuilt runtime for ${platform}. Supported: ${DISTRIBUTION_PLATFORMS.join(', ')}. On Windows use a supported Linux distribution in WSL2. You can use the browser without pairing this machine.`);
  }
  return parsed.data;
}

export function currentGlibcVersion(): string {
  let version: string | undefined;
  try {
    const result = Bun.spawnSync(['getconf', 'GNU_LIBC_VERSION'], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode === 0) version = /^glibc (\d+\.\d+(?:\.\d+)?)\s*$/u.exec(new TextDecoder().decode(result.stdout))?.[1];
  } catch {
    // Missing getconf is handled with the same actionable platform error.
  }
  if (!version) throw new Error('GitSpace Linux runtimes require glibc and getconf (libc-bin). Alpine/musl is not supported; use a glibc-based Linux distribution or use GitSpace in the browser without pairing.');
  return version;
}

export function versionAtLeast(actual: string, required: string): boolean {
  const left = actual.split('.').map(Number);
  const right = required.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

export function distributionBaseUrl(apiUrl: string): URL {
  const override = process.env.GITSPACE_DISTRIBUTION_URL;
  const url = override ? new URL(`${override.replace(/\/+$/u, '')}/`) : new URL('/distribution/v1/', apiUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('GitSpace distribution URL must be HTTPS (HTTP is allowed only for a local release smoke server), with no credentials, query, or fragment.');
  }
  return url;
}
