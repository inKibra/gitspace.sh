import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readHostConfig, syncServeRouteHostnames } from '../../../commands/host.js';
import { isCloudflaredInstalled } from '../../../utils/cloudflared.js';
import { buildProcessHostname } from '../../../utils/hostnames.js';
import { getGitspaceDir } from '../../../core/config.js';
import { listSessionsFromRunningServer, isProcessRunning, isServerRunning } from '../cli.js';
import { parseProcessSessionName } from '../../processes/names.js';
import { resolveWorkspaceRef } from '../../events/paths.js';
import { loadProcessesConfig } from '../../processes/config.js';
import type { ProcessPortConfig } from '../../../types/processes.js';
import { readTmuxHostingState, writeTmuxHostingState, type TmuxHostingState } from './state.js';
import { parseTmuxHostingBaseHost } from './base-host.js';

interface HostedServiceRoute {
  hostname: string;
  service: string;
}

type ParsedBaseHost = ReturnType<typeof parseTmuxHostingBaseHost>;
type HostedServiceRouteCollection =
  | { ok: true; routes: HostedServiceRoute[] }
  | { ok: false; reason: string };
type ManagedServeTunnel =
  | { ok: true; rootSubdomain: string; serveDomain: string; tunnelId: string; credentialsPath: string }
  | { ok: false; reason: string };

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

function getHostedRoutesPath(): string {
  return join(getHostingRuntimeDir(), 'hosted-routes.json');
}

function hashConfig(config: string): string {
  return createHash('sha256').update(config).digest('hex');
}

