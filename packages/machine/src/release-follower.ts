import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { hashArtifactPath } from '@gitspace/deployment';
import type { DeploymentStatus, ReleaseArtifact, ReleaseRecord } from '@gitspace/protocol';
import { z } from 'zod';
import { environmentLaunchResponseSchema, environmentStatusSchema, type EnvironmentLaunchRequest, type EnvironmentStatus } from './replacement-environment.js';

/**
 * Convergence on the tenant's `desired` release. Every generation polls
 * `deploy.status`; when desired points somewhere else it downloads the machine
 * bundle (and frontend tree) from the data bucket, verifies it, and asks its
 * host to swap. The successor reports itself applied on start; a rolled-back
 * swap is reported failed by whichever generation the host answers.
 */

/** Sibling of `releases/<sha>/machine.js`: the drizzle folder the bundle migrates with, inlined as one object. */
export const machineMigrationsManifestSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});
export type MachineMigrationsManifest = z.infer<typeof machineMigrationsManifestSchema>;

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
  reportMachineApplied(input: { sha: string; generation: string; status: 'applied' | 'failed'; error?: string }): Promise<ReleaseRecord>;
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
  /** `GITSPACE_RELEASE_SHA`: the release this generation was started from, null for a local build. */
  runningSha: string | null;
  /** `GITSPACE_GENERATION_HASH`. */
  generation: string | null;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface ReleaseObjectKeys {
  worker: string;
  machine: string;
  machineMigrations: string;
  frontendManifest: string;
  /** Prefix of the frontend tree; files live at `<frontend>/<path>`. */
  frontend: string;
}

export function releaseObjectKeys(sha: string): ReleaseObjectKeys {
  return {
    worker: `releases/${sha}/worker.mjs`,
    machine: `releases/${sha}/machine.js`,
    machineMigrations: `releases/${sha}/machine.migrations.json`,
    frontendManifest: `releases/${sha}/frontend.manifest.json`,
    frontend: `releases/${sha}/frontend`,
  };
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

  constructor(private readonly options: ReleaseFollowerOptions) {}

  /** Reports this generation applied when it came from a release, then polls. */
  async start(): Promise<void> {
    if (this.options.runningSha && this.options.generation) {
      try {
        await this.options.authority.reportMachineApplied({ sha: this.options.runningSha, generation: this.options.generation, status: 'applied' });
        console.log(`[gitspace-deploy] machine ${this.options.machineId} running release ${this.options.runningSha}`);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    this.timer = setInterval(() => { void this.nudge(); }, this.options.intervalMs ?? 20_000);
    await this.nudge();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
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
    const desired = status.desired;
    if (!desired.sha) return;
    const record = status.releases.find((release) => release.sha === desired.sha);
    if (!record) return;
    if (!this.options.hostUrl || !this.options.controlToken) return;
    const host = await this.hostStatus();
    if (host.lastLaunch?.sha === desired.sha && host.lastLaunch.status === 'failed') {
      await this.reportFailure(desired.sha, host.lastLaunch.error ?? 'Host rolled the release back');
      return;
    }
    if (record.status.machines[this.options.machineId] === 'failed') return;
    const wantsMachine = desired.targets.includes('machine') && record.artifacts.machine !== null
      && desired.sha !== this.options.runningSha && host.releaseSha !== desired.sha;
    // Same rule as the machine: only when the host is not already on this
    // release. A host that rebuilt the same release locally (the dev watcher)
    // has a newer tree than the staged one and must not be dragged back.
    const wantsFrontend = desired.targets.includes('frontend') && record.artifacts.frontend !== null
      && host.releaseSha !== desired.sha && host.frontendHash !== record.artifacts.frontend.hash;
    // The frontend goes first: swapping the machine retires this process, and the successor would only re-discover the frontend on its next poll.
    if (wantsFrontend && record.artifacts.frontend) await this.launchFrontend(record, record.artifacts.frontend);
    if (wantsMachine && record.artifacts.machine) await this.launchMachine(record, record.artifacts.machine);
  }

  private async launchMachine(record: ReleaseRecord, artifact: ReleaseArtifact): Promise<void> {
    const keys = releaseObjectKeys(record.sha);
    const candidate = join(this.options.environmentRoot, 'candidates', `machine-${record.sha}`);
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    const bundle = await this.options.blobs.get(artifact.key, artifact.hash);
    if (!bundle) throw new Error(`Release ${record.sha} machine bundle ${artifact.key} is missing`);
    await writeFile(join(candidate, 'machine.js'), bundle);
    const migrationsBytes = await this.options.blobs.get(keys.machineMigrations);
    if (!migrationsBytes) throw new Error(`Release ${record.sha} machine migrations are missing`);
    const migrations = machineMigrationsManifestSchema.parse(JSON.parse(new TextDecoder().decode(migrationsBytes)));
    for (const file of migrations.files) {
      const target = containedPath(join(candidate, 'drizzle'), file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    console.log(`[gitspace-deploy] machine ${this.options.machineId} downloaded release ${record.sha}; asking host to swap`);
    await this.launch(record.sha, { entrypoint: 'machine-daemon', path: candidate, hash: await hashArtifactPath(candidate), sha: record.sha });
  }

  private async launchFrontend(record: ReleaseRecord, artifact: ReleaseArtifact): Promise<void> {
    const keys = releaseObjectKeys(record.sha);
    const candidate = join(this.options.environmentRoot, 'candidates', `frontend-${record.sha}`);
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    const manifestBytes = await this.options.blobs.get(keys.frontendManifest);
    if (!manifestBytes) throw new Error(`Release ${record.sha} frontend manifest is missing`);
    const manifest = frontendManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    for (const file of manifest.files) {
      const bytes = await this.options.blobs.get(`${artifact.key}/${file.path}`, file.hash);
      if (!bytes) throw new Error(`Release ${record.sha} frontend file ${file.path} is missing`);
      const target = containedPath(candidate, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const hash = await hashArtifactPath(candidate);
    if (hash !== artifact.hash) throw new Error(`Release ${record.sha} frontend tree hashed ${hash}, expected ${artifact.hash}`);
    console.log(`[gitspace-deploy] machine ${this.options.machineId} downloaded release ${record.sha} frontend; asking host to swap`);
    await this.launch(record.sha, { entrypoint: 'frontend', path: candidate, hash, sha: record.sha });
  }

  private async launch(sha: string, input: EnvironmentLaunchRequest): Promise<void> {
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
      if (input.entrypoint === 'machine-daemon') await this.reportFailure(sha, outcome.data.error ?? 'Host rolled the release back');
      else throw new Error(`Frontend release ${sha} failed: ${outcome.data.error ?? 'unknown'}`);
    }
  }

  private async reportFailure(sha: string, error: string): Promise<void> {
    if (this.reportedFailures.has(sha)) return;
    this.reportedFailures.add(sha);
    console.error(`[gitspace-deploy] machine ${this.options.machineId} failed release ${sha}: ${error}`);
    await this.options.authority.reportMachineApplied({ sha, generation: this.options.generation ?? 'unknown', status: 'failed', error });
  }

  private async hostStatus(): Promise<EnvironmentStatus> {
    const response = await fetch(`${this.options.hostUrl}/__environment/status`, {
      headers: { authorization: `Bearer ${this.options.controlToken}` },
    });
    if (!response.ok) throw new Error(`Host status answered ${response.status}`);
    return environmentStatusSchema.parse(await response.json());
  }
}
