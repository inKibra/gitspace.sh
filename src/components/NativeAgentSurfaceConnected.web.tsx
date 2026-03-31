/** @jsxImportSource react */
import { useCallback } from 'react';
import { useGitSpace } from '../sdk/index.js';
import { NativeAgentSurface } from './NativeAgentSurface.web.js';
import type { HostUIDialogResponse } from '../lib/tmux-lite/agents/host-ui-bridge.js';

export function NativeAgentSurfaceConnected() {
  const { engine, state: multiState } = useGitSpace();
  const activeBackendKey = multiState.activeBackendKey;

  // Read agent session context and host UI state from multiState (reactive).
  const activeBackend = activeBackendKey ? multiState.byBackend[activeBackendKey] : null;
  const agentSessionId = activeBackend?.attachedAgentSessionId ?? null;
  const workspaceId = activeBackend?.attachedWorkspaceId ?? null;
  const agentAttached = !!(agentSessionId && workspaceId);
  const pendingDialog = activeBackend?.pendingDialogRequest ?? null;
  const workingMessage = activeBackend?.agentWorkingMessage;

  const handleSubmit = useCallback(async (text: string, rawImages: Array<{ dataUrl: string; name: string }>, rawFiles: Array<{ name: string; dataUrl: string }>) => {
    if (!activeBackendKey || !agentSessionId || !workspaceId) return;
    // Convert data URLs to raw base64 + mimeType for the agent prompt pipeline
    const images = rawImages
      .filter(img => img.dataUrl)
      .map(img => {
        // dataUrl format: "data:<mimeType>;base64,<data>"
        const commaIdx = img.dataUrl.indexOf(',');
        const meta = img.dataUrl.slice(0, commaIdx); // "data:image/png;base64"
        const mimeType = meta.replace('data:', '').replace(';base64', '');
        const data = img.dataUrl.slice(commaIdx + 1);
        return { data, mimeType };
      });

    // Stage non-image files and collect @ references
    let augmentedText = text;
    for (const file of rawFiles) {
      if (!file.dataUrl) continue;
      try {
        const commaIdx = file.dataUrl.indexOf(',');
        const meta = file.dataUrl.slice(0, commaIdx);
        const mimeType = meta.replace('data:', '').replace(';base64', '');
        const data = file.dataUrl.slice(commaIdx + 1);
        const result = await engine.stageUpload(
          { backendKey: activeBackendKey, workspaceId },
          file.name,
          data,
          mimeType,
        );
        augmentedText = augmentedText
          ? `${augmentedText} @${result.stagedPath}`
          : `@${result.stagedPath}`;
      } catch (err) {
        console.error('Failed to stage file:', file.name, err);
      }
    }

    // Build attachment indicators so the prompt text is honest about what's attached
    const indicators: string[] = [];
    for (const img of rawImages) {
      if (img.dataUrl) indicators.push(`[image: ${img.name}]`);
    }
    for (const file of rawFiles) {
      if (file.dataUrl) indicators.push(`[file: ${file.name}]`);
    }
    if (indicators.length > 0) {
      const suffix = indicators.join(' ');
      augmentedText = augmentedText ? `${augmentedText}\n${suffix}` : suffix;
    }

    void engine.promptAgentSession(
      { backendKey: activeBackendKey, workspaceId, agentSessionId },
      augmentedText,
      images.length > 0 ? images : undefined,
    );
  }, [engine, activeBackendKey, workspaceId, agentSessionId]);

  const handleAbort = useCallback(() => {
    if (!activeBackendKey || !agentSessionId || !workspaceId) return;
    void engine.abortAgentSession({ backendKey: activeBackendKey, workspaceId, agentSessionId });
  }, [engine, activeBackendKey, workspaceId, agentSessionId]);

  const handleDialogResponse = useCallback((response: HostUIDialogResponse) => {
    if (!activeBackendKey) return;
    void engine.sendDialogResponse(activeBackendKey, response.id, response.type, response.value);
    engine.clearPendingDialog(activeBackendKey);
  }, [engine, activeBackendKey]);

  const handleRequestCommands = useCallback(async () => {
    if (!activeBackendKey || !workspaceId) return [];
    try {
      return await engine.listAgentCommands({ backendKey: activeBackendKey, workspaceId });
    } catch {
      return [];
    }
  }, [engine, activeBackendKey, workspaceId]);

  const handleRequestFileSuggestions = useCallback(async (prefix: string) => {
    if (!activeBackendKey || !workspaceId) return [];
    try {
      return await engine.getFileSuggestions({ backendKey: activeBackendKey, workspaceId }, prefix, 20);
    } catch {
      return [];
    }
  }, [engine, activeBackendKey, workspaceId]);

  return (
    <NativeAgentSurface
      agentAttached={agentAttached}
      agentBusy={false}
      workingMessage={workingMessage}
      pendingDialog={pendingDialog}
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      onDialogResponse={handleDialogResponse}
      isSubmitting={false}
      onRequestCommands={handleRequestCommands}
      onRequestFileSuggestions={handleRequestFileSuggestions}
    />
  );
}
