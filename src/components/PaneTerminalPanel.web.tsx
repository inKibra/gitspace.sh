/** @jsxImportSource react */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachedTerminalPaneWeb } from './AttachedTerminalPane.web.js';
import { applyModifiersToInput, type ModifierState } from './TerminalControls.web.js';
import type { SessionTerminalHandle } from './SessionTerminal.web.js';
import { NativeAgentSurfaceConnected, type PromptLifecycleEvent, type PromptSubmitMode } from './NativeAgentSurfaceConnected.web.js';
import { AgentTranscript, type BlockHost } from '../blocks/render/index.web.js';
import { pendingInteractionBlocks } from '../blocks/agent/transcript-blocks.js';
import { AgentPaneHeader } from './AgentPaneHeader.web.js';
import { AgentSettingsPanel } from './AgentSettingsPanel.web.js';
import { AgentHistoryPanel } from './AgentHistoryPanel.web.js';
import type { Block } from '../blocks/index.js';
import type { AgentAuthProvider, AgentControlInfo, AgentDefinitionInfo, AgentGoalModeInfo, AgentHistoryEntry, AgentModelInfo, AgentOAuthEvent, AgentSettingSchemaItem, AgentShakeMode, AgentShakeResult, AgentToolInfo, AgentTreeNode, SessionStatus } from '../agents/agent-runtime-types.js';
import type { AttachedPaneState } from '../session/types.js';
import type { BackendKey } from '../session/backend.js';
import type { RemoteSessionPtyBackend } from '../session/useRemoteSessionClient.js';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const NO_LIVE: Block[] = [];

/** Client-side optimistic echo of the user's just-submitted prompt: shown
 *  pending until the server's transcript_live echo arrives; flipped to failed
 *  (with a working Retry) when the prompt RPC rejects. */
