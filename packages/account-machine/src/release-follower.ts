import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { hashArtifactPath } from '@gitspace/deployment';
import {
  executableManifestPath,
  parseExecutableArtifactManifest,
  sha256,
  validateExecutableArtifact,
  type ExecutableArtifactManifest,
} from '@gitspace/deployment/manifest';
import type { DeploymentStatus, ReleaseArtifact, ReleaseRecord } from '@gitspace/protocol';
import { z } from 'zod';
import { environmentLaunchResponseSchema, environmentStatusSchema, type EnvironmentLaunchRequest, type EnvironmentStatus } from './replacement-environment.js';
import { readJson, requestMachineUpdate } from './machine-update.js';
import type { MachineSelection } from './machine-update.js';

/**
 * Convergence on the tenant's desired release. Executables are authenticated
 * complete trees. Machine/frontend replacement belongs to the stable host.
 */


export const frontendManifestSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    hash: z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]),
    size: z.number().int().nonnegative(),
  })),
});
export type FrontendManifest = z.infer<typeof frontendManifestSchema>;

export interface ReleaseFollowerAuthority {
  deploymentStatus(): Promise<DeploymentStatus>;
  reportMachineApplied(input: { sha: string; target: 'machine'; generation: string; status: 'applied' | 'failed'; error?: string }): Promise<ReleaseRecord>;
  reportMachineChannelApplied(input: { target: 'machine'; generation: string }): Promise<void>;
}

export interface ReleaseBlobReader {
  get(key: string, expectedHash?: string): Promise<Uint8Array | null>;
}

