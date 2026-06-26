/** @jsxImportSource react */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachedTerminalPaneWeb } from './AttachedTerminalPane.web.js';
import { applyModifiersToInput, type ModifierState } from './TerminalControls.web.js';
import type { SessionTerminalHandle } from './SessionTerminal.web.js';
import { NativeAgentSurfaceConnected } from './NativeAgentSurfaceConnected.web.js';
import { AgentTranscript, type BlockHost } from '../blocks/render/index.web.js';
import { pendingInteractionBlocks } from '../blocks/agent/transcript-blocks.js';
import { AgentPaneHeader } from './AgentPaneHeader.web.js';
import type { Block } from '../blocks/index.js';
import type { AgentControlInfo, AgentModelInfo, SessionStatus } from '../agents/agent-runtime-types.js';
import type { AttachedPaneState } from '../session/types.js';
import type { BackendKey } from '../session/backend.js';
import type { RemoteSessionPtyBackend } from '../session/useRemoteSessionClient.js';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const NO_LIVE: Block[] = [];

export interface PaneTerminalPanelProps {
  pane: AttachedPaneState;
  backend: RemoteSessionPtyBackend | null;
  backendKey: BackendKey | null;
  showMobileControls: boolean;
  inputMode: boolean;
  keyboardVisible: boolean;
  onToggleInputMode: () => void;
  inputButtonClassName: string;
  terminalContainerClassName: string;
  onActivity?: () => void;
  allowTapFocus?: boolean;
  allowTouchScroll?: boolean;
  onFocus?: () => void;
  modifiers: ModifierState;
  onModifiersChange: (next: ModifierState) => void;
  showFloatingControls: boolean;
}

