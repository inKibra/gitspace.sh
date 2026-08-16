import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type {
  ProcessInstanceSpec,
  ProcessPortConfig,
  ProcessPortProtocol,
  ProcessesConfig,
  ResolvedProcessPort,
  RuntimeProcessDefinition,
} from '../../types/processes.js';
import { resolveWorkspaceRef } from '../events/paths.js';
import { toWorkspaceId } from '../../utils/workspace-id.js';
import { normalizeProcessInstanceCount } from './instances.js';
import { getProcessControlDir } from './control.js';
import { inspectListeningProcess, resolveManagedSession } from './ports.js';
import { normalizeProcessPortProtocol } from './port-conflicts.js';

const PORT_ALLOCATION_VERSION = 1;
const MIN_ALLOCATED_PORT = 17000;
const MAX_ALLOCATED_PORT = 47000;

interface ProcessPortAllocation {
  port: number;
  protocol: ProcessPortProtocol;
  updatedAt: number;
}

interface ProcessPortAllocationState {
  version: number;
  allocations: Record<string, ProcessPortAllocation>;
}

export class ProcessPortAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessPortAllocationError';
  }
}

function getWorkspaceRuntimeId(workspacePath: string): string {
  return resolveWorkspaceRef(workspacePath)?.workspaceId ?? basename(workspacePath) ?? workspacePath;
}

function getPortAllocationKey(processName: string, instance: number, portName: string): string {
  return `${processName}:${instance}:${portName}`;
}

export function getProcessPortAllocationPath(workspacePath: string): string {
  return join(getProcessControlDir(workspacePath), 'ports.json');
}

function readProcessPortAllocationState(workspacePath: string): ProcessPortAllocationState {
  const path = getProcessPortAllocationPath(workspacePath);
  if (!existsSync(path)) {
    return { version: PORT_ALLOCATION_VERSION, allocations: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProcessPortAllocationState>;
    const allocations = parsed.allocations && typeof parsed.allocations === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.allocations)
            .filter(([, entry]) => {
              return Boolean(
                entry
                && typeof entry === 'object'
                && Number.isInteger((entry as ProcessPortAllocation).port)
                && (entry as ProcessPortAllocation).port > 0
                && (((entry as ProcessPortAllocation).protocol === 'http') || ((entry as ProcessPortAllocation).protocol === 'tcp'))
                && typeof (entry as ProcessPortAllocation).updatedAt === 'number'
              );
            }) as Array<[string, ProcessPortAllocation]>,
        )
      : {};
    return {
      version: PORT_ALLOCATION_VERSION,
      allocations,
    };
  } catch {
    return { version: PORT_ALLOCATION_VERSION, allocations: {} };
  }
}