export interface ReleaseFollowerOptions {
  authority: ReleaseFollowerAuthority;
  blobs: ReleaseBlobReader;
  machineId: string;
  environmentRoot: string;
  /** `GITSPACE_HOST_URL`; without a host this generation cannot swap and only reports. */
  hostUrl: string | null;
  controlToken: string | null;
  /** Machine identity inherited from the stable replacement host. */
  runningMachineSha: string | null;
  /** `GITSPACE_GENERATION_HASH`. */
  generation: string | null;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface ReleaseObjectKeys {
  worker: string;
  machine: string;
  frontendManifest: string;
  /** Prefix of the frontend tree; files live at `<frontend>/<path>`. */
  frontend: string;
}

export function releaseObjectKeys(sha: string): ReleaseObjectKeys {
  return {
    worker: `releases/${sha}/worker.bundle.json`,
    machine: `releases/${sha}/machine.manifest.json`,
    frontendManifest: `releases/${sha}/frontend.manifest.json`,
    frontend: `releases/${sha}/frontend`,
  };
}

/** Frontend trees are hundreds of small lazily loaded chunks; each transfer is a signed round trip. */
export const FRONTEND_TRANSFER_CONCURRENCY = 16;

/** Runs `task` over every item with bounded concurrency; after any failure no new task starts. */
export async function forEachConcurrent<T>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await task(items[index]!, index); } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function containedPath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);
  if (!candidate.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Release file path ${relativePath} escapes its tree`);
  return candidate;
}

export class ReleaseFollower {
  private timer: Timer | undefined;
  private active: Promise<void> | null = null;
  private stopped = false;
  private readonly reportedFailures = new Set<string>();
  private reportedMachine = false;

  constructor(private readonly options: ReleaseFollowerOptions) {}

  /** Report only committed machine generations. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.nudge(); }, this.options.intervalMs ?? 20_000);
    await this.nudge();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One convergence pass now; a pass already in flight is awaited instead of doubled. */
  nudge(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.converge()
      .catch((error) => this.options.onError?.(error))
      .finally(() => { this.active = null; });
    return this.active;
  }

  private async converge(): Promise<void> {
    if (this.stopped) return;
    const status = await this.options.authority.deploymentStatus();
    // The child becomes healthy before its complete host is committed. It must not
    // report success or request another update in that window.
    if (await readJson(join(this.options.environmentRoot, 'machine-update.json'))) return;
    const updateFailure = await readJson<{ sha: string | null; hash: string; error: string }>(join(this.options.environmentRoot, 'machine-update-failure.json'));
    if (updateFailure?.sha) await this.reportFailure(updateFailure.sha, 'machine', updateFailure.error);
    if (this.options.hostUrl && this.options.controlToken && this.options.generation
      && process.env.GITSPACE_MACHINE_RUNTIME_PATH && !process.env.GITSPACE_HOST_PID
      && updateFailure?.hash !== this.options.generation) {
      const legacyHost = await this.hostStatus();
      if (legacyHost.machineHash !== this.options.generation || legacyHost.machineReleaseSha !== this.options.runningMachineSha) return;
      // The previous host committed only machine.js; promote the authenticated
      // candidate to a whole-host release without mutating the distribution.
      await requestMachineUpdate({
        version: 1, path: process.env.GITSPACE_MACHINE_RUNTIME_PATH,
        hash: this.options.generation, releaseSha: this.options.runningMachineSha,
      }, this.options.hostUrl, this.options.controlToken);
      return;
    }
    const desired = status.desired;
    const machineRecord = status.releases.find((release) => release.sha === desired.machine);
    const frontendRecord = status.releases.find((release) => release.sha === desired.frontend);
    if (!this.options.hostUrl || !this.options.controlToken) {
      await this.reportMachineApplied();
      return;
    }
    const host = await this.hostStatus();
    await this.reportMachineApplied(host);
    if (desired.machine !== null && host.lastLaunch?.sha === desired.machine && host.lastLaunch.target === 'machine' && host.lastLaunch.status === 'failed') {
      await this.reportFailure(desired.machine, 'machine', host.lastLaunch.error ?? 'Host rolled the release back');
    }
    if (desired.frontend === null && host.frontendReleaseSha !== null) await this.launchChannel('frontend');
    if (desired.machine === null && host.machineReleaseSha !== null) await this.launchChannel('machine');
    const wantsMachine = machineRecord?.artifacts.machine
      && machineRecord.status.machines[this.options.machineId] !== 'failed'
      && !this.reportedFailures.has(`machine:${machineRecord.sha}`)
      && machineRecord.sha !== this.options.runningMachineSha && host.machineReleaseSha !== machineRecord.sha;
    const wantsFrontend = frontendRecord?.artifacts.frontend
      && host.frontendReleaseSha !== frontendRecord.sha && host.frontendHash !== frontendRecord.artifacts.frontend.hash;
    if (wantsFrontend && frontendRecord?.artifacts.frontend) await this.launchFrontend(frontendRecord, frontendRecord.artifacts.frontend);
    if (wantsMachine && machineRecord?.artifacts.machine) {
      try {
        const { path, manifest } = await this.downloadExecutable(machineRecord.artifacts.machine, 'machine');
        await this.launch(machineRecord.sha, 'machine', {
          entrypoint: 'machine-daemon', target: 'machine', applies: ['machine'], path, hash: manifest.treeHash, sha: machineRecord.sha,
        });
      } catch (error) {
        await this.reportFailure(machineRecord.sha, 'machine', error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }

  private async reportMachineApplied(host?: EnvironmentStatus): Promise<void> {
    const { runningMachineSha, generation } = this.options;
    if (!generation || this.reportedMachine) return;
    if (host && (host.machineHash !== generation || host.machineReleaseSha !== runningMachineSha)) return;
    if (host) {
      const committedHost = await readJson<MachineSelection>(join(this.options.environmentRoot, 'host-selection.json'));
      if (process.env.GITSPACE_HOST_HASH !== generation || committedHost?.hash !== generation || committedHost.releaseSha !== runningMachineSha) return;
    }
    if (runningMachineSha === null) await this.options.authority.reportMachineChannelApplied({ target: 'machine', generation });
    else await this.options.authority.reportMachineApplied({ sha: runningMachineSha, target: 'machine', generation, status: 'applied' });
    this.reportedMachine = true;
  }

  private async downloadExecutable(
    artifact: ReleaseArtifact,
    target: 'machine',
  ): Promise<{ path: string; manifest: ExecutableArtifactManifest }> {
    const bytes = await this.options.blobs.get(artifact.key, artifact.hash);
    if (!bytes) throw new Error(`Executable manifest ${artifact.key} is missing`);
    const manifest = parseExecutableArtifactManifest(bytes, { target, manifestHash: artifact.hash, size: artifact.size });
    const expected = { target, hash: manifest.treeHash, manifestHash: artifact.hash };
    const candidate = join(this.options.environmentRoot, 'candidates', `${target}-${artifact.hash.slice(7)}`);
    const existing = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // Existing candidates may still have active children: never overwrite or remove them.
    if (existing) return { path: candidate, manifest: await validateExecutableArtifact(candidate, expected) };
    const staging = `${candidate}.download-${crypto.randomUUID()}`;
    await mkdir(staging, { recursive: true });
    try {
      for (const file of manifest.files) {
        const chunks = file.chunks;
        const destination = containedPath(staging, file.path);
        await mkdir(dirname(destination), { recursive: true });
        const handle = await open(destination, 'wx');
        try {
          for (const chunk of chunks) {
            const content = await this.options.blobs.get(chunk.key, chunk.hash);
            if (!content) throw new Error(`Executable chunk for ${file.path} is missing`);
            if (content.byteLength !== chunk.size || sha256(content) !== chunk.hash) throw new Error(`Executable file integrity mismatch: ${file.path}`);
            await handle.writeFile(content);
          }
          await handle.chmod(file.mode);
        } finally {
          await handle.close();
        }
      }
      await writeFile(executableManifestPath(staging), bytes);
      await validateExecutableArtifact(staging, expected);
      await rename(executableManifestPath(staging), executableManifestPath(candidate));
      await rename(staging, candidate);
      return { path: candidate, manifest };
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(executableManifestPath(staging), { force: true });
    }
  }

  private async launchFrontend(record: ReleaseRecord, artifact: ReleaseArtifact): Promise<void> {
    const keys = releaseObjectKeys(record.sha);
    const candidate = join(this.options.environmentRoot, 'candidates', `frontend-${record.sha}`);
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    const manifestBytes = await this.options.blobs.get(keys.frontendManifest);
    if (!manifestBytes) throw new Error(`Release ${record.sha} frontend manifest is missing`);
    const manifest = frontendManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    await forEachConcurrent(manifest.files, FRONTEND_TRANSFER_CONCURRENCY, async (file) => {
      const bytes = await this.options.blobs.get(`${artifact.key}/${file.path}`, file.hash);
      if (!bytes) throw new Error(`Release ${record.sha} frontend file ${file.path} is missing`);
      const target = containedPath(candidate, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    });
    const hash = await hashArtifactPath(candidate);
    if (hash !== artifact.hash) throw new Error(`Release ${record.sha} frontend tree hashed ${hash}, expected ${artifact.hash}`);
    await this.launch(record.sha, 'frontend', { entrypoint: 'frontend', target: 'frontend', applies: ['frontend'], path: candidate, hash, sha: record.sha });
  }

  private async launchChannel(target: 'machine' | 'frontend'): Promise<void> {
    const response = await fetch(`${this.options.hostUrl}/__environment/channel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const outcome = environmentLaunchResponseSchema.parse(await response.json());
    if (!response.ok || outcome.status === 'failed') throw new Error(`Channel ${target} activation failed: ${outcome.error ?? response.status}`);
  }

  private async launch(sha: string, target: 'machine' | 'frontend', input: EnvironmentLaunchRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.options.hostUrl}/__environment/launch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.controlToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    } catch (error) {
      // A machine swap retires this process mid-request; the successor reports the outcome.
      console.log(`[gitspace-deploy] host did not answer the ${input.entrypoint} launch: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const outcome = environmentLaunchResponseSchema.safeParse(await response.json());
    if (!outcome.success) throw new Error(`Host launch answered ${response.status} without a launch result`);
    if (outcome.data.status === 'failed') {
      if (target === 'machine') await this.reportFailure(sha, target, outcome.data.error ?? 'Host rolled the release back');
      else throw new Error(`Frontend release ${sha} failed: ${outcome.data.error ?? 'unknown'}`);
    }
  }

  private async reportFailure(sha: string, target: 'machine', error: string): Promise<void> {
    const key = `${target}:${sha}`;
    if (this.reportedFailures.has(key)) return;
    const generation = this.options.generation;
    console.error(`[gitspace-deploy] ${target} on ${this.options.machineId} failed release ${sha}: ${error}`);
    await this.options.authority.reportMachineApplied({ sha, target, generation: generation ?? 'unknown', status: 'failed', error });
    this.reportedFailures.add(key);
  }

  private async hostStatus(): Promise<EnvironmentStatus> {
    const response = await fetch(`${this.options.hostUrl}/__environment/status`, {
      headers: { authorization: `Bearer ${this.options.controlToken}` },
    });
    if (!response.ok) throw new Error(`Host status answered ${response.status}`);
    return environmentStatusSchema.parse(await response.json());
  }
}
