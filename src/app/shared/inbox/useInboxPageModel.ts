import { useInbox, type InboxItem } from '../../../components/Inbox.js';

export interface UseInboxPageModelArgs {
  items: InboxItem[];
  unreadCount: number;
  onClearItem: (itemId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onMarkRead: (itemId: string) => Promise<void>;
  onAttachSession: (sessionId: string) => Promise<void>;
  onClose: () => void;
}

export function useInboxPageModel(args: UseInboxPageModelArgs) {
  return useInbox({
    items: args.items,
    unreadCount: args.unreadCount,
    onClearItem: args.onClearItem,
    onClearAll: args.onClearAll,
    onMarkRead: args.onMarkRead,
    onAttachSession: args.onAttachSession,
    onClose: args.onClose,
  });
}
