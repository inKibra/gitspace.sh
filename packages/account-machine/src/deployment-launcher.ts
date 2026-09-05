import { readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AppendFactEvent, GitSpaceDatabase } from '@gitspace/core';
import { executableManifestPath, readExecutableFile, sha256, validateExecutableArtifact } from '@gitspace/account-omp/manifest';
import {
  buildFrontendTree,
  buildOmpBundle,
  buildMachineBundle,
  buildWorkerBundle,
  workerMetadataFromWrangler,
  workspaceSha,
  type BuiltExecutableArtifact,
} from '@gitspace/deployment';
import type { ReleaseArtifact, ReleaseRecord, ReleaseTarget, StageReleaseInput, TenantDesired } from '@gitspace/protocol';
import { releaseObjectKeys, type FrontendManifest } from './release-follower.js';

/**
 * "Launch into": build GitSpace from a workspace held on this machine, put the
 * bundles in the tenant's data bucket, stage the release, and point the
 * tenant's `desired` at it. Progress is logged and mirrored as `deployment`
 * fact events on the workspace's project.
 */

export type DeploymentLaunchErrorCode = 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_NOT_HELD' | 'NOT_GITSPACE' | 'BUSY';

export class DeploymentLaunchError extends Error {
  constructor(readonly code: DeploymentLaunchErrorCode, message: string) {
    super(message);
    this.name = 'DeploymentLaunchError';
  }
}

export interface ReleaseAuthority {
  stageRelease(input: StageReleaseInput): Promise<ReleaseRecord>;
  launchRelease(sha: string, targets: ReleaseTarget[]): Promise<{ record: ReleaseRecord; desired: TenantDesired }>;
}

export interface ReleaseBlobWriter {
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
}

export interface ProjectFactEvents {
  append(input: AppendFactEvent): void;
}

export interface DeploymentLauncherOptions {
  database: GitSpaceDatabase;
  machineId: string;
  authority: ReleaseAuthority;
  blobs: ReleaseBlobWriter;
  events: ProjectFactEvents;
  /** Scratch root for build output; each release builds under `<buildRoot>/<sha>`. */
  buildRoot: string;
  installTimeoutMs?: number;
}