function buildCloudflaredConfig(args: {
  tunnelId: string;
  credentialsPath: string;
  routes: HostedServiceRoute[];
}): string {
  const ingressLines = args.routes.flatMap((route) => [
    `  - hostname: ${route.hostname}`,
    `    service: ${route.service}`,
  ]);

  return [
    '# tmux hosting manages a locally-managed Cloudflare Tunnel for the selected serve namespace.',
    `tunnel: ${args.tunnelId}`,
    `credentials-file: ${JSON.stringify(args.credentialsPath)}`,
    'loglevel: info',
    '',
    'ingress:',
    ...ingressLines,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

function buildHostedHttpRoutesFile(entries: HostedServiceRoute[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function readHostedRoutesHash(): string | null {
  const routesPath = getHostedRoutesPath();
  return existsSync(routesPath) ? hashConfig(readFileSync(routesPath, 'utf-8')) : null;
}

function writeHostedRoutes(entries: HostedServiceRoute[]): void {
  const routesPath = getHostedRoutesPath();
  writeFileSync(routesPath, buildHostedHttpRoutesFile(entries), 'utf-8');
}

function clearHostedRoutes(): void {
  writeHostedRoutes([]);
}

function describeHostedServiceDiscoveryFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `failed to discover hosted services: ${error.message.trim()}`;
  }
  return 'failed to discover hosted services: tmux session listing failed';
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

async function waitForProcessReady(proc: Subprocess): Promise<boolean> {
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

async function clearPublishedServeRoutes(state: TmuxHostingState | null): Promise<void> {
  const baseHost = state?.baseHost;
  if (!baseHost) {
    clearHostedRoutes();
    return;
  }

  try {
    const parsedBaseHost = parseTmuxHostingBaseHost(baseHost);
    await syncServeRouteHostnames({
      rootSubdomain: parsedBaseHost.rootSubdomain,
      hostnames: [],
    });
  } catch {
    // Best effort cleanup only.
  }
  clearHostedRoutes();
}

async function stopManagedHostingRuntime(state: TmuxHostingState | null): Promise<void> {
  await stopManagedCloudflared(state);
  await clearPublishedServeRoutes(state);
}

function resolveManagedServeTunnel(parsedBaseHost: ParsedBaseHost): ManagedServeTunnel {
  const hostConfig = readHostConfig();
  const serveNamespace = hostConfig?.serveNamespaces?.[parsedBaseHost.rootSubdomain];
  if (!serveNamespace?.domain) {
    return { ok: false, reason: `missing serve tunnel configuration for ${parsedBaseHost.rootSubdomain}` };
  }

  const tunnel = serveNamespace.tunnel;
  if (!tunnel?.id || !tunnel.credentialsPath?.trim()) {
    return { ok: false, reason: `missing serve tunnel configuration for ${parsedBaseHost.rootSubdomain}` };
  }

  return {
    ok: true,
    rootSubdomain: parsedBaseHost.rootSubdomain,
    serveDomain: serveNamespace.domain,
    tunnelId: tunnel.id,
    credentialsPath: tunnel.credentialsPath,
  };
}

async function collectHostedServiceRoutes(
  state: TmuxHostingState,
  managedTunnel: Extract<ManagedServeTunnel, { ok: true }>,
): Promise<HostedServiceRouteCollection> {
  if (!await isServerRunning()) {
    return { ok: false, reason: 'tmux-lite server not running' };
  }

  let sessions: Awaited<ReturnType<typeof listSessionsFromRunningServer>>;
  try {
    sessions = await listSessionsFromRunningServer();
  } catch (error) {
    return { ok: false, reason: describeHostedServiceDiscoveryFailure(error) };
  }

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
      if (port.protocol === 'tcp') continue;
      const portLabel = port.name?.trim() || String(port.port);
      const hostname = buildProcessHostname(
        managedTunnel.serveDomain,
        managedTunnel.rootSubdomain,
        workspaceRef.workspaceId,
        processName,
        instance,
        portLabel,
        state.machineName,
      );
      entries.push({
        hostname,
        service: `http://127.0.0.1:${port.port}`,
      });
    }
  }

  const deduped = new Map(entries.map((entry) => [entry.hostname, entry]));
  return {
    ok: true,
    routes: [...deduped.values()].sort((a, b) => a.hostname.localeCompare(b.hostname)),
  };
}

export async function refreshTmuxHosting(): Promise<{ active: boolean; routes: HostedServiceRoute[]; reason?: string }> {
  const state = readTmuxHostingState();
  if (!state?.enabled) {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: 'disabled' };
  }
  if (!state.baseHost) {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: 'no base host selected' };
  }

  let parsedBaseHost: ParsedBaseHost;
  try {
    parsedBaseHost = parseTmuxHostingBaseHost(state.baseHost);
  } catch {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: 'invalid hosting base host' };
  }

  const managedTunnel = resolveManagedServeTunnel(parsedBaseHost);
  if (managedTunnel.ok === false) {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: managedTunnel.reason };
  }

  if (!await isCloudflaredInstalled()) {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: 'cloudflared not installed' };
  }

  const routeCollection = await collectHostedServiceRoutes(state, managedTunnel);
  if (routeCollection.ok === false) {
    await stopManagedHostingRuntime(state);
    return { active: false, routes: [], reason: routeCollection.reason };
  }
  const { routes } = routeCollection;

  const previousRoutesHash = readHostedRoutesHash();
  const nextRoutesHash = hashConfig(buildHostedHttpRoutesFile(routes));
  if (previousRoutesHash !== nextRoutesHash) {
    try {
      await syncServeRouteHostnames({
        rootSubdomain: managedTunnel.rootSubdomain,
        hostnames: routes.map((route) => route.hostname),
      });
    } catch (error) {
      await stopManagedHostingRuntime(state);
      return {
        active: false,
        routes: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    writeHostedRoutes(routes);
  }

  const configPath = getCloudflaredConfigPath();
  const config = buildCloudflaredConfig({
    tunnelId: managedTunnel.tunnelId,
    credentialsPath: managedTunnel.credentialsPath,
    routes,
  });
  const previousConfigHash = existsSync(configPath) ? hashConfig(readFileSync(configPath, 'utf-8')) : null;
  const nextConfigHash = hashConfig(config);
  if (previousConfigHash !== nextConfigHash) {
    writeFileSync(configPath, config, 'utf-8');
  }

  const currentPid = await resolveManagedCloudflaredPid(state);
  if (!currentPid && (state?.cloudflaredPid || state?.cloudflaredConfigPath)) {
    clearManagedCloudflaredRuntime();
  }

  if (currentPid && previousConfigHash === nextConfigHash) {
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

  const proc = spawn(['cloudflared', 'tunnel', '--config', configPath, 'run', managedTunnel.tunnelId], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (typeof proc.unref === 'function') {
    proc.unref();
  }

  const ready = await waitForProcessReady(proc);
  if (!ready) {
    clearManagedCloudflaredRuntime();
    return { active: false, routes, reason: 'cloudflared failed to start' };
  }

  writeTmuxHostingState({ cloudflaredPid: proc.pid, cloudflaredConfigPath: configPath, enabled: true });
  return { active: true, routes };
}

export async function stopTmuxHosting(): Promise<void> {
  const state = readTmuxHostingState();
  await stopManagedHostingRuntime(state);
}

export async function getTmuxHostingRuntimeStatus(): Promise<{ active: boolean; reason?: string; routeCount: number }> {
  const state = readTmuxHostingState();
  if (!state?.enabled) {
    return { active: false, routeCount: 0, reason: 'disabled' };
  }
  if (!state.baseHost) {
    return { active: false, routeCount: 0, reason: 'no base host selected' };
  }

  let parsedBaseHost: ParsedBaseHost;
  try {
    parsedBaseHost = parseTmuxHostingBaseHost(state.baseHost);
  } catch {
    return { active: false, routeCount: 0, reason: 'invalid hosting base host' };
  }

  const managedTunnel = resolveManagedServeTunnel(parsedBaseHost);
  if (managedTunnel.ok === false) {
    return { active: false, routeCount: 0, reason: managedTunnel.reason };
  }

  const routeCollection = await collectHostedServiceRoutes(state, managedTunnel);
  if (routeCollection.ok === false) {
    return { active: false, routeCount: 0, reason: routeCollection.reason };
  }

  const cloudflaredActive = (await resolveManagedCloudflaredPid(state)) !== null;
  return {
    active: cloudflaredActive,
    routeCount: routeCollection.routes.length,
    reason: cloudflaredActive ? undefined : 'cloudflared not running',
  };
}
