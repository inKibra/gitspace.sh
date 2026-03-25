import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getSecret } from '../../../utils/secrets.js';
import { isCloudflaredInstalled } from '../../../utils/cloudflared.js';
import { logger } from '../../../utils/logger.js';
import { buildProcessHostname } from '../../../utils/hostnames.js';
import { getGitspaceDir } from '../../../core/config.js';
import { listSessions, isProcessRunning } from '../cli.js';
import { parseProcessSessionName } from '../../processes/names.js';
import { resolveWorkspaceRef } from '../../events/paths.js';
import { loadProcessesConfig } from '../../processes/config.js';
import type { ProcessPortConfig } from '../../../types/processes.js';
import { getServeTokenKey } from '../../../commands/host.js';
import { readTmuxHostingState, writeTmuxHostingState, type TmuxHostingState } from './state.js';

interface HostedServiceRoute {
  hostname: string;
  service: string;
}

const READY_TIMEOUT_MS = 5000;
const MAX_WORKSPACE_PATH_CACHE_SIZE = 256;

function getHostingRuntimeDir(): string {
  const base = join(getGitspaceDir(), '.tmux-hosting');
  mkdirSync(base, { recursive: true });
  return base;
}

function getCloudflaredConfigPath(): string {
  return join(getHostingRuntimeDir(), 'cloudflared.yml');
}

function hashConfig(config: string): string {
  return createHash('sha256').update(config).digest('hex');
}

function buildIngressConfig(entries: HostedServiceRoute[]): string {
  const lines = ['ingress:'];
  for (const entry of entries) {
    lines.push(`  - hostname: ${entry.hostname}`);
    lines.push(`    service: ${entry.service}`);
  }
  lines.push('  - service: http_status:404');
  return `${lines.join('\n')}\n`;
}

function parseBaseHost(baseHost: string): { serveDomain: string; rootSubdomain: string } | null {
  const normalized = baseHost.trim().toLowerCase();
  if (!normalized.endsWith('.gitspace.sh')) {
    return null;
  }
  const subdomain = normalized.slice(0, -'.gitspace.sh'.length);
  if (!subdomain.endsWith('.serve')) {
    return null;
  }
  const rootSubdomain = subdomain.slice(0, -'.serve'.length);
  if (!rootSubdomain) {
    return null;
  }
  return { serveDomain: normalized, rootSubdomain };
}