function writeProcessPortAllocationState(workspacePath: string, state: ProcessPortAllocationState): void {
  const path = getProcessPortAllocationPath(workspacePath);
  mkdirSync(getProcessControlDir(workspacePath), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function hashString(input: string): number {
  let hash = 0;
  for (let idx = 0; idx < input.length; idx += 1) {
    hash = (hash * 31 + input.charCodeAt(idx)) >>> 0;
  }
  return hash;
}

function collectExpectedAllocationKeys(config: ProcessesConfig): Set<string> {
  const expectedKeys = new Set<string>();
  for (const process of config.processes) {
    const count = normalizeProcessInstanceCount(process.instances);
    for (let instance = 1; instance <= count; instance += 1) {
      for (const port of process.ports ?? []) {
        expectedKeys.add(getPortAllocationKey(process.name, instance, port.name));
      }
    }
  }
  return expectedKeys;
}

export function reconcileProcessPortAllocations(workspacePath: string, config: ProcessesConfig): void {
  const state = readProcessPortAllocationState(workspacePath);
  const expectedKeys = collectExpectedAllocationKeys(config);
  const nextAllocations = Object.fromEntries(
    Object.entries(state.allocations).filter(([key]) => expectedKeys.has(key)),
  );

  if (Object.keys(nextAllocations).length !== Object.keys(state.allocations).length) {
    writeProcessPortAllocationState(workspacePath, {
      version: PORT_ALLOCATION_VERSION,
      allocations: nextAllocations,
    });
  }
}

async function allocationBelongsToRunningSpec(
  workspacePath: string,
  processName: string,
  instance: number,
  port: number,
): Promise<boolean> {
  // Match the canonical, project-qualified workspace id the process runner
  // records in its session metadata (`toWorkspaceId(project, workspace)`, see
  // startProcessInstance). Using the bare/name-derived id here is what caused
  // long-named workspaces to never match, since the session name is truncated.
  const ref = resolveWorkspaceRef(workspacePath);
  const workspaceId = ref
    ? toWorkspaceId(ref.projectName, ref.workspaceId)
    : getWorkspaceRuntimeId(workspacePath);
  const listeners = inspectListeningProcess(port);
  if (listeners.length === 0) {
    return false;
  }

  for (const listener of listeners) {
    const managed = await resolveManagedSession(listener.pid);
    if (
      managed?.managedWorkspaceId === workspaceId
      && managed.managedProcessName === processName
      && managed.managedInstance === instance
    ) {
      return true;
    }
  }

  return false;
}

async function isAllocationReusable(
  workspacePath: string,
  processName: string,
  instance: number,
  entry: ProcessPortAllocation,
): Promise<boolean> {
  const listeners = inspectListeningProcess(entry.port);
  if (listeners.length === 0) {
    return true;
  }

  return allocationBelongsToRunningSpec(workspacePath, processName, instance, entry.port);
}

async function findAvailablePort(
  workspacePath: string,
  processName: string,
  instance: number,
  portName: string,
  reservedPorts: Set<number>,
): Promise<number> {
  const rangeSize = MAX_ALLOCATED_PORT - MIN_ALLOCATED_PORT + 1;
  const seed = hashString(`${getWorkspaceRuntimeId(workspacePath)}:${processName}:${instance}:${portName}`) % rangeSize;

  for (let offset = 0; offset < rangeSize; offset += 1) {
    const candidate = MIN_ALLOCATED_PORT + ((seed + offset) % rangeSize);
    if (reservedPorts.has(candidate)) {
      continue;
    }

    const listeners = inspectListeningProcess(candidate);
    if (listeners.length === 0) {
      return candidate;
    }

    if (await allocationBelongsToRunningSpec(workspacePath, processName, instance, candidate)) {
      return candidate;
    }
  }

  throw new ProcessPortAllocationError(
    `Unable to allocate a local port for ${processName}#${instance}:${portName}; no free port found in ${MIN_ALLOCATED_PORT}-${MAX_ALLOCATED_PORT}.`,
  );
}

function getReservedPortsForOtherAllocations(
  state: ProcessPortAllocationState,
  currentKeys: Set<string>,
): Set<number> {
  const reserved = new Set<number>();
  for (const [key, entry] of Object.entries(state.allocations)) {
    if (currentKeys.has(key)) {
      continue;
    }
    reserved.add(entry.port);
  }
  return reserved;
}

async function resolveDeclaredPortAllocation(
  workspacePath: string,
  spec: ProcessInstanceSpec,
  port: ProcessPortConfig,
  state: ProcessPortAllocationState,
  reservedPorts: Set<number>,
): Promise<ResolvedProcessPort> {
  const key = getPortAllocationKey(spec.name, spec.instance, port.name);
  const protocol = normalizeProcessPortProtocol(port.protocol);
  const existing = state.allocations[key];

  if (
    existing
    && existing.protocol === protocol
    && !reservedPorts.has(existing.port)
    && await isAllocationReusable(workspacePath, spec.name, spec.instance, existing)
  ) {
    existing.updatedAt = Date.now();
    reservedPorts.add(existing.port);
    return {
      instance: spec.instance,
      name: port.name,
      protocol,
      port: existing.port,
    };
  }

  const nextPort = await findAvailablePort(workspacePath, spec.name, spec.instance, port.name, reservedPorts);
  state.allocations[key] = {
    port: nextPort,
    protocol,
    updatedAt: Date.now(),
  };
  reservedPorts.add(nextPort);
  return {
    instance: spec.instance,
    name: port.name,
    protocol,
    port: nextPort,
  };
}

/**
 * Allocate (and persist) runtime ports for a process instance. This MUTATES
 * `ports.json` and may reallocate — it is the *start* path only (runner and
 * `startProcessInstance`). Reporting/routing paths must use
 * {@link readAllocatedProcessPorts} instead, so they can never move the port
 * of a running process.
 */
export async function resolveProcessRuntimePorts(
  workspacePath: string,
  spec: ProcessInstanceSpec,
): Promise<ResolvedProcessPort[]> {
  const state = readProcessPortAllocationState(workspacePath);
  const currentKeys = new Set((spec.definition.ports ?? []).map((port) => getPortAllocationKey(spec.name, spec.instance, port.name)));
  const reservedPorts = getReservedPortsForOtherAllocations(state, currentKeys);
  const resolvedPorts: ResolvedProcessPort[] = [];

  for (const port of spec.definition.ports ?? []) {
    resolvedPorts.push(await resolveDeclaredPortAllocation(workspacePath, spec, port, state, reservedPorts));
  }

  writeProcessPortAllocationState(workspacePath, state);
  return resolvedPorts;
}

/**
 * Pure read of the persisted port allocations for a process instance. Unlike
 * {@link resolveProcessRuntimePorts} this NEVER allocates, probes (lsof),
 * reconciles, or writes — it just reports what start-time allocation recorded.
 * Reporting and routing paths (`space service list`, machine snapshot, hosting
 * routes) use this so they can never move a running process's port. Ports with
 * no recorded allocation (never started) are omitted.
 */
export function readAllocatedProcessPorts(
  workspacePath: string,
  spec: ProcessInstanceSpec,
): ResolvedProcessPort[] {
  const state = readProcessPortAllocationState(workspacePath);
  const resolved: ResolvedProcessPort[] = [];
  for (const port of spec.definition.ports ?? []) {
    const existing = state.allocations[getPortAllocationKey(spec.name, spec.instance, port.name)];
    if (!existing) continue;
    resolved.push({
      instance: spec.instance,
      name: port.name,
      protocol: normalizeProcessPortProtocol(port.protocol),
      port: existing.port,
    });
  }
  return resolved;
}

/**
 * Read-only runtime process/port report for snapshots. Never allocates,
 * reconciles, or writes — it reflects the persisted allocation only.
 */
export function resolveRuntimeProcesses(
  workspacePath: string,
  config: ProcessesConfig,
): RuntimeProcessDefinition[] {
  return config.processes.map((process) => {
    const ports: ResolvedProcessPort[] = [];
    const instanceCount = normalizeProcessInstanceCount(process.instances);

    for (let instance = 1; instance <= instanceCount; instance += 1) {
      ports.push(...readAllocatedProcessPorts(workspacePath, {
        name: process.name,
        instance,
        definition: process,
      }));
    }

    return {
      name: process.name,
      instances: process.instances,
      ports,
    } satisfies RuntimeProcessDefinition;
  });
}
