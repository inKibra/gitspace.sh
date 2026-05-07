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
  showHeader?: boolean;
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
    showHeader = true,
  } = props;

  return (
    <div className={rootClassName}>
      {showHeader ? (
        <div className={headerClassName}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {leadingContent}
            <div className="min-w-0 text-sm text-[var(--gs-text-muted)] truncate">
              <span className="text-[var(--gs-success)]">●</span>{' '}
              {showConnectedLabel && <span className="hidden sm:inline">Connected</span>}
              {sessionName && (
                <span className="text-[var(--gs-text)]">
                  <span className="hidden sm:inline text-[var(--gs-text-dim)] mx-1">/</span>
                  {sessionName.split(':').pop()}
                </span>
              )}
              {(processTitle || terminalTitle) && (
                <span className="hidden md:inline text-[var(--gs-text-muted)] ml-2">
                  {processTitle || terminalTitle}
                </span>
              )}
              {lastAlertLabel && (
                <span className="hidden lg:inline text-[var(--gs-warning-bright)] ml-2">{lastAlertLabel}</span>
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
      ) : null}
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