export interface DeploymentLaunchInput {
  workspaceId: string;
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

export interface LaunchProgress {
  launchId: string;
  workspaceId: string;
  targets: ReleaseTarget[];
  sha: string | null;
  phase: string;
  message: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export class DeploymentLauncher {
  private active: Promise<ReleaseRecord> | null = null;
  private progress: LaunchProgress | null = null;

  constructor(private readonly options: DeploymentLauncherOptions) {}

  /** The launch in flight, or the last one this process ran. */
  status(): LaunchProgress | null {
    return this.progress;
  }

  /**
   * Validate synchronously, then build in the background. The caller gets the
   * progress record at once; phases arrive through `status()` and fact events.
   */
  launch(input: DeploymentLaunchInput): LaunchProgress {
    if (this.active) throw new DeploymentLaunchError('BUSY', 'A release is already being built on this machine');
    const workspace = this.options.database.getWorkspace(input.workspaceId);
    if (!workspace) throw new DeploymentLaunchError('WORKSPACE_NOT_FOUND', `Workspace ${input.workspaceId} does not exist`);
    if (workspace.placementState === 'closed' || workspace.holderId !== this.options.machineId) {
      throw new DeploymentLaunchError('WORKSPACE_NOT_HELD', `Workspace ${input.workspaceId} is not open on this machine`);
    }
    const targets = [...new Set(input.targets)];
    if (targets.length === 0) throw new DeploymentLaunchError('NOT_GITSPACE', 'A release needs at least one target');
    const now = new Date().toISOString();
    this.progress = { launchId: crypto.randomUUID(), workspaceId: workspace.id, targets, sha: null, phase: 'queued', message: 'Preparing the build', status: 'running', error: null, startedAt: now, updatedAt: now };
    this.active = this.run(workspace, targets).finally(() => { this.active = null; });
    this.active.catch(() => undefined);
    return this.progress;
  }

  /** Same as `launch`, awaiting completion; used by tests and the SDK-facing revert path. */
  launchAndWait(input: DeploymentLaunchInput): Promise<ReleaseRecord> {
    this.launch(input);
    return this.active!;
  }

  private async run(workspace: NonNullable<ReturnType<GitSpaceDatabase['getWorkspace']>>, targets: ReleaseTarget[]): Promise<ReleaseRecord> {
    const root = workspace.rootPath;
    const protocolPackage = await readFile(join(root, 'packages/protocol/package.json'), 'utf8').then(
      (source) => JSON.parse(source) as unknown,
      () => null,
    );
    const isGitSpace = typeof protocolPackage === 'object' && protocolPackage !== null && 'name' in protocolPackage && protocolPackage.name === '@gitspace/protocol';
    const current = this.progress!;
    const progress = (phase: string, message: string, payload: Record<string, unknown> = {}, status: LaunchProgress['status'] = 'running'): void => {
      const sha = current.sha ?? 'pending';
      console.log(`[gitspace-deploy] ${sha.slice(0, 12)} ${phase}: ${message}`);
      current.phase = phase;
      current.message = message;
      current.status = status;
      current.updatedAt = new Date().toISOString();
      if (status === 'failed') current.error = message;
      this.options.events.append({
        projectId: workspace.projectId,
        scope: 'code',
        entity: 'deployment',
        entityId: sha,
        revision: Date.now(),
        operation: 'updated',
        payload: { ...payload, launchId: current.launchId, phase, message, status, workspaceId: workspace.id, targets },
      });
    };
    if (!isGitSpace) {
      progress('failed', `Workspace ${workspace.id} is not a GitSpace checkout`, {}, 'failed');
      throw new DeploymentLaunchError('NOT_GITSPACE', `Workspace ${workspace.id} is not a GitSpace checkout`);
    }

    const sha = await workspaceSha(root);
    current.sha = sha;
    const buildRoot = join(this.options.buildRoot, sha);
    try {
      progress('install', `bun install --frozen-lockfile in ${root}`);
      const install = Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
        cwd: root,
        stdout: 'inherit',
        stderr: 'pipe',
        timeout: this.options.installTimeoutMs ?? 10 * 60_000,
        killSignal: 'SIGKILL',
      });
      const installOutput = await new Response(install.stderr).text();
      if (await install.exited !== 0) throw new Error(`bun install failed: ${installOutput.trim().split('\n').slice(-5).join(' | ')}`);

      await rm(buildRoot, { recursive: true, force: true });
      const keys = releaseObjectKeys(sha);
      const artifacts: StageReleaseInput['artifacts'] = { worker: null, machine: null, omp: null, frontend: null };
      let worker: StageReleaseInput['worker'] = null;
      let omp: StageReleaseInput['omp'] = null;

      if (targets.includes('worker')) {
        progress('build', 'building tenant worker');
        const built = await buildWorkerBundle(root, sha, join(buildRoot, 'worker'));
        worker = await workerMetadataFromWrangler(root);
        progress('upload', `uploading ${keys.worker}`);
        artifacts.worker = await this.putFile(keys.worker, built.path);
      }
      if (targets.includes('machine')) {
        progress('build', 'building machine daemon');
        const built = await buildMachineBundle(root, join(buildRoot, 'machine'));
        progress('upload', `uploading ${keys.machine}`);
        artifacts.machine = await this.putExecutable(keys.machine, built);
      }
      if (targets.includes('omp')) {
        progress('build', 'building hermetic OMP runtime');
        const built = await buildOmpBundle(root, join(buildRoot, 'omp'));
        omp = built.metadata;
        progress('upload', `uploading ${keys.omp}`);
        artifacts.omp = await this.putExecutable(keys.omp, built);
      }
      if (targets.includes('frontend')) {
        progress('build', 'building frontend');
        const built = await buildFrontendTree(root, join(buildRoot, 'frontend'));
        const files = await filesUnder(built.path);
        progress('upload', `uploading ${files.length} frontend files under ${keys.frontend}`);
        const manifest: FrontendManifest = { files: [] };
        let size = 0;
        for (const file of files) {
          const path = relative(built.path, file);
          const bytes = new Uint8Array(await readFile(file));
          const hash = await this.options.blobs.put(`${keys.frontend}/${path}`, bytes);
          manifest.files.push({ path, hash, size: bytes.byteLength });
          size += bytes.byteLength;
        }
        await this.options.blobs.put(keys.frontendManifest, new TextEncoder().encode(JSON.stringify(manifest)));
        artifacts.frontend = { key: keys.frontend, hash: built.hash, size };
      }

      progress('stage', 'staging release');
      await this.options.authority.stageRelease({
        sha,
        label: `${workspace.name} @ ${sha.slice(0, 12)}`,
        workspaceId: workspace.id,
        artifacts,
        worker,
        omp,
      });
      progress('launch', `launching into ${targets.join(', ')}`);
      const launched = await this.options.authority.launchRelease(sha, targets);
      progress('launched', `worker=${launched.record.status.worker} machine=${targets.includes('machine') ? 'pending' : 'skipped'} omp=${targets.includes('omp') ? 'pending' : 'skipped'} frontend=${launched.record.status.frontend}`, {
        release: launched.record.status,
        releaseError: launched.record.error,
      }, 'succeeded');
      return launched.record;
    } catch (error) {
      progress('failed', error instanceof Error ? error.message : String(error), {}, 'failed');
      throw error;
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  }

  private async putExecutable(key: string, built: BuiltExecutableArtifact): Promise<ReleaseArtifact> {
    const manifest = await validateExecutableArtifact(built.path, {
      target: built.manifest.target, hash: built.hash, manifestHash: built.manifestHash,
    });
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

  private async putFile(key: string, path: string): Promise<ReleaseArtifact> {
    const bytes = new Uint8Array(await readFile(path));
    const hash = sha256(bytes);
    const uploadedHash = await this.options.blobs.put(key, bytes);
    if (uploadedHash !== hash) throw new Error(`Uploaded file hash mismatch: ${path}`);
    return { key, hash, size: bytes.byteLength };
  }
}
