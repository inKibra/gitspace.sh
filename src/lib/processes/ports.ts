import { terminateSession, listSessionsFromRunningServer, isServerRunning } from '../tmux-lite/cli.js';
import { parseProcessSessionName } from './names.js';
import type { ResolvedProcessPort } from '../../types/processes.js';
import { normalizeProcessPortProtocol, PortConflictError, type PortConflictInfo } from './port-conflicts.js';

export function inspectListeningProcess(port: number): Array<{ pid: number; command?: string; user?: string; address?: string }> {
  const result = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcuPn']);
  if (result.exitCode !== 0) {
    return [];
  }

  const output = result.stdout.toString();
  const entries: Array<{ pid: number; command?: string; user?: string; address?: string }> = [];
  let current: { pid?: number; command?: string; user?: string; address?: string } = {};

  for (const line of output.split('\n')) {
    if (!line) continue;
    const prefix = line[0];
    const value = line.slice(1);
    if (prefix === 'p') {
      if (current.pid) {
        entries.push({ pid: current.pid, command: current.command, user: current.user, address: current.address });
      }
      current = { pid: Number(value) };
    } else if (prefix === 'c') {
      current.command = value;
    } else if (prefix === 'u') {
      current.user = value;
    } else if (prefix === 'n') {
      current.address = value;
    }
  }
  if (current.pid) {
    entries.push({ pid: current.pid, command: current.command, user: current.user, address: current.address });
  }
  return entries;
}

function getParentPid(pid: number): number | null {
  const result = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)]);
  if (result.exitCode !== 0) {
    return null;
  }
  const value = result.stdout.toString().trim();
  const parentPid = Number(value);
  return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
}

export async function resolveManagedSession(pid: number): Promise<PortConflictInfo | null> {
  try {
    if (!await isServerRunning()) {
      return null;
    }
  } catch {
    return null;
  }

  let sessions: Awaited<ReturnType<typeof listSessionsFromRunningServer>>;
  try {
    sessions = await listSessionsFromRunningServer();
  } catch {
    return null;
  }

  const sessionByPid = new Map(sessions.map((session) => [session.pid, session]));

  let currentPid: number | null = pid;
  while (currentPid && currentPid > 1) {
    const session = sessionByPid.get(currentPid);
    if (session) {
      const parsed = parseProcessSessionName(session.name);
      if (parsed?.processName) {
        return {
          port: 0,
          protocol: 'http',
          pid,
          managedSessionId: session.id,
          managedSessionName: session.name,
          managedWorkspaceId: parsed.workspaceId,
          managedProcessName: parsed.processName,
          managedInstance: parsed.instance,
        };
      }
    }
    currentPid = getParentPid(currentPid);
  }

  return null;
}

export async function detectPortConflicts(args: {
  processName: string;
  ports?: ResolvedProcessPort[];
}): Promise<PortConflictInfo[]> {
  const conflicts: PortConflictInfo[] = [];

  for (const port of args.ports ?? []) {
    if (!Number.isInteger(port.port) || port.port <= 0) continue;
    const listeners = inspectListeningProcess(port.port);
    for (const listener of listeners) {
      const managed = await resolveManagedSession(listener.pid);
      conflicts.push({
        port: port.port,
        protocol: normalizeProcessPortProtocol(port.protocol),
        pid: listener.pid,
        command: listener.command,
        user: listener.user,
        address: listener.address,
        managedSessionId: managed?.managedSessionId,
        managedSessionName: managed?.managedSessionName,
        managedWorkspaceId: managed?.managedWorkspaceId,
        managedProcessName: managed?.managedProcessName,
        managedInstance: managed?.managedInstance,
      });
    }
  }

  const deduped = new Map(conflicts.map((conflict) => [`${conflict.port}:${conflict.pid}`, conflict]));
  return [...deduped.values()];
}

export async function ensurePortsAvailable(args: { processName: string; ports?: ResolvedProcessPort[] }): Promise<void> {
  const conflicts = await detectPortConflicts(args);
  if (conflicts.length > 0) {
    throw new PortConflictError(args.processName, conflicts);
  }
}

export async function resolvePortConflict(conflict: PortConflictInfo): Promise<void> {
  if (conflict.managedSessionId) {
    await terminateSession(conflict.managedSessionId);
  } else {
    process.kill(conflict.pid, 'SIGTERM');
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (inspectListeningProcess(conflict.port).length === 0) {
      return;
    }
    await Bun.sleep(100);
  }
}
