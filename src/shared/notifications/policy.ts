/**
 * Notification Policy
 *
 * Shared logic for filtering notifications based on user config.
 * Used by both TUI and Web to determine which notifications to show.
 */

import type { InboxItem } from '../types.js';
import type { NotificationConfig, ToastNotification, InboxDiff } from './types.js';
import { DEFAULT_NOTIFICATION_CONFIG } from './types.js';
import {
  parseSessionName,
  getInboxIcon,
  getInboxTypeLabel,
} from '../components/Inbox.js';

/**
 * Check if a notification type is enabled in config
 */
export function isNotificationTypeEnabled(
  type: InboxItem['type'],
  config: NotificationConfig
): boolean {
  if (!config.enabled) return false;

  switch (type) {
    case 'exit':
      return config.types.exit;
    case 'idle':
      return config.types.idle;
    case 'bell':
      return config.types.bell;
    case 'title':
      return config.types.title;
    default:
      // OSC notifications come through as 'bell' type with context
      return config.types.osc;
  }
}

/**
 * Filter inbox items based on notification config
 */
export function filterByConfig(
  items: InboxItem[],
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG
): InboxItem[] {
  if (!config.enabled) return [];

  return items.filter((item) => isNotificationTypeEnabled(item.type, config));
}

/**
 * Compare two inbox states and return the diff
 */
export function diffInbox(
  previous: InboxItem[],
  current: InboxItem[]
): InboxDiff {
  const prevIds = new Set(previous.map((i) => i.id));
  const currIds = new Set(current.map((i) => i.id));
  const prevReadIds = new Set(previous.filter((i) => i.read).map((i) => i.id));

  const added = current.filter((i) => !prevIds.has(i.id));
  const removed = previous.filter((i) => !currIds.has(i.id));
  const read = current.filter(
    (i) => i.read && prevIds.has(i.id) && !prevReadIds.has(i.id)
  );

  return { added, removed, read };
}

/**
 * Convert an inbox item to a toast notification
 */
export function itemToToast(item: InboxItem): ToastNotification {
  const icon = getInboxIcon(item);
  const typeLabel = getInboxTypeLabel(item);

  // Build a concise title
  let title = typeLabel;
  if (item.processTitle) {
    title = `${typeLabel}: ${item.processTitle}`;
  }

  // Preview is the first line of context, truncated
  const preview = item.context.split('\n')[0]?.substring(0, 60) || '';

  return {
    id: item.id,
    sessionId: item.sessionId,
    sessionName: item.sessionName,
    icon,
    title,
    preview,
    timestamp: item.timestamp,
    item,
  };
}

/**
 * Get toast-eligible notifications from new inbox items
 *
 * Filters by config and returns ToastNotification objects
 * for items that should trigger a toast.
 */
export function getToastableItems(
  newItems: InboxItem[],
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG
): ToastNotification[] {
  if (!config.enabled || !config.toast.enabled) {
    return [];
  }

  return filterByConfig(newItems, config).map(itemToToast);
}

/**
 * Get the most recent unread item (for quick-jump)
 */
export function getMostRecentUnread(items: InboxItem[]): InboxItem | null {
  const unread = items.filter((i) => !i.read);
  if (unread.length === 0) return null;

  // Sort by timestamp descending
  unread.sort((a, b) => b.timestamp - a.timestamp);
  return unread[0];
}

/**
 * Session label for display (project / workspace / session)
 */
export function getSessionLabel(sessionName: string): string {
  const parts = parseSessionName(sessionName);
  return `${parts.project} / ${parts.workspace} / ${parts.session}`;
}
