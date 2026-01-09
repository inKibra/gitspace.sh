/**
 * TUI-specific wrapper for shared useInbox hook
 *
 * Integrates with TUI's renderer suspend/resume and tmux-lite CLI.
 */

import { useCallback } from 'react';
import { spawn } from 'child_process';
import { useInbox, type UseInboxProps, type UseInboxReturn } from '../../shared/components/Inbox.js';
import {
  clearInbox,
  markInboxRead,
  listSessions,
  type InboxItem,
} from '../../lib/tmux-lite/cli.js';

interface UseTUIInboxOptions {
  items: InboxItem[];
  unreadCount: number;
  onClose: () => void;
  onRefreshWorkspaces: () => Promise<void>;
  onRefreshInbox: () => Promise<{ items: InboxItem[]; unreadCount: number }>;
  renderer: {
    suspend: () => void;
    resume: () => void;
  };
}

interface UseTUIInboxReturn extends UseInboxReturn {
  /** Refresh inbox after operations */
  refreshInbox: () => Promise<void>;
}

export function useTUIInbox(options: UseTUIInboxOptions): UseTUIInboxReturn {
  const {
    items,
    unreadCount,
    onClose,
    onRefreshWorkspaces,
    onRefreshInbox,
    renderer,
  } = options;

  // Clear a single inbox item
  const onClearItem = useCallback(async (itemId: string) => {
    await clearInbox(itemId);
  }, []);

  // Clear all inbox items
  const onClearAll = useCallback(async () => {
    await clearInbox();
  }, []);

  // Mark an item as read
  const onMarkRead = useCallback(async (itemId: string) => {
    await markInboxRead(itemId);
  }, []);

  // Attach to a session
  const onAttachSession = useCallback(async (sessionId: string) => {
    const sessions = await listSessions();
    const session = sessions.find(s => s.id === sessionId);

    if (!session) {
      throw new Error('Session no longer exists');
    }

    // Get CLI path for tmux-lite
    const cliPath = new URL('../../lib/tmux-lite/cli.ts', import.meta.url).pathname;

    // Suspend TUI, attach to session, resume TUI
    renderer.suspend();
    const proc = spawn('bun', ['run', cliPath, 'attach', session.id, '-f'], { stdio: 'inherit' });
    await new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    renderer.resume();

    // Refresh workspaces after detaching
    await onRefreshWorkspaces();
  }, [renderer, onRefreshWorkspaces]);

  // Convert TUI InboxItem to shared InboxItem format
  const convertedItems = items.map(item => ({
    id: item.id,
    sessionId: item.sessionId,
    sessionName: item.sessionName,
    type: item.type as 'exit' | 'title' | 'idle' | 'bell',
    context: item.context,
    timestamp: item.timestamp,
    read: item.read,
    processTitle: item.processTitle,
    exitCode: item.exitCode,
  }));

  // Use the shared hook
  const hookReturn = useInbox({
    items: convertedItems,
    unreadCount,
    onClearItem,
    onClearAll,
    onMarkRead,
    onAttachSession,
    onClose,
  });

  // Wrap refresh to also update the TUI state
  const refreshInbox = useCallback(async () => {
    await onRefreshInbox();
  }, [onRefreshInbox]);

  return {
    ...hookReturn,
    refreshInbox,
  };
}
