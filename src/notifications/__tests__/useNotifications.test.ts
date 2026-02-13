import { describe, expect, it, beforeEach, afterEach, mock, jest, beforeAll, afterAll } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useNotifications } from '../useNotifications';
import type { NotificationConfig, ToastNotification } from '../types';
import type { InboxItem } from '../../lib/remote-session/protocol';

// Setup happy-dom for React Testing Library
const window = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

// @ts-expect-error - assigning Window to globalThis
globalThis.window = window;
// @ts-expect-error - assigning Document to globalThis
globalThis.document = window.document;

// ============================================================================
// Test Fixtures
// ============================================================================

let idCounter = 0;

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  idCounter++;
  return {
    id: `test-id-${idCounter}`,
    sessionId: 'session-1',
    sessionName: 'my-project:my-workspace:default',
    type: 'exit',
    timestamp: Date.now(),
    read: false,
    context: 'Command completed',
    processTitle: 'npm test',
    exitCode: 0,
    ...overrides,
  };
}

function createConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    enabled: true,
    minCommandDurationMs: 10000,
    types: {
      exit: true,
      idle: true,
      bell: true,
      title: true,
      osc: true,
    },
    toast: {
      enabled: true,
      holdWhenIdleMs: 15000,
    },
    ...overrides,
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

