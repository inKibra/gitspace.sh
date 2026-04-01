/** @jsxImportSource react */
import { useEffect } from 'react';
import { SessionTerminal } from './SessionTerminal.web';
import type { WorkspaceScriptPhase } from '../types/script-phase.js';

type ScriptPhase = WorkspaceScriptPhase | 'remove';

interface Props {
  phase: ScriptPhase;
  workspaceName: string;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
  canAttachAnyway?: boolean;
  onAttachAnyway?: () => void | Promise<void>;
  onBack: () => void;
  onCancel?: () => void;
}

const PHASE_LABELS: Record<ScriptPhase, string> = {
  pre: 'Pre Scripts',
  setup: 'Setup Scripts',
  select: 'Select Scripts',
  remove: 'Remove Scripts',
};

export function ScriptTerminal({
  phase,
  workspaceName,
  isRunning,
  error,
  exitCode,
  setWriteCallback,
  canAttachAnyway = false,
  onAttachAnyway,
  onBack,
  onCancel,
}: Props) {
  useEffect(() => {
    return () => {
      setWriteCallback(null);
    };
  }, [setWriteCallback]);

  const statusText = isRunning
    ? 'Running...'
    : error
      ? `Failed${typeof exitCode === 'number' ? ` (exit ${exitCode})` : ''}`
      : 'Complete';

  const statusColor = isRunning
    ? 'text-[var(--gs-warning)]'
    : error
      ? 'text-[var(--gs-danger-hover)]'
      : 'text-[var(--gs-success)]';

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--gs-bg)]">
      <div className="bg-[var(--gs-bg-elevated)] px-4 py-2 flex items-center justify-between border-b border-[var(--gs-border)] min-h-[52px] gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--gs-success)] font-medium">{PHASE_LABELS[phase]}</span>
          <span className="text-[var(--gs-text-muted)] truncate">- {workspaceName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm ${statusColor}`}>{statusText}</span>
          {isRunning && onCancel && (
            <button
              onClick={onCancel}
              className="px-3 py-2 text-sm bg-[var(--gs-chip-amber-bg)] hover:bg-[var(--gs-chip-amber-border)] rounded text-[var(--gs-warning-bright)] border border-[var(--gs-chip-amber-border)]"
            >
              Cancel Scripts
            </button>
          )}
          {!isRunning && (
            <>
              {canAttachAnyway && onAttachAnyway && (
                <button
                  onClick={() => {
                    void onAttachAnyway();
                  }}
                  className="px-3 py-2 text-sm bg-[var(--gs-chip-green-bg)] hover:bg-[var(--gs-success-muted)] rounded text-[var(--gs-chip-green-text)] border border-[var(--gs-chip-green-border)]"
                >
                  Attach Anyway
                </button>
              )}
              <button
                onClick={onBack}
                className="px-3 py-2 text-sm bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] rounded text-[var(--gs-text)] border border-[var(--gs-border)]"
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <SessionTerminal
          onData={() => {}}
          onResize={() => {}}
          setWriteCallback={setWriteCallback}
          allowTapFocus={true}
          allowTouchScroll={true}
        />
      </div>

      {error && !isRunning && (
        <div className="bg-[var(--gs-chip-red-bg)] border-t border-[var(--gs-chip-red-border)] px-3 py-1 text-[var(--gs-danger-hover)] text-sm truncate">
          {error}
        </div>
      )}
    </div>
  );
}
