import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  DeploymentEngine,
  DeploymentJournal,
  FrontendReplacementDriver,
  MachineReplacementDriver,
  createDeploymentPlan,
  hashArtifactPath,
  type DeploymentArtifact,
  type FrontendReplacementHost,
  type MachineGenerationPointer,
  type MachineReplacementHost,
} from '@gitspace/deployment';
import { z } from 'zod';

const machineSelectionSchema = z.object({
  version: z.literal(1),
  path: z.string().min(1),
  hash: z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]),
  releaseSha: z.string().min(1).nullable(),
});

export interface ReplacementEnvironmentBootstrap {
  projectId: string;
  projectName: string;
  repositoryPath: string;
  baseBranch: string;
  workspaceId: string;
  workspaceName: string;
  workspaceBranch: string;
  workspacePath: string;
}

export interface ReplacementEnvironmentOptions {
  id: string;
  root: string;
  repositoryRoot: string;
  rpcPort: number;
  /** Interface the RPC proxy listens on; the generations behind it always bind loopback. */
  rpcHost?: string;
  webPort: number;
  machineId: string;
  artifactKey: Uint8Array;
  ompAgentDir: string;
  controlToken: string;
  bootstrap?: ReplacementEnvironmentBootstrap;
  environment?: Record<string, string>;
}

/** One replacement: candidate artifacts plus the release identity they came from (null for a local file-save build). */
export interface EnvironmentDeployment {
  artifacts: DeploymentArtifact[];
  releaseSha: string | null;
  releaseTargets?: Array<'machine' | 'omp' | 'frontend'>;
  revision: string;
  dirty: boolean;
}

export interface EnvironmentDeploymentResult {
  /** Entrypoints whose hash differed from the running generation; empty when nothing changed. */
  changed: DeploymentArtifact[];
}

/** `POST /__environment/launch`: a machine asks its host to swap one downloaded release target. */
export const environmentLaunchRequestSchema = z.object({
  entrypoint: z.enum(['machine-daemon', 'frontend']),
  target: z.enum(['machine', 'omp', 'frontend']),
  applies: z.array(z.enum(['machine', 'omp', 'frontend'])).min(1),
  path: z.string().min(1),
  hash: z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]),
  sha: z.string().min(1).max(160),
});
export type EnvironmentLaunchRequest = z.infer<typeof environmentLaunchRequestSchema>;

export const environmentChannelRequestSchema = z.object({
  target: z.enum(['machine', 'frontend']),
});
export type EnvironmentChannelRequest = z.infer<typeof environmentChannelRequestSchema>;

export const environmentLaunchResponseSchema = z.object({
  status: z.enum(['applied', 'failed']),
  hash: z.string().nullable(),
  error: z.string().nullable(),
});
export type EnvironmentLaunchResponse = z.infer<typeof environmentLaunchResponseSchema>;

/** `GET /__environment/status`: running hashes, independent release identities, and the last launch outcome. */
export const environmentStatusSchema = z.object({
  machineHash: z.string().nullable(),
  frontendHash: z.string().nullable(),
  machineReleaseSha: z.string().nullable(),
  ompReleaseSha: z.string().nullable(),
  frontendReleaseSha: z.string().nullable(),
  lastLaunch: z.object({
    sha: z.string().nullable(),
    entrypoint: z.enum(['machine-daemon', 'frontend']),
    target: z.enum(['machine', 'omp', 'frontend']),
    status: z.enum(['applied', 'failed']),
    error: z.string().nullable(),
  }).nullable(),
});
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

interface FrontendHostControl {
  launch(input: EnvironmentLaunchRequest): Promise<EnvironmentLaunchResponse>;
  channel(input: EnvironmentChannelRequest): Promise<EnvironmentLaunchResponse>;
  status(): EnvironmentStatus;
}

interface RunningGeneration {
  pointer: MachineGenerationPointer;
  process: ReturnType<typeof Bun.spawn>;
  url: string;
}

