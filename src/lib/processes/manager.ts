/**
 * Workspace process manager
 */

import { join } from 'path';
import { listSessions, createSession, killSession } from '../tmux-lite/cli.js';
import type { ProcessInstanceSpec, ProcessDefinition, ProcessesConfig } from '../../types/processes.js';
import { getProcessInstances, loadProcessesConfig } from './config.js';
import { buildProcessSessionName, parseProcessSessionName } from './names.js';

export interface ProcessSessionInfo {
  sessionId: string;
  name: string;
  workspacePath: string;
  processName: string;
  instance: number;
}

export interface ProcessRunResult {
  sessionId: string;
  created: boolean;
}

export async function listProcessSessions(workspacePath: string): Promise<ProcessSessionInfo[]> {
  const sessions = await listSessions();
  const workspaceId = workspacePath.split('/').pop() ?? workspacePath;
  return sessions
    .filter((session) => session.name.startsWith('proc:'))
    .map((session) => {
      const parsed = parseProcessSessionName(session.name);
      if (!parsed) return null;
      return {
        sessionId: session.id,
        name: session.name,
        workspacePath: session.cwd,
        processName: parsed.processName,
        instance: parsed.instance,
      };
    })
    .filter((item): item is ProcessSessionInfo => Boolean(item))
    .filter((item) =>
      item.name.includes(`:${workspaceId}:`) &&
      (item.workspacePath === workspacePath || item.workspacePath.startsWith(workspacePath))
    );
}

export function loadWorkspaceProcesses(workspacePath: string): ProcessesConfig {
  return loadProcessesConfig(workspacePath);
}

export async function startProcessInstance(
  workspacePath: string,
  spec: ProcessInstanceSpec
): Promise<ProcessRunResult> {
  const existing = await listProcessSessions(workspacePath);
  const target = existing.find(
    (item) => item.processName === spec.name && item.instance === spec.instance
  );

  if (target) {
    return { sessionId: target.sessionId, created: false };
  }

  if (!spec.definition.command) {
    throw new Error(`Process ${spec.name} is missing a command`);
  }

  const workspaceId = workspacePath.split('/').pop() ?? workspacePath;
  const sessionName = buildProcessSessionName(workspaceId, spec.name, spec.instance);
  const cwd = spec.definition.cwd
    ? join(workspacePath, spec.definition.cwd)
    : workspacePath;

  const runnerArgs = [
    "--internal-process-runner",
    "--workspace",
    workspacePath,
    "--process",
    spec.name,
    "--instance",
    String(spec.instance),
  ];

  const devScript = process.execPath.endsWith('bun')
    ? [join(import.meta.dir, "../../index.ts"), ...runnerArgs]
    : runnerArgs;

  const session = await createSession(sessionName, cwd, {
    command: process.execPath,
    args: devScript,
    env: spec.definition.env,
  });

  return { sessionId: session.id, created: true };
}

export async function stopProcessInstance(
  workspacePath: string,
  spec: ProcessInstanceSpec
): Promise<void> {
  const sessions = await listProcessSessions(workspacePath);
  const target = sessions.find(
    (item) => item.processName === spec.name && item.instance === spec.instance
  );
  if (!target) return;
  await killSession(target.sessionId);
}

export function getRestartConfig(definition: ProcessDefinition) {
  return {
    policy: definition.restart?.policy ?? 'never',
    maxAttempts: definition.restart?.maxAttempts ?? 5,
    backoffMs: definition.restart?.backoffMs ?? 2000,
    maxBackoffMs: definition.restart?.maxBackoffMs ?? 30000,
  };
}

export function getProcessSpecs(workspacePath: string): ProcessInstanceSpec[] {
  const config = loadProcessesConfig(workspacePath);
  return getProcessInstances(config);
}

export { buildProcessSessionName, parseProcessSessionName } from './names.js';
