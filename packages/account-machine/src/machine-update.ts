import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashArtifactPath, DeploymentSqliteConnection, prepareBootstrapMigration } from '@gitspace/deployment';
import { prepareMachineNativeRuntime } from '../../deployment/src/native-runtime.js';
import { executableManifestPath, sha256 } from '@gitspace/account-omp/manifest';

export interface MachineSelection {
  version: 1;
  path: string;
  hash: string;
  releaseSha: string | null;
}
export interface HostMachine {
  pid: number;
  hostPid: number;
  url: string;
  hash: string;
}
interface UpdateTransaction {
  version: 1;
  pid: number;
  hostPid: number;
  machinePid: number;
  predecessor: MachineSelection;
  candidate: MachineSelection;
  phase: 'prepared' | 'stopped' | 'checkpointed' | 'starting' | 'committed' | 'rollback';
  checkpoint: string;
  checkpointComplete?: boolean;
  successorPid?: number;
  legacyHostEntry?: string;
  migration?: boolean;
  error?: string;
  stopRequested?: boolean;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function verifyMachine(selection: MachineSelection): Promise<void> {
  if ((await hashArtifactPath(selection.path)) !== selection.hash)
    throw new Error('Complete machine artifact integrity mismatch');
  for (const file of ['host-runtime.js', 'machine-update.js', 'machine-bootstrap.js', 'machine.js']) {
    if (!existsSync(join(selection.path, file))) throw new Error(`Complete machine artifact missing ${file}`);
  }
}

/** OS-owned SQLite locks disappear on process death, unlike stale PID files. Never unlink these files. */
export function acquireMachineLock(root: string, name: 'host' | 'update'): () => void {
  const connection = new DeploymentSqliteConnection(join(root, `${name}-writer-lock.sqlite`), { strict: true });
  try {
    connection.database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    connection.close();
    throw new Error(`Another ${name} process owns this machine`, { cause: error });
  }
  return () => connection.close();
}
const children = new Map<number, ChildProcess>();
async function detached(entry: string, environment: NodeJS.ProcessEnv): Promise<number> {
  const root = environment.GITSPACE_ENVIRONMENT_ROOT!;
  const logPath =
    environment.GITSPACE_MACHINE_LOG_PATH ??
    (environment.GITSPACE_MACHINE_PID_PATH
      ? join(dirname(environment.GITSPACE_MACHINE_PID_PATH), 'machine.log')
      : join(root, 'machine.log'));
  const log = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry], { env: environment, detached: true, stdio: ['ignore', log, log] });
    const started = Promise.withResolvers<void>();
    child.once('spawn', started.resolve);
    child.once('error', started.reject);
    await started.promise;
    if (!child.pid) throw new Error('Unable to start complete machine process');
    children.set(child.pid, child);
    child.once('exit', () => children.delete(child.pid!));
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

async function parentEnvironment(pid: number): Promise<{ args: string[]; environment: NodeJS.ProcessEnv }> {
  let args: string[];
  let entries: string[];
  if (process.platform === 'linux') {
    args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    entries = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').filter(Boolean);
  } else if (process.platform === 'darwin') {
    // KERN_PROCARGS2 returns the actual argv and environment, without ps quoting/truncation.
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      const mib = new Int32Array([1, 49, pid]);
      const bytes = new Uint8Array(2 * 1024 * 1024);
      const size = new BigUint64Array([BigInt(bytes.length)]);
      if (libc.symbols.sysctl(ptr(mib), 3, ptr(bytes), ptr(size), null, 0) !== 0)
        throw new Error('Cannot read legacy macOS host process environment');
      const count = new DataView(bytes.buffer).getInt32(0, true);
      const end = Number(size[0]);
      let offset = 4;
      while (offset < end && bytes[offset] !== 0) offset++;
      while (offset < end && bytes[offset] === 0) offset++;
      const parts = new TextDecoder().decode(bytes.subarray(offset, end)).split('\0');
      args = parts.slice(0, count);
      entries = parts.slice(count).filter(Boolean);
    } finally {
      libc.close();
    }
  } else throw new Error(`Legacy host discovery is unsupported on ${process.platform}`);
  return {
    args,
    environment: Object.fromEntries(
      entries.map((entry) => {
        const split = entry.indexOf('=');
        return [entry.slice(0, split), entry.slice(split + 1)];
      }),
    ),
  };
}

