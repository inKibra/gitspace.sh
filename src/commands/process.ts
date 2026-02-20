/**
 * Process commands
 */

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

interface ProcessCommandOptions {
  workspace?: string;
  name?: string;
}

function resolveWorkspacePath(): string {
  return process.cwd();
}

export async function listProcesses(options: ProcessCommandOptions): Promise<void> {
  const workspacePath = options.workspace || resolveWorkspacePath();
  const specs = getProcessSpecs(workspacePath);
  const sessions = await listProcessSessions(workspacePath);

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

  logger.info(`Attach with: gssh tmux attach ${session.id}`);
}
