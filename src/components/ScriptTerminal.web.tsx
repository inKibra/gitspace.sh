import type { WorkspaceScriptPhase } from '../types/script-phase.js';
import { ScriptTerminalPanel } from './ScriptTerminalPanel.web.js';

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
  return (
    <ScriptTerminalPanel
      phase={phase}
      workspaceName={workspaceName}
      isRunning={isRunning}
      error={error}
      exitCode={exitCode}
      setWriteCallback={setWriteCallback}
      canAttachAnyway={canAttachAnyway}
      onAttachAnyway={onAttachAnyway}
      onBack={onBack}
      onCancel={onCancel}
      className="h-screen w-screen"
    />
  );
}
