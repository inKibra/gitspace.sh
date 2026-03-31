/** @jsxImportSource react */
/**
 * NativeAgentSurface — wraps the native composer and host UI dialog overlay.
 *
 * Rendered at the app level via portal. Shows the native composer when an agent
 * session is attached, and renders host UI dialogs from the Pi SDK.
 */

import { createPortal } from 'react-dom';
import { NativeComposer } from './NativeComposer.web.js';
import { HostUIDialogOverlay } from './HostUIDialogs.web.js';
import type { HostUIDialogRequest, HostUIDialogResponse } from '../lib/tmux-lite/agents/host-ui-bridge.js';

export interface NativeAgentSurfaceProps {
  /** Whether an agent session is currently active and attached. */
  agentAttached: boolean;
  /** Whether the agent is currently busy (streaming/processing). */
  agentBusy: boolean;
  /** Working message from the agent. */
  workingMessage?: string;
  /** Pending dialog request from the Pi SDK. */
  pendingDialog: HostUIDialogRequest | null;
  /** Called when the user submits text from the native composer. */
  onSubmit: (text: string, images: Array<{ dataUrl: string; name: string }>, files: Array<{ name: string; dataUrl: string }>) => void;
  /** Called when the user wants to abort the agent. */
  onAbort?: () => void;
  /** Called when the user responds to a host UI dialog. */
  onDialogResponse: (response: HostUIDialogResponse) => void;
  /** Whether submission is in progress. */
  isSubmitting?: boolean;
  /** Fetch available slash commands for autocomplete. */
  onRequestCommands?: () => Promise<Array<{ name: string; description: string; kind: string }>>;
  /** Fetch file suggestions for @ autocomplete. */
  onRequestFileSuggestions?: (prefix: string) => Promise<Array<{ path: string; isDirectory: boolean }>>;
}

export function NativeAgentSurface({
  agentAttached,
  agentBusy,
  workingMessage,
  pendingDialog,
  onSubmit,
  onAbort,
  onDialogResponse,
  isSubmitting,
  onRequestCommands,
  onRequestFileSuggestions,
}: NativeAgentSurfaceProps) {
  // Dialog overlay stays as a portal (always on top)
  const dialogOverlay = pendingDialog ? createPortal(
    <HostUIDialogOverlay
      request={pendingDialog}
      onResponse={onDialogResponse}
    />,
    document.body,
  ) : null;

  if (!agentAttached) return dialogOverlay;

  return (
    <>
      {dialogOverlay}
      {/* Composer rendered inline (no portal, no fixed positioning) */}
      {workingMessage && (
        <div
          style={{
            padding: '4px 12px',
            fontSize: '12px',
            color: '#8b949e',
            backgroundColor: '#161b22',
            borderTop: '1px solid #21262d',
            textAlign: 'center',
          }}
        >
          {workingMessage}
        </div>
      )}
      <NativeComposer
        onSubmit={onSubmit}
        onAbort={onAbort}
        isBusy={agentBusy}
        isSubmitting={isSubmitting}
        placeholder="Message agent..."
        onRequestCommands={onRequestCommands}
        onRequestFileSuggestions={onRequestFileSuggestions}
      />
    </>
  );
}
