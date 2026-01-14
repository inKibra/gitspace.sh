/**
 * useNotifications Hook
 *
 * Shared hook for managing notification toasts and quick-attach.
 * Works with both TUI and Web by accepting platform-specific callbacks.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { InboxItem } from '../types.js';
import type { NotificationConfig, ToastNotification } from './types.js';
import { DEFAULT_NOTIFICATION_CONFIG } from './types.js';
import { diffInbox, getToastableItems, getMostRecentUnread } from './policy.js';

/**
 * Options for useNotifications hook
 */
export interface UseNotificationsOptions {
  /** Current inbox items */
  items: InboxItem[];
  /** Notification config */
  config?: NotificationConfig;
  /** Callback when a toast should be shown */
  onShowToast?: (notification: ToastNotification) => void;
  /** Callback to attach to a session */
  onAttachSession?: (sessionId: string) => void;
  /** Polling interval in ms (0 to disable) */
  pollIntervalMs?: number;
  /** Callback to refresh inbox */
  onRefreshInbox?: () => Promise<void>;
}

/**
 * Return type for useNotifications hook
 */
export interface UseNotificationsReturn {
  /** Currently visible toast (for hotkey handling) */
  activeToast: ToastNotification | null;
  /** Clear the active toast */
  clearActiveToast: () => void;
  /** Attach to the active toast's session (for hotkey) */
  attachToActiveToast: () => void;
  /** Get most recent unread item */
  mostRecentUnread: InboxItem | null;
  /** Number of toasts shown since mount */
  toastCount: number;
}

/**
 * Hook for managing notification toasts
 *
 * Tracks inbox changes and triggers toast callbacks for new items.
 * Maintains an "active toast" reference for quick-attach via hotkey.
 *
 * @example
 * ```tsx
 * const notifications = useNotifications({
 *   items: inbox,
 *   config: notificationConfig,
 *   onShowToast: (toast) => {
 *     // Show platform-specific toast
 *     sonner.info(toast.title, { description: toast.preview });
 *   },
 *   onAttachSession: (sessionId) => {
 *     terminal.attachSession({ sessionId });
 *   },
 * });
 *
 * // Handle Shift+Tab to attach to active toast
 * if (event.shiftKey && event.key === 'Tab' && notifications.activeToast) {
 *   notifications.attachToActiveToast();
 * }
 * ```
 */
export function useNotifications(
  options: UseNotificationsOptions
): UseNotificationsReturn {
  const {
    items,
    config = DEFAULT_NOTIFICATION_CONFIG,
    onShowToast,
    onAttachSession,
    pollIntervalMs = 0,
    onRefreshInbox,
  } = options;

  // Track previous inbox items for diffing
  const prevItemsRef = useRef<InboxItem[]>([]);

  // Active toast (most recent, for hotkey attach)
  const [activeToast, setActiveToast] = useState<ToastNotification | null>(null);

  // Toast count for debugging/stats
  const [toastCount, setToastCount] = useState(0);

  // Timer ref for clearing active toast
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear active toast after a delay (e.g., 10 seconds)
  const TOAST_ACTIVE_DURATION_MS = 10000;

  const clearActiveToast = useCallback(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setActiveToast(null);
  }, []);

  const attachToActiveToast = useCallback(() => {
    if (activeToast && onAttachSession) {
      onAttachSession(activeToast.sessionId);
      clearActiveToast();
    }
  }, [activeToast, onAttachSession, clearActiveToast]);

  // Detect new items and trigger toasts
  useEffect(() => {
    if (!config.enabled || !config.toast.enabled) {
      prevItemsRef.current = items;
      return;
    }

    const diff = diffInbox(prevItemsRef.current, items);
    prevItemsRef.current = items;

    if (diff.added.length === 0) return;

    const toastable = getToastableItems(diff.added, config);
    if (toastable.length === 0) return;

    // Show toasts for new items
    for (const toast of toastable) {
      onShowToast?.(toast);
      setToastCount((c) => c + 1);
    }

    // Set the most recent as active toast
    const mostRecent = toastable[toastable.length - 1];
    setActiveToast(mostRecent);

    // Clear active toast after timeout
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      setActiveToast(null);
    }, TOAST_ACTIVE_DURATION_MS);
  }, [items, config, onShowToast]);

  // Polling for inbox refresh
  useEffect(() => {
    if (pollIntervalMs <= 0 || !onRefreshInbox) return;

    const interval = setInterval(() => {
      onRefreshInbox();
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [pollIntervalMs, onRefreshInbox]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const mostRecentUnread = getMostRecentUnread(items);

  return {
    activeToast,
    clearActiveToast,
    attachToActiveToast,
    mostRecentUnread,
    toastCount,
  };
}
