/**
 * useNotifications Hook
 *
 * Shared hook for managing notification toasts and quick-attach.
 * Works with both TUI and Web by accepting platform-specific callbacks.
 *
 * Features:
 * - Show toasts for new inbox items
 * - Hold toasts when user is inactive (latest per session)
 * - Auto-dismiss notifications for the current active session
 * - Flush held toasts when user becomes active
 * - Auto-dismiss held toasts on session detach
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { InboxItem } from '../lib/remote-session/protocol.js';
import type { NotificationConfig, ToastNotification } from './types.js';
import { DEFAULT_NOTIFICATION_CONFIG } from './types.js';
import { diffInbox, getToastableItems, getMostRecentUnread } from './policy.js';

/**
 * Get the "skeleton" of a title by keeping only letters and spaces.
 * Used to detect when title changes are just counter/progress/animation updates.
 *
 * Examples:
 *   "htop - 12:00:01" → "htop"
 *   "CPU: 45%" → "cpu"
 *   "Building... 3/10" → "building"
 *   "⠋ Loading..." → "loading"
 */
function getTitleSkeleton(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')  // Keep only letters and spaces
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .trim();
}

/**
 * Check if two titles are semantically different (not just counter updates).
 */
function isTitleSignificantlyDifferent(prev: string, curr: string): boolean {
  if (!prev || !curr) return true;
  return getTitleSkeleton(prev) !== getTitleSkeleton(curr);
}

