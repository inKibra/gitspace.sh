/**
 * Process commands
 */
import { basename } from 'node:path';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { listSessions } from '../lib/tmux-lite/cli.js';
import {
  getProcessSpecs,
  startProcessInstance,
  stopProcessInstance,
  listProcessSessions,
} from '../lib/processes/manager.js';
import { loadProcessesConfig, getProcessDefinition } from '../lib/processes/config.js';
import { normalizeProcessInstanceCount } from '../lib/processes/instances.js';
import { readAllocatedProcessPorts } from '../lib/processes/allocations.js';
import { openBrowserUrl } from '../utils/open-browser.js';
import { refreshTmuxHosting } from '../lib/tmux-lite/hosting/supervisor.js';
import {
  buildServiceEndpoints,
  getHostingRouteState,
  type HostingRouteState,
  type ServiceEndpoint,
} from '../lib/services/endpoints.js';

interface ProcessCommandOptions {
  workspace?: string;
  name?: string;
  port?: string;
  all?: boolean;
  local?: boolean;
  remote?: boolean;
}

function resolveWorkspacePath(): string {
  return process.cwd();
}

function getWorkspaceId(workspacePath: string): string {
  return basename(workspacePath) || workspacePath;
}

async function getSpecEndpoints(
  workspacePath: string,
  spec: ReturnType<typeof getProcessSpecs>[number],
  workspaceId: string,
  hosting: HostingRouteState,
): Promise<ServiceEndpoint[]> {
  const ports = readAllocatedProcessPorts(workspacePath, spec);
  return buildServiceEndpoints({
    workspaceId,
    processName: spec.name,
    instance: spec.instance,
    ports,
    hosting,
  });
}

function formatEndpointLabel(endpoint: ServiceEndpoint): string {
  return `${endpoint.portLabel} (${endpoint.protocol}:${endpoint.port})`;
}

function selectBrowserEndpoints(endpoints: ServiceEndpoint[], options: ProcessCommandOptions): ServiceEndpoint[] {
  if (options.local && options.remote) {
    throw new SpacesError('Choose only one of --local or --remote', 'USER_ERROR');
  }

  let filtered = endpoints.filter((endpoint) => endpoint.protocol === 'http');
  if (options.port) {
    filtered = filtered.filter((endpoint) => endpoint.portLabel === options.port || String(endpoint.port) === options.port);
  }

  if (filtered.length === 0) {
    const reason = options.port
      ? `No openable HTTP port matched ${options.port}`
      : 'No openable HTTP ports configured';
    throw new SpacesError(reason, 'USER_ERROR');
  }

  if (options.remote) {
    filtered = filtered.filter((endpoint) => Boolean(endpoint.remoteUrl) && endpoint.hostingEnabled);
    if (filtered.length === 0) {
      throw new SpacesError('No active hosted URL available for this process', 'USER_ERROR');
    }
  }

  return options.all ? filtered : [filtered[0]!];
}

function getOpenTargetUrl(endpoint: ServiceEndpoint, options: ProcessCommandOptions): string {
  if (options.local) {
    return endpoint.localUrl;
  }
  if (options.remote) {
    if (!endpoint.remoteUrl) {
      throw new SpacesError('No hosted URL available for this process', 'USER_ERROR');
    }
    return endpoint.remoteUrl;
  }
  return endpoint.remoteUrl && endpoint.hostingEnabled ? endpoint.remoteUrl : endpoint.localUrl;
}

