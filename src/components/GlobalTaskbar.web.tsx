/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { WorkspaceRemovalTask } from '../app/react/useWorkspaceRemovalTasks.js';

/**
 * Persistent bottom lifecycle taskbar (mock GlobalChrome BottomTaskbar):
 * status dot + task title + PRE/SETUP/SELECT/REMOVE step pills + elapsed +
 * '+N queued' chip + expandable log. Fed by the workspace lifecycle tasks.
 */

const STEP_ORDER = ['pre', 'setup', 'select', 'remove'] as const;

function currentStep(task: WorkspaceRemovalTask): string {
  const p = task.phase ?? '';
  if (p === 'git-worktree-remove' || p === 'cleanup-leftovers') return 'remove';
  return STEP_ORDER.includes(p as (typeof STEP_ORDER)[number]) ? p : 'pre';
}

function elapsedLabel(task: WorkspaceRemovalTask): string {
  const end = task.completedAt ?? Date.now();
  const s = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GlobalTaskbar({ tasks, onDismiss }: {
  tasks: WorkspaceRemovalTask[];
  onDismiss?: (taskId: string) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const visible = tasks.filter((t) => t.status !== 'succeeded' || (t.completedAt && Date.now() - t.completedAt < 8000));
  const active = visible[0];
  if (!active) return null;
  const step = currentStep(active);
  const running = active.status === 'running' || active.status === 'queued';
  return (
    <div className="gs-ui flex-shrink-0 border-t border-[var(--gs-border)] bg-[#050505]">
      <div className="flex cursor-pointer items-center gap-2.5 px-4 py-[7px]" onClick={() => setOpen((v) => !v)}>
        <span
          className={`h-[8px] w-[8px] flex-none rounded-full ${running ? 'animate-pulse bg-[var(--gs-accent)]' : active.status === 'failed' || active.status === 'needs_attention' ? 'bg-[var(--gs-danger)]' : 'bg-[var(--gs-success)]'}`}
        />
        <span className="truncate text-[12px] text-[var(--gs-text)]">{active.label || `Removing ${active.workspaceName}`}</span>
        <span className="flex items-center gap-1">
          {STEP_ORDER.map((p) => (
            <span
              key={p}
              className={`border px-1.5 py-px text-[9.5px] uppercase tracking-[.05em] ${p === step && running ? 'border-[var(--gs-warning)] text-[var(--gs-warning)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}
            >
              {p === 'pre' ? 'prepare' : p}
            </span>
          ))}
        </span>
        <span className="font-[family-name:var(--gs-font)] text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{elapsedLabel(active)}</span>
        {visible.length > 1 && (
          <span className="rounded-full border border-[var(--gs-border)] px-1.5 text-[10px] uppercase text-[var(--gs-text-dim)]">+{visible.length - 1} queued</span>
        )}
        {active.progressLabel && <span className="truncate text-[11px] text-[var(--gs-text-dim)]">{active.progressLabel}</span>}
        <span className="ml-auto flex items-center gap-2">
          {onDismiss && !running && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDismiss(active.id); }} className="px-1 text-[11px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]">✕</button>
          )}
          <span className="text-[11px] text-[var(--gs-text-dim)]">{open ? '▾' : '▸'}</span>
        </span>
      </div>
      {open && (
        <div className="max-h-[220px] overflow-y-auto border-t border-[var(--gs-border-muted)] px-4 py-2">
          <pre className="whitespace-pre-wrap font-[family-name:var(--gs-font)] text-[11px] leading-[1.6] text-[var(--gs-text-muted)]">{active.logLines.join('\n') || '…'}</pre>
          {visible.slice(1).map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-0.5 text-[11px] text-[var(--gs-text-muted)]">
              <span className={`rounded-full border px-1.5 text-[9.5px] uppercase ${t.status === 'failed' ? 'border-[rgba(255,80,80,.4)] text-[var(--gs-danger)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}>{t.status}</span>
              {t.label || t.workspaceName}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