// Per-session debounce interval (ms)
const TOAST_DEBOUNCE_MS = 15000;

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
  /** Callback to mark an inbox item as read (for auto-dismiss) */
  onMarkRead?: (itemId: string) => Promise<void>;
  /** Polling interval in ms (0 to disable) */
  pollIntervalMs?: number;
  /** Callback to refresh inbox */
  onRefreshInbox?: () => Promise<void>;
  /** Whether user is currently active (for holding toasts). Default: true */
  isUserActive?: boolean;
  /** Session ID user is currently attached to (skip/auto-dismiss toasts for this session) */
  currentSessionId?: string;
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
  /** Number of toasts currently held (waiting for activity) */
  heldCount: number;
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
 *     sonner.info(toast.title, { description: toast.preview });
 *   },
 *   onAttachSession: (sessionId) => {
 *     terminal.attachSession({ sessionId });
 *   },
 *   onMarkRead: async (itemId) => {
 *     await markInboxRead(itemId);
 *   },
 *   isUserActive,
 *   currentSessionId: attachedSession?.id,
 * });
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
    onMarkRead,
    pollIntervalMs = 0,
    onRefreshInbox,
    isUserActive = true,
    currentSessionId,
  } = options;

  // Track previous inbox items for diffing
  const prevItemsRef = useRef<InboxItem[]>([]);

  // Track previous session ID to detect detach
  const prevSessionIdRef = useRef<string | undefined>(undefined);

  // Track previous isUserActive to detect activity resumption
  const prevIsUserActiveRef = useRef<boolean>(true);

  // Active toast (most recent, for hotkey attach)
  const [activeToast, setActiveToast] = useState<ToastNotification | null>(null);

  // Toast count for debugging/stats
  const [toastCount, setToastCount] = useState(0);

  // Held toasts (sessionId -> latest toast) - waiting for user to become active
  const heldToastsRef = useRef<Map<string, ToastNotification>>(new Map());
  const [heldCount, setHeldCount] = useState(0);

  // Timer ref for clearing active toast
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-session debounce tracking (sessionId -> last toast timestamp)
  const lastToastTimeRef = useRef<Map<string, number>>(new Map());

  // Last seen title per session (for filtering minor title changes)
  const lastTitleRef = useRef<Map<string, string>>(new Map());

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

  // Helper to show a toast and update state
  const showToast = useCallback((toast: ToastNotification) => {
    onShowToast?.(toast);
    setToastCount((c) => c + 1);
    setActiveToast(toast);

    // Clear active toast after timeout
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      setActiveToast(null);
    }, TOAST_ACTIVE_DURATION_MS);
  }, [onShowToast]);

  // Helper to auto-dismiss a notification
  const autoDismiss = useCallback(async (itemId: string) => {
    if (onMarkRead) {
      try {
        await onMarkRead(itemId);
      } catch {
        // Ignore errors - notification is best-effort
      }
    }
  }, [onMarkRead]);

  // Detect session detach and auto-dismiss held toasts for that session
  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = currentSessionId;

    // If we just detached from a session (had a session, now don't or different)
    if (prevSessionId && prevSessionId !== currentSessionId) {
      // Auto-dismiss any held toasts for the detached session
      const heldForSession = heldToastsRef.current.get(prevSessionId);
      if (heldForSession) {
        autoDismiss(heldForSession.id);
        heldToastsRef.current.delete(prevSessionId);
        setHeldCount(heldToastsRef.current.size);
      }
    }
  }, [currentSessionId, autoDismiss]);

  // Detect activity resumption and flush held toasts
  useEffect(() => {
    const wasActive = prevIsUserActiveRef.current;
    prevIsUserActiveRef.current = isUserActive;

    // If user just became active (was inactive, now active)
    if (!wasActive && isUserActive && heldToastsRef.current.size > 0) {
      // Get held toasts, excluding current session
      const toastsToShow = Array.from(heldToastsRef.current.entries())
        .filter(([sessionId]) => sessionId !== currentSessionId)
        .map(([, toast]) => toast)
        .sort((a, b) => a.timestamp - b.timestamp);

      // Auto-dismiss held toasts for current session (if any)
      if (currentSessionId) {
        const currentSessionToast = heldToastsRef.current.get(currentSessionId);
        if (currentSessionToast) {
          autoDismiss(currentSessionToast.id);
        }
      }

      // Clear held toasts
      heldToastsRef.current.clear();
      setHeldCount(0);

      // Show the flushed toasts (update debounce tracking)
      const now = Date.now();
      for (const toast of toastsToShow) {
        lastToastTimeRef.current.set(toast.sessionId, now);
        showToast(toast);
      }
    }
  }, [isUserActive, currentSessionId, showToast, autoDismiss]);

  // Detect new items and handle them based on activity state
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

    const holdWhenIdleMs = config.toast.holdWhenIdleMs || 0;
    const shouldHold = holdWhenIdleMs > 0 && !isUserActive;

    for (const toast of toastable) {
      const now = Date.now();

      // Per-session debounce: skip if we showed a toast for this session within 15s
      const lastTime = lastToastTimeRef.current.get(toast.sessionId) || 0;
      if (now - lastTime < TOAST_DEBOUNCE_MS) {
        continue;
      }

      // For title notifications, check if significantly different from last seen
      if (toast.item.type === 'title') {
        const lastTitle = lastTitleRef.current.get(toast.sessionId) || '';
        const newTitle = toast.item.context || '';
        if (!isTitleSignificantlyDifferent(lastTitle, newTitle)) {
          // Update last title but don't show toast
          lastTitleRef.current.set(toast.sessionId, newTitle);
          continue;
        }
        lastTitleRef.current.set(toast.sessionId, newTitle);
      }

      // Case 1: Notification is for the session user is actively watching
      if (currentSessionId && toast.sessionId === currentSessionId) {
        if (isUserActive) {
          // User is actively watching this session - auto-dismiss
          autoDismiss(toast.id);
        } else {
          // User is attached but inactive - hold it
          heldToastsRef.current.set(toast.sessionId, toast);
          setHeldCount(heldToastsRef.current.size);
        }
        continue;
      }

      // Case 2: Notification is for a different session
      if (shouldHold) {
        // User is inactive - hold toast (latest per session)
        heldToastsRef.current.set(toast.sessionId, toast);
        setHeldCount(heldToastsRef.current.size);
      } else {
        // User is active - show toast immediately
        lastToastTimeRef.current.set(toast.sessionId, now);
        showToast(toast);
      }
    }
  }, [items, config, isUserActive, currentSessionId, showToast, autoDismiss]);

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
    heldCount,
  };
}
