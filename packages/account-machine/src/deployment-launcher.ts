import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExecutorJournal, LocalAttachment } from '@gitspace/runtime-machine';
import { executableManifestPath, readExecutableFile, sha256, validateExecutableArtifact } from '@gitspace/deployment/manifest';
import { hashArtifactPath, workspaceRevision } from '@gitspace/deployment';
import type { BuiltArtifact, BuiltExecutableArtifact } from '@gitspace/deployment';
import { GITSPACE_CANONICAL_BRANCH, GITSPACE_SOURCE_REPOSITORY, launchSourceSchema, releaseTargetSchema, workerManifestSchema, workerModuleKey, workerReleaseMetadataSchema, type DeploymentStatus, type LaunchProgress, type LaunchSource, type ReleaseArtifact, type ReleaseRecord, type ReleaseSource, type ReleaseTarget, type StageReleaseInput, type TenantDesired, type WorkerReleaseMetadata } from '@gitspace/protocol';
import { portableFileKey, portableManifestSchema } from '@gitspace/protocol/machine-release';
import { FRONTEND_TRANSFER_CONCURRENCY, forEachConcurrent, releaseObjectKeys, type FrontendManifest } from './release-objects.js';
import { z } from 'zod';

const targetPackages: Record<ReleaseTarget, string> = {
  worker: 'account-worker', machine: 'account-machine', frontend: 'account-web',
};
const inferenceCapablePackageSchema = z.object({ gitspace: z.object({ inferenceVersion: z.literal(1) }) });

/** A release is stamped only when every selected target's own source declares profile-managed inference. */
export async function requireInferenceCapableSource(root: string, targets: readonly ReleaseTarget[]): Promise<void> {
  for (const target of targets) {
    let capable = false;
    try {
      capable = inferenceCapablePackageSchema.safeParse(JSON.parse(await readFile(join(root, 'packages', targetPackages[target], 'package.json'), 'utf8'))).success;
    } catch { /* Missing or unreadable manifests are legacy sources. */ }
    if (!capable) throw new Error(`This workspace's ${target} source does not support inference profiles; update the workspace before launching`);
  }
}

/** What a target build reports: the worker's metadata, and the portable release a machine build makes when its source can. */
type BuiltTarget<T> = T & { worker?: WorkerReleaseMetadata; portable?: BuiltArtifact };

