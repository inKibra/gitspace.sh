/** @jsxImportSource react */
/**
 * NativeAgentSurface — wraps the native composer and host UI dialog overlay.
 *
 * Rendered at the app level via portal. Shows the native composer when an agent
 * session is attached, and renders host UI dialogs from the Pi SDK.
 */

import { createPortal } from 'react-dom';
import { NativeComposer } from './NativeComposer.web.js';
import type { NativeComposerSubmitMode } from './NativeComposer.web.js';
import { HostUIDialogOverlay } from './HostUIDialogs.web.js';
import type { HostUIDialogRequest, HostUIDialogResponse } from '../lib/tmux-lite/agents/host-ui-bridge.js';


export interface QueuedAgentMessages {
  steering: string[];
  followUp: string[];
}

function QueuedMessageRow({
  message,
  onEdit,
  onCancel,
}: {
  message: string;
  onEdit?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message}</span>
      <button type="button" onClick={() => void onEdit?.()} style={{ border: 0, background: 'transparent', color: 'var(--gs-info-light)', cursor: 'pointer', fontSize: 12 }}>Edit</button>
      <button type="button" onClick={() => void onCancel?.()} style={{ border: 0, background: 'transparent', color: 'var(--gs-text-dim)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
    </div>
  );
}
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
  onSubmit: (text: string, images: Array<{ dataUrl: string; name: string }>, files: Array<{ name: string; dataUrl: string }>, mode: NativeComposerSubmitMode) => void;
  /** Called when the user wants to abort the agent. */
  onAbort?: () => void;
  /** Called when the user responds to a host UI dialog. */
  onDialogResponse: (response: HostUIDialogResponse) => void;
  /** Whether submission is in progress. */
  isSubmitting?: boolean;
  /** Pending SDK steering/follow-up messages for the attached agent session. */
  queuedMessages?: QueuedAgentMessages;
  /** Per-pane/agent key used to restore draft text after switching panes. */
  draftStorageKey?: string | null;
  draftStorageVersion?: number;
  onCancelQueuedMessage?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>;
  onEditQueuedMessage?: (kind: 'steering' | 'followUp', index: number, message: string) => void | Promise<void>;
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
  queuedMessages,
  draftStorageKey,
  draftStorageVersion,
  onCancelQueuedMessage,
  onEditQueuedMessage,
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
            color: 'var(--gs-text-muted)',
            backgroundColor: 'var(--gs-bg-elevated)',
            borderTop: '1px solid var(--gs-border-muted)',
            textAlign: 'center',
          }}
        >
          {workingMessage}
        </div>
      )}
      {queuedMessages && (queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0) && (
        <div style={{
          borderTop: '1px solid var(--gs-border-muted)',
          background: 'var(--gs-bg-elevated)',
          padding: '6px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          {queuedMessages.steering.length > 0 && (
            <div style={{ color: 'var(--gs-text-muted)', fontSize: 12 }}>
              <div style={{ color: 'var(--gs-warning-bright)', fontWeight: 700, marginBottom: 3 }}>Steering current turn</div>
              {queuedMessages.steering.map((message, index) => (
                <QueuedMessageRow
                  key={`steer-${index}`}
                  message={message}
                  onEdit={() => onEditQueuedMessage?.('steering', index, message)}
                  onCancel={() => onCancelQueuedMessage?.('steering', index)}
                />
              ))}
            </div>
          )}
          {queuedMessages.followUp.length > 0 && (
            <div style={{ color: 'var(--gs-text-muted)', fontSize: 12 }}>
              <div style={{ color: 'var(--gs-info-light)', fontWeight: 700, marginBottom: 3 }}>Queued follow-ups</div>
              {queuedMessages.followUp.map((message, index) => (
                <QueuedMessageRow
                  key={`follow-up-${index}`}
                  message={`${index + 1}. ${message}`}
                  onEdit={() => onEditQueuedMessage?.('followUp', index, message)}
                  onCancel={() => onCancelQueuedMessage?.('followUp', index)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <NativeComposer
        onSubmit={onSubmit}
        onAbort={onAbort}
        isBusy={agentBusy}
        isSubmitting={isSubmitting}
        placeholder="Message agent..."
        draftStorageKey={draftStorageKey}
        draftStorageVersion={draftStorageVersion}
        onRequestCommands={onRequestCommands}
        onRequestFileSuggestions={onRequestFileSuggestions}
      />
    </>
  );
}
