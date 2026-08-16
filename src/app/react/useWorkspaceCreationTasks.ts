import { useCallback, useMemo, useState } from 'react';
import type { WorkspacePhase } from '../../types/config.js';
import type { RemoteOperationRecord } from '../../lib/remote-session/protocol.js';

export interface WorkspaceCreationTask {
  id: string;
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  phase: WorkspacePhase;
  status: 'creating' | 'failed';
  progressLabel: string;
  startedAt: number;
}

const MAX_TASKS = 8;

export function workspaceOperationsToCreationTasks(
  operations: Record<string, RemoteOperationRecord>,
): WorkspaceCreationTask[] {
  return Object.values(operations)
    .filter((operation) => operation.kind === 'workspace.create' && (operation.state === 'running' || operation.state === 'failed'))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((operation) => {
      const workspaceName = operation.scope.workspaceName
        ?? operation.scope.workspaceId?.split(':').slice(-1)[0]
        ?? 'workspace';
      const projectName = operation.scope.projectName ?? '';
      return {
        id: operation.operationId,
        workspaceId: operation.scope.workspaceId ?? `${projectName}:${workspaceName}`,
        workspaceName,
        projectName,
        phase: 'code',
        status: operation.state === 'running' ? 'creating' : 'failed',
        progressLabel: operation.error?.message ?? operation.message ?? 'Creating workspace...',
        startedAt: operation.startedAt,
      };
    });
}

export interface UseWorkspaceCreationTasksReturn {
  tasks: WorkspaceCreationTask[];
  tasksByWorkspaceId: Record<string, WorkspaceCreationTask>;
  startTask: (params: {
    projectName: string;
    workspaceName: string;
    phase?: WorkspacePhase;
    progressLabel?: string;
  }) => string;
  updateProgress: (workspaceId: string, progressLabel: string) => void;
	  completeTask: (id: string) => void;
	  completeTaskByWorkspaceId: (workspaceId: string) => void;
	  failTask: (id: string, message: string) => void;
	  failTaskByWorkspaceId: (workspaceId: string, message: string) => void;
	  dismissTask: (id: string) => void;
}

export function useWorkspaceCreationTasks(): UseWorkspaceCreationTasksReturn {
  const [tasks, setTasks] = useState<WorkspaceCreationTask[]>([]);

  const startTask = useCallback(
    (params: {
      projectName: string;
      workspaceName: string;
      phase?: WorkspacePhase;
      progressLabel?: string;
    }): string => {
      const id = `workspace-create:${params.projectName}:${params.workspaceName}:${Date.now().toString(36)}`;
      const workspaceId = `${params.projectName}:${params.workspaceName}`;
      const task: WorkspaceCreationTask = {
        id,
        workspaceId,
        workspaceName: params.workspaceName,
        projectName: params.projectName,
        phase: params.phase ?? 'code',
        status: 'creating',
        progressLabel: params.progressLabel ?? 'Creating workspace...',
        startedAt: Date.now(),
      };
      setTasks((current) => [task, ...current.filter((item) => item.workspaceId !== workspaceId)].slice(0, MAX_TASKS));
      return id;
    },
    [],
  );

  const updateProgress = useCallback((workspaceId: string, progressLabel: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.workspaceId === workspaceId && task.status === 'creating'
          ? { ...task, progressLabel }
          : task,
      ),
    );
  }, []);

  const completeTask = useCallback((id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);

  const failTask = useCallback((id: string, message: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === id
          ? { ...task, status: 'failed' as const, progressLabel: message }
          : task,
      ),
    );
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);

	  const completeTaskByWorkspaceId = useCallback((workspaceId: string) => {
	    setTasks((current) => current.filter((task) => task.workspaceId !== workspaceId));
	  }, []);

	  const failTaskByWorkspaceId = useCallback((workspaceId: string, message: string) => {
	    setTasks((current) =>
	      current.map((task) =>
	        task.workspaceId === workspaceId
	          ? { ...task, status: 'failed' as const, progressLabel: message }
	          : task,
	      ),
	    );
	  }, []);

  const tasksByWorkspaceId = useMemo(() => {
    const result: Record<string, WorkspaceCreationTask> = {};
    for (const task of tasks) {
      if (!result[task.workspaceId]) result[task.workspaceId] = task;
    }
    return result;
  }, [tasks]);

  return {
    tasks,
    tasksByWorkspaceId,
    startTask,
    updateProgress,
	    completeTask,
	    completeTaskByWorkspaceId,
	    failTask,
	    failTaskByWorkspaceId,
	    dismissTask,
	  };
	}
