/** @jsxImportSource react */
import { useEffect } from 'react';
import { SessionTerminal } from './SessionTerminal.web';
import type { WorkspaceScriptPhase } from '../types/script-phase.js';

export type ScriptPhase = WorkspaceScriptPhase | 'remove';

interface Props {
  phase: ScriptPhase;
  workspaceName: string;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  setWriteCallback?: (fn: ((data: Uint8Array) => void) | null) => void;
  logLines?: string[];
  emptyLogLabel?: string;
  canAttachAnyway?: boolean;
  onAttachAnyway?: () => void | Promise<void>;
  onBack?: () => void;
  backLabel?: string;
  onCancel?: () => void;
  className?: string;
}

const PHASE_LABELS: Record<ScriptPhase, string> = {
  pre: 'Pre Scripts',
  setup: 'Setup Scripts',
  select: 'Select Scripts',
  remove: 'Remove Scripts',
};

function statusText(isRunning: boolean, error: string | undefined, exitCode: number | undefined): string {
  if (isRunning) return 'Running...';
  if (error) return `Failed${typeof exitCode === 'number' ? ` (exit ${exitCode})` : ''}`;
  return 'Complete';
}

function statusColor(isRunning: boolean, error: string | undefined): string {
  if (isRunning) return 'text-[var(--gs-warning)]';
  if (error) return 'text-[var(--gs-danger-hover)]';
  return 'text-[var(--gs-success)]';
}

export function ScriptTerminalPanel({
  phase,
  workspaceName,
  isRunning,
  error,
  exitCode,
  setWriteCallback,
  logLines,
  emptyLogLabel = 'No script output yet.',
  canAttachAnyway = false,
  onAttachAnyway,
  onBack,
  backLabel = 'Back',
  onCancel,
  className = '',
}: Props) {
  useEffect(() => {
    if (!setWriteCallback) return;
    return () => {
      setWriteCallback(null);
    };
  }, [setWriteCallback]);

  const hasBufferedLogs = Array.isArray(logLines);

  return (
    <div className={`flex min-h-0 flex-col bg-[var(--gs-bg)] ${className}`}>
      <div className="flex min-h-[52px] items-center justify-between gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-[var(--gs-success)]">{PHASE_LABELS[phase]}</span>
          <span className="truncate text-[var(--gs-text-muted)]">- {workspaceName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm ${statusColor(isRunning, error)}`}>{statusText(isRunning, error, exitCode)}</span>
          {isRunning && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--gs-chip-amber-border)] bg-[var(--gs-chip-amber-bg)] px-3 py-2 text-sm text-[var(--gs-warning-bright)] hover:bg-[var(--gs-chip-amber-border)]"
            >
              Cancel Scripts
            </button>
          )}
          {!isRunning && canAttachAnyway && onAttachAnyway && (
            <button
              type="button"
              onClick={() => {
                void onAttachAnyway();
              }}
              className="rounded border border-[var(--gs-chip-green-border)] bg-[var(--gs-chip-green-bg)] px-3 py-2 text-sm text-[var(--gs-chip-green-text)] hover:bg-[var(--gs-success-muted)]"
            >
              Attach Anyway
            </button>
          )}
          {!isRunning && onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded border border-[var(--gs-border)] bg-[var(--gs-btn-secondary-bg)] px-3 py-2 text-sm text-[var(--gs-text)] hover:bg-[var(--gs-border)]"
            >
              {backLabel}
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {hasBufferedLogs ? (
          <pre className="h-full min-h-32 overflow-auto whitespace-pre-wrap bg-[var(--gs-bg)] p-4 font-mono text-xs text-[var(--gs-text)]">
            {logLines.length > 0 ? logLines.join('\n') : emptyLogLabel}
          </pre>
        ) : (
          <SessionTerminal
            onData={() => {}}
            onResize={() => {}}
            setWriteCallback={setWriteCallback ?? (() => {})}
            allowTapFocus={true}
            allowTouchScroll={true}
          />
        )}
      </div>

      {error && !isRunning && (
        <div className="truncate border-t border-[var(--gs-chip-red-border)] bg-[var(--gs-chip-red-bg)] px-3 py-1 text-sm text-[var(--gs-danger-hover)]">
          {error}
        </div>
      )}
    </div>
  );
}
