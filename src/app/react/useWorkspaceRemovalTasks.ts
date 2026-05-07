import { useCallback, useMemo, useState } from 'react';
import { toBackendScopedWorkspaceKey, type BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { WorkspaceScriptPhase } from '../../types/script-phase.js';

export type WorkspaceLifecycleScriptPhase = WorkspaceScriptPhase | 'remove';

export type WorkspaceRemoveResult =
  | { status: 'removed' }
  | { status: 'failed'; message: string; exitCode?: number }
  | { status: 'preserved_leftovers'; path: string; files: string[]; reason: string };

export interface WorkspaceRemovalTask {
  id: string;
  kind: 'workspace-lifecycle';
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
      progressLabel: 'Running workspace scripts...',
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