function processEnvironment(extra: Record<string, string>, releaseSha: string | null): Record<string, string> {
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...extra,
  };
  delete environment.GITSPACE_MACHINE_RELEASE_SHA;
  delete environment.GITSPACE_RELEASE_SHA;
  if (releaseSha !== null) environment.GITSPACE_MACHINE_RELEASE_SHA = releaseSha;
  return environment;
}

async function forwardReader(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, prefix: string): Promise<void> {
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      process.stdout.write(prefix + decoder.decode(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function forwardStream(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  await forwardReader(stream.getReader(), new TextDecoder(), prefix);
}

async function waitForReady(process: ReturnType<typeof Bun.spawn>, hash: string): Promise<string> {
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return new Promise((resolveReady, reject) => {
    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Machine generation ${hash} exited before readiness`);
          buffered += decoder.decode(chunk.value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            console.log(`[machine ${hash.slice(7, 15)}] ${line}`);
            const match = /GitSpace RPC ready at (http:\/\/[^/]+)\/rpc/u.exec(line);
            if (match) {
              resolveReady(match[1]!);
              void forwardReader(reader, decoder, `[machine ${hash.slice(7, 15)}] `);
              return;
            }
          }
        }
      } catch (error) {
        reject(error);
      }
    };
    void pump();
  });
}

class MachineHost implements MachineReplacementHost {
  private current: MachineGenerationPointer | null = null;
  private activeUrl: string | null = null;
  private readonly running = new Map<string, RunningGeneration>();
  private accepting = true;
  /** Machine release identities inherited by a successor generation. OMP selects its own artifact. */
  readonly releaseShas = new Map<string, string | null>();
  successorReleaseSha: string | null = null;
  readonly proxy: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: ReplacementEnvironmentOptions, private readonly hostUrl: string) {
    this.proxy = Bun.serve({
      hostname: options.rpcHost ?? '127.0.0.1',
      port: options.rpcPort,
      idleTimeout: 0,
      fetch: (request) => {
        if (!this.accepting || !this.activeUrl) {
          return new Response('GitSpace environment is replacing', { status: 503 });
        }
        const source = new URL(request.url);
        const target = new URL(`${source.pathname}${source.search}`, this.activeUrl);
        return fetch(new Request(target, request));
      },
    });
  }

  async stopAdmissions(): Promise<void> { this.accepting = false; }
  async drainRpc(): Promise<void> {}
  async drainWorkers(): Promise<void> {
    if (this.current) await this.stopGeneration(this.current);
  }
  async currentGeneration(): Promise<MachineGenerationPointer | null> { return this.current; }

  async checkpointDatabase(): Promise<string> {
    const checkpoint = join(this.options.root, 'checkpoints', crypto.randomUUID());
    await mkdir(checkpoint, { recursive: true });
    const databasePath = join(this.options.root, 'gitspace.db');
    if (existsSync(databasePath)) await cp(databasePath, join(checkpoint, 'gitspace.db'));
    return checkpoint;
  }

  async migrateDatabase(_nextGenerationHash: string): Promise<void> {}

  async restoreDatabase(checkpointId: string): Promise<void> {
    const databasePath = join(this.options.root, 'gitspace.db');
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const source = join(checkpointId, 'gitspace.db');
    if (existsSync(source)) await cp(source, databasePath);
  }

  async releaseDatabaseCheckpoint(checkpointId: string): Promise<void> {
    await rm(checkpointId, { recursive: true, force: true });
  }

  async startSuccessor(next: MachineGenerationPointer): Promise<void> {
    this.releaseShas.set(next.socketPath, this.successorReleaseSha);
    await this.ensureGeneration(next);
  }

  async probeSuccessor(next: MachineGenerationPointer): Promise<void> {
    const generation = this.running.get(next.socketPath);
    if (!generation) throw new Error(`Machine generation ${next.hash} is not running`);
    const response = await fetch(new URL('/health', generation.url));
    if (!response.ok) throw new Error(`Machine generation health failed with ${response.status}`);
  }

  async switchActiveSocket(next: MachineGenerationPointer): Promise<void> {
    const generation = await this.ensureGeneration(next);
    const path = join(this.options.root, 'machine-selection.json');
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify({
      version: 1, path: next.artifactPath, hash: next.hash,
      releaseSha: this.releaseShas.get(next.socketPath) ?? null,
    }), { mode: 0o600 });
    await rename(temporary, path);
    this.current = next;
    this.activeUrl = generation.url;
  }

  /** `replace` (the replacement flow) retires the generation first so it keeps possession for its successor; `release` (environment close) lets it hand spaces back to the cloud. */
  async stopGeneration(generation: MachineGenerationPointer, mode: 'replace' | 'release' = 'replace'): Promise<void> {
    const running = this.running.get(generation.socketPath);
    if (!running) return;
    if (mode === 'replace') {
      try {
        await fetch(new URL('/__control/retire', running.url), {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.controlToken}` },
        });
      } catch (error) {
        console.error(`[machine ${generation.hash.slice(7, 15)}] retire failed`, error);
      }
    }
    running.process.kill('SIGTERM');
    await running.process.exited;
    this.running.delete(generation.socketPath);
    if (this.current?.socketPath === generation.socketPath) this.activeUrl = null;
  }

  async resumeAdmissions(): Promise<void> { this.accepting = true; }

  async close(): Promise<void> {
    for (const generation of [...this.running.values()]) await this.stopGeneration(generation.pointer, 'release');
    await this.proxy.stop(true);
  }

  private async ensureGeneration(pointer: MachineGenerationPointer): Promise<RunningGeneration> {
    const existing = this.running.get(pointer.socketPath);
    if (existing) return existing;
    const bootstrap = this.options.bootstrap;
    const releaseSha = this.releaseShas.get(pointer.socketPath) ?? null;
    const process = Bun.spawn(['bun', join(pointer.artifactPath, 'machine.js')], {
      cwd: this.options.repositoryRoot,
      env: processEnvironment({
        ...this.options.environment,
        GITSPACE_ENVIRONMENT_ID: this.options.id,
        GITSPACE_ENVIRONMENT_ROOT: this.options.root,
        GITSPACE_MACHINE_ID: this.options.machineId,
        GITSPACE_ARTIFACT_KEY: Buffer.from(this.options.artifactKey).toString('base64'),
        GITSPACE_OMP_AGENT_DIR: this.options.ompAgentDir,
        GITSPACE_MIGRATIONS_FOLDER: join(pointer.artifactPath, 'drizzle'),
        GITSPACE_GENERATION_HASH: pointer.hash,
        GITSPACE_CONTROL_TOKEN: this.options.controlToken,
        GITSPACE_HOST_URL: this.hostUrl,
        GITSPACE_RPC_HOST: '127.0.0.1',
        GITSPACE_RPC_PORT: '0',
        ...(bootstrap ? {
          GITSPACE_BOOTSTRAP_PROJECT_ID: bootstrap.projectId,
          GITSPACE_BOOTSTRAP_PROJECT_NAME: bootstrap.projectName,
          GITSPACE_BOOTSTRAP_REPOSITORY_PATH: bootstrap.repositoryPath,
          GITSPACE_BOOTSTRAP_BASE_BRANCH: bootstrap.baseBranch,
          GITSPACE_BOOTSTRAP_WORKSPACE_ID: bootstrap.workspaceId,
          GITSPACE_BOOTSTRAP_WORKSPACE_NAME: bootstrap.workspaceName,
          GITSPACE_BOOTSTRAP_WORKSPACE_BRANCH: bootstrap.workspaceBranch,
          GITSPACE_BOOTSTRAP_WORKSPACE_PATH: bootstrap.workspacePath,
        } : {}),
      }, releaseSha),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void forwardStream(process.stderr as ReadableStream<Uint8Array>, `[machine ${pointer.hash.slice(7, 15)}] `);
    const generation = { pointer, process, url: await waitForReady(process, pointer.hash) };
    this.running.set(pointer.socketPath, generation);
    return generation;
  }
}

class FrontendHost implements FrontendReplacementHost {
  private generationPath: string | null = null;
  readonly server: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: ReplacementEnvironmentOptions, control: FrontendHostControl) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: options.webPort,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/rpc' || url.pathname === '/health') {
          return fetch(new Request(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${options.rpcPort}`), request));
        }
        if (url.pathname === '/__environment/health') {
          return Response.json({ status: this.generationPath ? 'ok' : 'starting', generationPath: this.generationPath });
        }
        if (url.pathname === '/__environment/status' || url.pathname === '/__environment/launch' || url.pathname === '/__environment/channel') {
          if (request.headers.get('authorization') !== `Bearer ${options.controlToken}`) {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }
          if (url.pathname === '/__environment/status') return Response.json(control.status());
          if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
          if (url.pathname === '/__environment/channel') {
            const parsed = environmentChannelRequestSchema.safeParse(await request.json());
            if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
            const launched = await control.channel(parsed.data);
            return Response.json(launched, { status: launched.status === 'applied' ? 200 : 409 });
          }
          const parsed = environmentLaunchRequestSchema.safeParse(await request.json());
          if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
          const launched = await control.launch(parsed.data);
          return Response.json(launched, { status: launched.status === 'applied' ? 200 : 409 });
        }
        if (!this.generationPath) return new Response('Frontend generation is not active', { status: 503 });
        const requested = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const candidate = resolve(this.generationPath, requested);
        const rootPrefix = `${resolve(this.generationPath)}${sep}`;
        let file = candidate.startsWith(rootPrefix) ? Bun.file(candidate) : Bun.file(join(this.generationPath, 'index.html'));
        if (!await file.exists()) file = Bun.file(join(this.generationPath, 'index.html'));
        if (!await file.exists()) return new Response('Frontend asset not found', { status: 404 });
        return new Response(file, { headers: { 'content-type': file.type, 'cache-control': 'no-store' } });
      },
    });
  }

  async checkpointClients(_nextHash: string): Promise<void> {}
  async publishGeneration(nextHash: string): Promise<void> {
    this.generationPath = join(this.options.root, 'frontend', 'generations', nextHash.slice('sha256:'.length));
  }
  async probeGeneration(generationPath: string, hash: string): Promise<void> {
    if (!await Bun.file(join(generationPath, 'index.html')).exists()) throw new Error(`Frontend generation ${hash} has no index.html`);
    if (this.generationPath !== generationPath) throw new Error(`Frontend generation ${hash} is not published`);
  }
  async close(): Promise<void> { await this.server.stop(true); }
}

/**
 * Machine + frontend generations behind stable ports. `deploy` is the one
 * replacement path: the self-develop watcher and a release launch both go
 * through the deployment plan and engine, so the journal, rollback, and
 * health probing are identical regardless of where the artifact came from.
 */
export class ReplacementEnvironment {
  readonly machineHost: MachineReplacementHost;
  readonly frontendHost: FrontendReplacementHost;
  /** Where a generation reaches its host (`/__environment/launch`, `/__environment/status`). */
  readonly hostUrl: string;
  private readonly machine: MachineHost;
  private readonly frontend: FrontendHost;
  private readonly journal: DeploymentJournal;
  private readonly engine: DeploymentEngine;
  private machineHash: string | null = null;
  private frontendHash: string | null = null;
  private machineReleaseSha: string | null = null;
  private frontendReleaseSha: string | null = null;
  private readonly channelArtifacts = new Map<EnvironmentChannelRequest['target'], DeploymentArtifact>();
  private lastLaunch: EnvironmentStatus['lastLaunch'] = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly options: ReplacementEnvironmentOptions) {
    if (options.artifactKey.byteLength !== 32) throw new RangeError('Environment artifact key must be 32 bytes');
    this.frontend = new FrontendHost(options, {
      launch: (input) => this.launch(input),
      channel: (input) => this.channel(input),
      status: () => this.status(),
    });
    this.hostUrl = `http://127.0.0.1:${this.frontend.server.port}`;
    this.machine = new MachineHost(options, this.hostUrl);
    this.machineHost = this.machine;
    this.frontendHost = this.frontend;
    this.journal = new DeploymentJournal(join(options.root, 'gitspace.db'));
    this.engine = new DeploymentEngine(this.journal, [
      new MachineReplacementDriver(options.root, this.machine),
      new FrontendReplacementDriver(options.root, this.frontend),
    ]);
  }

  status(): EnvironmentStatus {
    return {
      machineHash: this.machineHash,
      frontendHash: this.frontendHash,
      machineReleaseSha: this.machineReleaseSha,
      ompReleaseSha: null,
      frontendReleaseSha: this.frontendReleaseSha,
      lastLaunch: this.lastLaunch,
    };
  }

  /** Restore an account-selected machine without briefly running the bundled channel. */
  async bootMachine(channelPath: string): Promise<void> {
    if (this.machineHash !== null) throw new Error('Machine bootstrap requires an unstarted machine host');
    const channel: DeploymentArtifact = {
      entrypoint: 'machine-daemon', path: channelPath, hash: await hashArtifactPath(channelPath), dependsOn: [],
    };
    let selection: z.infer<typeof machineSelectionSchema> | null = null;
    try {
      selection = machineSelectionSchema.parse(JSON.parse(await readFile(join(this.options.root, 'machine-selection.json'), 'utf8')));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const selected = selection?.releaseSha ? selection : null;
    if (selected && await hashArtifactPath(selected.path) !== selected.hash) throw new Error('Selected machine release hash mismatch');
    this.channelArtifacts.set('machine', channel);
    await this.deploy({
      artifacts: [selected ? { ...channel, path: selected.path, hash: selected.hash } : channel],
      releaseSha: selected?.releaseSha ?? null,
      revision: selected?.releaseSha ?? 'bundled',
      dirty: false,
    });
  }

  /** Plan and execute a replacement for the artifacts whose hash differs from what is running; serialized. */
  deploy(input: EnvironmentDeployment): Promise<EnvironmentDeploymentResult> {
    const run = this.queue.then(() => this.replace(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async replace(input: EnvironmentDeployment): Promise<EnvironmentDeploymentResult> {
    if (input.releaseTargets?.includes('omp')) throw new Error('OMP releases must be activated by the OMP process runtime');
    const releaseTargets = input.releaseTargets ?? ['machine'];
    const nextMachineReleaseSha = releaseTargets.includes('machine') ? input.releaseSha : this.machineReleaseSha;
    const changed = input.artifacts.filter((artifact) => (
      artifact.entrypoint === 'machine-daemon'
        ? artifact.hash !== this.machineHash || nextMachineReleaseSha !== this.machineReleaseSha
        : artifact.hash !== this.frontendHash || input.releaseSha !== this.frontendReleaseSha
    ));
    if (changed.length === 0) return { changed };
    const machineChanged = changed.some((artifact) => artifact.entrypoint === 'machine-daemon');
    const frontendChanged = changed.some((artifact) => artifact.entrypoint === 'frontend');
    const channelCandidates: Array<[EnvironmentChannelRequest['target'], DeploymentArtifact]> = [];
    if (input.releaseSha === null) {
      for (const artifact of changed) {
        const target = artifact.entrypoint === 'machine-daemon' ? 'machine' : 'frontend';
        if (this.channelArtifacts.has(target)) continue;
        const path = join(this.options.root, 'channel', target, artifact.hash.slice('sha256:'.length));
        await mkdir(join(this.options.root, 'channel', target), { recursive: true });
        await cp(artifact.path, path, { recursive: true });
        if (await hashArtifactPath(path) !== artifact.hash) throw new Error(`Retained ${target} channel artifact hash mismatch`);
        channelCandidates.push([target, { ...artifact, path }]);
      }
    }
    if (machineChanged) this.machine.successorReleaseSha = nextMachineReleaseSha;
    const plan = await createDeploymentPlan({
      source: { projectId: 'gitspace', revision: input.revision, dirty: input.dirty },
      target: {
        environmentId: this.options.id,
        kind: 'sandbox',
        expectedGeneration: `${this.machineHash ?? 'none'}|${this.frontendHash ?? 'none'}`,
      },
      candidateArtifacts: changed,
      currentHashes: {
        ...(this.machineHash && !machineChanged ? { 'machine-daemon': this.machineHash } : {}),
        ...(this.frontendHash && !frontendChanged ? { frontend: this.frontendHash } : {}),
      },
      authority: { kind: 'sandbox', environmentId: this.options.id },
    });
    if (plan.status === 'error') throw plan.error;
    const executed = await this.engine.execute(plan.value);
    if (executed.status === 'error') throw executed.error;
    for (const [target, artifact] of channelCandidates) this.channelArtifacts.set(target, artifact);
    for (const artifact of changed) {
      if (artifact.entrypoint === 'machine-daemon') {
        this.machineHash = artifact.hash;
        this.machineReleaseSha = nextMachineReleaseSha;
      }
      if (artifact.entrypoint === 'frontend') {
        this.frontendHash = artifact.hash;
        this.frontendReleaseSha = input.releaseSha;
      }
    }
    if (frontendChanged && this.frontendHash) {
      // The swap is committed; telling the running machine about the new frontend is advisory.
      await this.publishCodeVersion(this.frontendHash).catch((error) => console.error('[gitspace-host] code-version notification failed', error));
    }
    return { changed };
  }

  /** A generation's request to swap to a release artifact it downloaded; failures roll back inside the engine and are reported, not thrown. */
  private async launch(input: EnvironmentLaunchRequest): Promise<EnvironmentLaunchResponse> {
    try {
      if (input.target === 'omp' || input.applies.includes('omp')) {
        throw new Error('OMP releases must be activated by the OMP process runtime');
      }
      const artifact: DeploymentArtifact = {
        entrypoint: input.entrypoint,
        hash: input.hash,
        path: input.path,
        dependsOn: input.entrypoint === 'frontend' && this.machineHash ? ['machine-daemon'] : [],
      };
      await this.deploy({ artifacts: [artifact], releaseSha: input.sha, releaseTargets: input.applies, revision: input.sha, dirty: false });
      this.lastLaunch = { sha: input.sha, entrypoint: input.entrypoint, target: input.target, status: 'applied', error: null };
      return { status: 'applied', hash: input.hash, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gitspace-host] launch ${input.entrypoint} ${input.sha} failed: ${message}`);
      this.lastLaunch = { sha: input.sha, entrypoint: input.entrypoint, target: input.target, status: 'failed', error: message };
      return { status: 'failed', hash: input.hash, error: message };
    }
  }

  private channel(input: EnvironmentChannelRequest): Promise<EnvironmentLaunchResponse> {
    const run = this.queue.then(async (): Promise<EnvironmentLaunchResponse> => {
      const entrypoint = input.target === 'machine' ? 'machine-daemon' : 'frontend';
      const retained = this.channelArtifacts.get(input.target);
      try {
        if (!retained) throw new Error(`No retained ${input.target} channel artifact is available`);
        await this.replace({
          artifacts: [{ ...retained, dependsOn: input.target === 'frontend' && this.machineHash ? ['machine-daemon'] : [] }],
          releaseSha: null,
          releaseTargets: [input.target],
          revision: `channel:${retained.hash}`,
          dirty: false,
        });
        this.lastLaunch = { sha: null, entrypoint, target: input.target, status: 'applied', error: null };
        return { status: 'applied', hash: retained.hash, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastLaunch = { sha: null, entrypoint, target: input.target, status: 'failed', error: message };
        return { status: 'failed', hash: retained?.hash ?? null, error: message };
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async publishCodeVersion(hash: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.machine.proxy.port}/__control/code-version`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hash }),
    });
    if (!response.ok) throw new Error(`Code-version notification failed with ${response.status}`);
  }

  async close(): Promise<void> {
    await this.frontend.close();
    await this.machine.close();
    this.journal.close();
  }
}