export async function listProcesses(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  const specs = getProcessSpecs(workspacePath);
  const sessions = await listProcessSessions(workspacePath);
  const hosting = getHostingRouteState();
  const workspaceId = getWorkspaceId(workspacePath);

  if (specs.length === 0) {
    logger.info('No processes configured in .gitspace/processes.json.');
    return;
  }

  for (const spec of specs) {
    const running = sessions.find(
      (session) => session.processName === spec.name && session.instance === spec.instance,
    );
    const status = running ? 'running' : 'stopped';
    logger.log(`${spec.name}#${spec.instance} ${status}`);
    const endpoints = await getSpecEndpoints(workspacePath, spec, workspaceId, hosting);
    if (endpoints.length === 0) {
      // Ports are allocated at start; a configured-but-never-started process
      // legitimately has none yet. Reporting no longer allocates on read.
      const hasConfiguredPorts = (spec.definition.ports ?? []).length > 0;
      logger.log(hasConfiguredPorts ? '  ports not allocated yet (start the service)' : '  no ports configured');
      continue;
    }
    for (const endpoint of endpoints) {
      logger.log(`  ${formatEndpointLabel(endpoint)}`);
      logger.log(`    local:  ${endpoint.localUrl}`);
      logger.log(`    remote: ${endpoint.remoteUrl
        ? `${endpoint.remoteUrl}${endpoint.hostingEnabled ? '' : ' (configured, hosting disabled)'}`
        : 'not configured (run `space hosting select`)'
      }`);
    }
  }
}

export async function startProcess(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  if (!options.name) {
    throw new SpacesError('Provide process name via --name', 'USER_ERROR');
  }

  const specs = getProcessSpecs(workspacePath).filter((spec) => spec.name === options.name);
  if (specs.length === 0) {
    const processConfig = loadProcessesConfig(workspacePath);
    const definition = getProcessDefinition(processConfig, options.name);
    if (definition && normalizeProcessInstanceCount(definition.instances) === 0) {
      throw new SpacesError(`Process is disabled (instances: 0): ${options.name}`, 'USER_ERROR');
    }
    throw new SpacesError(`Process not found: ${options.name}`, 'USER_ERROR');
  }

  for (const spec of specs) {
    const result = await startProcessInstance(workspacePath, spec);
    const note = result.created ? 'started' : 'already running';
    logger.log(`${spec.name}#${spec.instance} ${note} (${result.sessionId})`);
  }
  await refreshTmuxHosting().catch(() => undefined);
}

export async function stopProcess(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  if (!options.name) {
    throw new SpacesError('Provide process name via --name', 'USER_ERROR');
  }

  const specs = getProcessSpecs(workspacePath).filter((spec) => spec.name === options.name);
  if (specs.length === 0) {
    throw new SpacesError(`Process not found: ${options.name}`, 'USER_ERROR');
  }

  for (const spec of specs) {
    await stopProcessInstance(workspacePath, spec);
    logger.log(`${spec.name}#${spec.instance} stopped`);
  }
  await refreshTmuxHosting().catch(() => undefined);
}

export async function attachProcess(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  if (!options.name) {
    throw new SpacesError('Provide process name via --name', 'USER_ERROR');
  }

  const sessions = await listProcessSessions(workspacePath);
  const target = sessions.find((session) => session.processName === options.name);
  if (!target) {
    throw new SpacesError(`Process not running: ${options.name}`, 'USER_ERROR');
  }

  const sessionList = await listSessions();
  const session = sessionList.find((item) => item.id === target.sessionId);
  if (!session) {
    throw new SpacesError(`Session not found for process ${options.name}`, 'SYSTEM_ERROR');
  }

  logger.info(`Attach with: gssh machine tmux attach ${session.id}`);
}

export async function openProcess(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  if (!options.name) {
    throw new SpacesError('Provide process name via --name', 'USER_ERROR');
  }

  const workspaceId = getWorkspaceId(workspacePath);
  const hosting = getHostingRouteState();
  const specs = getProcessSpecs(workspacePath).filter((spec) => spec.name === options.name);
  if (specs.length === 0) {
    throw new SpacesError(`Process not found: ${options.name}`, 'USER_ERROR');
  }

  const endpoints = (await Promise.all(specs.map((spec) => getSpecEndpoints(workspacePath, spec, workspaceId, hosting)))).flat();
  const selected = selectBrowserEndpoints(endpoints, options);

  for (const endpoint of selected) {
    const targetUrl = getOpenTargetUrl(endpoint, options);
    const result = await openBrowserUrl(targetUrl);
    if (!result.ok) {
      throw new SpacesError(`Failed to open browser: ${result.message}`, 'SYSTEM_ERROR');
    }
    logger.log(`Opened ${options.name} ${formatEndpointLabel(endpoint)} -> ${targetUrl}`);
  }
}
