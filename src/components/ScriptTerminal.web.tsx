/** @jsxImportSource react */
import { useEffect } from 'react';
import { SessionTerminal } from './SessionTerminal.web';

type ScriptPhase = 'pre' | 'setup' | 'select' | 'remove';

interface Props {
  phase: ScriptPhase;
  workspaceName: string;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
  onBack: () => void;
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
  onBack,
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
    ? 'text-[#d29922]'
    : error
      ? 'text-[#ff7b72]'
      : 'text-[#3fb950]';

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
      <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[#3fb950] font-medium">{PHASE_LABELS[phase]}</span>
          <span className="text-[#8b949e] truncate">- {workspaceName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm ${statusColor}`}>{statusText}</span>
          {!isRunning && (
            <button
              onClick={onBack}
              className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] border border-[#30363d]"
            >
              Back
            </button>
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
        <div className="bg-[#331111] border-t border-[#552222] px-3 py-1 text-[#ff7b72] text-sm truncate">
          {error}
        </div>
      )}
    </div>
  );
}