/** Secrets never enter the update journal; recovery reads the private host control credential. */
export async function requestMachineUpdate(candidate: MachineSelection, hostUrl: string, token: string): Promise<void> {
  await verifyMachine(candidate);
  await prepareMachineNativeRuntime(candidate.path);
  const root = process.env.GITSPACE_ENVIRONMENT_ROOT;
  if (!root) throw new Error('GITSPACE_ENVIRONMENT_ROOT is required');
  const release = acquireMachineLock(root, 'update');
  try {
    const pending = await readJson<UpdateTransaction>(join(root, 'machine-update.json'));
    if (pending) {
      if (alive(pending.pid)) return;
      throw new Error('An interrupted complete-machine update requires bootstrap recovery');
    }
    let environment = { ...process.env };
    let hostPid = Number(process.env.GITSPACE_HOST_PID);
    let legacyHostEntry: string | undefined;
    if (!hostPid) {
      hostPid = process.ppid;
      const parent = await parentEnvironment(hostPid);
      legacyHostEntry = parent.args.find((arg) => arg.endsWith('/host.js'));
      if (
        !legacyHostEntry ||
        parent.environment.GITSPACE_ENVIRONMENT_ROOT !== root ||
        parent.environment.GITSPACE_MACHINE_ID !== process.env.GITSPACE_MACHINE_ID
      ) {
        throw new Error('Cannot authenticate legacy host parent identity');
      }
      environment = {
        ...process.env,
        ...parent.environment,
        GITSPACE_CONTROL_TOKEN: token,
        GITSPACE_RPC_PORT: parent.environment.GITSPACE_RPC_PORT,
        GITSPACE_RPC_HOST: parent.environment.GITSPACE_RPC_HOST,
        GITSPACE_WEB_PORT: parent.environment.GITSPACE_WEB_PORT,
      };
      environment.GITSPACE_BUNDLE_ROOT ??= dirname(legacyHostEntry);
      // Native old CLIs did not pass a PID path; only adopt the conventional file if it names this host.
      const pidPath = join(dirname(root), 'machine.pid');
      if (
        !environment.GITSPACE_MACHINE_PID_PATH &&
        existsSync(pidPath) &&
        Number(await readFile(pidPath, 'utf8')) === hostPid
      )
        environment.GITSPACE_MACHINE_PID_PATH = pidPath;
      // Legacy recovery installs predate embedded machine anchors. Pin the
      // already-installed local manifest only after authenticating its live host;
      // this is not a claim of a publisher-signed channel release.
      environment.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH ??= sha256(
        await readFile(executableManifestPath(join(environment.GITSPACE_BUNDLE_ROOT!, 'machine'))),
      );
      environment.GITSPACE_OMP_MANIFEST_HASH ??= sha256(
        await readFile(executableManifestPath(join(environment.GITSPACE_BUNDLE_ROOT!, 'omp'))),
      );
    } else if (hostPid !== process.pid) {
      // Child RPC bindings are ephemeral. Host startup bindings are passed separately, never inferred from them.
      environment.GITSPACE_RPC_PORT = process.env.GITSPACE_HOST_RPC_PORT;
      environment.GITSPACE_RPC_HOST = process.env.GITSPACE_HOST_RPC_HOST;
      environment.GITSPACE_WEB_PORT = process.env.GITSPACE_HOST_WEB_PORT;
    }
    const predecessor =
      (await readJson<MachineSelection>(join(root, 'host-selection.json'))) ??
      (await readJson<MachineSelection>(join(root, 'machine-selection.json')));
    if (!predecessor) throw new Error('Missing predecessor machine selection');
    if (legacyHostEntry) {
      if ((await hashArtifactPath(predecessor.path)) !== predecessor.hash)
        throw new Error('Predecessor machine integrity mismatch');
    } else await verifyMachine(predecessor);
    const machine = await readJson<HostMachine>(join(root, 'host-machine.json'));
    const machinePid = hostPid === process.pid ? machine?.pid : process.pid;
    const machineUrl = hostPid === process.pid ? machine?.url : process.env.GITSPACE_MACHINE_LOCAL_URL;
    if (!machinePid || !machineUrl) throw new Error('Missing running machine retirement endpoint');
    await atomicJson(join(root, 'host-control.json'), { token });
    if (legacyHostEntry)
      await prepareBootstrapMigration({
        bundleRoot: environment.GITSPACE_BUNDLE_ROOT!,
        environmentRoot: root,
        candidatePath: candidate.path,
        initialMachineManifestHash: environment.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH!,
        initialOmpManifestHash: environment.GITSPACE_OMP_MANIFEST_HASH!,
      });
    const transaction: UpdateTransaction = {
      version: 1,
      pid: process.pid,
      hostPid,
      machinePid,
      predecessor,
      candidate,
      phase: 'prepared',
      checkpoint: join(root, 'checkpoints', `complete-${crypto.randomUUID()}`),
      legacyHostEntry,
      migration: Boolean(legacyHostEntry),
    };
    await atomicJson(join(root, 'machine-update.json'), transaction);
    try {
      transaction.pid = await detached(join(candidate.path, 'machine-update.js'), {
        ...environment,
        GITSPACE_UPDATE_HOST_URL: hostUrl,
        GITSPACE_CONTROL_TOKEN: token,
        GITSPACE_UPDATE_MACHINE_URL: machineUrl,
        GITSPACE_UPDATE_HANDOFF: '1',
      });
      await atomicJson(join(root, 'machine-update.json'), transaction);
    } catch (error) {
      // The prepared journal is intentionally retained: bootstrap can recover even a spawn/fsync failure.
      throw error;
    }
  } finally {
    release();
  }
}

