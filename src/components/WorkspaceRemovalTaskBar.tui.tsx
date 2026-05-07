/** @jsxImportSource @opentui/react */
import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { WorkspaceRemovalTask } from '../app/react/useWorkspaceRemovalTasks.js';

interface Props {
  tasks: WorkspaceRemovalTask[];
  modalOpen?: boolean;
}

const COLORS = {
  border: '#555555',
  text: '#FFFFFF',
  muted: '#888888',
  running: '#FFAA00',
  success: '#00FF88',
  error: '#FF5555',
};

function statusColor(task: WorkspaceRemovalTask): string {
  if (task.status === 'succeeded') return COLORS.success;
  if (task.status === 'failed') return COLORS.error;
  if (task.status === 'needs_attention') return COLORS.running;
  return COLORS.running;
}

function statusLabel(task: WorkspaceRemovalTask): string {
  if (task.status === 'succeeded') return 'removed';
  if (task.status === 'needs_attention') return 'needs attention';
  return task.status;
}

function elapsed(task: WorkspaceRemovalTask): string {
  const end = task.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function WorkspaceRemovalTaskBar({ tasks, modalOpen = false }: Props) {
  const [expanded, setExpanded] = useState(false);
  const activeTask = tasks.find((task) => task.status === 'running' || task.status === 'queued') ?? tasks[0] ?? null;

  useKeyboard((key) => {
    if (modalOpen || !activeTask) return;
    if (key.name === 't') {
      key.preventDefault?.();
      setExpanded((value) => !value);
    }
  });

  if (!activeTask) return null;

  if (expanded) {
    const visibleLogs = activeTask.logLines.slice(-8);
    return (
      <box flexDirection="column" border borderStyle="single" borderColor={COLORS.border} paddingLeft={1} paddingRight={1} height={14}>
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text fg={COLORS.text}>{activeTask.label}</text>
          <text fg={statusColor(activeTask)}>{statusLabel(activeTask)} · {elapsed(activeTask)} · [t] collapse</text>
        </box>
        <text fg={COLORS.muted} height={1}>{activeTask.phase ?? 'remove'} · {activeTask.progressLabel ?? statusLabel(activeTask)}</text>
        <box flexDirection="column" flexGrow={1}>
          {visibleLogs.length > 0 ? visibleLogs.map((line, index) => (
            <text key={`${index}:${line}`} fg={COLORS.text}>{line.slice(0, 160)}</text>
          )) : (
            <text fg={COLORS.muted}>No cleanup script output yet.</text>
          )}
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="row" justifyContent="space-between" border borderStyle="single" borderColor={COLORS.border} height={3} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.text}>task {activeTask.label} · {activeTask.progressLabel ?? statusLabel(activeTask)}</text>
      <text fg={statusColor(activeTask)}>{elapsed(activeTask)} · [t] logs</text>
    </box>
  );
}
