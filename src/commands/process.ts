/**
 * Process commands
 */

import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { listSessions } from '../lib/tmux-lite/cli.js';
import { basename } from 'node:path';
import {
  getProcessSpecs,
  startProcessInstance,
  stopProcessInstance,
  listProcessSessions,
} from '../lib/processes/manager.js';
import { loadProcessesConfig, getProcessDefinition } from '../lib/processes/config.js';
import { normalizeProcessInstanceCount } from '../lib/processes/instances.js';
import { openBrowserUrl } from '../utils/open-browser.js';
import type { ProcessPortConfig } from '../types/processes.js';
import { refreshTmuxHosting } from '../lib/tmux-lite/hosting/supervisor.js';
import { PortConflictError, resolvePortConflict, type PortConflictInfo } from '../lib/processes/ports.js';
import { selectOne } from '../utils/prompts.js';
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

function getSpecEndpoints(
  spec: { name: string; instance: number; definition: { ports?: ProcessPortConfig[] } },
  workspaceId: string,
  hosting: HostingRouteState
): ServiceEndpoint[] {
  return buildServiceEndpoints({
    workspaceId,
    processName: spec.name,
    instance: spec.instance,
    ports: spec.definition.ports,
    hosting,
  });
}

function formatEndpointLabel(endpoint: ServiceEndpoint): string {
  return endpoint.portLabel === String(endpoint.port)
    ? `${endpoint.protocol}:${endpoint.port}`
    : `${endpoint.portLabel} (${endpoint.protocol}:${endpoint.port})`;
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

function describePortConflict(conflict: PortConflictInfo): string {
  if (conflict.managedSessionId) {
    return `:${conflict.port} used by ${conflict.managedProcessName ?? 'service'}#${conflict.managedInstance ?? 1} in ${conflict.managedWorkspaceId ?? 'another workspace'}`;
  }
  return `:${conflict.port} used by ${conflict.command ?? 'unknown process'} (pid ${conflict.pid}${conflict.user ? `, ${conflict.user}` : ''})`;
}

async function resolveStartConflict(specName: string, error: PortConflictError): Promise<boolean> {
  const conflict = error.conflicts[0];
  if (!conflict) {
    throw error;
  }

  const choice = await selectOne([
    {
      label: conflict.managedSessionId ? 'Stop conflicting service' : 'Kill conflicting process',
      value: 'resolve',
      description: describePortConflict(conflict),
    },
    { label: 'Cancel', value: 'cancel', description: `Do not start ${specName}` },
  ], `Cannot start ${specName}: ${describePortConflict(conflict)}`);

  if (choice !== 'resolve') {
    return false;
  }

  await resolvePortConflict(conflict);
  return true;
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
      (session) => session.processName === spec.name && session.instance === spec.instance
    );
    const status = running ? 'running' : 'stopped';
    logger.log(`${spec.name}#${spec.instance} ${status}`);
    const endpoints = getSpecEndpoints(spec, workspaceId, hosting);
    if (endpoints.length === 0) {
      logger.log('  no ports configured');
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
    try {
      const result = await startProcessInstance(workspacePath, spec);
      const note = result.created ? 'started' : 'already running';
      logger.log(`${spec.name}#${spec.instance} ${note} (${result.sessionId})`);
    } catch (error) {
      if (error instanceof PortConflictError) {
        const resolved = await resolveStartConflict(spec.name, error);
        if (!resolved) {
          throw new SpacesError(`Start cancelled for ${spec.name}`, 'USER_ERROR');
        }
        const result = await startProcessInstance(workspacePath, spec);
        const note = result.created ? 'started' : 'already running';
        logger.log(`${spec.name}#${spec.instance} ${note} (${result.sessionId})`);
        continue;
      }
      throw error;
    }
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

  const endpoints = specs.flatMap((spec) => getSpecEndpoints(spec, workspaceId, hosting));
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
