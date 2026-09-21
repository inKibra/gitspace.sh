#!/usr/bin/env bun
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createRelayAuthorization, createSignedControlRequest, decodeMachinePairingToken, signRpcRequest } from '@gitspace/protocol';
import { credentialProtocolBase64, type SignedCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';
import { Command } from 'commander';
import openBrowser from 'open';
import { installRuntime } from './bootstrap.js';

const CONFIG_ROOT = process.env.GITSPACE_CONFIG_HOME ?? join(homedir(), '.config', 'gitspace');
const CONFIG_PATH = join(CONFIG_ROOT, 'config.json');
const PID_PATH = join(CONFIG_ROOT, 'machine.pid');
const LOG_PATH = join(CONFIG_ROOT, 'machine.log');
const PAIRING_PATH = join(CONFIG_ROOT, 'pairing.json');
interface MachineConfig {
  version: 3;
  apiUrl: string;
  accountUrl: string;
  handle: string;
  userId: string;
  relayUrl: string;
  rootPublicKey: string;
  brokerUrl: string;
  brokerToken: string;
  machine: { id: string; label: string; signingPrivateKey: string; exchangePrivateKey: string; grant: SignedCredentialAuthorityGrant };
}
interface PendingPairing {
  pairingId: string;
  machineId: string;
  label: string;
  signingPrivateKey: string;
  exchangePrivateKey: string;
}
interface EnrolledPairing {
  state: 'enrolled';
  userId: string;
  handle: string;
  accountUrl: string;
  relayUrl: string;
  apiUrl: string;
  rootPublicKey: string;
  machineId: string;
  grant: SignedCredentialAuthorityGrant;
  brokerUrl: string;
  brokerToken: string;
}

async function loadConfig(): Promise<MachineConfig | null> {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as MachineConfig;
    if (config.version !== 3) throw new Error('This is a legacy enrollment. Revoke the old machine in your account before relinking it. Your local files have not been changed.');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function requireConfig(): Promise<MachineConfig> {
  const config = await loadConfig();
  if (!config) throw new Error('This machine is not linked. Open your GitSpace account, choose Settings > Machines > Add a computer, and follow the pairing steps.');
  return config;
}
async function savePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(CONFIG_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
async function accountArtifactKey(config: MachineConfig): Promise<string> {
  const request = createSignedControlRequest({ userId: config.userId, machineId: config.machine.id, operation: 'artifacts.key.get', payload: {}, signingPrivateKey: credentialProtocolBase64.decode(config.machine.signingPrivateKey) });
  const response = await fetch(new URL('/v1/control', config.apiUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Account artifact key request failed (HTTP ${response.status})`);
  const result = await response.json() as { status?: string; value?: { key?: string } };
  if (result.status !== 'ok' || !result.value?.key || credentialProtocolBase64.decode(result.value.key).byteLength !== 32) throw new Error('Control plane returned an invalid account artifact key');
  return result.value.key;
}
function processIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
async function selectedMachineRoot(runtimeRoot: string): Promise<string> {
  let source: string;
  try { source = await readFile(join(CONFIG_ROOT, 'machine', 'host-selection.json'), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(runtimeRoot, 'machine');
    throw error;
  }
  const selected = JSON.parse(source) as { version?: number; path?: string };
  if (selected.version !== 1 || typeof selected.path !== 'string' || selected.path.length === 0) throw new Error('Invalid complete machine selection; your workspace data has not been changed.');
  return selected.path;
}
function requireSystemTools(): void {
  const missing = ['git', 'ssh', 'ssh-agent', 'ssh-add', 'ssh-keygen'].filter(tool => !Bun.which(tool));
  if (missing.length) throw new Error(`Install Git and the OpenSSH client before linking this machine. Missing: ${missing.join(', ')}. Bun and OMP are included by GitSpace.`);
}
async function startMachine(): Promise<void> {
  const config = await requireConfig();
  requireSystemTools();
  const currentPid = await machinePid();
  if (currentPid && processIsRunning(currentPid)) throw new Error(`Machine is already running (pid ${currentPid})`);
  const selectionPath = join(CONFIG_ROOT, 'runtime-selection.json');
  if (!existsSync(selectionPath)) {
    console.log('Downloading the verified machine runtime...');
    await installRuntime(CONFIG_ROOT, 'https://api.gitspace.sh');
  }
  const { path: runtimeRoot } = JSON.parse(await readFile(selectionPath, 'utf8')) as { path: string };
  const bun = join(runtimeRoot, 'bin', 'bun');
  if (!existsSync(bun) || !existsSync(join(await selectedMachineRoot(runtimeRoot), 'machine-native.json'))) throw new Error('The selected machine runtime is incomplete. Run gitspace doctor to inspect the installation; your workspace data has not been changed.');
  const artifactKey = await accountArtifactKey(config);
  const environmentRoot = join(CONFIG_ROOT, 'machine');
  await mkdir(environmentRoot, { recursive: true, mode: 0o700 });
  await rm(PID_PATH, { force: true });
  const log = openSync(LOG_PATH, 'a', 0o600);
  let offset = statSync(LOG_PATH).size;
  const child = Bun.spawn([bun, join(runtimeRoot, 'host.js')], {
    cwd: CONFIG_ROOT, detached: true, stdout: log, stderr: log,
    env: {
      ...process.env,
      PATH: `${join(runtimeRoot, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      GITSPACE_ENVIRONMENT_ROOT: environmentRoot,
      GITSPACE_BUNDLE_ROOT: runtimeRoot,
      GITSPACE_MACHINE_PID_PATH: PID_PATH,
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
      GITSPACE_OMP_AGENT_DIR: join(CONFIG_ROOT, 'omp'),
      OMP_AUTH_BROKER_URL: config.brokerUrl,
      OMP_AUTH_BROKER_TOKEN: config.brokerToken,
      GITSPACE_MANAGED_SPACE_ROOT: process.env.GITSPACE_MANAGED_SPACE_ROOT ?? join(homedir(), 'gitspace', 'spaces'),
    },
  });
  closeSync(log);
  child.unref();
  console.log(`Starting ${config.machine.label}. Its releases are managed by your account.`);
  const reader = await open(LOG_PATH, 'r');
  const bytes = Buffer.alloc(16 * 1024);
  let recent = '';
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const pid = await machinePid();
      if ((!pid || !processIsRunning(pid)) && !processIsRunning(child.pid)) throw new Error(`Machine failed to start. See ${LOG_PATH}`);
      const { bytesRead } = await reader.read(bytes, 0, bytes.length, offset);
      offset += bytesRead;
      recent = (recent + bytes.toString('utf8', 0, bytesRead)).slice(-32_768);
      if (pid && processIsRunning(pid) && recent.includes(`GitSpace host ready pid=${pid} `)) {
        console.log(`Machine runtime ready (pid ${pid}). Check its connection in ${config.accountUrl}`);
        return;
      }
      await Bun.sleep(500);
    }
    throw new Error(`The machine is still starting. Check gitspace machine status and ${LOG_PATH}; no process was killed.`);
  } finally { await reader.close(); }
}
async function stopMachine(): Promise<void> {
  let pid = await machinePid();
  if (!pid || !processIsRunning(pid)) {
    await rm(PID_PATH, { force: true });
    console.log('Machine is stopped');
    return;
  }
  const deadline = Date.now() + 120_000;
  let signalled: number | null = null;
  while (Date.now() < deadline) {
    if (pid && processIsRunning(pid)) {
      if (pid !== signalled) {
        try { process.kill(pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        signalled = pid;
      }
    } else {
      const replacement = await machinePid();
      if (replacement === pid || !replacement) {
        await rm(PID_PATH, { force: true });
        break;
      }
      pid = replacement;
      continue;
    }
    await Bun.sleep(250);
    pid = await machinePid();
  }
  if (pid && processIsRunning(pid)) throw new Error(`Machine ${pid} has not stopped. Inspect ${LOG_PATH}; it has not been force-killed.`);
  console.log('Machine stopped');
}

const program = new Command().name('gitspace').description('Connect this computer to your GitSpace account').version('1.0.0');
const machine = program.command('machine').description('Link and operate this computer');
machine.command('setup').description('Link using the pairing command from your account, then start the runtime')
  .requiredOption('--pair <token>', 'Short-lived pairing token from Settings > Machines > Add a computer')
  .option('--label <label>', 'Machine label', hostname())
  .action(async (options: { pair: string; label: string }) => {
    requireSystemTools();
    if (await loadConfig()) throw new Error('This computer is already linked. Use gitspace machine start, or remove its enrollment before linking another account.');
    const token = decodeMachinePairingToken(options.pair);
    if (!token) throw new Error('Invalid or expired pairing token. Create a new pairing command in your account.');
    let pending: PendingPairing;
    try {
      pending = JSON.parse(await readFile(PAIRING_PATH, 'utf8')) as PendingPairing;
      if (pending.pairingId !== token.pairingId) throw new Error('Another pairing is recorded locally. Cancel it in the browser and remove the local pairing.json before starting a new one.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      pending = { pairingId: token.pairingId, machineId: `m-${crypto.randomUUID()}`, label: options.label.slice(0, 160), signingPrivateKey: credentialProtocolBase64.encode(ed25519.utils.randomSecretKey()), exchangePrivateKey: credentialProtocolBase64.encode(x25519.utils.randomSecretKey()) };
      await savePrivateJson(PAIRING_PATH, pending);
    }
    const privateKey = credentialProtocolBase64.decode(pending.signingPrivateKey);
    const pairingRequest = async <T>(action: 'claim' | 'poll', payload: object): Promise<T> => {
      const url = new URL(`/v1/machine-pairings/${action}`, token.apiUrl);
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitspace-device': signRpcRequest({ deviceId: token.pairingId, signingPrivateKey: privateKey, method: 'POST', path: url.pathname, body }) }, body, signal: AbortSignal.timeout(30_000) });
      const result = await response.json() as { status: string; value: T; error?: { message?: string } };
      if (!response.ok || result.status !== 'ok') throw new Error(result.error?.message ?? `Machine pairing failed (HTTP ${response.status})`);
      return result.value;
    };
    await pairingRequest('claim', { userId: token.userId, pairingId: token.pairingId, token: token.token, machineId: pending.machineId, label: pending.label, signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(credentialProtocolBase64.decode(pending.exchangePrivateKey))) });
    console.log(`Approve ${pending.label} in the browser. Signing key: ${credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey))}`);
    while (Date.now() < token.expiresAt) {
      const result = await pairingRequest<EnrolledPairing | { state: 'pending' }>('poll', { userId: token.userId, pairingId: token.pairingId });
      if (result.state === 'enrolled') {
        if (result.machineId !== pending.machineId || result.userId !== token.userId || result.grant.grant.signingPublicKey !== credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey))) throw new Error('Pairing response does not match this machine');
        await savePrivateJson(CONFIG_PATH, { version: 3, apiUrl: result.apiUrl, accountUrl: result.accountUrl, handle: result.handle, userId: result.userId, relayUrl: result.relayUrl, rootPublicKey: result.rootPublicKey, brokerUrl: result.brokerUrl, brokerToken: result.brokerToken, machine: { id: pending.machineId, label: pending.label, signingPrivateKey: pending.signingPrivateKey, exchangePrivateKey: pending.exchangePrivateKey, grant: result.grant } } satisfies MachineConfig);
        await rm(PAIRING_PATH, { force: true });
        console.log(`Linked ${pending.label} to ${result.handle}. No account recovery key was stored on this machine.`);
        await startMachine();
        return;
      }
      await Bun.sleep(2_000);
    }
    throw new Error('Pairing expired. Create a new pairing command in the browser.');
  });
machine.command('start').description('Start the installed account-managed runtime').action(startMachine);
machine.command('stop').description('Stop this machine runtime').action(stopMachine);
machine.command('recover').description('Build and activate a complete tenant machine release from its held source workspace')
  .requiredOption('--source <path>', 'GitSpace source checkout held by this machine')
  .requiredOption('--workspace <id>', 'Account workspace id of that checkout')
  .action(async (options: { source: string; workspace: string }) => {
    const source = resolve(options.source);
    const entrypoint = join(source, 'packages/account-machine/src/source-recovery.ts');
    if (!existsSync(entrypoint)) throw new Error('Recovery requires a GitSpace source checkout containing the source-recovery entrypoint');
    const config = await loadConfig();
    let bun: string;
    let environment = { ...process.env };
    if (config) {
      const pid = await machinePid();
      if (!pid || !processIsRunning(pid)) throw new Error('Start the machine before source recovery so it can stage and activate the complete release.');
      const installed = JSON.parse(await readFile(join(CONFIG_ROOT, 'runtime-selection.json'), 'utf8')) as { path: string };
      bun = join(installed.path, 'bin/bun');
      environment = {
        ...environment,
        GITSPACE_ENVIRONMENT_ROOT: join(CONFIG_ROOT, 'machine'),
        GITSPACE_MACHINE_ID: config.machine.id,
        GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: config.machine.signingPrivateKey,
        GITSPACE_CONTROL_URL: config.apiUrl,
        GITSPACE_USER_ID: config.userId,
      };
    } else {
      // Provider consoles already carry the linked machine environment; no local enrollment is invented.
      for (const name of ['GITSPACE_ENVIRONMENT_ROOT', 'GITSPACE_MACHINE_ID', 'GITSPACE_MACHINE_SIGNING_PRIVATE_KEY', 'GITSPACE_CONTROL_URL', 'GITSPACE_USER_ID']) {
        if (!environment[name]) throw new Error(`Recovery needs a linked machine or its provider-console environment (${name} is missing)`);
      }
      const installedBun = Bun.which('bun');
      if (!installedBun) throw new Error('The linked machine runtime must provide Bun for source recovery');
      bun = installedBun;
    }
    console.log('Preparing source recovery dependencies; the current host and tenant selection remain active.');
    const install = Bun.spawn([bun, 'install', '--frozen-lockfile'], { cwd: source, env: environment, stdout: 'inherit', stderr: 'inherit' });
    if (await install.exited !== 0) throw new Error('Recovery source dependency installation failed; the existing host was not changed');
    const recovery = Bun.spawn([bun, entrypoint, options.workspace, source], { cwd: source, env: environment, stdout: 'inherit', stderr: 'inherit' });
    if (await recovery.exited !== 0) throw new Error('Source recovery did not confirm activation; inspect the account deployment progress for the machine update outcome.');
  });
machine.command('status').description('Show local runtime and relay status').action(async () => {
  const config = await requireConfig();
  const pid = await machinePid();
  const health = async (url: URL): Promise<string> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return response.ok ? 'reachable' : `HTTP ${response.status}`;
    } catch { return 'unreachable'; }
  };
  const [relay, tunnel] = await Promise.all([
    health(new URL('/health', config.relayUrl)),
    health(new URL(`/tunnel/${encodeURIComponent(config.machine.id)}/health`, config.relayUrl)),
  ]);
  console.log(`Machine: ${config.machine.label}\nDaemon: ${pid && processIsRunning(pid) ? `running (pid ${pid})` : 'stopped'}\nRelay service: ${relay}\nMachine tunnel: ${tunnel}\nAccount: ${config.accountUrl}\nLog: ${LOG_PATH}`);
});
machine.command('remove').description('Stop and revoke this computer; retain its local workspace files').action(async () => {
  const config = await requireConfig();
  await stopMachine();
  const path = '/v1/machines/revoke';
  const response = await fetch(new URL(path, config.apiUrl), { method: 'POST', headers: { authorization: createRelayAuthorization(credentialProtocolBase64.decode(config.machine.signingPrivateKey), path), 'content-type': 'application/json' }, body: JSON.stringify({ userId: config.userId, machineId: config.machine.id }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as { status?: string; error?: { message?: string } };
  if (!response.ok || result.status !== 'ok') throw new Error(result.error?.message ?? 'Machine revocation failed; local identity retained');
  await rm(CONFIG_PATH);
  console.log('Machine revoked. Local workspace files and runtime installation were retained.');
});
program.command('open').description('Open your account in the browser').option('--print', 'Print the account URL').action(async (options: { print?: boolean }) => {
  const config = await requireConfig();
  if (!options.print) await openBrowser(config.accountUrl);
  console.log(config.accountUrl);
});
program.command('doctor').description('Check this machine installation and account connection').action(async () => {
  const config = await loadConfig();
  const checks: Array<[string, 'ok' | 'warn' | 'fail', string]> = [['machine', config ? 'ok' : 'warn', config?.machine.label ?? 'Link from Settings > Machines in your account']];
  for (const tool of ['git', 'ssh', 'ssh-agent', 'ssh-add', 'ssh-keygen']) checks.push([tool, Bun.which(tool) ? 'ok' : 'fail', Bun.which(tool) ?? 'Install Git and the OpenSSH client']);
  try {
    const selection = JSON.parse(await readFile(join(CONFIG_ROOT, 'runtime-selection.json'), 'utf8')) as { path: string };
    const bun = join(selection.path, 'bin/bun');
    checks.push(['bun', existsSync(bun) ? 'ok' : 'fail', bun]);
    const native = join(await selectedMachineRoot(selection.path), 'machine-native.json');
    checks.push(['native selection', existsSync(native) ? 'ok' : 'warn', existsSync(native) ? native : 'Legacy bootstrap: recover the tenant machine from source before upgrading its host']);
    checks.push(['omp', existsSync(join(selection.path, 'omp', 'omp.js')) ? 'ok' : 'fail', 'Account-managed packaged OMP']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    checks.push(['runtime', 'warn', 'Not installed yet; machine setup/start downloads it']);
  }
  if (config) for (const [name, url] of [['control', new URL('/health', config.apiUrl)], ['relay', new URL('/health', config.relayUrl)]] as const) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }); checks.push([name, response.ok ? 'ok' : 'fail', `HTTP ${response.status}`]); } catch { checks.push([name, 'fail', 'Unreachable']); }
  }
  for (const [name, status, detail] of checks) console.log(`${status.padEnd(4)} ${name.padEnd(10)} ${detail}`);
  if (checks.some(([, status]) => status === 'fail')) process.exitCode = 1;
});
try { await program.parseAsync(process.argv); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
