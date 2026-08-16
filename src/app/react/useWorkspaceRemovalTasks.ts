import { useCallback, useMemo, useState } from 'react';
import { toBackendScopedWorkspaceKey, type BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { WorkspaceScriptPhase } from '../../types/script-phase.js';
import type { RemoteOperationKind, RemoteOperationRecord } from '../../lib/remote-session/protocol.js';

export type WorkspaceLifecycleScriptPhase = WorkspaceScriptPhase | 'remove';

export type WorkspaceRemoveResult =
  | { status: 'removed' }
  | { status: 'failed'; message: string; exitCode?: number }
  | { status: 'preserved_leftovers'; path: string; files: string[]; reason: string };

export interface WorkspaceRemovalTask {
  id: string;
  kind: 'workspace-lifecycle';
  operationKind?: RemoteOperationKind;
  label: string;
  workspaceName: string;
  workspaceId: string;
  ref: BackendScopedWorkspaceRef;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_attention';
  phase?: WorkspaceLifecycleScriptPhase | 'git-worktree-remove' | 'cleanup-leftovers';
  startedAt: number;
  completedAt?: number;
  progressLabel?: string;
  logLines: string[];
  result?: WorkspaceRemoveResult;
}

export interface WorkspaceRemovalTaskTarget {
  ref: BackendScopedWorkspaceRef;
  workspaceName: string;
}

const MAX_LOG_LINES = 500;

function createTaskId(workspaceId: string): string {
  return `workspace-lifecycle:${workspaceId}:${Date.now().toString(36)}`;
}

function phaseLabel(phase: WorkspaceLifecycleScriptPhase): string {
  if (phase === 'remove') return 'Remove';
  if (phase === 'setup') return 'Setup';
  if (phase === 'select') return 'Select';
  return 'Prepare';
}

function progressLabelForPhase(phase: WorkspaceLifecycleScriptPhase): string {
  if (phase === 'remove') return 'Running cleanup scripts...';
  return `Running ${phaseLabel(phase).toLowerCase()} scripts...`;
}

function appendLogLines(existing: string[], chunk: Uint8Array): string[] {
  if (chunk.length === 0) return existing;
  const text = new TextDecoder().decode(chunk);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const next = [...existing];
  for (const line of lines) {
    if (line.length === 0) continue;
    next.push(line);
  }
  return next.slice(-MAX_LOG_LINES);
}

function isLeftoversMessage(message: string): boolean {
  return /leftover|preserved/i.test(message);
}

function decodeOperationOutput(outputBase64: string | undefined): string[] {
  if (!outputBase64) return [];
  try {
    const binary = globalThis.atob(outputBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return appendLogLines([], bytes);
  } catch {
    return [];
  }
}

function workspaceNameFromOperation(operation: RemoteOperationRecord): string {
  return operation.scope.workspaceName
    ?? operation.scope.workspaceId?.split(':').slice(-1)[0]
    ?? 'workspace';
}

function phaseFromOperation(operation: RemoteOperationRecord): WorkspaceRemovalTask['phase'] {
  if (operation.kind === 'workspace.delete') {
    return operation.state === 'succeeded' ? 'git-worktree-remove' : 'remove';
  }
  const phase = operation.phase;
  if (phase === 'pre' || phase === 'setup' || phase === 'select' || phase === 'remove') {
    return phase;
  }
  return operation.kind === 'workspace.scripts' ? 'setup' : undefined;
}

function statusFromOperation(operation: RemoteOperationRecord): WorkspaceRemovalTask['status'] {
  if (operation.state === 'running') return 'running';
  if (operation.state === 'succeeded') return 'succeeded';
  return 'failed';
}

function labelFromOperation(operation: RemoteOperationRecord): string {
  const workspaceName = workspaceNameFromOperation(operation);
  if (operation.kind === 'workspace.delete') return `Remove ${workspaceName}`;
  if (operation.kind === 'workspace.scripts') return `${phaseLabel(phaseFromOperation(operation) === 'select' ? 'select' : 'setup')} ${workspaceName}`;
  return workspaceName;
}

export function workspaceOperationsToRemovalTasks(
  operations: Record<string, RemoteOperationRecord>,
  backendKey: string,
): WorkspaceRemovalTask[] {
  return Object.values(operations)
    .filter((operation) => operation.kind === 'workspace.delete' || operation.kind === 'workspace.scripts')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((operation) => {
      const workspaceName = workspaceNameFromOperation(operation);
      const workspaceId = operation.scope.workspaceId ?? `${operation.scope.projectName ?? ''}:${workspaceName}`;
      const status = statusFromOperation(operation);
      const task: WorkspaceRemovalTask = {
        id: operation.operationId,
        kind: 'workspace-lifecycle',
        operationKind: operation.kind,
        label: labelFromOperation(operation),
        workspaceName,
        workspaceId,
        ref: { backendKey, workspaceId },
        status,
        phase: phaseFromOperation(operation),
        startedAt: operation.startedAt,
        completedAt: status === 'running' ? undefined : operation.updatedAt,
        progressLabel: operation.message,
        logLines: decodeOperationOutput(operation.outputBase64),
        result: operation.state === 'failed'
          ? { status: 'failed', message: operation.error?.message ?? operation.message ?? 'Operation failed' }
          : operation.kind === 'workspace.delete' && operation.state === 'succeeded'
            ? { status: 'removed' }
            : undefined,
      };
      return task;
    });
}

export function useWorkspaceRemovalTasks() {
  const [tasks, setTasks] = useState<WorkspaceRemovalTask[]>([]);

  const activeTask = useMemo(
    () => tasks.find((task) => task.status === 'running' || task.status === 'queued') ?? tasks[0] ?? null,
    [tasks],
  );

  const tasksByWorkspaceId = useMemo(() => {
    const result: Record<string, WorkspaceRemovalTask> = {};
    for (const task of tasks) {
      if (!result[task.workspaceId]) result[task.workspaceId] = task;
    }
    return result;
  }, [tasks]);

  const tasksByWorkspaceKey = useMemo(() => {
    const result: Record<string, WorkspaceRemovalTask> = {};
    for (const task of tasks) {
      const key = toBackendScopedWorkspaceKey(task.ref);
      if (!result[key]) result[key] = task;
    }
    return result;
  }, [tasks]);

  const startTask = useCallback((target: WorkspaceRemovalTaskTarget): string => {
    const id = createTaskId(target.ref.workspaceId);
    const task: WorkspaceRemovalTask = {
      id,
      kind: 'workspace-lifecycle',
      label: `Remove ${target.workspaceName}`,
      workspaceName: target.workspaceName,
      workspaceId: target.ref.workspaceId,
      ref: target.ref,
      status: 'running',
      phase: 'remove',
      startedAt: Date.now(),
      progressLabel: 'Running cleanup scripts...',
      logLines: [],
    };
    setTasks((current) => [task, ...current.filter((item) => item.workspaceId !== task.workspaceId)].slice(0, 8));
    return id;
  }, []);

  const startLifecycleTask = useCallback((target: WorkspaceRemovalTaskTarget, phase: WorkspaceLifecycleScriptPhase = 'pre'): string => {
    const id = createTaskId(target.ref.workspaceId);
    const task: WorkspaceRemovalTask = {
      id,
      kind: 'workspace-lifecycle',
      label: `${phaseLabel(phase)} ${target.workspaceName}`,
      workspaceName: target.workspaceName,
      workspaceId: target.ref.workspaceId,
      ref: target.ref,
      status: 'running',
      phase,
      startedAt: Date.now(),
      progressLabel: progressLabelForPhase(phase),
      logLines: [],
    };
    setTasks((current) => [task, ...current.filter((item) => item.workspaceId !== task.workspaceId)].slice(0, 8));
    return id;
  }, []);

  const appendOutput = useCallback((workspaceId: string | undefined, data: Uint8Array) => {
    setTasks((current) => current.map((task) => {
      if (task.status !== 'running') return task;
      if (workspaceId && task.workspaceId !== workspaceId) return task;
      return {
        ...task,
        logLines: appendLogLines(task.logLines, data),
      };
    }));
  }, []);

  const updatePhase = useCallback((workspaceId: string | undefined, phase: WorkspaceRemovalTask['phase'], progressLabel: string) => {
    setTasks((current) => current.map((task) => {
      if (task.status !== 'running') return task;
      if (workspaceId && task.workspaceId !== workspaceId) return task;
      return {
        ...task,
        phase,
        label: phase && phase !== 'git-worktree-remove' && phase !== 'cleanup-leftovers'
          ? `${phaseLabel(phase)} ${task.workspaceName}`
          : task.label,
        progressLabel,
      };
    }));
  }, []);

  const completeTask = useCallback((id: string, result: WorkspaceRemoveResult) => {
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      const status = result.status === 'removed'
        ? 'succeeded'
        : result.status === 'preserved_leftovers'
          ? 'needs_attention'
          : 'failed';
      return {
        ...task,
        status,
        completedAt: Date.now(),
        phase: result.status === 'removed' ? 'git-worktree-remove' : task.phase,
        progressLabel: result.status === 'removed'
          ? 'Removed'
          : result.status === 'preserved_leftovers'
            ? 'Leftovers preserved'
            : 'Failed',
        result,
      };
    }));
  }, []);

  const completeSuccess = useCallback((id: string, progressLabel = 'Removed') => {
    if (progressLabel === 'Removed') {
      completeTask(id, { status: 'removed' });
      return;
    }
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      return { ...task, status: 'succeeded', completedAt: Date.now(), progressLabel };
    }));
  }, [completeTask]);

  const completeFailure = useCallback((id: string, message: string, exitCode?: number) => {
    completeTask(id, { status: 'failed', message, exitCode });
  }, [completeTask]);

  const completeFromError = useCallback((id: string, message: string) => {
    if (isLeftoversMessage(message)) {
      completeTask(id, {
        status: 'preserved_leftovers',
        path: '',
        files: [],
        reason: message,
      });
      return;
    }
    completeFailure(id, message);
  }, [completeFailure, completeTask]);

  const dismissTask = useCallback((id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);

  return {
    tasks,
    activeTask,
    tasksByWorkspaceId,
    tasksByWorkspaceKey,
    startTask,
    startLifecycleTask,
    appendOutput,
    updatePhase,
    completeSuccess,
    completeFailure,
    completeFromError,
    dismissTask,
  };
}
