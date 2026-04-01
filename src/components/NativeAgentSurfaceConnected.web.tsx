/** @jsxImportSource react */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useGitSpace } from '../sdk/index.js';
import { NativeAgentSurface } from './NativeAgentSurface.web.js';
import type { HostUIDialogResponse } from '../lib/tmux-lite/agents/host-ui-bridge.js';

interface NativeAgentSurfaceConnectedProps {
  backendKey?: string | null;
}

export function NativeAgentSurfaceConnected({ backendKey }: NativeAgentSurfaceConnectedProps = {}) {
  const { engine, state: multiState } = useGitSpace();
  const resolvedBackendKey = backendKey ?? multiState.activeBackendKey;

  // Read agent session context and host UI state from multiState (reactive).
  const activeBackend = resolvedBackendKey ? multiState.byBackend[resolvedBackendKey] : null;
  const agentSessionId = activeBackend?.attachedAgentSessionId ?? null;
  const workspaceId = activeBackend?.attachedWorkspaceId ?? null;
  const agentAttached = !!(agentSessionId && workspaceId);
  const pendingDialog = activeBackend?.pendingDialogRequest ?? null;
  const workingMessage = activeBackend?.agentWorkingMessage;
  const attachedAgentState = useMemo(
    () => (agentSessionId ? activeBackend?.snapshot?.agentSessionsById[agentSessionId] ?? null : null),
    [activeBackend?.snapshot, agentSessionId],
  );
  const agentBusy = attachedAgentState?.state === 'running' || attachedAgentState?.state === 'retrying';
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async (text: string, rawImages: Array<{ dataUrl: string; name: string }>, rawFiles: Array<{ name: string; dataUrl: string }>) => {
    if (!resolvedBackendKey || !agentSessionId || !workspaceId || isSubmitting) return;
    setIsSubmitting(true);
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
            { backendKey: resolvedBackendKey, workspaceId },
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
        return;
      }

      await engine.promptAgentSession(
        { backendKey: resolvedBackendKey, workspaceId, agentSessionId },
        augmentedText,
        images.length > 0 ? images : undefined,
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [engine, resolvedBackendKey, workspaceId, agentSessionId, isSubmitting]);

  const handleAbort = useCallback(() => {
    if (!resolvedBackendKey || !agentSessionId || !workspaceId) return;
    void engine.abortAgentSession({ backendKey: resolvedBackendKey, workspaceId, agentSessionId });
  }, [engine, resolvedBackendKey, workspaceId, agentSessionId]);

  const handleDialogResponse = useCallback((response: HostUIDialogResponse) => {
    if (!resolvedBackendKey) return;
    void engine.sendDialogResponse(resolvedBackendKey, response.id, response.type, response.value)
      .then(() => {
        engine.clearPendingDialog(resolvedBackendKey);
      })
      .catch((error) => {
        console.error('Failed to send dialog response', error);
        toast.error(error instanceof Error ? error.message : 'Failed to submit dialog response');
      });
  }, [engine, resolvedBackendKey]);

  const handleRequestCommands = useCallback(async () => {
    if (!resolvedBackendKey || !workspaceId) return [];
    try {
      return await engine.listAgentCommands({ backendKey: resolvedBackendKey, workspaceId });
    } catch {
      return [];
    }
  }, [engine, resolvedBackendKey, workspaceId]);

  const handleRequestFileSuggestions = useCallback(async (prefix: string) => {
    if (!resolvedBackendKey || !workspaceId) return [];
    try {
      return await engine.getFileSuggestions({ backendKey: resolvedBackendKey, workspaceId }, prefix, 20);
    } catch {
      return [];
    }
  }, [engine, resolvedBackendKey, workspaceId]);

  return (
    <NativeAgentSurface
      agentAttached={agentAttached}
      agentBusy={agentBusy}
      workingMessage={workingMessage}
      pendingDialog={pendingDialog}
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      onDialogResponse={handleDialogResponse}
      isSubmitting={isSubmitting}
      onRequestCommands={handleRequestCommands}
      onRequestFileSuggestions={handleRequestFileSuggestions}
    />
  );
}
