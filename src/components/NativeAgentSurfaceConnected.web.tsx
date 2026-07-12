/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../lib/sonner.web.js';
import { recordRpcFailure } from '../lib/client-diagnostics.web.js';
import { useGitSpace } from '../sdk/index.js';
import { NativeAgentSurface } from './NativeAgentSurface.web.js';
import type { HostUIDialogResponse } from '../lib/tmux-lite/agents/host-ui-bridge.js';

export type PromptSubmitMode = 'send' | 'steer' | 'followUp';

/** Prompt lifecycle notification for the hosting pane (optimistic echo + retry). */
export type PromptLifecycleEvent =
  | { phase: 'submitted'; text: string; mode: PromptSubmitMode }
  | { phase: 'failed'; text: string; mode: PromptSubmitMode; error: string };

interface NativeAgentSurfaceConnectedProps {
  backendKey?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  paneId?: string | null;
  /** Text to drop into the composer (e.g. a re-done message). Applied whenever
   *  `nonce` changes so the same text can be re-injected. */
  externalDraft?: { text: string; nonce: number } | null;
  /** Observes prompt attempts/failures so the pane can render an optimistic
   *  echo and keep the last-attempted prompt for Retry. */
  onPromptLifecycle?: (event: PromptLifecycleEvent) => void;
  /** Re-send request (from the transcript's Retry button). Applied whenever
   *  `nonce` changes so the same prompt can be retried repeatedly. */
  retrySignal?: { text: string; mode: PromptSubmitMode; nonce: number } | null;
}

