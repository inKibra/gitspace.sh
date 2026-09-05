#!/usr/bin/env bun
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildInitialRuntime } from '@gitspace/deployment';
import {
  createRelayAuthorization,
  createSignedControlRequest,
  encodeDeviceInviteToken,
  signDeviceInvite,
} from '@gitspace/protocol';
import {
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import { Command } from 'commander';
import openBrowser from 'open';

const VERSION = '0.1.0';
const DEFAULT_API_URL = 'https://api.gitspace.sh';
const CONFIG_ROOT = process.env.GITSPACE_CONFIG_HOME ?? join(homedir(), '.config', 'gitspace');
const CONFIG_PATH = join(CONFIG_ROOT, 'config.json');
const PID_PATH = join(CONFIG_ROOT, 'machine.pid');
const LOG_PATH = join(CONFIG_ROOT, 'machine.log');
const REPOSITORY_ROOT = process.env.GITSPACE_SOURCE_ROOT
  ?? [resolve(import.meta.dir, '../../..'), resolve(import.meta.dir, '../..'), process.cwd()]
    .find((candidate) => existsSync(join(candidate, 'packages/account-machine/src/runtime.ts')))
  ?? resolve(import.meta.dir, '../../..');

interface MachineConfig {
  id: string;
  label: string;
  signingPrivateKey: string;
  exchangePrivateKey: string;
  grant: SignedCredentialAuthorityGrant;
}

interface GitSpaceConfig {
  version: 2;
  apiUrl: string;
  accountUrl: string;
  handle: string;
  userId: string;
  relayUrl: string;
  rootPrivateKey: string;
  rootPublicKey: string;
  vaultKey: string;
  machine?: MachineConfig;
}

function base64(bytes: Uint8Array): string {
  return credentialProtocolBase64.encode(bytes);
}

function recoveryToken(privateKey: Uint8Array): string {
  return `gsr_${base64(privateKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

function recoveryPrivateKey(token: string): Uint8Array {
  if (!token.startsWith('gsr_')) throw new Error('Recovery key must start with gsr_');
  const encoded = token.slice(4).replaceAll('-', '+').replaceAll('_', '/');
  const key = credentialProtocolBase64.decode(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
  if (key.byteLength !== 32) throw new Error('Recovery key is invalid');
  return key;
}

function derivedVaultKey(rootPrivateKey: Uint8Array): Uint8Array {
  return sha256.create().update(new TextEncoder().encode('gitspace-vault-v1\n')).update(rootPrivateKey).digest();
}

async function loadConfig(): Promise<GitSpaceConfig | null> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as GitSpaceConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function requireConfig(): Promise<GitSpaceConfig> {
  const config = await loadConfig();
  if (!config) throw new Error('Not logged in. Run `gitspace login`.');
  return config;
}

async function saveConfig(config: GitSpaceConfig): Promise<void> {
  await mkdir(CONFIG_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, CONFIG_PATH);
}

async function signedPost<T>(config: Pick<GitSpaceConfig, 'apiUrl' | 'rootPrivateKey'>, path: string, body: unknown): Promise<T> {
  const privateKey = credentialProtocolBase64.decode(config.rootPrivateKey);
  const response = await fetch(new URL(path, config.apiUrl), {
    method: 'POST',
    headers: {
      authorization: createRelayAuthorization(privateKey, path),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { status?: string; value?: T; error?: { message?: string } } & T;
  if (!response.ok || result.status === 'error') throw new Error(result.error?.message ?? `GitSpace API returned HTTP ${response.status}`);
  return (result.status === 'ok' ? result.value : result) as T;
}

async function accountArtifactKey(config: GitSpaceConfig, machine: MachineConfig): Promise<string> {
  const request = createSignedControlRequest({
    userId: config.userId,
    machineId: machine.id,
    operation: 'artifacts.key.get',
    payload: {},
    signingPrivateKey: credentialProtocolBase64.decode(machine.signingPrivateKey),
  });
  const response = await fetch(new URL('/v1/control', config.apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Account artifact key request failed (HTTP ${response.status})`);
  try {
    const result = await response.json() as { status?: unknown; value?: { key?: unknown } } | null;
    const key = result?.value?.key;
    if (result?.status !== 'ok' || typeof key !== 'string' || credentialProtocolBase64.decode(key).byteLength !== 32) {
      throw new Error('Invalid account artifact key');
    }
    return key;
  } catch {
    // Do not expose response bodies or decoder errors: they may contain key material.
    throw new Error('Control plane returned an invalid account artifact key');
  }
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function machinePid(): Promise<number | null> {
  try {
    const pid = Number((await readFile(PID_PATH, 'utf8')).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function buildRuntime(): Promise<string> {
  const runtimeRoot = join(CONFIG_ROOT, 'runtime', crypto.randomUUID());
  await mkdir(runtimeRoot, { recursive: true });
  try {
    await buildInitialRuntime(REPOSITORY_ROOT, runtimeRoot);
    const selection = join(CONFIG_ROOT, 'runtime-selection.json');
    const temporary = `${selection}.next`;
    await writeFile(temporary, JSON.stringify({ path: runtimeRoot }), { mode: 0o600 });
    await rename(temporary, selection);
    return runtimeRoot;
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

const program = new Command()
  .name('gitspace')
  .description('GitSpace production client')
  .version(VERSION);

program.command('login')
  .description('Create or recover your GitSpace account')
  .argument('<handle>', 'Permanent GitSpace account handle')
  .option('--recovery-key <key>', 'Recover an existing root identity')
  .option('--invite <token>', 'Operator invitation required to create an account')
  .option('--api <url>', 'GitSpace control plane URL', process.env.GITSPACE_API_URL ?? DEFAULT_API_URL)
  .action(async (handleInput: string, options: { recoveryKey?: string; invite?: string; api: string }) => {
    const existing = await loadConfig();
    const created = !options.recoveryKey && !existing;
    if (created && !options.invite) throw new Error('Creating an account requires --invite <token>. For an existing account, use --recovery-key <key>.');
    const rootPrivateKey = options.recoveryKey
      ? recoveryPrivateKey(options.recoveryKey)
      : existing
        ? credentialProtocolBase64.decode(existing.rootPrivateKey)
        : ed25519.utils.randomSecretKey();
    const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
    const vaultKey = derivedVaultKey(rootPrivateKey);
    const handle = handleInput.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(handle)) throw new Error('Handle must be 1 to 30 lowercase letters, numbers, or hyphens');
    const bootstrap = await signedPost<{ userId: string; handle: string; relayUrl: string; accountUrl: string; apiUrl: string }>(
      { apiUrl: options.api, rootPrivateKey: base64(rootPrivateKey) },
      created ? '/v1/accounts/bootstrap' : '/v1/accounts/recover',
      { rootPublicKey: base64(rootPublicKey), handle, ...(created ? { vaultKey: base64(vaultKey), invite: options.invite } : {}) },
    );
    await saveConfig({
      version: 2,
      apiUrl: options.api,
      accountUrl: bootstrap.accountUrl,
      handle: bootstrap.handle,
      userId: bootstrap.userId,
      relayUrl: bootstrap.relayUrl,
      rootPrivateKey: base64(rootPrivateKey),
      rootPublicKey: base64(rootPublicKey),
      vaultKey: base64(vaultKey),
      ...(existing?.machine ? { machine: existing.machine } : {}),
    });
    console.log(`Logged in as ${bootstrap.handle} (${bootstrap.userId})`);
    if (created) console.log(`Recovery key (store it now): ${recoveryToken(rootPrivateKey)}`);
  });

const machine = program.command('machine').description('Manage this physical machine');

machine.command('setup')
  .description('Enroll this machine and build its local runtime')
  .option('--label <label>', 'Machine label', hostname())
  .action(async (options: { label: string }) => {
    const config = await requireConfig();
    const signingPrivateKey = ed25519.utils.randomSecretKey();
    const exchangePrivateKey = x25519.utils.randomSecretKey();
    const machineId = `m-${crypto.randomUUID()}`;
    const grant = signCredentialAuthorityGrant({
      version: 1,
      userId: config.userId,
      machineId,
      signingPublicKey: base64(ed25519.getPublicKey(signingPrivateKey)),
      exchangePublicKey: base64(x25519.getPublicKey(exchangePrivateKey)),
      capabilities: ['credential.access', 'credential.refresh', 'credential.manage', 'storage.provision', 'storage.access', 'space.control'],
      generation: 1,
    }, credentialProtocolBase64.decode(config.rootPrivateKey));
    console.log('Building machine runtime…');
    await buildRuntime();
    await signedPost(config, '/v1/machines/enroll', { userId: config.userId, label: options.label, deviceGrant: grant });
    config.machine = {
      id: machineId,
      label: options.label,
      signingPrivateKey: base64(signingPrivateKey),
      exchangePrivateKey: base64(exchangePrivateKey),
      grant,
    };
    await saveConfig(config);
    console.log(`Enrolled ${options.label} (${machineId})`);
  });

machine.command('start')
  .description('Start the GitSpace machine daemon and production relay connector')
  .action(async () => {
    const config = await requireConfig();
    if (!config.machine) throw new Error('Machine is not enrolled. Run `gitspace machine setup`.');
    const currentPid = await machinePid();
    if (currentPid && await processIsRunning(currentPid)) throw new Error(`Machine is already running (pid ${currentPid})`);
    const { path: runtimeRoot } = JSON.parse(await readFile(join(CONFIG_ROOT, 'runtime-selection.json'), 'utf8')) as { path: string };
    const artifactKey = await accountArtifactKey(config, config.machine);
    const environmentRoot = join(CONFIG_ROOT, 'machine');
    await mkdir(environmentRoot, { recursive: true, mode: 0o700 });
    const hostEntrypoint = join(runtimeRoot, 'host.js');
    const log = openSync(LOG_PATH, 'a', 0o600);
    const child = Bun.spawn([process.execPath, hostEntrypoint], {
      cwd: CONFIG_ROOT,
      detached: true,
      stdout: log,
      stderr: log,
      env: {
        ...process.env,
        GITSPACE_ENVIRONMENT_ROOT: environmentRoot,
        GITSPACE_BUNDLE_ROOT: runtimeRoot,
        GITSPACE_MACHINE_ID: config.machine.id,
        GITSPACE_MACHINE_LABEL: config.machine.label,
        GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: config.machine.signingPrivateKey,
        GITSPACE_MACHINE_GRANT: JSON.stringify(config.machine.grant),
        GITSPACE_ROOT_PUBLIC_KEY: config.rootPublicKey,
        GITSPACE_ARTIFACT_KEY: artifactKey,
        GITSPACE_CONTROL_URL: config.apiUrl,
        GITSPACE_USER_ID: config.userId,
        GITSPACE_RELAY_URL: config.relayUrl,
        GITSPACE_PUBLIC_RPC_URL: `${config.relayUrl}/tunnel/${encodeURIComponent(config.machine.id)}/rpc`,
        GITSPACE_SERVICE_DOMAIN: 'gssh.dev',
        GITSPACE_SERVICE_NAMESPACE: config.handle,
        GITSPACE_OMP_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'),
        GITSPACE_MANAGED_SPACE_ROOT: join(homedir(), 'gitspace', 'spaces'),
        GITSPACE_WALGIT_BINARY: Bun.which('walgit') ?? 'walgit',
      },
    });
    closeSync(log);
    child.unref();
    await writeFile(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
    await Bun.sleep(1_000);
    if (!await processIsRunning(child.pid)) throw new Error(`Machine failed to start. See ${LOG_PATH}`);
    console.log(`Machine started (pid ${child.pid})`);
  });

machine.command('stop')
  .description('Stop the local GitSpace machine daemon')
  .action(async () => {
    const pid = await machinePid();
    if (!pid || !await processIsRunning(pid)) {
      await rm(PID_PATH, { force: true });
      console.log('Machine is stopped');
      return;
    }
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 50 && await processIsRunning(pid); attempt += 1) await Bun.sleep(100);
    if (await processIsRunning(pid)) throw new Error(`Machine ${pid} did not stop`);
    await rm(PID_PATH, { force: true });
    console.log('Machine stopped');
  });

machine.command('status')
  .description('Show local process and production relay status')
  .action(async () => {
    const config = await requireConfig();
    const pid = await machinePid();
    const running = pid !== null && await processIsRunning(pid);
    let relay = 'unreachable';
    try {
      const response = await fetch(new URL('/health', config.relayUrl), { signal: AbortSignal.timeout(5_000) });
      relay = response.ok ? 'online' : `HTTP ${response.status}`;
    } catch {}
    console.log(`Machine: ${config.machine?.label ?? 'not enrolled'}`);
    console.log(`Daemon: ${running ? `running (pid ${pid})` : 'stopped'}`);
    console.log(`Relay: ${relay}`);
    console.log(`Log: ${LOG_PATH}`);
  });

machine.command('remove')
  .description('Revoke and remove this physical machine')
  .action(async () => {
    const config = await requireConfig();
    if (!config.machine) {
      console.log('Machine is not enrolled');
      return;
    }
    const pid = await machinePid();
    if (pid && await processIsRunning(pid)) process.kill(pid, 'SIGTERM');
    await signedPost(config, '/v1/machines/revoke', { userId: config.userId, machineId: config.machine.id });
    delete config.machine;
    await saveConfig(config);
    await rm(PID_PATH, { force: true });
    console.log('Machine revoked');
  });

program.command('open')
  .description('Open GitSpace in the browser and enroll this browser')
  .option('--print', 'Print the one-time enrollment URL without opening a browser')
  .action(async (options: { print?: boolean }) => {
    const config = await requireConfig();
    if (!config.machine) throw new Error('Machine is not enrolled. Run `gitspace machine setup`.');
    const now = Date.now();
    const invite = signDeviceInvite({
      version: 1,
      userId: config.userId,
      inviteId: crypto.randomUUID(),
      kind: 'browser',
      label: 'GitSpace browser',
      scope: { kind: 'user' },
      capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'],
      canDelegate: true,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
      grantTtlMs: null,
      enrollUrl: config.apiUrl,
    }, credentialProtocolBase64.decode(config.rootPrivateKey));
    const url = new URL(config.accountUrl);
    url.searchParams.set('enroll', encodeDeviceInviteToken(invite));
    if (options.print) {
      console.log(url.toString());
      return;
    }
    await openBrowser(url.toString());
    console.log(url.origin);
  });

program.command('doctor')
  .description('Check production account, relay, machine runtime, and dependencies')
  .action(async () => {
    const config = await loadConfig();
    const checks: Array<[string, 'ok' | 'warn' | 'fail', string]> = [];
    checks.push(['identity', config ? 'ok' : 'fail', config ? config.userId : 'run `gitspace login`']);
    checks.push(['machine', config?.machine ? 'ok' : 'fail', config?.machine?.label ?? 'run `gitspace machine setup`']);
    checks.push(['bun', Bun.which('bun') ? 'ok' : 'fail', Bun.which('bun') ?? 'missing']);
    checks.push(['omp', Bun.which('omp') ? 'ok' : 'fail', Bun.which('omp') ?? 'missing']);
    checks.push(['walgit', Bun.which('walgit') ? 'ok' : 'warn', Bun.which('walgit') ?? 'install before creating repositories']);
    if (config) {
      const endpoints = [
        ['control', `${config.apiUrl}/health`],
        ['relay', new URL('/health', config.relayUrl).toString()],
      ] as const;
      for (const [name, url] of endpoints) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          checks.push([name, response.ok ? 'ok' : 'fail', response.ok ? url : `HTTP ${response.status}`]);
        } catch (error) {
          checks.push([name, 'fail', error instanceof Error ? error.message : String(error)]);
        }
      }
    }
    for (const [name, status, detail] of checks) console.log(`${status.padEnd(4)} ${name.padEnd(9)} ${detail}`);
    if (checks.some(([, status]) => status === 'fail')) process.exitCode = 1;
  });

program.command('update')
  .description('Rebuild the installed machine runtime from the current GitSpace release')
  .action(async () => {
    await requireConfig();
    console.log('Building machine runtime…');
    await buildRuntime();
    console.log('Machine runtime updated. Restart it to apply the update.');
  });

program.command('logout')
  .description('Remove the local account and machine identity')
  .action(async () => {
    const pid = await machinePid();
    if (pid && await processIsRunning(pid)) process.kill(pid, 'SIGTERM');
    await rm(CONFIG_ROOT, { recursive: true, force: true });
    console.log('Logged out');
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
