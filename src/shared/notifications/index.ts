/**
 * Shared notifications module
 *
 * Provides types, policy logic, and hooks for notification handling
 * across TUI and Web platforms.
 */

// Types
export type {
  NotificationConfig,
  ToastNotification,
  InboxDiff,
} from './types.js';
export { DEFAULT_NOTIFICATION_CONFIG } from './types.js';

// Policy functions
export {
  isNotificationTypeEnabled,
  filterByConfig,
  diffInbox,
  itemToToast,
  getToastableItems,
  getMostRecentUnread,
  getSessionLabel,
} from './policy.js';

// Hook
export type {
  UseNotificationsOptions,
  UseNotificationsReturn,
} from './useNotifications.js';
export { useNotifications } from './useNotifications.js';
