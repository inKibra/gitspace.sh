/** @jsxImportSource react */
import { useMemo, useState } from 'react';
import type { WorkspaceRemovalTask } from '../app/react/useWorkspaceRemovalTasks.js';
import { ScriptTerminalPanel } from './ScriptTerminalPanel.web.js';
import type { ScriptPhase } from './ScriptTerminalPanel.web.js';

interface Props {
  tasks: WorkspaceRemovalTask[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  onDismiss: (taskId: string) => void | Promise<void>;
  placement?: 'fixed' | 'inline';
}

function formatElapsed(task: WorkspaceRemovalTask): string {
  const end = task.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function getStatusLabel(task: WorkspaceRemovalTask): string {
  if (task.status === 'succeeded') {
    return task.operationKind === 'workspace.delete' || task.result?.status === 'removed' ? 'removed' : 'complete';
  }
  if (task.status === 'needs_attention') return 'needs attention';
  return task.status;
}

function getStatusClass(task: WorkspaceRemovalTask): string {
  if (task.status === 'succeeded') return 'text-[var(--gs-success)]';
  if (task.status === 'failed') return 'text-[var(--gs-danger-hover)]';
  if (task.status === 'needs_attention') return 'text-[var(--gs-warning-bright)]';
  return 'text-[var(--gs-warning)]';
}

function getScriptPhase(task: WorkspaceRemovalTask): ScriptPhase {
  if (task.phase === 'pre' || task.phase === 'setup' || task.phase === 'select' || task.phase === 'remove') {
    return task.phase;
  }
  return 'remove';
}

function getEmptyLogLabel(task: WorkspaceRemovalTask): string {
  return task.phase === 'remove'
    ? 'No cleanup script output yet.'
    : 'No workspace script output yet.';
}

function getFallbackTask(tasks: WorkspaceRemovalTask[]): WorkspaceRemovalTask | null {
  return tasks.find((task) => task.status === 'running' || task.status === 'queued') ?? tasks[0] ?? null;
}

export function WorkspaceRemovalTaskBar({ tasks, selectedTaskId, onSelectTask, onDismiss, placement = 'fixed' }: Props) {
  const [expanded, setExpanded] = useState(false);
  const activeTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? getFallbackTask(tasks),
    [tasks, selectedTaskId],
  );

  if (!activeTask) return null;

  const containerClass = placement === 'fixed'
    ? 'fixed inset-x-0 bottom-0 z-40 border-t border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-2xl'
    : 'flex-shrink-0 border-t border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]';

  return (
    <div className={containerClass}>
      {expanded && (
        <div className="grid max-h-[45vh] grid-cols-1 gap-0 border-b border-[var(--gs-border)] md:grid-cols-[260px_1fr]">
          <div className="max-h-[45vh] overflow-y-auto border-b border-[var(--gs-border)] md:border-b-0 md:border-r">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelectTask?.(task.id)}
                aria-pressed={task.id === activeTask.id}
                className={`flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--gs-bg-surface)] ${task.id === activeTask.id ? 'bg-[var(--gs-bg-surface)]' : ''}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-[var(--gs-text)]">{task.label}</span>
                  <span className={`block text-xs ${getStatusClass(task)}`}>{getStatusLabel(task)}</span>
                </span>
                {task.completedAt && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDismiss(task.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        onDismiss(task.id);
                      }
                    }}
                    className="text-xs text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]"
                  >
                    dismiss
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex max-h-[45vh] flex-col">
            <ScriptTerminalPanel
              phase={getScriptPhase(activeTask)}
              workspaceName={activeTask.workspaceName}
              isRunning={activeTask.status === 'running' || activeTask.status === 'queued'}
              error={activeTask.result?.status === 'failed' ? activeTask.result.message : undefined}
              exitCode={activeTask.result?.status === 'failed' ? activeTask.result.exitCode : undefined}
              logLines={activeTask.logLines}
              emptyLogLabel={getEmptyLogLabel(activeTask)}
              className="h-full"
            />
            {activeTask.result?.status === 'preserved_leftovers' && (
              <div className="border-t border-[var(--gs-chip-amber-border)] bg-[var(--gs-chip-amber-bg)] px-4 py-2 text-xs text-[var(--gs-warning-bright)]">
                {activeTask.result.reason}
              </div>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className={`text-xs uppercase tracking-[0.16em] ${getStatusClass(activeTask)}`}>task</span>
          <span className="truncate text-sm text-[var(--gs-text)]">{activeTask.label}</span>
          <span className="hidden text-xs text-[var(--gs-text-muted)] sm:inline">{activeTask.progressLabel ?? getStatusLabel(activeTask)}</span>
        </span>
        <span className="shrink-0 text-xs text-[var(--gs-text-muted)]">
          {formatElapsed(activeTask)} · {expanded ? 'collapse' : 'logs'}
        </span>
      </button>
    </div>
  );
}