interface OptimisticPrompt {
  id: string;
  text: string;
  mode: PromptSubmitMode;
  status: 'pending' | 'failed';
  error?: string;
}

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
  /** Session is blocked on the user (ask dialog / pending permission) — drives
   *  the header dot amber so it agrees with the board and the on-screen dialog. */
  awaitingInput?: boolean;
  /** The daemon-bound workspace goal. Omitted for @base and unbound workspaces. */
  goalContext?: { id: string; title: string; phase: string } | null;
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
  awaitingInput,
  goalContext,
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
    // Agent panes have no terminal to detach from: drop the viewer lease.
    void (pane.agentSessionId
      ? backend?.closeAgentPane?.(pane.paneId)
      : backend?.detachPane?.(pane.paneId)
    )?.catch(() => undefined);
  }, [backend, pane.paneId, pane.agentSessionId]);

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
  // Last prompt the user attempted for THIS pane (kept even after a successful
  // send + composer clear) so the transcript's Retry can re-send it, plus the
  // optimistic echo the transcript renders while the server echo is in flight.
  const lastPromptRef = useRef<{ text: string; mode: PromptSubmitMode } | null>(null);
  const [optimistic, setOptimistic] = useState<OptimisticPrompt | null>(null);
  const optimisticSeq = useRef(0);
  const [retrySignal, setRetrySignal] = useState<{ text: string; mode: PromptSubmitMode; nonce: number } | null>(null);
  const handlePromptLifecycle = useCallback((event: PromptLifecycleEvent) => {
    if (event.phase === 'submitted') {
      lastPromptRef.current = { text: event.text, mode: event.mode };
      optimisticSeq.current += 1;
      setOptimistic({ id: `optimistic:${optimisticSeq.current}`, text: event.text, mode: event.mode, status: 'pending' });
      return;
    }
    // failed → mark the matching optimistic echo failed (keeps Retry visible).
    setOptimistic((o) => (o && o.text === event.text ? { ...o, status: 'failed', error: event.error } : o));
  }, []);
  const retryLastPrompt = useCallback(() => {
    const last = lastPromptRef.current;
    if (!last) return;
    setRetrySignal((prev) => ({ text: last.text, mode: last.mode, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  // New session in this pane → stale optimistic echo must not carry over.
  useEffect(() => {
    setOptimistic(null);
    setRetrySignal(null);
    lastPromptRef.current = null;
  }, [wsId, agentSessionId]);

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
    },
    dispatch: (action) => {
      // Transcript error blocks' Retry → re-send this pane's last prompt.
      if (action.kind === 'run' && action.actionId === 'retry-prompt') retryLastPrompt();
    },
  }), [backend, wsId, agentSessionId, retryLastPrompt]);

  // Live transcript suffix: stream the in-progress turn from the agent-state
  // deltas. On commit, clear it — the hook folds the finished turn into history.
  const [liveBlocks, setLiveBlocks] = useState<Block[]>(NO_LIVE);
  useEffect(() => {
    if (!backend?.subscribeAgentState || !wsId || !agentSessionId) return;
    const unsub = backend.subscribeAgentState((delta) => {
      if (delta.type !== 'agent_transcript_live' || delta.workspaceId !== wsId || delta.sessionId !== agentSessionId) return;
      setLiveBlocks(delta.committed ? NO_LIVE : delta.blocks);
      // Reconcile the optimistic user echo against the server's live transcript:
      // once the server echoes the user's message (or the turn commits), the
      // optimistic copy is redundant. A failed optimistic only clears on an
      // exact text match — the message provably got through despite the error.
      setOptimistic((o) => {
        if (!o) return o;
        const echoed = delta.blocks.some((b) => {
          if (b.type !== 'message') return false;
          const d = b.data as { role?: string; text?: string };
          return d.role === 'user' && d.text === o.text;
        });
        if (echoed) return null;
        if (o.status === 'pending' && delta.committed) return null;
        return o;
      });
    });
    return unsub;
  }, [backend, wsId, agentSessionId]);

  // Optimistic echo → transcript blocks (a pending/dim user message; plus an
  // error block with a working Retry when the prompt failed).
  const optimisticBlocks = useMemo<Block[]>(() => {
    if (!optimistic) return NO_LIVE;
    const message: Block = {
      id: optimistic.id,
      type: 'message',
      data: { role: 'user', text: optimistic.text, ...(optimistic.status === 'pending' ? { pending: true } : {}) },
    };
    if (optimistic.status === 'failed') {
      return [message, { id: `${optimistic.id}:error`, type: 'error', data: { text: optimistic.error ?? 'Failed to send message' } }];
    }
    return [message];
  }, [optimistic]);

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
    // Only adopt a DEFINED result — never clobber good control data with a
    // transient undefined (agent not ready, or a race while the pane sits
    // offscreen during a workspace switch). That clobber is what left the
    // top bar blank on return; the model/context stays until real new data.
    void fn.call(backend, wsId, agentSessionId).then((c) => { if (c) setControl(c); }).catch(() => undefined);
  }, [backend, wsId, agentSessionId]);
  useEffect(() => {
    refreshControl();
  }, [refreshControl, agentStatus?.type, agentModel?.name]);
  // Self-heal: if control never loaded (initial fetch raced the session
  // becoming ready), retry briefly until it does. Stops once loaded.
  useEffect(() => {
    if (control) return;
    let attempts = 0;
    const t = setInterval(() => {
      attempts += 1;
      if (attempts > 8) { clearInterval(t); return; }
      refreshControl();
    }, 1500);
    return () => clearInterval(t);
  }, [control, refreshControl]);
  const [modelError, setModelError] = useState<string | null>(null);
  const handleSetModel = useCallback((provider: string, modelId: string) => {
    const fn = backend?.setAgentModel;
    if (!fn || !wsId || !agentSessionId) return;
    setModelError(null);
    void fn.call(backend, wsId, agentSessionId, provider, modelId)
      .then(() => refreshControl())
      .catch((e) => setModelError(e instanceof Error ? e.message.replace(/^Failed to set model:\s*/, '') : 'Failed to switch model'));
  }, [backend, wsId, agentSessionId, refreshControl]);
  const handleSetThinkingLevel = useCallback((level: string) => {
    const fn = backend?.setAgentThinkingLevel;
    if (!fn || !wsId || !agentSessionId) return;
    setModelError(null);
    void fn.call(backend, wsId, agentSessionId, level)
      .then(() => refreshControl())
      .catch((e) => setModelError(e instanceof Error ? e.message.replace(/^Failed to set thinking level:\s*/, '') : 'Failed to set thinking level'));
  }, [backend, wsId, agentSessionId, refreshControl]);
  const handleSetApprovalMode = useCallback((mode: string) => {
    const fn = backend?.setAgentApprovalMode;
    if (!fn || !wsId || !agentSessionId) return;
    setModelError(null);
    void fn.call(backend, wsId, agentSessionId, mode)
      .then(() => refreshControl())
      .catch((e) => setModelError(e instanceof Error ? e.message.replace(/^Failed to set approval mode:\s*/, '') : 'Failed to set approval mode'));
  }, [backend, wsId, agentSessionId, refreshControl]);

  // Goal Mode is intentionally pane/session-local. The backend remains the
  // authority; this state only renders the current control result and is
  // discarded whenever the pane represents a different agent session.
  const [goalMode, setGoalMode] = useState<AgentGoalModeInfo | undefined>(undefined);
  const [goalModePending, setGoalModePending] = useState(false);
  const goalContextKey = goalContext ? `${goalContext.id}:${goalContext.phase}` : null;
  const goalModeSessionKey = wsId && agentSessionId ? `${wsId}:${agentSessionId}` : null;
  const goalModeSessionKeyRef = useRef<string | null>(null);
  const refreshGoalMode = useCallback(async () => {
    if (!goalContextKey || !goalModeSessionKey) return;
    const fn = backend?.getAgentGoalMode;
    if (!fn) {
      if (goalModeSessionKeyRef.current === goalModeSessionKey) {
        setGoalMode({ enabled: false, available: false, message: 'Goal Mode is not supported by this backend.' });
      }
      return;
    }
    try {
      const mode = await fn.call(backend, wsId!, agentSessionId!);
      if (goalModeSessionKeyRef.current === goalModeSessionKey) setGoalMode(mode);
    } catch (error) {
      if (goalModeSessionKeyRef.current === goalModeSessionKey) {
        setGoalMode({
          enabled: false,
          available: false,
          message: error instanceof Error ? error.message : 'Could not read Goal Mode availability.',
        });
      }
    }
  }, [backend, goalContextKey, goalModeSessionKey, wsId, agentSessionId]);
  useEffect(() => {
    goalModeSessionKeyRef.current = goalModeSessionKey;
    setGoalMode(undefined);
    setGoalModePending(false);
    if (goalContextKey) void refreshGoalMode();
  }, [goalContextKey, goalModeSessionKey, refreshGoalMode]);
  const handleSetGoalMode = useCallback(async ({ enabled, precursor }: { enabled: boolean; precursor?: string }) => {
    if (!goalContextKey || !goalModeSessionKey || goalModeSessionKeyRef.current !== goalModeSessionKey) return;
    const fn = backend?.setAgentGoalMode;
    if (!fn) {
      setGoalMode({ enabled: false, available: false, message: 'Goal Mode is not supported by this backend.' });
      return;
    }
    const previous = goalMode;
    setGoalModePending(true);
    setGoalMode((current) => ({ enabled, available: current?.available ?? true }));
    try {
      const updated = await fn.call(backend, wsId!, agentSessionId!, { enabled, ...(enabled && precursor ? { precursor } : {}) });
      if (goalModeSessionKeyRef.current === goalModeSessionKey) setGoalMode(updated);
    } catch (error) {
      if (goalModeSessionKeyRef.current === goalModeSessionKey) {
        setGoalMode({
          ...(previous ?? { enabled: false, available: true }),
          message: error instanceof Error ? error.message : 'Could not update Goal Mode.',
        });
      }
    } finally {
      if (goalModeSessionKeyRef.current === goalModeSessionKey) setGoalModePending(false);
    }
  }, [backend, goalContextKey, goalModeSessionKey, wsId, agentSessionId, goalMode]);

  // Agent settings panel (settings + provider sign-in)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authProviders, setAuthProviders] = useState<AgentAuthProvider[]>([]);
  const [agentSchema, setAgentSchema] = useState<AgentSettingSchemaItem[]>([]);
  const [agentTools, setAgentTools] = useState<AgentToolInfo[]>([]);
  const [agentDefs, setAgentDefs] = useState<AgentDefinitionInfo[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const loadSettingsPanel = useCallback(() => {
    setSettingsLoading(true);
    const p = backend?.getAgentAuthProviders?.call(backend).then(setAuthProviders).catch(() => undefined);
    const s = backend?.getAgentSettingsSchema?.call(backend).then(setAgentSchema).catch(() => undefined);
    const t = wsId && agentSessionId ? backend?.getAgentTools?.call(backend, wsId, agentSessionId).then(setAgentTools).catch(() => undefined) : undefined;
    const a = wsId ? backend?.listAgentDefinitions?.call(backend, wsId).then(setAgentDefs).catch(() => undefined) : undefined;
    void Promise.all([p, s, t, a]).finally(() => setSettingsLoading(false));
  }, [backend, wsId, agentSessionId]);
  const openSettings = useCallback(() => { setSettingsOpen(true); loadSettingsPanel(); }, [loadSettingsPanel]);
  const handleSetApiKey = useCallback(async (provider: string, key: string) => {
    const fn = backend?.setAgentProviderApiKey;
    if (!fn) throw new Error('Not supported');
    await fn.call(backend, provider, key);
    loadSettingsPanel();
    refreshControl();
  }, [backend, loadSettingsPanel, refreshControl]);
  const handleRemoveAccount = useCallback(async (provider: string, credentialId: number) => {
    const fn = backend?.removeAgentProviderAccount;
    if (!fn) throw new Error('Not supported');
    await fn.call(backend, provider, credentialId);
    loadSettingsPanel();
    refreshControl();
  }, [backend, loadSettingsPanel, refreshControl]);
  const handleCheckUsage = useCallback(async (provider: string) => {
    const fn = backend?.checkAgentProviderUsage;
    if (!fn) throw new Error('Not supported');
    return fn.call(backend, provider);
  }, [backend]);
  /** Per-session attribution for the Usage tab — reads the transcript, so it
   *  works even when the session isn't live. */
  const handleLoadSessionUsage = useCallback(async () => {
    const fn = backend?.getAgentSessionUsageReport;
    if (!fn || !wsId || !agentSessionId) return null;
    return fn.call(backend, wsId, agentSessionId);
  }, [backend, wsId, agentSessionId]);
  const handleSetSetting = useCallback(async (path: string, value: string | number | boolean | string[]) => {
    const fn = backend?.setAgentSetting;
    if (!fn) throw new Error('Not supported');
    await fn.call(backend, path, value);
    loadSettingsPanel();
    refreshControl();
  }, [backend, loadSettingsPanel, refreshControl]);
  const handleCompact = useCallback(() => {
    const fn = backend?.compactAgentSession;
    if (!fn || !wsId || !agentSessionId) return;
    void fn.call(backend, wsId, agentSessionId).then(() => refreshControl()).catch(() => undefined);
  }, [backend, wsId, agentSessionId, refreshControl]);
  const handleCycleRole = useCallback(() => {
    const fn = backend?.cycleAgentRole;
    if (!fn || !wsId || !agentSessionId) return;
    void fn.call(backend, wsId, agentSessionId, 'forward').then(() => refreshControl()).catch(() => undefined);
  }, [backend, wsId, agentSessionId, refreshControl]);
  const handleToggleFast = useCallback(() => {
    const fn = backend?.setAgentSetting;
    // Fast mode is the per-family service-tier setting (tier.openai/anthropic/
    // google); serviceTierKey is null when the current model can't do it.
    const key = control?.serviceTierKey;
    if (!fn || !key) return;
    const next = control?.serviceTier === 'priority' ? 'none' : 'priority';
    void fn.call(backend, key, next).then(() => refreshControl()).catch(() => undefined);
  }, [backend, control?.serviceTier, control?.serviceTierKey, refreshControl]);

  // Conversation history / rewind + branch tree
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<AgentHistoryEntry[]>([]);
  const [historyTree, setHistoryTree] = useState<AgentTreeNode[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [transcriptRefresh, setTranscriptRefresh] = useState(0);
  // Shake rewrites persisted session entries. Keep the result pane-local and
  // refresh only committed transcript history; live streaming blocks stay intact.
  const [shakeResult, setShakeResult] = useState<AgentShakeResult | undefined>(undefined);
  const [shakeError, setShakeError] = useState<string | null>(null);
  const [shakePending, setShakePending] = useState(false);
  const shakeSessionKey = wsId && agentSessionId
    ? `${backendKey ?? backend?.descriptor.key ?? 'unknown'}:${wsId}:${agentSessionId}`
    : null;
  const shakeSessionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    shakeSessionKeyRef.current = shakeSessionKey;
    setShakeResult(undefined);
    setShakeError(null);
    setShakePending(false);
  }, [shakeSessionKey]);
  const handleShake = useCallback(async (mode: AgentShakeMode) => {
    if (!shakeSessionKey || shakeSessionKeyRef.current !== shakeSessionKey) return;
    const fn = backend?.shakeAgentSession;
    if (!fn) {
      setShakeError('Shake is not supported by this backend.');
      return;
    }
    setShakePending(true);
    setShakeError(null);
    setShakeResult(undefined);
    try {
      const result = await fn.call(backend, wsId!, agentSessionId!, mode);
      if (shakeSessionKeyRef.current !== shakeSessionKey) return;
      setShakeResult(result);
      const changed = result.mode === 'images'
        ? (result.imagesDropped ?? 0) > 0
        : result.toolResultsDropped + result.blocksDropped > 0;
      if (changed) setTranscriptRefresh((n) => n + 1);
      refreshControl();
    } catch (error) {
      if (shakeSessionKeyRef.current === shakeSessionKey) {
        setShakeError(error instanceof Error ? error.message : 'Could not shake this session context.');
      }
    } finally {
      if (shakeSessionKeyRef.current === shakeSessionKey) setShakePending(false);
    }
  }, [backend, wsId, agentSessionId, refreshControl, shakeSessionKey]);
  // Text to drop back into the composer after a re-do (bumped nonce re-applies).
  const [composerInjection, setComposerInjection] = useState<{ text: string; nonce: number } | null>(null);
  const treeAvailable = !!backend?.getAgentSessionTree;
  const loadHistory = useCallback(() => {
    if (!wsId || !agentSessionId) return;
    setHistoryLoading(true);
    const hist = backend?.getAgentHistory?.call(backend, wsId, agentSessionId).then(setHistoryEntries).catch(() => undefined);
    const tree = backend?.getAgentSessionTree?.call(backend, wsId, agentSessionId).then(setHistoryTree).catch(() => undefined);
    void Promise.allSettled([hist, tree]).finally(() => setHistoryLoading(false));
  }, [backend, wsId, agentSessionId]);
  const openHistory = useCallback(() => { setHistoryOpen(true); loadHistory(); }, [loadHistory]);
  const handleNavigateHistory = useCallback((entryId: string, mode: 'redo' | 'jump') => {
    const fn = backend?.navigateAgentHistory;
    if (!fn || !wsId || !agentSessionId) return;
    void fn.call(backend, wsId, agentSessionId, entryId, mode).then((result) => {
      if (result?.ok) {
        setHistoryOpen(false);
        setLiveBlocks(NO_LIVE);
        setTranscriptRefresh((n) => n + 1);
        refreshControl();
        if (result.editorText) setComposerInjection((prev) => ({ text: result.editorText!, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    }).catch(() => undefined);
  }, [backend, wsId, agentSessionId, refreshControl]);

  // OAuth sign-in flow (events arrive via the agent-state delta channel)
  const [oauthFlow, setOauthFlow] = useState<(AgentOAuthEvent & { provider: string }) | null>(null);
  const oauthFlowIdRef = useRef<string | null>(null);
  const oauthProviderRef = useRef<string>('');
  useEffect(() => {
    if (!backend?.subscribeAgentState) return;
    return backend.subscribeAgentState((delta) => {
      if (delta.type !== 'agent_oauth_event' || delta.event.flowId !== oauthFlowIdRef.current) return;
      // Merge so the auth URL persists when a later prompt event arrives.
      setOauthFlow((prev) => ({ ...(prev ?? {}), ...delta.event, provider: oauthProviderRef.current }));
      if (delta.event.kind === 'done') { loadSettingsPanel(); refreshControl(); }
    });
  }, [backend, loadSettingsPanel, refreshControl]);
  const handleOAuthLogin = useCallback((provider: string) => {
    const fn = backend?.startAgentOAuthLogin;
    if (!fn) return;
    const flowId = crypto.randomUUID();
    oauthFlowIdRef.current = flowId;
    oauthProviderRef.current = provider;
    setOauthFlow({ flowId, kind: 'auth', provider });
    void fn.call(backend, provider, flowId).catch((e) =>
      setOauthFlow({ flowId, kind: 'done', ok: false, error: e instanceof Error ? e.message : 'Failed to start', provider }),
    );
  }, [backend]);
  const handleOAuthRespond = useCallback((value: string) => {
    const fn = backend?.respondAgentOAuthPrompt;
    const flowId = oauthFlowIdRef.current;
    if (!fn || !flowId) return;
    void fn.call(backend, flowId, value).catch(() => undefined);
  }, [backend]);

  // Agent panes show the native block transcript (replacing the xterm view);
  // shell panes keep the terminal.
  const isAgentPane = !!(pane.agentSessionId && pane.workspaceId);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {isAgentPane ? (
        <>
          <AgentPaneHeader
            model={agentModel}
            status={agentStatus}
            control={control}
            onSetModel={handleSetModel}
            onSetThinkingLevel={handleSetThinkingLevel}
            onSetApprovalMode={handleSetApprovalMode}
            onCycleRole={handleCycleRole}
            onToggleFast={handleToggleFast}
            onOpenHistory={openHistory}
            onOpenAuth={openSettings}
            error={modelError}
            awaitingInput={awaitingInput}
            goal={goalContext}
            goalMode={goalMode}
            goalModePending={goalModePending}
            goalSessionKey={agentSessionId}
            onSetGoalMode={handleSetGoalMode}
            shakeResult={shakeResult}
            shakePending={shakePending}
            shakeError={shakeError}
            onShake={pane.viewOnly ? undefined : handleShake}
          />
          <div className="flex-1 min-h-0 bg-[var(--gs-bg)]">
            <AgentTranscript
              fetchRange={fetchTranscriptRange}
              live={liveBlocks}
              pending={optimisticBlocks.length > 0 ? [...pendingBlocks, ...optimisticBlocks] : pendingBlocks}
              host={transcriptHost}
              pageSize={30}
              refreshNonce={transcriptRefresh}
            />
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
            externalDraft={composerInjection}
            onPromptLifecycle={handlePromptLifecycle}
            retrySignal={retrySignal}
          />
        </div>
      ) : null}
      {settingsOpen && (
        <AgentSettingsPanel
          control={control}
          schema={agentSchema}
          tools={agentTools}
          agents={agentDefs}
          providers={authProviders}
          loading={settingsLoading}
          oauth={oauthFlow}
          onSetModel={handleSetModel}
          onSetSetting={handleSetSetting}
          onSetApiKey={handleSetApiKey}
          onOAuthLogin={handleOAuthLogin}
          onOAuthRespond={handleOAuthRespond}
          onRemoveAccount={handleRemoveAccount}
          onCheckUsage={handleCheckUsage}
          onLoadSessionUsage={handleLoadSessionUsage}
          onCompact={handleCompact}
          onClose={() => { setSettingsOpen(false); setOauthFlow(null); oauthFlowIdRef.current = null; }}
        />
      )}
      {historyOpen && (
        <AgentHistoryPanel
          entries={historyEntries}
          tree={historyTree}
          treeAvailable={treeAvailable}
          loading={historyLoading}
          onNavigate={handleNavigateHistory}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