async function waitDead(pid: number, timeout = 150_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`Process ${pid} did not drain; replacement remains fenced`);
    await Bun.sleep(100);
  }
}
async function stopHost(root: string, pid: number, machinePid?: number, failed = false): Promise<void> {
  const machine = await readJson<HostMachine>(join(root, 'host-machine.json'));
  if (machine?.hostPid === pid) machinePid ??= machine.pid;
  if (failed && machine?.hostPid === pid && alive(machine.pid)) {
    await fetch(`${machine.url}/__control/retire`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.GITSPACE_CONTROL_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
  }
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  try {
    await waitDead(pid, failed ? 10_000 : 150_000);
    if (machinePid && alive(machinePid)) process.kill(machinePid, 'SIGTERM');
    if (machinePid) await waitDead(machinePid, failed ? 10_000 : 150_000);
    if (failed) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  } catch (error) {
    if (!failed) throw error;
    // Candidate hosts always lead their own process group. Reap every potential DB writer before restore.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (killError) {
      if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError;
    }
    if (machinePid && alive(machinePid)) process.kill(machinePid, 'SIGKILL');
    await waitDead(pid);
    if (machinePid) await waitDead(machinePid);
  }
  const child = children.get(pid);
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = Promise.withResolvers<void>();
    child.once('exit', () => exited.resolve());
    await exited.promise;
  }
}
async function snapshot(root: string, checkpoint: string): Promise<void> {
  await mkdir(checkpoint, { recursive: true });
  for (const name of ['gitspace.db', 'deployment.db']) {
    if (!existsSync(join(root, name))) continue;
    const connection = new DeploymentSqliteConnection(join(root, name), { readonly: true, strict: true });
    try {
      connection.run('machine.update.checkpoint', () =>
        connection.database.query('VACUUM INTO ?').run(join(checkpoint, name)),
      );
    } finally {
      connection.close();
    }
  }
  for (const file of [
    'machine-selection.json',
    'omp-selection.json',
    'frontend-selection.json',
    'frontend-channel.json',
  ]) {
    if (existsSync(join(root, file))) await cp(join(root, file), join(checkpoint, file));
  }
  for (const name of [
    'gitspace.db',
    'deployment.db',
    'machine-selection.json',
    'omp-selection.json',
    'frontend-selection.json',
    'frontend-channel.json',
  ]) {
    if (!existsSync(join(checkpoint, name))) continue;
    const file = await open(join(checkpoint, name), 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const directory = await open(checkpoint, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function restore(root: string, checkpoint: string): Promise<void> {
  for (const file of [
    'gitspace.db',
    'gitspace.db-wal',
    'gitspace.db-shm',
    'deployment.db',
    'deployment.db-wal',
    'deployment.db-shm',
    'machine-selection.json',
    'omp-selection.json',
    'frontend-selection.json',
    'frontend-channel.json',
  ]) {
    await rm(join(root, file), { force: true });
    if (existsSync(join(checkpoint, file))) await cp(join(checkpoint, file), join(root, file));
  }
}
async function startHost(
  root: string,
  selection: MachineSelection,
  transaction: UpdateTransaction,
  legacy = false,
): Promise<number> {
  if (legacy) {
    if ((await hashArtifactPath(selection.path)) !== selection.hash)
      throw new Error('Predecessor machine integrity mismatch');
  } else await verifyMachine(selection);
  await rm(join(root, 'host-ready.json'), { force: true });
  await rm(join(root, 'host-machine.json'), { force: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITSPACE_HOST_SELECTION: JSON.stringify(selection),
    GITSPACE_UPDATE_OWNER: String(process.pid),
  };
  delete environment.GITSPACE_UPDATE_HANDOFF;
  delete environment.GITSPACE_HOST_PID;
  delete environment.GITSPACE_HOST_HASH;
  transaction.successorPid = await detached(
    legacy ? transaction.legacyHostEntry! : join(selection.path, 'host-runtime.js'),
    environment,
  );
  await atomicJson(join(root, 'machine-update.json'), transaction);
  const pid = transaction.successorPid;
  const deadline = Date.now() + 150_000;
  while (alive(pid)) {
    const ready = legacy
      ? await readJson<HostMachine>(join(root, 'host-machine.json')).then((machine) =>
          machine?.hostPid === pid ? { pid, hash: machine.hash, url: machine.url } : null,
        )
      : await readJson<{ pid: number; hash: string; url: string }>(join(root, 'host-ready.json'));
    if (ready?.pid === pid && ready.hash === selection.hash) {
      const response = await fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (response?.ok) return pid;
    }
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
  }
  throw new Error('Complete successor host failed readiness');
}

export async function runMachineUpdate(): Promise<void> {
  const root = process.env.GITSPACE_ENVIRONMENT_ROOT!;
  const path = join(root, 'machine-update.json');
  if (process.env.GITSPACE_UPDATE_HANDOFF === '1') {
    const deadline = Date.now() + 30_000;
    while ((await readJson<UpdateTransaction>(path))?.pid !== process.pid) {
      if (Date.now() > deadline) throw new Error('Updater handoff was not durably acknowledged');
      await Bun.sleep(50);
    }
  }
  let release: (() => void) | undefined;
  const lockDeadline = Date.now() + 30_000;
  while (!release) {
    try {
      release = acquireMachineLock(root, 'update');
    } catch (error) {
      if (process.env.GITSPACE_UPDATE_HANDOFF !== '1' || Date.now() > lockDeadline) throw error;
      await Bun.sleep(50);
    }
  }
  try {
    const transaction = await readJson<UpdateTransaction>(path);
    if (!transaction) return;
    if (transaction.pid !== process.pid && alive(transaction.pid))
      throw new Error('An updater still owns the transaction');
    await verifyMachine(transaction.candidate);
    transaction.pid = process.pid;
    await atomicJson(path, transaction);
    const migration = transaction.migration
      ? await prepareBootstrapMigration({
          bundleRoot: process.env.GITSPACE_BUNDLE_ROOT!,
          environmentRoot: root,
          candidatePath: transaction.candidate.path,
          initialMachineManifestHash: process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH!,
          initialOmpManifestHash: process.env.GITSPACE_OMP_MANIFEST_HASH!,
        })
      : null;
    try {
      if (transaction.phase === 'prepared') {
        if (!transaction.stopRequested && alive(transaction.machinePid)) {
          const machine = await readJson<HostMachine>(join(root, 'host-machine.json'));
          const url = process.env.GITSPACE_UPDATE_MACHINE_URL ?? machine?.url;
          if (!url) throw new Error('Missing machine retirement endpoint');
          const response = await fetch(`${url}/__control/retire`, {
            method: 'POST',
            headers: { authorization: `Bearer ${process.env.GITSPACE_CONTROL_TOKEN}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok || ((await response.json()) as { stopMode?: string }).stopMode !== 'replace')
            throw new Error('Machine did not acknowledge retained ownership');
        }
        transaction.stopRequested = true;
        await atomicJson(path, transaction);
        await stopHost(root, transaction.hostPid, transaction.machinePid);
        transaction.phase = 'stopped';
        await atomicJson(path, transaction);
      }
      if (transaction.phase === 'stopped') {
        await rm(transaction.checkpoint, { recursive: true, force: true });
        await snapshot(root, transaction.checkpoint);
        transaction.checkpointComplete = true;
        transaction.phase = 'checkpointed';
        await atomicJson(path, transaction);
      }
      if (transaction.phase === 'starting' || transaction.phase === 'rollback')
        throw new Error(transaction.error ?? 'Recovering interrupted complete machine activation');
      if (transaction.phase !== 'committed') {
        transaction.phase = 'starting';
        await atomicJson(path, transaction);
        await atomicJson(join(root, 'machine-selection.json'), transaction.candidate);
        await startHost(root, transaction.candidate, transaction);
        await atomicJson(join(root, 'host-selection.json'), transaction.candidate);
        await migration?.commit();
        transaction.phase = 'committed';
        await atomicJson(path, transaction);
      }
      if (transaction.phase === 'committed' && (!transaction.successorPid || !alive(transaction.successorPid))) {
        await startHost(root, transaction.candidate, transaction);
      }
    } catch (error) {
      transaction.error = String(error);
      // Retirement failure must never turn a still-running predecessor into a second writer.
      if (transaction.phase === 'prepared' && !transaction.stopRequested) {
        await migration?.rollback();
        await atomicJson(join(root, 'machine-update-failure.json'), {
          sha: transaction.candidate.releaseSha,
          hash: transaction.candidate.hash,
          error: String(error),
        });
        await rm(path, { force: true });
        return;
      }
      if (transaction.phase === 'prepared' && (alive(transaction.hostPid) || alive(transaction.machinePid)))
        throw error;
      if (transaction.successorPid) await stopHost(root, transaction.successorPid, undefined, true);
      transaction.phase = 'rollback';
      await atomicJson(path, transaction);
      if (transaction.checkpointComplete) await restore(root, transaction.checkpoint);
      await migration?.rollback();
      if (transaction.legacyHostEntry) await rm(join(root, 'host-selection.json'), { force: true });
      else await atomicJson(join(root, 'host-selection.json'), transaction.predecessor);
      await atomicJson(join(root, 'machine-update-failure.json'), {
        sha: transaction.candidate.releaseSha,
        hash: transaction.candidate.hash,
        error: String(error),
      });
      await startHost(root, transaction.predecessor, transaction, Boolean(transaction.legacyHostEntry));
    }
    await rm(path, { force: true });
    await rm(transaction.checkpoint, { recursive: true, force: true });
  } finally {
    release();
  }
}
if (import.meta.main) await runMachineUpdate();