function findWorkspacePathById(workspaceId: string): string | null {
  const spacesDir = getGitspaceDir();
  if (!existsSync(spacesDir)) {
    return null;
  }
  const entries = readdirSync(spacesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'app') continue;
    const candidate = join(spacesDir, entry.name, 'workspaces', workspaceId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function waitForCloudflaredReady(proc: Subprocess): Promise<boolean> {
  const result = await Promise.race([
    proc.exited.then((code) => ({ code })),
    Bun.sleep(READY_TIMEOUT_MS).then(() => ({ code: null })),
  ]);
  return result.code === null;
}

async function readProcessCommand(pid: number): Promise<string | null> {
  if (!isProcessRunning(pid)) {
    return null;
  }

  try {
    const proc = spawn(['ps', '-o', 'command=', '-p', String(pid)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited.catch(() => null);
    const command = output.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

async function resolveManagedCloudflaredPid(state: TmuxHostingState | null): Promise<number | null> {
  const pid = state?.cloudflaredPid;
  if (typeof pid !== 'number') {
    return null;
  }

  const command = await readProcessCommand(pid);
  if (!command || !command.includes('cloudflared') || !command.includes(' tunnel ')) {
    return null;
  }

  const expectedConfigPath = state?.cloudflaredConfigPath?.trim();
  if (expectedConfigPath && !command.includes(expectedConfigPath)) {
    return null;
  }

  return pid;
}

function clearManagedCloudflaredRuntime(): void {
  writeTmuxHostingState({
    cloudflaredPid: undefined,
    cloudflaredConfigPath: undefined,
  });
}

async function stopManagedCloudflared(state: TmuxHostingState | null): Promise<void> {
  const pid = await resolveManagedCloudflaredPid(state);
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      // Best effort.
    }
  }
  if (state?.cloudflaredPid || state?.cloudflaredConfigPath) {
    clearManagedCloudflaredRuntime();
  }
}

export async function collectHostedServiceRoutes(): Promise<HostedServiceRoute[]> {
  const state = readTmuxHostingState();
  if (!state?.baseHost) {
    return [];
  }

  const sessions = await listSessions().catch(() => []);
  const configCache = new Map<string, ReturnType<typeof loadProcessesConfig>>();
  const workspacePathCache = new Map<string, string>();
  const entries: HostedServiceRoute[] = [];

  for (const session of sessions) {
    const parsed = parseProcessSessionName(session.name);
    const processName = parsed?.processName;
    if (!processName || session.exitCode !== undefined) continue;
    const instance = parsed?.instance ?? 1;

    let workspaceRef = resolveWorkspaceRef(session.cwd);
    if (!workspaceRef && parsed?.workspaceId) {
      const cached = workspacePathCache.get(parsed.workspaceId);
      const workspacePath = cached ?? findWorkspacePathById(parsed.workspaceId);
      if (workspacePath) {
        workspacePathCache.set(parsed.workspaceId, workspacePath);
        while (workspacePathCache.size > MAX_WORKSPACE_PATH_CACHE_SIZE) {
          const oldest = workspacePathCache.keys().next().value;
          if (!oldest) break;
          workspacePathCache.delete(oldest);
        }
        workspaceRef = resolveWorkspaceRef(workspacePath);
      }
    }
    if (!workspaceRef) continue;

    const config = configCache.get(workspaceRef.workspacePath) ?? loadProcessesConfig(workspaceRef.workspacePath);
    configCache.set(workspaceRef.workspacePath, config);
    const definition = config.processes.find((process) => process.name === processName);
    const ports = (definition?.ports ?? []).filter((port): port is ProcessPortConfig => Boolean(port));

    for (const port of ports) {
      if (!Number.isInteger(port.port) || port.port <= 0) continue;
      const portLabel = port.name?.trim() || String(port.port);
      const protocol = port.protocol === 'tcp' ? 'tcp' : 'http';
      const hostname = buildProcessHostname(
        state.baseHost,
        workspaceRef.workspaceId,
        processName,
        instance,
        portLabel,
        state.machineName,
      );
      entries.push({
        hostname,
        service: `${protocol}://127.0.0.1:${port.port}`,
      });
    }
  }

  const deduped = new Map(entries.map((entry) => [entry.hostname, entry]));
  return [...deduped.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export async function refreshTmuxHosting(): Promise<{ active: boolean; routes: HostedServiceRoute[]; reason?: string }> {
  const state = readTmuxHostingState();
  if (!state?.enabled) {
    await stopManagedCloudflared(state);
    return { active: false, routes: [], reason: 'disabled' };
  }
  if (!state.baseHost) {
    await stopManagedCloudflared(state);
    return { active: false, routes: [], reason: 'no base host selected' };
  }

  const parsedBaseHost = parseBaseHost(state.baseHost);
  if (!parsedBaseHost) {
    await stopManagedCloudflared(state);
    return { active: false, routes: [], reason: 'invalid hosting base host' };
  }

  if (!await isCloudflaredInstalled()) {
    await stopManagedCloudflared(state);
    return { active: false, routes: [], reason: 'cloudflared not installed' };
  }

  const tunnelToken = await getSecret(getServeTokenKey(parsedBaseHost.rootSubdomain));
  if (!tunnelToken) {
    await stopManagedCloudflared(state);
    return { active: false, routes: [], reason: `missing serve tunnel token for ${parsedBaseHost.rootSubdomain}` };
  }

  const routes = await collectHostedServiceRoutes();
  const config = buildIngressConfig(routes);
  const configPath = getCloudflaredConfigPath();
  const configHash = hashConfig(config);
  const previousHash = existsSync(configPath) ? hashConfig(readFileSync(configPath, 'utf-8')) : null;
  if (previousHash !== configHash) {
    writeFileSync(configPath, config, 'utf-8');
  }

  const currentPid = await resolveManagedCloudflaredPid(state);
  if (!currentPid && (state?.cloudflaredPid || state?.cloudflaredConfigPath)) {
    clearManagedCloudflaredRuntime();
  }

  if (currentPid && previousHash === configHash) {
    return { active: true, routes };
  }

  if (currentPid) {
    try {
      process.kill(currentPid);
    } catch {
      // Best effort.
    }
    clearManagedCloudflaredRuntime();
  }

  const proc = spawn(['cloudflared', 'tunnel', '--config', configPath, 'run'], {
    env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (typeof proc.unref === 'function') {
    proc.unref();
  }

  const ready = await waitForCloudflaredReady(proc);
  if (!ready) {
    try {
      proc.kill();
    } catch {
      // Best effort.
    }
    clearManagedCloudflaredRuntime();
    return { active: false, routes, reason: 'cloudflared failed to start' };
  }

  writeTmuxHostingState({ cloudflaredPid: proc.pid, cloudflaredConfigPath: configPath, enabled: true });
  return { active: true, routes };
}

export async function stopTmuxHosting(): Promise<void> {
  const state = readTmuxHostingState();
  await stopManagedCloudflared(state);
}

export async function getTmuxHostingRuntimeStatus(): Promise<{ active: boolean; reason?: string; routeCount: number }> {
  const state = readTmuxHostingState();
  if (!state?.enabled) {
    return { active: false, routeCount: 0, reason: 'disabled' };
  }
  const routes = await collectHostedServiceRoutes();
  const active = (await resolveManagedCloudflaredPid(state)) !== null;
  return {
    active,
    routeCount: routes.length,
    reason: active ? undefined : 'cloudflared not running',
  };
}
