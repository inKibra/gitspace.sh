import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { nativeAbiSchema } from '@gitspace/protocol/deployment';
import { readExecutableFile, validateNativeAbi } from '@gitspace/account-omp/manifest';
import { z } from 'zod';

const digestSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive(),
});
const absolutePath = z.string().min(1).refine(isAbsolute, 'Environment native tool paths must be absolute');
export const walgitProvenanceSchema = z.object({
  repository: z.literal('https://github.com/tobi/walgit.git'),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  rustVersion: z.string().min(1),
  bunVersion: z.string().min(1),
  build: z.literal('static-openssl-v1'),
  patch: digestSchema.extend({ path: z.literal('patches/walgit/conditional-multipart.patch') }),
}).strict();

/** An account source declaration, never an implicit PATH/global-binary preference. */
export const machineNativeDeclarationSchema = z.object({
  version: z.literal(1),
  walgit: z.discriminatedUnion('source', [
    z.object({ source: z.literal('pinned-walgit') }).strict(),
    z.object({
      source: z.literal('release'),
      artifact: digestSchema.extend({
        location: z.string().min(1),
        abi: nativeAbiSchema,
      }).strict(),
    }).strict(),
    digestSchema.extend({ source: z.literal('environment'), path: absolutePath, abi: nativeAbiSchema }).strict(),
  ]),
}).strict();
export type MachineNativeDeclaration = z.infer<typeof machineNativeDeclarationSchema>;

/** Part of the authenticated complete machine tree, including environment selection. */
export const machineNativeRuntimeSchema = z.object({
  version: z.literal(1),
  bunVersion: z.string().min(1),
  abi: nativeAbiSchema,
  walgit: z.discriminatedUnion('source', [
    digestSchema.extend({ source: z.literal('release'), path: z.literal('native/walgit'), provenance: walgitProvenanceSchema.nullable() }).strict(),
    digestSchema.extend({ source: z.literal('environment'), path: absolutePath }).strict(),
  ]),
}).strict();
export type MachineNativeRuntime = z.infer<typeof machineNativeRuntimeSchema>;

/** Official Git LFS in the authenticated machine tree. Its directory is the only PATH entry a generation adds. */
export const GIT_LFS_PATH = 'native/bin/git-lfs';
// Beside, not inside, machine-native.json: predecessor hosts strictly parse that file while verifying a candidate.
export const GIT_LFS_DECLARATION = 'native/git-lfs.json';
export const gitLfsRuntimeSchema = digestSchema.extend({
  version: z.literal(1),
  path: z.literal(GIT_LFS_PATH),
  upstream: digestSchema.extend({
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    url: z.string().startsWith('https://github.com/git-lfs/git-lfs/releases/download/'),
  }).strict(),
}).strict();
export type GitLfsRuntime = z.infer<typeof gitLfsRuntimeSchema>;

export interface PreparedMachineNativeRuntime {
  walgit: string;
  /** Null only for generations that predate bundled Git LFS, e.g. a rollback target. */
  gitLfs: string | null;
}

export async function nativeFileDigest(path: string): Promise<{ sha256: string; size: number }> {
  if (!(await lstat(path)).isFile()) throw new Error(`Native payload must be a regular file: ${path}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of readExecutableFile(path)) { hash.update(bytes); size += bytes.byteLength; }
  return { sha256: hash.digest('hex'), size };
}

export async function verifyNativeFile(path: string, expected: { sha256: string; size: number }): Promise<void> {
  const actual = await nativeFileDigest(path);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`Native payload integrity mismatch: ${path}`);
  if (!((await lstat(path)).mode & 0o111)) throw new Error(`Native payload is not executable: ${path}`);
}

export async function readMachineNativeRuntime(path: string): Promise<MachineNativeRuntime> {
  try {
    return machineNativeRuntimeSchema.parse(JSON.parse(await readFile(join(path, 'machine-native.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Machine generation ${path} predates native selection. Keep its existing host and run gitspace machine recover --source <held-checkout> --workspace <id> before replacing the host/image; no tenant code or data has been replaced.`, { cause: error });
    }
    throw error;
  }
}

async function startNative(argv: string[], started: (stdout: string) => boolean, label: string): Promise<void> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 || !started(stdout)) throw new Error(`Selected ${label} cannot start (${code}): ${stderr || stdout}`);
  } finally { clearTimeout(timer); }
}

export async function readGitLfsRuntime(root: string): Promise<GitLfsRuntime | null> {
  try {
    return gitLfsRuntimeSchema.parse(JSON.parse(await readFile(join(root, GIT_LFS_DECLARATION), 'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Verifies the declared bytes before executing them; null for a tree that predates bundled Git LFS. */
export async function prepareGitLfs(root: string): Promise<string | null> {
  const runtime = await readGitLfsRuntime(root);
  if (!runtime) return null;
  const binary = join(root, runtime.path);
  await verifyNativeFile(binary, runtime);
  await startNative([binary, 'version'], (stdout) => stdout.startsWith(`git-lfs/${runtime.upstream.version} `), 'Git LFS');
  return binary;
}

/** Called before draining a predecessor, and again by the successor before opening state. */
export async function prepareMachineNativeRuntime(path: string): Promise<PreparedMachineNativeRuntime> {
  const runtime = await readMachineNativeRuntime(path);
  validateNativeAbi(runtime.abi);
  if (runtime.bunVersion !== Bun.version) throw new Error(`Native generation requires Bun ${runtime.bunVersion}, found ${Bun.version}`);
  const binary = runtime.walgit.source === 'release' ? join(path, runtime.walgit.path) : runtime.walgit.path;
  await verifyNativeFile(binary, runtime.walgit);
  if (runtime.walgit.source === 'release' && runtime.walgit.provenance) {
    const snapshot = await nativeFileDigest(join(path, 'native/patches/conditional-multipart.patch'));
    const expected = runtime.walgit.provenance.patch;
    if (snapshot.sha256 !== expected.sha256 || snapshot.size !== expected.size) throw new Error('WalGit patch snapshot integrity mismatch');
  }
  await startNative([binary, '--version'], (stdout) => /walgit/iu.test(stdout), 'WalGit');
  return { walgit: binary, gitLfs: await prepareGitLfs(path) };
}

/**
 * PATH for one generation's processes: its tool directory first, replacing (never accumulating) a predecessor's.
 * Bun.spawn without `env` uses the startup environment, so hosts must pass this when spawning the machine.
 */
export function machineToolEnvironment(
  environment: Record<string, string | undefined>,
  native: Pick<PreparedMachineNativeRuntime, 'gitLfs'>,
): { PATH: string; GITSPACE_MACHINE_TOOL_PATH: string } {
  const tools = native.gitLfs ? dirname(native.gitLfs) : '';
  const previous = environment.GITSPACE_MACHINE_TOOL_PATH;
  const inherited = environment.PATH ? environment.PATH.split(delimiter).filter((entry) => !entry || (entry !== previous && entry !== tools)) : [];
  return { PATH: (tools ? [tools, ...inherited] : inherited).join(delimiter), GITSPACE_MACHINE_TOOL_PATH: tools };
}