export function PaneTerminalPanel({
  pane,
  backend,
  backendKey,
  showMobileControls,
  inputMode,
  keyboardVisible,
  onToggleInputMode,
  inputButtonClassName,
  terminalContainerClassName,
  onActivity,
  allowTapFocus = true,
  allowTouchScroll = true,
  onFocus,
  modifiers,
  onModifiersChange,
  showFloatingControls,
}: PaneTerminalPanelProps) {
  const terminalRef = useRef<SessionTerminalHandle>(null);

  const sendPaneBytes = useCallback((data: Uint8Array) => {
    if (pane.viewOnly) return;
    void backend?.writePaneData?.(pane.paneId, data).catch(() => undefined);
  }, [backend, pane.paneId, pane.viewOnly]);

  const handleSendData = useCallback((data: string) => {
    if (data === PAGE_UP && terminalRef.current?.pageUp()) return;
    if (data === PAGE_DOWN && terminalRef.current?.pageDown()) return;
    sendPaneBytes(new TextEncoder().encode(data));
  }, [sendPaneBytes]);

  const handleKeyboardData = useCallback((data: Uint8Array) => {
    if (pane.viewOnly) return;
    const hasModifiers = modifiers.ctrl || modifiers.shift || modifiers.alt;
    if (hasModifiers) {
      sendPaneBytes(applyModifiersToInput(data, modifiers));
      onModifiersChange({ ctrl: false, shift: false, alt: false });
      return;
    }
    sendPaneBytes(data);
  }, [modifiers, onModifiersChange, pane.viewOnly, sendPaneBytes]);

  const handleWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    backend?.setPaneOutputHandler?.(pane.paneId, fn);
  }, [backend, pane.paneId]);

  const handleResize = useCallback((cols: number, rows: number) => {
    void backend?.resizePane?.(pane.paneId, cols, rows).catch(() => undefined);
  }, [backend, pane.paneId]);

  const handleDetach = useCallback(() => {
    void backend?.detachPane?.(pane.paneId).catch(() => undefined);
  }, [backend, pane.paneId]);

  const handleFocus = useCallback(() => {
    terminalRef.current?.focus();
    onFocus?.();
  }, [onFocus]);

  const wsId = pane.workspaceId;
  const agentSessionId = pane.agentSessionId;
  const fetchTranscriptRange = useCallback(
    async (before: string | undefined, limit: number) => {
      const fn = backend?.getAgentTranscriptRange;
      if (!fn || !wsId || !agentSessionId) return { blocks: NO_LIVE, oldestCursor: null, hasMore: false };
      const r = await fn.call(backend, wsId, agentSessionId, before, limit);
      return { blocks: r.blocks as Block[], oldestCursor: r.oldestCursor, hasMore: r.hasMore };
    },
    [backend, wsId, agentSessionId],
  );
  const transcriptHost = useMemo<BlockHost>(() => ({
    readOnly: false,
    resolve: (blockId, response) => {
      if (typeof blockId !== 'string' || !backend || !wsId || !agentSessionId) return;
      // approval-gate blocks: perm:<permissionId>
      if (blockId.startsWith('perm:')) {
        void backend
          .respondToAgentPermission(wsId, agentSessionId, blockId.slice(5), response === 'Deny' ? 'deny' : 'allow')
          .catch(() => undefined);
        return;
      }
      // host-ui question blocks: q:<id>:<index> → answer the question dialog
      if (blockId.startsWith('q:') && backend.sendDialogResponse) {
        const questionId = blockId.slice(2).split(':')[0];
        void backend.sendDialogResponse(questionId, 'select', typeof response === 'string' ? response : String(response)).catch(() => undefined);
      }
    },
    dispatch: () => {},
  }), [backend, wsId, agentSessionId]);

  // Live transcript suffix: stream the in-progress turn from the agent-state
  // deltas. On commit, clear it — the hook folds the finished turn into history.
  const [liveBlocks, setLiveBlocks] = useState<Block[]>(NO_LIVE);
  useEffect(() => {
    if (!backend?.subscribeAgentState || !wsId || !agentSessionId) return;
    const unsub = backend.subscribeAgentState((delta) => {
      if (delta.type !== 'agent_transcript_live' || delta.workspaceId !== wsId || delta.sessionId !== agentSessionId) return;
      setLiveBlocks(delta.committed ? NO_LIVE : delta.blocks);
    });
    return unsub;
  }, [backend, wsId, agentSessionId]);

  // Pending interactive blocks (permissions / questions / todos) from agent state,
  // shown at the foot of the transcript and resolved through the host.
  const [pendingBlocks, setPendingBlocks] = useState<Block[]>(NO_LIVE);
  const [agentModel, setAgentModel] = useState<AgentModelInfo | undefined>(undefined);
  const [agentStatus, setAgentStatus] = useState<SessionStatus | undefined>(undefined);
  useEffect(() => {
    if (!backend?.subscribeAgentState || !wsId || !agentSessionId) return;
    const recompute = () => {
      const snap = backend.getAgentStateSnapshot?.()[wsId];
      setPendingBlocks(snap
        ? pendingInteractionBlocks({
            permissions: snap.pendingPermissions?.[agentSessionId],
            questions: snap.pendingQuestions?.[agentSessionId],
            todoPhases: snap.todoPhases?.[agentSessionId],
            error: snap.errorMessages?.[agentSessionId] ?? null,
          })
        : NO_LIVE);
      setAgentModel(snap?.modelInfo?.[agentSessionId]);
      setAgentStatus(snap?.statuses?.[agentSessionId]);
    };
    recompute();
    const unsub = backend.subscribeAgentState(recompute);
    return unsub;
  }, [backend, wsId, agentSessionId]);

  // Control-surface info (usage + model switcher) — refetched on turn boundaries
  // (status changes) so usage stays current.
  const [control, setControl] = useState<AgentControlInfo | undefined>(undefined);
  const refreshControl = useCallback(() => {
    const fn = backend?.getAgentControlInfo;
    if (!fn || !wsId || !agentSessionId) return;
    void fn.call(backend, wsId, agentSessionId).then(setControl).catch(() => undefined);
  }, [backend, wsId, agentSessionId]);
  useEffect(() => {
    refreshControl();
  }, [refreshControl, agentStatus?.type]);
  const [modelError, setModelError] = useState<string | null>(null);
  const handleSetModel = useCallback((provider: string, modelId: string) => {
    const fn = backend?.setAgentModel;
    if (!fn || !wsId || !agentSessionId) return;
    setModelError(null);
    void fn.call(backend, wsId, agentSessionId, provider, modelId)
      .then(() => refreshControl())
      .catch((e) => setModelError(e instanceof Error ? e.message.replace(/^Failed to set model:\s*/, '') : 'Failed to switch model'));
  }, [backend, wsId, agentSessionId, refreshControl]);

  // Agent panes show the native block transcript (replacing the xterm view);
  // shell panes keep the terminal.
  const isAgentPane = !!(pane.agentSessionId && pane.workspaceId);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {isAgentPane ? (
        <>
          <AgentPaneHeader model={agentModel} status={agentStatus} control={control} onSetModel={handleSetModel} error={modelError} />
          <div className="flex-1 min-h-0 bg-[var(--gs-bg)]">
            <AgentTranscript fetchRange={fetchTranscriptRange} live={liveBlocks} pending={pendingBlocks} host={transcriptHost} pageSize={30} />
          </div>
        </>
      ) : (
        <AttachedTerminalPaneWeb
          rootClassName="flex-1 min-h-0 flex flex-col bg-[var(--gs-bg)] overflow-hidden"
          headerClassName="flex-shrink-0 px-3 py-2 border-b border-[var(--gs-border-muted)] bg-[var(--gs-bg-elevated)] flex items-center justify-between gap-2"
          sessionName={pane.sessionName ?? pane.sessionId}
          processTitle={pane.meta?.processTitle ?? null}
          terminalTitle={pane.meta?.terminalTitle ?? null}
          lastAlertLabel={pane.meta?.lastAlertKind
            ? `${pane.meta.lastAlertKind}${pane.meta.unreadAlertCount ? ` (${pane.meta.unreadAlertCount})` : ''}`
            : null}
          showConnectedLabel={true}
          showMobileControls={showMobileControls}
          inputMode={inputMode}
          keyboardVisible={keyboardVisible}
          onToggleInputMode={onToggleInputMode}
          inputButtonClassName={inputButtonClassName}
          onDetach={handleDetach}
          detachButtonClassName="px-2 py-1 text-xs rounded border border-[var(--gs-border)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]"
          terminalContainerClassName={terminalContainerClassName}
          terminalRef={terminalRef}
          onData={handleKeyboardData}
          setWriteCallback={handleWriteCallback}
          onResize={handleResize}
          onActivity={onActivity}
          readOnly={pane.viewOnly}
          allowTapFocus={allowTapFocus}
          allowTouchScroll={allowTouchScroll}
          onSendData={handleSendData}
          onFocusTerminal={handleFocus}
          modifiers={modifiers}
          onModifiersChange={onModifiersChange}
          showFloatingControls={showFloatingControls}
          showHeader={false}
        />
      )}
      {pane.agentSessionId && pane.workspaceId ? (
        <div className="flex-shrink-0 border-t border-[var(--gs-border)]">
          <NativeAgentSurfaceConnected
            backendKey={backendKey}
            workspaceId={pane.workspaceId}
            agentSessionId={pane.agentSessionId}
            paneId={pane.paneId}
          />
        </div>
      ) : null}
    </div>
  );
}