export function NativeAgentSurfaceConnected({ backendKey, workspaceId, agentSessionId, paneId, externalDraft, onPromptLifecycle, retrySignal }: NativeAgentSurfaceConnectedProps = {}) {
  const { engine, state: multiState } = useGitSpace();
  const resolvedBackendKey = backendKey ?? multiState.activeBackendKey;

  // Read agent session context and host UI state from multiState (reactive).
  const activeBackend = resolvedBackendKey ? multiState.byBackend[resolvedBackendKey] : null;
  const resolvedAgentSessionId = agentSessionId ?? activeBackend?.attachedAgentSessionId ?? null;
  const resolvedWorkspaceId = workspaceId ?? activeBackend?.attachedWorkspaceId ?? null;
  const agentAttached = !!(resolvedAgentSessionId && resolvedWorkspaceId);
  const pendingDialog = resolvedAgentSessionId
    ? activeBackend?.pendingDialogByAgentSessionId?.[resolvedAgentSessionId] ?? null
    : activeBackend?.pendingDialogRequest ?? null;
  const workingMessage = resolvedAgentSessionId
    ? activeBackend?.workingMessageByAgentSessionId?.[resolvedAgentSessionId]
    : activeBackend?.agentWorkingMessage;
  const attachedAgentState = useMemo(
    () => (resolvedAgentSessionId ? activeBackend?.snapshot?.agentSessionsById[resolvedAgentSessionId] ?? null : null),
    [activeBackend?.snapshot, resolvedAgentSessionId],
  );
  const agentBusy = attachedAgentState?.state === 'running' || attachedAgentState?.state === 'retrying';
  const queuedMessages = attachedAgentState?.queuedMessages ?? { steering: [], followUp: [] };
  const draftStorageKey = resolvedBackendKey && resolvedWorkspaceId && resolvedAgentSessionId
    ? `gssh:agent-composer-draft:${resolvedBackendKey}:${resolvedWorkspaceId}:${resolvedAgentSessionId}:${paneId ?? 'default'}`
    : null;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftStorageVersion, setDraftStorageVersion] = useState(0);

  // Inject an external draft (a re-done message) into the composer: write it to
  // the draft store and bump the version so the composer reloads it. Keyed on
  // nonce so re-doing the same text again re-applies.
  const lastInjectedNonce = useRef(0);
  useEffect(() => {
    if (!externalDraft || externalDraft.nonce === lastInjectedNonce.current) return;
    lastInjectedNonce.current = externalDraft.nonce;
    if (!draftStorageKey) return;
    try { localStorage.setItem(draftStorageKey, externalDraft.text); } catch { /* storage unavailable */ }
    setDraftStorageVersion((v) => v + 1);
  }, [externalDraft, draftStorageKey]);

  const handleSubmit = useCallback(async (text: string, rawImages: Array<{ dataUrl: string; name: string }>, rawFiles: Array<{ name: string; dataUrl: string }>, mode: 'send' | 'steer' | 'followUp') => {
    if (!resolvedBackendKey || !resolvedAgentSessionId || !resolvedWorkspaceId || isSubmitting) return false;
    setIsSubmitting(true);
    // What we actually attempted to send — used for lifecycle events (optimistic
    // echo + retry) and visible to the catch below (augmentation happens in-try).
    let attemptedText = text;
    try {
      const images = rawImages
        .filter(img => img.dataUrl)
        .map(img => {
          const commaIdx = img.dataUrl.indexOf(',');
          const meta = img.dataUrl.slice(0, commaIdx);
          const mimeType = meta.replace('data:', '').replace(';base64', '');
          const data = img.dataUrl.slice(commaIdx + 1);
          return { data, mimeType };
        });

      let augmentedText = text;
      const stagedFileNames: string[] = [];
      for (const file of rawFiles) {
        if (!file.dataUrl) continue;
        try {
          const commaIdx = file.dataUrl.indexOf(',');
          const meta = file.dataUrl.slice(0, commaIdx);
          const mimeType = meta.replace('data:', '').replace(';base64', '');
          const data = file.dataUrl.slice(commaIdx + 1);
          const result = await engine.stageUpload(
            { backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId },
            file.name,
            data,
            mimeType,
          );
          stagedFileNames.push(file.name);
          augmentedText = augmentedText
            ? `${augmentedText} @${result.stagedPath}`
            : `@${result.stagedPath}`;
        } catch (err) {
          console.error('Failed to stage file:', file.name, err);
          toast.error(`Failed to attach ${file.name}`);
        }
      }

      const indicators: string[] = [];
      for (const img of rawImages) {
        if (img.dataUrl) indicators.push(`[image: ${img.name}]`);
      }
      for (const fileName of stagedFileNames) {
        indicators.push(`[file: ${fileName}]`);
      }
      if (indicators.length > 0) {
        const suffix = indicators.join(' ');
        augmentedText = augmentedText ? `${augmentedText}\n${suffix}` : suffix;
      }

      const hasPromptText = augmentedText.trim().length > 0;
      if (!hasPromptText && images.length === 0) {
        toast.error('Nothing to send — all file attachments failed to stage.');
        return false;
      }

      attemptedText = augmentedText;
      const trimmed = augmentedText.trim();
      const isCompactCommand = trimmed === '/compact' || trimmed.startsWith('/compact ');
      const isSpaceCommand = trimmed === '/space' || trimmed.startsWith('/space ');
      if (isCompactCommand) {
        const compactInstructions = trimmed.startsWith('/compact ') ? trimmed.slice('/compact '.length).trim() : '';
        toast.info(compactInstructions
          ? 'Compacting session with instructions...'
          : 'Compacting session...');
      } else if (isSpaceCommand) {
        toast.info('Running workspace command...');
        try {
          onPromptLifecycle?.({ phase: 'submitted', text: trimmed, mode });
          await engine.promptAgentSession(
            { backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId },
            trimmed,
            undefined,
            mode === 'send' ? undefined : { streamingBehavior: mode },
          );
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to run workspace command';
          recordRpcFailure('prompt_agent_session', error, { workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId });
          onPromptLifecycle?.({ phase: 'failed', text: trimmed, mode, error: message });
          toast.error(message);
          return false;
        }
      }

      onPromptLifecycle?.({ phase: 'submitted', text: augmentedText, mode });
      await engine.promptAgentSession(
        { backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId },
        augmentedText,
        images.length > 0 ? images : undefined,
        mode === 'send' ? undefined : { streamingBehavior: mode },
      );
      if (isCompactCommand) {
        toast.success('Compaction requested.');
      }
    } catch (error) {
      console.error('Failed to submit agent prompt', error);
      const message = error instanceof Error ? error.message : 'Failed to send command';
      recordRpcFailure('prompt_agent_session', error, { workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId });
      onPromptLifecycle?.({ phase: 'failed', text: attemptedText, mode, error: message });
      toast.error(message);
      // Preserve the composer text: submitAndClear keeps the draft when the
      // submitter returns false (a failed send must never eat the message).
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [engine, resolvedBackendKey, resolvedWorkspaceId, resolvedAgentSessionId, isSubmitting, onPromptLifecycle]);

  // Retry (from the transcript's failed-prompt Retry button): re-send the pane's
  // last-attempted prompt. Nonce-keyed so the same text can be retried again.
  const lastRetryNonce = useRef(0);
  useEffect(() => {
    if (!retrySignal || retrySignal.nonce === lastRetryNonce.current) return;
    lastRetryNonce.current = retrySignal.nonce;
    if (!retrySignal.text.trim()) return;
    void handleSubmit(retrySignal.text, [], [], retrySignal.mode);
  }, [retrySignal, handleSubmit]);

  const handleStop = useCallback(() => {
    if (!resolvedBackendKey || !resolvedAgentSessionId || !resolvedWorkspaceId) return;
    // stopAgentTurn cancels the current LLM turn; the session stays alive.
    void engine.stopAgentTurn({ backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId });
  }, [engine, resolvedBackendKey, resolvedWorkspaceId, resolvedAgentSessionId]);

  const handleDialogResponse = useCallback((response: HostUIDialogResponse) => {
    if (!resolvedBackendKey) return;
    // Clear by the session the overlay is keyed on so the modal always
    // dismisses on success.
    const clear = () => engine.clearPendingDialog(resolvedBackendKey, resolvedAgentSessionId ?? undefined);
    void engine.sendDialogResponse(resolvedBackendKey, response.id, response.type, response.value)
      .then(clear)
      .catch((error) => {
        // A dialog the daemon already resolved (late/duplicate answer) is gone
        // server-side — dismiss the modal instead of stranding it. Genuine
        // transport failures keep the modal so the user can retry.
        if (error instanceof Error && /no longer pending/i.test(error.message)) {
          clear();
          return;
        }
        console.error('Failed to send dialog response', error);
        toast.error(error instanceof Error ? error.message : 'Failed to submit dialog response');
      });
  }, [engine, resolvedBackendKey, resolvedAgentSessionId]);

  const handleRequestCommands = useCallback(async () => {
    if (!resolvedBackendKey || !resolvedWorkspaceId) return [];
    try {
      return await engine.listAgentCommands({ backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId });
    } catch {
      return [];
    }
  }, [engine, resolvedBackendKey, resolvedWorkspaceId]);

  const handleRequestFileSuggestions = useCallback(async (prefix: string) => {
    if (!resolvedBackendKey || !resolvedWorkspaceId) return [];
    try {
      return await engine.getFileSuggestions({ backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId }, prefix, 20);
    } catch {
      return [];
    }
  }, [engine, resolvedBackendKey, resolvedWorkspaceId]);

  const removeQueuedMessage = useCallback(async (
    kind: 'steering' | 'followUp',
    index: number,
    options?: { restoreToDraft?: boolean; fallbackMessage?: string },
  ) => {
    if (!resolvedBackendKey || !resolvedAgentSessionId || !resolvedWorkspaceId) return;
    try {
      const message = await engine.removeAgentQueuedMessage(
        { backendKey: resolvedBackendKey, workspaceId: resolvedWorkspaceId, agentSessionId: resolvedAgentSessionId },
        kind,
        index,
      );
      const draftMessage = message ?? options?.fallbackMessage;
      if (options?.restoreToDraft && draftMessage && draftStorageKey) {
        localStorage.setItem(draftStorageKey, draftMessage);
        setDraftStorageVersion((value) => value + 1);
      }
    } catch (error) {
      console.error('Failed to remove queued agent message', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update queued message');
    }
  }, [draftStorageKey, engine, resolvedBackendKey, resolvedAgentSessionId, resolvedWorkspaceId]);

  const handleCancelQueuedMessage = useCallback((kind: 'steering' | 'followUp', index: number) => {
    void removeQueuedMessage(kind, index);
  }, [removeQueuedMessage]);

  const handleEditQueuedMessage = useCallback((kind: 'steering' | 'followUp', index: number, message: string) => {
    void removeQueuedMessage(kind, index, { restoreToDraft: true, fallbackMessage: message });
  }, [removeQueuedMessage]);

  return (
    <NativeAgentSurface
      agentAttached={agentAttached}
      agentBusy={agentBusy}
      workingMessage={workingMessage}
      pendingDialog={pendingDialog}
      onSubmit={handleSubmit}
      onAbort={handleStop}
      onDialogResponse={handleDialogResponse}
      isSubmitting={isSubmitting}
      queuedMessages={queuedMessages}
      draftStorageKey={draftStorageKey}
      draftStorageVersion={draftStorageVersion}
      onCancelQueuedMessage={handleCancelQueuedMessage}
      onEditQueuedMessage={handleEditQueuedMessage}
      onRequestCommands={handleRequestCommands}
      onRequestFileSuggestions={handleRequestFileSuggestions}
    />
  );
}