describe('useNotifications', () => {
  beforeEach(() => {
    idCounter = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // Toast showing when user is active
  // ==========================================================================

  describe('toast showing when user is active', () => {
    it('should show toast immediately when user is active', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem();

      const { rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      // Add a new item
      rerender({ items: [item] });

      expect(onShowToast).toHaveBeenCalledTimes(1);
      expect(onShowToast.mock.calls[0][0]).toMatchObject({
        id: item.id,
        sessionId: item.sessionId,
      });
    });

    it('should increment toastCount when toast is shown', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item1 = createInboxItem();
      const item2 = createInboxItem({ sessionId: 'session-2' });

      const { result, rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      expect(result.current.toastCount).toBe(0);

      rerender({ items: [item1] });
      expect(result.current.toastCount).toBe(1);

      rerender({ items: [item1, item2] });
      expect(result.current.toastCount).toBe(2);
    });

    it('should set activeToast when toast is shown', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem();

      const { result, rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      expect(result.current.activeToast).toBeNull();

      rerender({ items: [item] });
      expect(result.current.activeToast).not.toBeNull();
      expect(result.current.activeToast?.id).toBe(item.id);
    });
  });

  // ==========================================================================
  // Toast holding when user is inactive
  // ==========================================================================

  describe('toast holding when user is inactive', () => {
    it('should hold toast when user is inactive and holdWhenIdleMs > 0', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item = createInboxItem();

      const { result, rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      // Add a new item while user is inactive
      rerender({ items: [item], isUserActive: false });

      // Should NOT show toast
      expect(onShowToast).not.toHaveBeenCalled();
      // Should hold the toast
      expect(result.current.heldCount).toBe(1);
    });

    it('should show toast immediately when holdWhenIdleMs is 0', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 0 } });
      const item = createInboxItem();

      const { rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      rerender({ items: [item], isUserActive: false });

      // Should show toast even though user is inactive (holdWhenIdleMs = 0)
      expect(onShowToast).toHaveBeenCalledTimes(1);
    });

    it('should keep only latest toast per session when holding', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item1 = createInboxItem({ sessionId: 'session-1' });
      const item2 = createInboxItem({ sessionId: 'session-1', timestamp: Date.now() + 1000 });

      const { result, rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      rerender({ items: [item1], isUserActive: false });
      expect(result.current.heldCount).toBe(1);

      rerender({ items: [item1, item2], isUserActive: false });
      // Still 1 because it's the same session (latest replaces previous)
      expect(result.current.heldCount).toBe(1);
    });
  });

  // ==========================================================================
  // Flush held toasts when user becomes active
  // ==========================================================================

  describe('flush held toasts when user becomes active', () => {
    it('should flush held toasts when user becomes active', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item = createInboxItem();

      const { result, rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      // Add item while inactive
      rerender({ items: [item], isUserActive: false });
      expect(onShowToast).not.toHaveBeenCalled();
      expect(result.current.heldCount).toBe(1);

      // User becomes active
      rerender({ items: [item], isUserActive: true });
      expect(onShowToast).toHaveBeenCalledTimes(1);
      expect(result.current.heldCount).toBe(0);
    });

    it('should flush multiple held toasts in chronological order', () => {
      const shownToasts: ToastNotification[] = [];
      const onShowToast = mock<(toast: ToastNotification) => void>((toast) => {
        shownToasts.push(toast);
      });
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });

      const baseTime = Date.now();
      const item1 = createInboxItem({ sessionId: 'session-1', timestamp: baseTime + 2000 });
      const item2 = createInboxItem({ sessionId: 'session-2', timestamp: baseTime + 1000 });

      const { rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      // Add items while inactive
      rerender({ items: [item1], isUserActive: false });
      rerender({ items: [item1, item2], isUserActive: false });

      // User becomes active
      rerender({ items: [item1, item2], isUserActive: true });

      // Should show both, item2 first (earlier timestamp)
      expect(shownToasts.length).toBe(2);
      expect(shownToasts[0].sessionId).toBe('session-2');
      expect(shownToasts[1].sessionId).toBe('session-1');
    });
  });

  // ==========================================================================
  // Auto-dismiss for current session
  // ==========================================================================

  describe('auto-dismiss for current session', () => {
    it('should auto-dismiss notifications for current session when user is active', async () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onMarkRead = mock<(itemId: string) => Promise<void>>(() => Promise.resolve());
      const config = createConfig();
      const item = createInboxItem({ sessionId: 'current-session' });

      const { rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          onMarkRead,
          isUserActive: true,
          currentSessionId: 'current-session',
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });

      // Should NOT show toast (user is watching this session)
      expect(onShowToast).not.toHaveBeenCalled();
      // Should auto-dismiss (mark as read)
      expect(onMarkRead).toHaveBeenCalledWith(item.id);
    });

    it('should hold notification for current session when user is inactive', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onMarkRead = mock<(itemId: string) => Promise<void>>(() => Promise.resolve());
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item = createInboxItem({ sessionId: 'current-session' });

      const { result, rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          onMarkRead,
          isUserActive,
          currentSessionId: 'current-session',
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      rerender({ items: [item], isUserActive: false });

      // Should hold, not show or dismiss
      expect(onShowToast).not.toHaveBeenCalled();
      expect(onMarkRead).not.toHaveBeenCalled();
      expect(result.current.heldCount).toBe(1);
    });

    it('should auto-dismiss held toast for current session when user becomes active', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onMarkRead = mock<(itemId: string) => Promise<void>>(() => Promise.resolve());
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item = createInboxItem({ sessionId: 'current-session' });

      const { result, rerender } = renderHook(
        ({ items, isUserActive }) => useNotifications({
          items,
          config,
          onShowToast,
          onMarkRead,
          isUserActive,
          currentSessionId: 'current-session',
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false } }
      );

      // Add item while inactive
      rerender({ items: [item], isUserActive: false });
      expect(result.current.heldCount).toBe(1);

      // User becomes active
      rerender({ items: [item], isUserActive: true });

      // Should NOT show (it's for current session)
      expect(onShowToast).not.toHaveBeenCalled();
      // Should auto-dismiss
      expect(onMarkRead).toHaveBeenCalledWith(item.id);
      expect(result.current.heldCount).toBe(0);
    });
  });

  // ==========================================================================
  // Held toast cleanup on session detach
  // ==========================================================================

  describe('held toast cleanup on session detach', () => {
    it('should auto-dismiss held toasts for detached session', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onMarkRead = mock<(itemId: string) => Promise<void>>(() => Promise.resolve());
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item = createInboxItem({ sessionId: 'session-1' });

      const { result, rerender } = renderHook(
        ({ items, isUserActive, currentSessionId }: { items: InboxItem[]; isUserActive: boolean; currentSessionId: string | undefined }) => useNotifications({
          items,
          config,
          onShowToast,
          onMarkRead,
          isUserActive,
          currentSessionId,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false, currentSessionId: 'session-1' as string | undefined } }
      );

      // Add item while inactive and attached to session-1
      rerender({ items: [item], isUserActive: false, currentSessionId: 'session-1' });
      expect(result.current.heldCount).toBe(1);

      // Detach from session-1 (switch to different session or undefined)
      rerender({ items: [item], isUserActive: false, currentSessionId: undefined });

      // Should auto-dismiss the held toast for detached session
      expect(onMarkRead).toHaveBeenCalledWith(item.id);
      expect(result.current.heldCount).toBe(0);
    });

    it('should keep held toasts for other sessions on detach', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onMarkRead = mock<(itemId: string) => Promise<void>>(() => Promise.resolve());
      const config = createConfig({ toast: { enabled: true, holdWhenIdleMs: 15000 } });
      const item1 = createInboxItem({ sessionId: 'session-1' });
      const item2 = createInboxItem({ sessionId: 'session-2' });

      const { result, rerender } = renderHook(
        ({ items, isUserActive, currentSessionId }: { items: InboxItem[]; isUserActive: boolean; currentSessionId: string | undefined }) => useNotifications({
          items,
          config,
          onShowToast,
          onMarkRead,
          isUserActive,
          currentSessionId,
        }),
        { initialProps: { items: [] as InboxItem[], isUserActive: false, currentSessionId: 'session-1' as string | undefined } }
      );

      // Add items while inactive
      rerender({ items: [item1], isUserActive: false, currentSessionId: 'session-1' });
      rerender({ items: [item1, item2], isUserActive: false, currentSessionId: 'session-1' });
      expect(result.current.heldCount).toBe(2);

      // Detach from session-1
      rerender({ items: [item1, item2], isUserActive: false, currentSessionId: undefined });

      // Should only dismiss session-1's toast
      expect(onMarkRead).toHaveBeenCalledTimes(1);
      expect(onMarkRead).toHaveBeenCalledWith(item1.id);
      expect(result.current.heldCount).toBe(1);
    });
  });

  // ==========================================================================
  // Timer cleanup on unmount
  // ==========================================================================

  describe('timer cleanup on unmount', () => {
    it('should clear active toast after timeout', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem();

      const { result, rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });
      expect(result.current.activeToast).not.toBeNull();

      // Advance time by 10 seconds (TOAST_ACTIVE_DURATION_MS)
      act(() => {
        jest.advanceTimersByTime(10000);
      });

      expect(result.current.activeToast).toBeNull();
    });

    it('should clear timeout on unmount', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem();

      const { rerender, unmount } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });

      // Unmount before timeout fires
      unmount();

      // This should not throw - timeout should be cleared
      act(() => {
        jest.advanceTimersByTime(10000);
      });
    });
  });

  // ==========================================================================
  // Polling behavior
  // ==========================================================================

  describe('polling behavior', () => {
    it('should call onRefreshInbox at specified interval', () => {
      const onRefreshInbox = mock<() => Promise<void>>(() => Promise.resolve());
      const config = createConfig();

      renderHook(() => useNotifications({
        items: [],
        config,
        pollIntervalMs: 5000,
        onRefreshInbox,
        isUserActive: true,
      }));

      expect(onRefreshInbox).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(onRefreshInbox).toHaveBeenCalledTimes(1);

      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(onRefreshInbox).toHaveBeenCalledTimes(2);
    });

    it('should not poll when pollIntervalMs is 0', () => {
      const onRefreshInbox = mock<() => Promise<void>>(() => Promise.resolve());
      const config = createConfig();

      renderHook(() => useNotifications({
        items: [],
        config,
        pollIntervalMs: 0,
        onRefreshInbox,
        isUserActive: true,
      }));

      act(() => {
        jest.advanceTimersByTime(10000);
      });

      expect(onRefreshInbox).not.toHaveBeenCalled();
    });

    it('should clear polling interval on unmount', () => {
      const onRefreshInbox = mock<() => Promise<void>>(() => Promise.resolve());
      const config = createConfig();

      const { unmount } = renderHook(() => useNotifications({
        items: [],
        config,
        pollIntervalMs: 5000,
        onRefreshInbox,
        isUserActive: true,
      }));

      unmount();

      act(() => {
        jest.advanceTimersByTime(10000);
      });

      // Should not have been called after unmount
      expect(onRefreshInbox).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // clearActiveToast and attachToActiveToast
  // ==========================================================================

  describe('clearActiveToast', () => {
    it('should clear active toast and cancel timeout', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem();

      const { result, rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });
      expect(result.current.activeToast).not.toBeNull();

      act(() => {
        result.current.clearActiveToast();
      });

      expect(result.current.activeToast).toBeNull();
    });
  });

  describe('attachToActiveToast', () => {
    it('should call onAttachSession with session ID and clear toast', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const onAttachSession = mock<(sessionId: string) => void>(() => {});
      const config = createConfig();
      const item = createInboxItem({ sessionId: 'session-to-attach' });

      const { result, rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          onAttachSession,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });
      expect(result.current.activeToast).not.toBeNull();

      act(() => {
        result.current.attachToActiveToast();
      });

      expect(onAttachSession).toHaveBeenCalledWith('session-to-attach');
      expect(result.current.activeToast).toBeNull();
    });

    it('should do nothing if no active toast', () => {
      const onAttachSession = mock<(sessionId: string) => void>(() => {});
      const config = createConfig();

      const { result } = renderHook(() => useNotifications({
        items: [],
        config,
        onAttachSession,
        isUserActive: true,
      }));

      act(() => {
        result.current.attachToActiveToast();
      });

      expect(onAttachSession).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // mostRecentUnread
  // ==========================================================================

  describe('mostRecentUnread', () => {
    it('should return most recent unread item', () => {
      const config = createConfig();
      const item1 = createInboxItem({ timestamp: 1000, read: false });
      const item2 = createInboxItem({ timestamp: 2000, read: false });
      const item3 = createInboxItem({ timestamp: 3000, read: true });

      const { result } = renderHook(() => useNotifications({
        items: [item1, item2, item3],
        config,
        isUserActive: true,
      }));

      expect(result.current.mostRecentUnread?.id).toBe(item2.id);
    });

    it('should return null if no unread items', () => {
      const config = createConfig();
      const item = createInboxItem({ read: true });

      const { result } = renderHook(() => useNotifications({
        items: [item],
        config,
        isUserActive: true,
      }));

      expect(result.current.mostRecentUnread).toBeNull();
    });
  });

  // ==========================================================================
  // Config disabled states
  // ==========================================================================

  describe('config disabled states', () => {
    it('should not show toasts when notifications disabled', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ enabled: false });
      const item = createInboxItem();

      const { rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });

      expect(onShowToast).not.toHaveBeenCalled();
    });

    it('should not show toasts when toast.enabled is false', () => {
      const onShowToast = mock<(toast: ToastNotification) => void>(() => {});
      const config = createConfig({ toast: { enabled: false, holdWhenIdleMs: 15000 } });
      const item = createInboxItem();

      const { rerender } = renderHook(
        ({ items }) => useNotifications({
          items,
          config,
          onShowToast,
          isUserActive: true,
        }),
        { initialProps: { items: [] as InboxItem[] } }
      );

      rerender({ items: [item] });

      expect(onShowToast).not.toHaveBeenCalled();
    });
  });
});