/** Build code belongs to the selected source tree, not the currently running machine generation. */
export async function buildWorkspaceTarget<T extends BuiltArtifact>(
  root: string, sha: string, target: ReleaseTarget, output: string, environment: Record<string, string> = {},
): Promise<BuiltTarget<T>> {
  releaseTargetSchema.parse(target);
  const resultPath = `${output}.build.json`;
  const builder = pathToFileURL(join(root, 'packages/deployment/src/builders.ts')).href;
  const script = `
    // This specifier is the runtime-selected tenant workspace, not this launcher's bundled modules.
    const builders = await import(${JSON.stringify(builder)});
    const root = ${JSON.stringify(root)};
    const output = ${JSON.stringify(output)};
    const target = ${JSON.stringify(target)};
    let built;
    if (target === 'worker') built = { ...await builders.buildWorkerRelease(root, ${JSON.stringify(sha)}, output), worker: await builders.workerMetadataFromWrangler(root) };
    else if (target === 'machine') {
      built = await builders.buildMachineBundle(root, output);
      // Source trees from before portable releases build only this platform's machine.
      if (typeof builders.buildPortableRelease === 'function') built.portable = await builders.buildPortableRelease(root, output + '-portable');
    }
    else built = await builders.buildFrontendTree(root, output);
    await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(built));
  `;
  // A fresh process prevents module-cache reuse after source edits and isolates builder globals.
  // Bun caches its implicit child environment before the runtime resolves its native selection.
  const child = Bun.spawn([process.execPath, '--eval', script], { cwd: root, env: { ...process.env, ...environment }, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Workspace-owned ${target} build failed; inspect the deployment build output`);
  try {
    return JSON.parse(await readFile(resultPath, 'utf8')) as BuiltTarget<T>;
  } finally {
    await rm(resultPath, { force: true });
  }
}
async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10 * 60_000, killSignal: 'SIGKILL' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exited with ${code}`}`);
  return stdout.trim();
}

/** What a launch builds: an attached workspace cache, or a canonical commit. */
type BuildSource = { kind: 'workspace'; workspace: DeploymentSource } | { kind: 'canonical'; commit: string };
/** The tree a launch builds, its release key and recorded source, and how to dispose of it afterwards. */
interface PreparedSource { root: string; key: string; label: string; source: ReleaseSource; environment: Record<string, string>; remove(): Promise<void> }

/**
 * "Launch into": build GitSpace from a ready workspace cache, or a clean commit of the canonical repository, on this machine, put the
 * bundles in the tenant's data bucket, stage the release, and point the
 * tenant's `desired` at it. Progress is logged and reported to the account.
 */

export type DeploymentLaunchErrorCode = 'WORKSPACE_NOT_FOUND' | 'CACHE_UNAVAILABLE' | 'NOT_GITSPACE' | 'BUSY';

export class DeploymentLaunchError extends Error {
  constructor(readonly code: DeploymentLaunchErrorCode, message: string) {
    super(message);
    this.name = 'DeploymentLaunchError';
  }
}

type DeploymentSource = Pick<LocalAttachment, 'rootPath'> & Pick<LocalAttachment['attachment'], 'projectId' | 'workspaceId'> & { name: string };

/** The executor's durable local assignment owns the checkout, not the retired workspace-holder table. */
export function deploymentSource(attachments: readonly LocalAttachment[], machineId: string, workspaceId: string): DeploymentSource {
  let attached = false;
  for (const local of attachments) {
    const { attachment } = local;
    if (attachment.workspaceId !== workspaceId || attachment.machineId !== machineId) continue;
    attached = true;
    if (attachment.state !== 'ready' || attachment.cache?.state !== 'live' || !local.prerequisitesComplete) continue;
    return { workspaceId: attachment.workspaceId, projectId: attachment.projectId, rootPath: local.rootPath, name: attachment.checkout.kind === 'shared' ? attachment.checkout.branch : attachment.workspaceId };
  }
  if (!attached) throw new DeploymentLaunchError('WORKSPACE_NOT_FOUND', `Attach workspace ${workspaceId} to machine ${machineId} before launching`);
  throw new DeploymentLaunchError('CACHE_UNAVAILABLE', `Workspace ${workspaceId} needs a ready live cache on machine ${machineId}; resume or finish setup before launching`);
}

export interface ReleaseAuthority {
  deploymentStatus(): Promise<DeploymentStatus>;
  stageRelease(input: StageReleaseInput): Promise<ReleaseRecord>;
  launchRelease(sha: string, targets: ReleaseTarget[]): Promise<{ record: ReleaseRecord; desired: TenantDesired }>;
  /** The account keeps the latest launch so every browser can follow it, whichever machine answers or none does. */
  reportLaunchProgress(progress: LaunchProgress): Promise<void>;
}

export interface ReleaseBlobWriter {
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
}

export interface DeploymentLauncherOptions {
  attachments: ExecutorJournal['attachments'];
  machineId: string;
  authority: ReleaseAuthority;
  blobs: ReleaseBlobWriter;
  /** Scratch root for build output; each release builds under `<buildRoot>/<sha>`. */
  buildRoot: string;
  installTimeoutMs?: number;
}

export interface DeploymentLaunchInput {
  source: LaunchSource;
  targets: ReleaseTarget[];
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export class DeploymentLauncher {
  private active: Promise<ReleaseRecord> | null = null;
  private progress: LaunchProgress | null = null;
  private reporting: Promise<void> = Promise.resolve();

  constructor(private readonly options: DeploymentLauncherOptions) {}

  /** Reports in order without blocking the build; a lost report is logged and the next one carries newer state. */
  private report(progress: LaunchProgress): void {
    const snapshot = { ...progress, targets: [...progress.targets], message: progress.message.slice(0, 4_096), error: progress.error?.slice(0, 4_096) ?? null };
    this.reporting = this.reporting
      .then(() => this.options.authority.reportLaunchProgress(snapshot))
      .catch((error: unknown) => console.error('[gitspace-deploy] launch progress report failed', error));
  }

  /**
   * Validate synchronously, then build in the background. The caller gets the
   * progress record at once; later phases are reported to the account.
   */
  launch(input: DeploymentLaunchInput): LaunchProgress {
    if (this.active) throw new DeploymentLaunchError('BUSY', 'A release is already being built on this machine');
    const source = launchSourceSchema.parse(input.source);
    const build: BuildSource = source.kind === 'workspace' ? { kind: 'workspace', workspace: deploymentSource(this.options.attachments(), this.options.machineId, source.workspaceId) } : source;
    const targets = [...new Set(z.array(releaseTargetSchema).parse(input.targets))];
    if (targets.length === 0) throw new DeploymentLaunchError('NOT_GITSPACE', 'A release needs at least one target');
    const now = new Date().toISOString();
    this.progress = { launchId: crypto.randomUUID(), source, targets, sha: null, phase: 'queued', message: 'Preparing the build', status: 'running', error: null, startedAt: now, updatedAt: now };
    this.report(this.progress);
    this.active = this.run(build, targets).finally(() => { this.active = null; });
    this.active.catch(() => undefined);
    return this.progress;
  }

  /** Same as `launch`, awaiting completion; used by tests and the SDK-facing revert path. */
  launchAndWait(input: DeploymentLaunchInput): Promise<ReleaseRecord> {
    this.launch(input);
    return this.active!;
  }

  /** A workspace cache builds where it is; its key and label name its commit and uncommitted files. */
  private async workspaceSource(workspace: DeploymentSource): Promise<PreparedSource> {
    const revision = await workspaceRevision(workspace.rootPath);
    const changes = revision.uncommittedFiles === 0 ? '' : ` + ${revision.uncommittedFiles} uncommitted`;
    return {
      root: workspace.rootPath, key: revision.key, label: `${workspace.name} @ ${revision.commit.slice(0, 12)}${changes}`.slice(0, 160), environment: {},
      source: { kind: 'workspace', workspaceId: workspace.workspaceId, commit: revision.commit, uncommittedFiles: revision.uncommittedFiles },
      remove: async () => {},
    };
  }

  /** One canonical commit, fetched into a cached repository and checked out detached into its own worktree. */
  private async canonicalSource(commit: string): Promise<PreparedSource> {
    const repository = join(this.options.buildRoot, 'canonical.git');
    if (!existsSync(join(repository, 'HEAD'))) {
      await mkdir(repository, { recursive: true });
      await git(repository, ['init', '--bare', '--quiet']);
    }
    await git(repository, ['fetch', '--quiet', '--no-tags', '--depth', '1', GITSPACE_SOURCE_REPOSITORY, commit]);
    const root = join(this.options.buildRoot, `canonical-${commit}`);
    await git(repository, ['worktree', 'prune']);
    await rm(root, { recursive: true, force: true });
    await git(repository, ['worktree', 'add', '--detach', '--force', root, commit]);
    const revision = await workspaceRevision(root);
    if (revision.key !== commit) throw new Error(`The canonical checkout of ${commit} is not clean`);
    return {
      root, key: commit, label: `${GITSPACE_CANONICAL_BRANCH} @ ${commit.slice(0, 12)}`, environment: { GITSPACE_SOURCE_BRANCH: GITSPACE_CANONICAL_BRANCH, GITSPACE_SOURCE_COMMIT: commit },
      source: { kind: 'canonical', repository: GITSPACE_SOURCE_REPOSITORY, branch: GITSPACE_CANONICAL_BRANCH, commit },
      remove: async () => { await git(repository, ['worktree', 'remove', '--force', root]).catch(() => rm(root, { recursive: true, force: true })); },
    };
  }

  /** Launches a staged release; worker and frontend activation finish in this call, machine hosts follow. */
  private async launchStaged(sha: string, targets: ReleaseTarget[], progress: (phase: string, message: string, status?: LaunchProgress['status']) => void): Promise<ReleaseRecord> {
    progress('launch', `launching into ${targets.join(', ')}`);
    const launched = await this.options.authority.launchRelease(sha, targets);
    if ((targets.includes('worker') && launched.record.status.worker === 'failed')
      || (targets.includes('frontend') && launched.record.status.frontend === 'failed')) {
      throw new Error(launched.record.error ?? 'Release activation failed');
    }
    progress('launched', `worker=${launched.record.status.worker} machine=${targets.includes('machine') ? 'pending' : 'skipped'} frontend=${launched.record.status.frontend}`, 'succeeded');
    return launched.record;
  }

  private async run(build: BuildSource, targets: ReleaseTarget[]): Promise<ReleaseRecord> {
    const current = this.progress!;
    const progress = (phase: string, message: string, status: LaunchProgress['status'] = 'running'): void => {
      const sha = current.sha ?? 'pending';
      console.log(`[gitspace-deploy] ${sha.slice(0, 12)} ${phase}: ${message}`);
      current.phase = phase;
      current.message = message;
      current.status = status;
      current.updatedAt = new Date().toISOString();
      if (status === 'failed') current.error = message;
      this.report(current);
    };
    let prepared: PreparedSource | null = null;
    let buildRoot: string | null = null;
    try {
      if (build.kind === 'canonical') progress('checkout', `fetching ${GITSPACE_CANONICAL_BRANCH} @ ${build.commit.slice(0, 12)} from ${GITSPACE_SOURCE_REPOSITORY}`);
      prepared = build.kind === 'workspace' ? await this.workspaceSource(build.workspace) : await this.canonicalSource(build.commit);
      const { root, environment } = prepared;
      const protocolPackage = await readFile(join(root, 'packages/protocol/package.json'), 'utf8').then(
        (source) => JSON.parse(source) as unknown,
        () => null,
      );
      if (!(typeof protocolPackage === 'object' && protocolPackage !== null && 'name' in protocolPackage && protocolPackage.name === '@gitspace/protocol')) {
        throw new DeploymentLaunchError('NOT_GITSPACE', `${prepared.label} is not a GitSpace checkout`);
      }
      const sha = prepared.key;
      current.sha = sha;
      // A release is built once: its objects are written once, and a rebuild differs in its bytecode. The account's
      // release of this source is staged again as it is (the account admits it again) and launched.
      const built = (await this.options.authority.deploymentStatus()).releases.find(release => release.sha === sha);
      if (built && targets.every(target => built.artifacts[target])) {
        progress('stage', `launching the account's release of ${sha.slice(0, 12)} again, as it was built`);
        const { worker, machine, frontend, portable } = built.artifacts;
        await this.options.authority.stageRelease({ sha, inferenceVersion: 1, label: built.label, source: built.source ?? prepared.source, artifacts: { worker, machine, frontend, ...(portable ? { portable } : {}) }, worker: built.worker });
        return await this.launchStaged(sha, targets, progress);
      }
      buildRoot = join(this.options.buildRoot, sha);
      progress('install', `bun install --frozen-lockfile in ${root}`);
      const install = Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], {
        cwd: root,
        stdout: 'inherit',
        stderr: 'pipe',
        timeout: this.options.installTimeoutMs ?? 10 * 60_000,
        killSignal: 'SIGKILL',
      });
      const installOutput = await new Response(install.stderr).text();
      if (await install.exited !== 0) throw new Error(`bun install failed: ${installOutput.trim().split('\n').slice(-5).join(' | ')}`);
      await requireInferenceCapableSource(root, targets);

      await rm(buildRoot, { recursive: true, force: true });
      const keys = releaseObjectKeys(sha);
      const artifacts: StageReleaseInput['artifacts'] = { worker: null, machine: null, frontend: null };
      let worker: StageReleaseInput['worker'] = null;

      if (targets.includes('worker')) {
        progress('build', 'building tenant worker');
        const built = await buildWorkspaceTarget<BuiltArtifact>(root, sha, 'worker', join(buildRoot, 'worker'), environment);
        worker = workerReleaseMetadataSchema.parse(built.worker);
        progress('upload', `uploading ${keys.worker} and its modules`);
        artifacts.worker = await this.putWorker(keys.worker, built);
      }
      if (targets.includes('machine')) {
        progress('build', 'building machine daemon');
        const built = await buildWorkspaceTarget<BuiltExecutableArtifact>(root, sha, 'machine', join(buildRoot, 'machine'), environment);
        progress('upload', `uploading ${keys.machine}`);
        artifacts.machine = await this.putExecutable(keys.machine, built);
        if (built.portable) {
          progress('upload', `uploading the portable release ${keys.portable}`);
          artifacts.portable = await this.putPortable(keys.portable, built.portable);
        }
      }
      if (targets.includes('frontend')) {
        progress('build', 'building frontend');
        const built = await buildWorkspaceTarget<BuiltArtifact>(root, sha, 'frontend', join(buildRoot, 'frontend'), environment);
        const hash = await hashArtifactPath(built.path);
        const files = await filesUnder(built.path);
        progress('upload', `uploading ${files.length} frontend files under ${keys.frontend}`);
        const entries: FrontendManifest['files'] = new Array(files.length);
        await forEachConcurrent(files, FRONTEND_TRANSFER_CONCURRENCY, async (file, index) => {
          const path = relative(built.path, file);
          const bytes = new Uint8Array(await readFile(file));
          entries[index] = { path, hash: await this.options.blobs.put(`${keys.frontend}/${path}`, bytes), size: bytes.byteLength };
        });
        const manifest: FrontendManifest = { files: entries };
        const size = entries.reduce((total, entry) => total + entry.size, 0);
        await this.options.blobs.put(keys.frontendManifest, new TextEncoder().encode(JSON.stringify(manifest)));
        artifacts.frontend = { key: keys.frontend, hash, size };
      }

      progress('stage', 'staging release');
      await this.options.authority.stageRelease({
        sha,
        inferenceVersion: 1,
        label: prepared.label,
        source: prepared.source,
        artifacts,
        worker,
      });
      return await this.launchStaged(sha, targets, progress);
    } catch (error) {
      progress('failed', error instanceof Error ? error.message : String(error), 'failed');
      throw error;
    } finally {
      if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
      await prepared?.remove();
    }
  }

  private async putExecutable(key: string, built: BuiltExecutableArtifact): Promise<ReleaseArtifact> {
    const manifest = await validateExecutableArtifact(built.path, {
      target: built.manifest.target, hash: built.hash, manifestHash: built.manifestHash,
    });
    if (manifest.inferenceVersion !== 1) throw new Error('This source build does not support inference profiles; upgrade the workspace before launching');
    for (const file of manifest.files) {
      let index = 0;
      let size = 0;
      const hash = new Bun.CryptoHasher('sha256');
      for await (const content of readExecutableFile(join(built.path, file.path))) {
        const chunk = file.chunks[index++];
        if (!chunk || content.byteLength !== chunk.size || sha256(content) !== chunk.hash) throw new Error(`Executable chunk changed before upload: ${file.path}`);
        const uploadedHash = await this.options.blobs.put(chunk.key, content);
        if (uploadedHash !== chunk.hash) throw new Error(`Uploaded executable chunk hash mismatch: ${file.path}`);
        hash.update(content);
        size += content.byteLength;
      }
      if (index !== file.chunks.length || size !== file.size || `sha256:${hash.digest('hex')}` !== file.hash) throw new Error(`Executable changed before upload: ${file.path}`);
    }
    // Publish the authenticated inventory last; it cannot reference partially uploaded files.
    const bytes = new Uint8Array(await readFile(executableManifestPath(built.path)));
    if (sha256(bytes) !== built.manifestHash) throw new Error('Executable manifest changed before upload');
    const hash = await this.options.blobs.put(key, bytes);
    if (hash !== built.manifestHash) throw new Error('Uploaded executable manifest hash mismatch');
    return { key, hash: built.manifestHash, size: bytes.byteLength };
  }

  /** Uploads each file the portable manifest names, checked against it, then the manifest, so a stored manifest never names a missing file. */
  private async putPortable(key: string, built: BuiltArtifact): Promise<ReleaseArtifact> {
    const bytes = new Uint8Array(await readFile(built.path));
    if (sha256(bytes) !== built.hash) throw new Error('Portable release manifest changed before upload');
    const manifest = portableManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    await forEachConcurrent(manifest.files, FRONTEND_TRANSFER_CONCURRENCY, async (file) => {
      const content = new Uint8Array(await readFile(join(dirname(built.path), 'portable', file.path)));
      const hash = sha256(content);
      if (content.byteLength !== file.size || hash !== `sha256:${file.sha256}`) throw new Error(`Portable release file changed before upload: ${file.path}`);
      if (await this.options.blobs.put(portableFileKey(key, file.path), content) !== hash) throw new Error(`Uploaded portable release file hash mismatch: ${file.path}`);
    });
    if (await this.options.blobs.put(key, bytes) !== built.hash) throw new Error('Uploaded portable release manifest hash mismatch');
    return { key, hash: built.hash, size: bytes.byteLength };
  }

  /** Uploads each module the manifest pins, checked against it, then the manifest, so a stored manifest never names a missing module. */
  private async putWorker(key: string, built: BuiltArtifact): Promise<ReleaseArtifact> {
    const bytes = new Uint8Array(await readFile(built.path));
    if (sha256(bytes) !== built.hash) throw new Error('Worker manifest changed before upload');
    const manifest = workerManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    for (const module of manifest.modules) {
      const content = new Uint8Array(await readFile(join(dirname(built.path), module.name)));
      const hash = sha256(content);
      if (content.byteLength !== module.size || hash !== `sha256:${module.sha256}`) throw new Error(`Worker module changed before upload: ${module.name}`);
      if (await this.options.blobs.put(workerModuleKey(key, module.name), content) !== hash) throw new Error(`Uploaded worker module hash mismatch: ${module.name}`);
    }
    if (await this.options.blobs.put(key, bytes) !== built.hash) throw new Error('Uploaded worker manifest hash mismatch');
    return { key, hash: built.hash, size: bytes.byteLength };
  }
}
