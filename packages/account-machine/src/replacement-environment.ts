import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  DeploymentEngine,
  DeploymentJournal,
  DeploymentSqliteConnection,
  FrontendReplacementDriver,
  MachineReplacementDriver,
  createDeploymentPlan,
  deploymentSqliteErrorDetails,
  hashArtifactPath,
  withDeploymentSqliteContext,
  type DeploymentArtifact,
  type FrontendReplacementHost,
  type MachineGenerationPointer,
  type MachineReplacementHost,
} from '@gitspace/deployment';
import { z } from 'zod';
import { prepareMachineNativeRuntime } from '../../deployment/src/native-runtime.js';
import { executableManifestPath, parseExecutableArtifactManifest, validateExecutableArtifact } from '@gitspace/account-omp/manifest';
import { atomicJson, readJson, requestMachineUpdate } from './machine-update.js';
import type { MachineSelection } from './machine-update.js';

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
  status: z.enum(['applied', 'pending', 'failed']),
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
  process: Bun.Subprocess;
  url: string;
  stopping?: true;
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

function openHostDeploymentJournal(root: string): DeploymentJournal {
  const path = join(root, 'deployment.db');
  const journal = new DeploymentJournal(path);
  if (!existsSync(join(root, 'gitspace.db'))) return journal;
  const connection = new DeploymentSqliteConnection(path, { strict: true });
  const database = connection.database;
  let failed = false;
  try {
    connection.registerDatabase('runtime', join(root, 'gitspace.db'));
    connection.run('host.migration.attach-runtime', () => database.query('ATTACH DATABASE ? AS runtime').run(join(root, 'gitspace.db')));
    connection.captureConfiguration();
    const tables = connection.run('host.migration.probe-tables', () => database.query<{ name: string }, []>(
      "SELECT name FROM runtime.sqlite_master WHERE type = 'table' AND name IN ('deployment_runs', 'deployment_steps')",
    ).all());
    if (tables.length === 0) return journal;
    if (tables.length !== 2) throw new Error('Legacy deployment journal is incomplete');
    // Commit the destination first. If interrupted before removing the old tables,
    // retry copies missing rows without overwriting newer recovery state here.
    connection.transaction('host.migration.copy-journal', () => {
      connection.run('host.migration.copy-runs', () => database.exec('INSERT INTO deployment_runs SELECT * FROM runtime.deployment_runs WHERE true ON CONFLICT(id) DO NOTHING'));
      connection.run('host.migration.copy-steps', () => database.exec('INSERT INTO deployment_steps SELECT * FROM runtime.deployment_steps WHERE true ON CONFLICT(run_id, attempt, entrypoint) DO NOTHING'));
    });
    connection.transaction('host.migration.drop-legacy-journal', () => {
      connection.run('host.migration.drop-legacy-steps', () => database.exec('DROP TABLE runtime.deployment_steps;'));
      connection.run('host.migration.drop-legacy-runs', () => database.exec('DROP TABLE runtime.deployment_runs;'));
    });
    return journal;
  } catch (error) {
    failed = true;
    try {
      journal.close();
    } catch {
      // The instrumented close records its failure; retain the migration error.
    }
    throw error;
  } finally {
    if (failed) {
      try {
        connection.close();
      } catch {
        // The instrumented close records its failure; retain the migration error.
      }
    } else {
      connection.close();
    }
  }
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

async function waitForReady(process: Bun.Subprocess, hash: string): Promise<string> {
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let forwarding = false;
  let deadline: Timer | undefined;
  const pump = async (): Promise<string> => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Machine generation ${hash} closed stdout before readiness`);
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        console.log(`[machine ${hash.slice(7, 15)}] ${line}`);
        const match = /GitSpace RPC ready at (http:\/\/[^/]+)\/rpc/u.exec(line);
        if (match) {
          forwarding = true;
          void forwardReader(reader, decoder, `[machine ${hash.slice(7, 15)}] `);
          return match[1]!;
        }
      }
    }
  };
  try {
    return await Promise.race([
      pump(),
      process.exited.then((code) => { throw new Error(`Machine generation ${hash} exited with ${code} before readiness`); }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`Machine generation ${hash} did not become ready within 120000ms`)), 120_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    if (!forwarding) void reader.cancel().catch(() => undefined);
  }
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
        if (new URL(request.url).pathname !== '/health' && existsSync(join(options.root, 'machine-update.json'))) {
          return new Response('Complete machine update is not committed', { status: 503 });
        }
        if (!this.accepting || !this.activeUrl) {
          return new Response('GitSpace environment is replacing', { status: 503 });
        }
        const source = new URL(request.url);
        const target = new URL(`${source.pathname}${source.search}`, this.activeUrl);
        return fetch(new Request(target, request));
      },
    });
    options.rpcPort = this.proxy.port!;
  }

  async stopAdmissions(): Promise<void> { this.accepting = false; }
  async drainRpc(): Promise<void> {}
  async drainWorkers(): Promise<void> {
    try {
      if (this.current) await this.stopGeneration(this.current);
    } catch (error) {
      // Only a predecessor that has not received SIGTERM can safely resume admissions.
      if (this.activeUrl && this.current && !this.running.get(this.current.socketPath)?.stopping) this.accepting = true;
      throw error;
    }
  }
  async currentGeneration(): Promise<MachineGenerationPointer | null> { return this.current; }

  async checkpointDatabase(): Promise<string> {
    const checkpoint = join(this.options.root, 'checkpoints', crypto.randomUUID());
    await mkdir(checkpoint, { recursive: true });
    const databasePath = join(this.options.root, 'gitspace.db');
    if (existsSync(databasePath)) {
      const connection = new DeploymentSqliteConnection(databasePath, { readonly: true, strict: true });
      let failed = false;
      try {
        // A byte copy misses committed WAL pages when another connection remains open.
        connection.run('host.checkpoint.vacuum-into', () => connection.database.query('VACUUM INTO ?').run(join(checkpoint, 'gitspace.db')));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) {
          try {
            connection.close();
          } catch {
            // The instrumented close records its failure; retain the checkpoint error.
          }
        } else {
          connection.close();
        }
      }
    }
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
    const response = await fetch(new URL('/health', generation.url), { signal: AbortSignal.timeout(30_000) });
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
    console.info(JSON.stringify({
      event: 'native_replacement', machineId: this.options.machineId, operation: 'stop',
      generation: generation.hash, mode, stage: 'shutdown', outcome: 'start',
    }));
    if (mode === 'replace' && !running.stopping && running.process.exitCode === null) {
      try {
        const response = await fetch(new URL('/__control/retire', running.url), {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.controlToken}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Retirement answered HTTP ${response.status}`);
        const acknowledged = z.object({ stopMode: z.literal('replace') }).safeParse(await response.json());
        if (!acknowledged.success) throw new Error('Retirement did not acknowledge retained workspace ownership');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          event: 'native_replacement', machineId: this.options.machineId, operation: 'retire',
          generation: generation.hash, stage: 'retirement', outcome: 'failure', error: message,
        }));
        throw new Error(`Machine ${this.options.machineId} generation ${generation.hash} retirement failed: ${message}`, { cause: error });
      }
    }
    let deadline: Timer | undefined;
    try {
      if (!running.stopping && running.process.exitCode === null) {
        running.process.kill('SIGTERM');
        running.stopping = true;
      }
      const exitCode = await Promise.race([
        running.process.exited,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Graceful shutdown did not finish within 120000ms; the generation remains fenced and no replacement may start')), 120_000);
        }),
      ]);
      console.info(JSON.stringify({
        event: 'native_replacement', machineId: this.options.machineId, operation: 'stop',
        generation: generation.hash, mode, stage: 'shutdown', outcome: 'exited', exitCode,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: 'native_replacement', machineId: this.options.machineId, operation: 'stop',
        generation: generation.hash, mode, stage: 'shutdown', outcome: 'failure', error: message,
      }));
      throw new Error(`Machine ${this.options.machineId} generation ${generation.hash} shutdown failed: ${message}`, { cause: error });
    } finally {
      clearTimeout(deadline);
    }
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
    if (await hashArtifactPath(pointer.artifactPath) !== pointer.hash) throw new Error('Machine generation integrity mismatch before start');
    await prepareMachineNativeRuntime(pointer.artifactPath);
    const bootstrap = this.options.bootstrap;
    const releaseSha = this.releaseShas.get(pointer.socketPath) ?? null;
    const process = Bun.spawn([globalThis.process.execPath, join(pointer.artifactPath, 'machine.js')], {
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
        GITSPACE_MACHINE_RUNTIME_PATH: pointer.artifactPath,
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
    try {
      const generation = { pointer, process, url: await waitForReady(process, pointer.hash) };
      this.running.set(pointer.socketPath, generation);
      await atomicJson(join(this.options.root, 'host-machine.json'), {
        pid: process.pid, hostPid: globalThis.process.pid, url: generation.url, hash: pointer.hash,
      });
      return generation;
    } catch (error) {
      // A failed startup must not keep writing the shared disk during rollback.
      // It has no admitted RPCs or acknowledged retirement endpoint yet.
      if (process.exitCode === null) process.kill('SIGKILL');
      await process.exited;
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: 'native_replacement', machineId: this.options.machineId, operation: 'start',
        generation: pointer.hash, releaseSha, stage: 'readiness', outcome: 'failure', error: message,
      }));
      throw new Error(`Machine ${this.options.machineId} generation ${pointer.hash} readiness failed: ${message}`, { cause: error });
    }
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
        if (request.method !== 'GET' && existsSync(join(options.root, 'machine-update.json'))) {
          return new Response('Complete machine update is not committed', { status: 503 });
        }
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
            return Response.json(launched, { status: launched.status === 'failed' ? 409 : launched.status === 'pending' ? 202 : 200 });
          }
          const parsed = environmentLaunchRequestSchema.safeParse(await request.json());
          if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
          const launched = await control.launch(parsed.data);
          return Response.json(launched, { status: launched.status === 'failed' ? 409 : launched.status === 'pending' ? 202 : 200 });
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
    this.journal = openHostDeploymentJournal(options.root);
    this.frontend = new FrontendHost(options, {
      launch: (input) => this.launch(input),
      channel: (input) => this.channel(input),
      status: () => this.status(),
    });
    this.hostUrl = `http://127.0.0.1:${this.frontend.server.port}`;
    this.machine = new MachineHost(options, this.hostUrl);
    this.machineHost = this.machine;
    this.frontendHost = this.frontend;
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
  async bootMachine(channelPath: string, manifestHash?: string, hostSelection?: MachineSelection): Promise<void> {
    if (this.machineHash !== null) throw new Error('Machine bootstrap requires an unstarted machine host');
    let channelHash: `sha256:${string}`;
    if (hostSelection && !existsSync(join(channelPath, 'host-runtime.js'))) {
      // Retain an incompatible legacy channel only as an explicit rollback
      // choice. Never validate or execute it while booting a complete selection;
      // the update preflight rejects this old format before draining anything.
      channelHash = await hashArtifactPath(channelPath);
    } else if (manifestHash) {
      const manifest = parseExecutableArtifactManifest(await readFile(executableManifestPath(channelPath)), { target: 'machine', manifestHash });
      await validateExecutableArtifact(channelPath, { target: 'machine', hash: manifest.treeHash, manifestHash });
      channelHash = manifest.treeHash;
    } else {
      // Local/test environments supply artifacts directly; production hosts pass their embedded trust anchor.
      channelHash = await hashArtifactPath(channelPath);
    }
    const channel: DeploymentArtifact = {
      entrypoint: 'machine-daemon', path: channelPath, hash: channelHash, dependsOn: [],
    };
    let selection: z.infer<typeof machineSelectionSchema> | null = null;
    try {
      selection = machineSelectionSchema.parse(JSON.parse(await readFile(join(this.options.root, 'machine-selection.json'), 'utf8')));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const selected = hostSelection ?? (selection?.releaseSha ? selection : null);
    if (selected && await hashArtifactPath(selected.path) !== selected.hash) throw new Error('Selected machine release hash mismatch');
    this.channelArtifacts.set('machine', channel);
    await this.deploy({
      artifacts: [selected ? { ...channel, path: selected.path, hash: selected.hash as `sha256:${string}` } : channel],
      releaseSha: selected?.releaseSha ?? null,
      revision: selected?.releaseSha ?? 'bundled',
      dirty: false,
    });
  }

  /** Frontend selection is independent of machine replacement and survives host restarts. */
  async restoreFrontend(): Promise<void> {
    const selected = await readJson<MachineSelection>(join(this.options.root, 'frontend-selection.json'));
    const channel = await readJson<DeploymentArtifact>(join(this.options.root, 'frontend-channel.json'));
    if (channel) this.channelArtifacts.set('frontend', channel);
    if (!selected) return;
    await this.deploy({
      artifacts: [{ entrypoint: 'frontend', path: selected.path, hash: selected.hash as `sha256:${string}`, dependsOn: ['machine-daemon'] }],
      releaseSha: selected.releaseSha, releaseTargets: ['frontend'], revision: selected.releaseSha ?? 'channel', dirty: false,
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
    // Reject missing, tampered or incompatible native payloads before stopping a healthy predecessor.
    for (const artifact of changed) {
      if (artifact.entrypoint !== 'machine-daemon') continue;
      if (await hashArtifactPath(artifact.path) !== artifact.hash) throw new Error('Machine candidate integrity mismatch');
      await prepareMachineNativeRuntime(artifact.path);
    }
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
    if (executed.status === 'error') {
      console.error(JSON.stringify({
        event: 'native_replacement', machineId: this.options.machineId, operation: 'replace',
        operationId: executed.error.deploymentId, stage: executed.error.phase ?? 'execute',
        generation: changed.find((artifact) => artifact.entrypoint === executed.error.entrypoint)?.hash ?? null,
        activeGeneration: this.machineHash, releaseSha: input.releaseSha,
        outcome: 'failure', error: executed.error.message,
      }));
      throw executed.error;
    }
    for (const [target, artifact] of channelCandidates) this.channelArtifacts.set(target, artifact);
    for (const artifact of changed) {
      if (artifact.entrypoint === 'machine-daemon') {
        this.machineHash = artifact.hash;
        this.machineReleaseSha = nextMachineReleaseSha;
      }
      if (artifact.entrypoint === 'frontend') {
        this.frontendHash = artifact.hash;
        this.frontendReleaseSha = input.releaseSha;
        await atomicJson(join(this.options.root, 'frontend-selection.json'), {
          version: 1, path: artifact.path, hash: artifact.hash, releaseSha: input.releaseSha,
        });
        const channel = this.channelArtifacts.get('frontend');
        if (channel) await atomicJson(join(this.options.root, 'frontend-channel.json'), channel);
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
    return withDeploymentSqliteContext({ releaseSha: input.sha, target: input.target }, async (): Promise<EnvironmentLaunchResponse> => {
      try {
        if (input.target === 'omp' || input.applies.includes('omp')) {
          throw new Error('OMP releases must be activated by the OMP process runtime');
        }
        if (input.target === 'machine' && process.env.GITSPACE_HOST_PID === String(process.pid)) {
          const update = this.queue.then(() => requestMachineUpdate({ version: 1, path: input.path, hash: input.hash, releaseSha: input.sha }, this.hostUrl, this.options.controlToken));
          this.queue = update.catch(() => undefined);
          await update;
          return { status: 'pending', hash: input.hash, error: null };
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
        console.error(JSON.stringify({
          event: 'native_replacement', machineId: this.options.machineId, operation: 'launch',
          entrypoint: input.entrypoint, releaseSha: input.sha, target: input.target,
          stage: 'launch', outcome: 'failure', error: deploymentSqliteErrorDetails(error),
        }));
        this.lastLaunch = { sha: input.sha, entrypoint: input.entrypoint, target: input.target, status: 'failed', error: message };
        return { status: 'failed', hash: input.hash, error: message };
      }
    });
  }

  private channel(input: EnvironmentChannelRequest): Promise<EnvironmentLaunchResponse> {
    const run = this.queue.then(async (): Promise<EnvironmentLaunchResponse> => {
      const entrypoint = input.target === 'machine' ? 'machine-daemon' : 'frontend';
      const retained = this.channelArtifacts.get(input.target);
      try {
        if (!retained) throw new Error(`No retained ${input.target} channel artifact is available`);
        if (input.target === 'machine' && process.env.GITSPACE_HOST_PID === String(process.pid)) {
          await requestMachineUpdate({ version: 1, path: retained.path, hash: retained.hash, releaseSha: null }, this.hostUrl, this.options.controlToken);
          return { status: 'pending', hash: retained.hash, error: null };
        }
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
    await this.queue;
    await this.machine.close();
    this.journal.close();
  }
}
