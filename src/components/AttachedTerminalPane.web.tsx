/** @jsxImportSource react */

import type { ReactNode, RefObject } from 'react';
import { SessionTerminal, type SessionTerminalHandle } from './SessionTerminal.web.js';
import { TerminalControls, type ModifierState } from './TerminalControls.web.js';
import { FloatingControls } from './FloatingControls.web.js';

export interface AttachedTerminalPaneWebProps {
  rootClassName: string;
  headerClassName: string;
  leadingContent?: ReactNode;
  trailingContent?: ReactNode;
  sessionName?: string | null;
  processTitle?: string | null;
  terminalTitle?: string | null;
  lastAlertLabel?: string | null;
  showConnectedLabel?: boolean;
  showMobileControls: boolean;
  inputMode: boolean;
  keyboardVisible: boolean;
  onToggleInputMode: () => void;
  inputButtonClassName: string;
  onDetach: () => void | Promise<void>;
  detachButtonClassName: string;
  terminalContainerClassName: string;
  terminalRef: RefObject<SessionTerminalHandle | null>;
  onData: (data: Uint8Array) => void;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
  onResize: (cols: number, rows: number) => void;
  onActivity?: () => void;
  readOnly?: boolean;
  allowTapFocus?: boolean;
  allowTouchScroll?: boolean;
  onSendData: (data: string) => void;
  onFocusTerminal: () => void;
  modifiers: ModifierState;
  onModifiersChange: (next: ModifierState) => void;
  showFloatingControls: boolean;
}

export function AttachedTerminalPaneWeb(props: AttachedTerminalPaneWebProps) {
  const {
    rootClassName,
    headerClassName,
    leadingContent,
    trailingContent,
    sessionName,
    processTitle,
    terminalTitle,
    lastAlertLabel,
    showConnectedLabel = true,
    showMobileControls,
    inputMode,
    keyboardVisible,
    onToggleInputMode,
    inputButtonClassName,
    onDetach,
    detachButtonClassName,
    terminalContainerClassName,
    terminalRef,
    onData,
    setWriteCallback,
    onResize,
    onActivity,
    readOnly,
    allowTapFocus = true,
    allowTouchScroll = true,
    onSendData,
    onFocusTerminal,
    modifiers,
    onModifiersChange,
    showFloatingControls,
  } = props;

  return (
    <div className={rootClassName}>
      <div className={headerClassName}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {leadingContent}
          <div className="min-w-0 text-sm text-[#8b949e] truncate">
            <span className="text-[#3fb950]">●</span>{' '}
            {showConnectedLabel && <span className="hidden sm:inline">Connected</span>}
            {sessionName && (
              <span className="text-[#e6edf3]">
                <span className="hidden sm:inline text-[#6e7681] mx-1">/</span>
                {sessionName.split(':').pop()}
              </span>
            )}
            {(processTitle || terminalTitle) && (
              <span className="hidden md:inline text-[#8b949e] ml-2">
                {processTitle || terminalTitle}
              </span>
            )}
            {lastAlertLabel && (
              <span className="hidden lg:inline text-[#f59e0b] ml-2">{lastAlertLabel}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {showMobileControls && (
            <button type="button" onClick={onToggleInputMode} className={inputButtonClassName}>
              Input
            </button>
          )}
          {trailingContent}
          <button type="button" onClick={() => void onDetach()} className={detachButtonClassName}>
            Detach
          </button>
        </div>
      </div>
      <div className={terminalContainerClassName}>
        <SessionTerminal
          ref={terminalRef}
          onData={onData}
          setWriteCallback={setWriteCallback}
          onResize={onResize}
          allowTapFocus={allowTapFocus}
          allowTouchScroll={allowTouchScroll}
          onActivity={onActivity}
          readOnly={readOnly}
        />
      </div>
      {showMobileControls && inputMode && (
        <TerminalControls
          onSendData={onSendData}
          onFocusTerminal={onFocusTerminal}
          keyboardVisible={keyboardVisible}
          modifiers={modifiers}
          onModifiersChange={onModifiersChange}
        />
      )}
      {showFloatingControls && (
        <FloatingControls
          onSendData={onSendData}
          showJogWheel={inputMode}
        />
      )}
    </div>
  );
}
