import { useCallback } from 'react';
import { useInboxPageModel } from '../shared/inbox/useInboxPageModel.js';
import { resolveInboxCommand, type SessionCommandKeyInput } from '../input/sessionCommands.js';
import type { InboxItem } from '../../components/Inbox.js';

export interface UseInboxPageOptions {
  items: InboxItem[];
  unreadCount: number;
  onClearItem: (itemId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onMarkRead: (itemId: string) => Promise<void>;
  onAttachSession: (sessionId: string) => Promise<void>;
  onClose: () => void;
}

export function useInboxPage(options: UseInboxPageOptions) {
  const inboxProps = useInboxPageModel(options);

  const handleInboxCommand = useCallback(async (input: SessionCommandKeyInput): Promise<boolean> => {
    const command = resolveInboxCommand(input);
    if (!command) {
      return false;
    }

    if (command === 'move-up') inboxProps.moveUp();
    else if (command === 'move-down') inboxProps.moveDown();
    else if (command === 'activate') {
      if (inboxProps.isViewingThread) await inboxProps.attachToSession();
      else await inboxProps.openThread();
    } else if (command === 'back') {
      if (inboxProps.isViewingThread) inboxProps.closeThread();
      else options.onClose();
    } else if (command === 'delete') {
      if (inboxProps.isViewingThread) await inboxProps.deleteThread();
      else await inboxProps.deleteSelected();
    } else if (command === 'clear') {
      await inboxProps.clearAll();
    } else if (command === 'attach' && inboxProps.isViewingThread) {
      await inboxProps.attachToSession();
    }

    return true;
  }, [inboxProps, options]);

  return { inboxProps, handleInboxCommand };
}
