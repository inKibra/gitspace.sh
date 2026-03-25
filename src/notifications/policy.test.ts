import { describe, expect, it } from 'bun:test';
import {
  isNotificationTypeEnabled,
  filterByConfig,
  diffInbox,
  itemToToast,
  getToastableItems,
  getMostRecentUnread,
  getSessionLabel,
} from './policy';
import type { NotificationConfig } from './types';
import type { InboxItem } from '../lib/remote-session/protocol';

// ============================================================================
// Test Fixtures
// ============================================================================

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'test-id-1',
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
// isNotificationTypeEnabled
// ============================================================================

describe('isNotificationTypeEnabled', () => {
  it('should return false when notifications are disabled globally', () => {
    const config = createConfig({ enabled: false });
    expect(isNotificationTypeEnabled('exit', config)).toBe(false);
    expect(isNotificationTypeEnabled('bell', config)).toBe(false);
  });

  it('should return true for enabled notification types', () => {
    const config = createConfig();
    expect(isNotificationTypeEnabled('exit', config)).toBe(true);
    expect(isNotificationTypeEnabled('idle', config)).toBe(true);
    expect(isNotificationTypeEnabled('bell', config)).toBe(true);
    expect(isNotificationTypeEnabled('title', config)).toBe(true);
    expect(isNotificationTypeEnabled('osc', config)).toBe(true);
  });

  it('should return false for disabled notification types', () => {
    const config = createConfig({
      types: { exit: false, idle: false, bell: true, title: true, osc: false },
    });
    expect(isNotificationTypeEnabled('exit', config)).toBe(false);
    expect(isNotificationTypeEnabled('idle', config)).toBe(false);
    expect(isNotificationTypeEnabled('osc', config)).toBe(false);
    expect(isNotificationTypeEnabled('bell', config)).toBe(true);
  });

  it('should handle unknown types by checking osc setting', () => {
    const configOscOn = createConfig({ types: { exit: true, idle: true, bell: true, title: true, osc: true } });
    const configOscOff = createConfig({ types: { exit: true, idle: true, bell: true, title: true, osc: false } });

    // Unknown types fall through to osc check
    expect(isNotificationTypeEnabled('unknown' as any, configOscOn)).toBe(true);
    expect(isNotificationTypeEnabled('unknown' as any, configOscOff)).toBe(false);
  });
});

// ============================================================================
// filterByConfig
// ============================================================================

describe('filterByConfig', () => {
  it('should return empty array when notifications disabled', () => {
    const items = [createInboxItem({ type: 'exit' }), createInboxItem({ type: 'bell' })];
    const config = createConfig({ enabled: false });

    expect(filterByConfig(items, config)).toEqual([]);
  });

  it('should filter out disabled notification types', () => {
    const exitItem = createInboxItem({ id: '1', type: 'exit' });
    const bellItem = createInboxItem({ id: '2', type: 'bell' });
    const idleItem = createInboxItem({ id: '3', type: 'idle' });

    const items = [exitItem, bellItem, idleItem];
    const config = createConfig({
      types: { exit: true, idle: false, bell: true, title: true, osc: true },
    });

    const result = filterByConfig(items, config);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('should return all items when all types enabled', () => {
    const items = [
      createInboxItem({ id: '1', type: 'exit' }),
      createInboxItem({ id: '2', type: 'bell' }),
      createInboxItem({ id: '3', type: 'idle' }),
      createInboxItem({ id: '4', type: 'title' }),
    ];
    const config = createConfig();

    expect(filterByConfig(items, config)).toHaveLength(4);
  });

  it('should use default config when not provided', () => {
    const items = [createInboxItem({ type: 'exit' })];
    // Default config has all types enabled
    expect(filterByConfig(items)).toHaveLength(1);
  });
});

// ============================================================================
// diffInbox
// ============================================================================

describe('diffInbox', () => {
  it('should detect newly added items', () => {
    const previous: InboxItem[] = [];
    const current = [createInboxItem({ id: 'new-1' }), createInboxItem({ id: 'new-2' })];

    const diff = diffInbox(previous, current);

    expect(diff.added).toHaveLength(2);
    expect(diff.added.map((i) => i.id)).toEqual(['new-1', 'new-2']);
    expect(diff.removed).toHaveLength(0);
    expect(diff.read).toHaveLength(0);
  });

  it('should detect removed items', () => {
    const previous = [createInboxItem({ id: 'old-1' }), createInboxItem({ id: 'old-2' })];
    const current = [createInboxItem({ id: 'old-1' })];

    const diff = diffInbox(previous, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].id).toBe('old-2');
  });

  it('should detect items marked as read', () => {
    const previous = [
      createInboxItem({ id: 'item-1', read: false }),
      createInboxItem({ id: 'item-2', read: false }),
    ];
    const current = [
      createInboxItem({ id: 'item-1', read: true }),
      createInboxItem({ id: 'item-2', read: false }),
    ];

    const diff = diffInbox(previous, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.read).toHaveLength(1);
    expect(diff.read[0].id).toBe('item-1');
  });

  it('should handle mixed changes', () => {
    const previous = [
      createInboxItem({ id: 'kept', read: false }),
      createInboxItem({ id: 'removed', read: false }),
      createInboxItem({ id: 'marked-read', read: false }),
    ];
    const current = [
      createInboxItem({ id: 'kept', read: false }),
      createInboxItem({ id: 'marked-read', read: true }),
      createInboxItem({ id: 'added', read: false }),
    ];

    const diff = diffInbox(previous, current);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe('added');
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].id).toBe('removed');
    expect(diff.read).toHaveLength(1);
    expect(diff.read[0].id).toBe('marked-read');
  });

  it('should not include previously read items in read list', () => {
    const previous = [createInboxItem({ id: 'already-read', read: true })];
    const current = [createInboxItem({ id: 'already-read', read: true })];

    const diff = diffInbox(previous, current);
    expect(diff.read).toHaveLength(0);
  });
});

// ============================================================================
// itemToToast
// ============================================================================

describe('itemToToast', () => {
  it('should convert exit item with zero exit code', () => {
    const item = createInboxItem({
      id: 'exit-0',
      type: 'exit',
      exitCode: 0,
      processTitle: 'npm test',
      context: 'Tests passed\nAll 42 tests passed',
    });

    const toast = itemToToast(item);

    expect(toast.id).toBe('exit-0');
    expect(toast.sessionId).toBe('session-1');
    expect(toast.sessionName).toBe('my-project:my-workspace:default');
    expect(toast.icon).toBe('✅');
    expect(toast.title).toBe('my-project / my-workspace / default: Completed - npm test');
    expect(toast.preview).toBe('Tests passed\nAll 42 tests passed');
    expect(toast.item).toBe(item);
  });

  it('should convert exit item with non-zero exit code', () => {
    const item = createInboxItem({
      type: 'exit',
      exitCode: 1,
      processTitle: 'npm build',
      context: 'Build failed',
    });

    const toast = itemToToast(item);

    expect(toast.icon).toBe('❌');
    expect(toast.title).toBe('my-project / my-workspace / default: Exit code 1 - npm build');
  });

  it('should convert bell item', () => {
    const item = createInboxItem({
      type: 'bell',
      processTitle: undefined,
      context: 'Alert notification',
    });

    const toast = itemToToast(item);

    expect(toast.icon).toBe('🔔');
    expect(toast.title).toBe('my-project / my-workspace / default: Bell');
  });

  it('should convert idle item', () => {
    const item = createInboxItem({
      type: 'idle',
      processTitle: 'vim',
      context: 'No activity for 5 minutes',
    });

    const toast = itemToToast(item);

    expect(toast.icon).toBe('⏸️');
    expect(toast.title).toBe('my-project / my-workspace / default: Activity Complete - vim');
  });

  it('should convert title item', () => {
    const item = createInboxItem({
      type: 'title',
      processTitle: 'bash',
      context: 'Title changed to: ~/projects',
    });

    const toast = itemToToast(item);

    expect(toast.icon).toBe('📝');
    expect(toast.title).toBe('my-project / my-workspace / default: Title Change - bash');
  });

  it('should convert osc item', () => {
    const item = createInboxItem({
      type: 'osc',
      processTitle: 'app',
      context: 'Custom notification',
    });

    const toast = itemToToast(item);

    expect(toast.icon).toBe('📟');
    expect(toast.title).toBe('my-project / my-workspace / default: OSC Notification - app');
  });

  it('should truncate long preview text', () => {
    const longContext = 'A'.repeat(100) + '\nSecond line';
    const item = createInboxItem({ context: longContext });

    const toast = itemToToast(item);

    expect(toast.preview).toBe(`${'A'.repeat(100)}\nSecond line`);
  });
});

// ============================================================================
// getToastableItems
// ============================================================================

describe('getToastableItems', () => {
  it('should return empty array when notifications disabled', () => {
    const items = [createInboxItem()];
    const config = createConfig({ enabled: false });

    expect(getToastableItems(items, config)).toEqual([]);
  });

  it('should return empty array when toasts disabled', () => {
    const items = [createInboxItem()];
    const config = createConfig({ toast: { enabled: false, holdWhenIdleMs: 15000 } });

    expect(getToastableItems(items, config)).toEqual([]);
  });

  it('should filter and convert items to toasts', () => {
    const items = [
      createInboxItem({ id: '1', type: 'exit' }),
      createInboxItem({ id: '2', type: 'bell' }),
    ];
    const config = createConfig({
      types: { exit: true, idle: true, bell: false, title: true, osc: true },
    });

    const toasts = getToastableItems(items, config);

    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe('1');
  });

  it('should use default config when not provided', () => {
    const items = [createInboxItem({ id: '1' })];

    const toasts = getToastableItems(items);

    expect(toasts).toHaveLength(1);
  });
});

// ============================================================================
// getMostRecentUnread
// ============================================================================

describe('getMostRecentUnread', () => {
  it('should return null for empty array', () => {
    expect(getMostRecentUnread([])).toBeNull();
  });

  it('should return null when all items are read', () => {
    const items = [
      createInboxItem({ id: '1', read: true }),
      createInboxItem({ id: '2', read: true }),
    ];

    expect(getMostRecentUnread(items)).toBeNull();
  });

  it('should return the most recent unread item', () => {
    const now = Date.now();
    const items = [
      createInboxItem({ id: 'old', read: false, timestamp: now - 2000 }),
      createInboxItem({ id: 'newest', read: false, timestamp: now }),
      createInboxItem({ id: 'middle', read: false, timestamp: now - 1000 }),
    ];

    const result = getMostRecentUnread(items);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('newest');
  });

  it('should skip read items even if more recent', () => {
    const now = Date.now();
    const items = [
      createInboxItem({ id: 'read-newest', read: true, timestamp: now }),
      createInboxItem({ id: 'unread-older', read: false, timestamp: now - 1000 }),
    ];

    const result = getMostRecentUnread(items);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('unread-older');
  });
});

// ============================================================================
// getSessionLabel
// ============================================================================

describe('getSessionLabel', () => {
  it('should format session name into label', () => {
    expect(getSessionLabel('my-project:my-workspace:default')).toBe(
      'my-project / my-workspace / default'
    );
  });

  it('should handle missing parts', () => {
    expect(getSessionLabel('project')).toBe('project / unknown / unknown');
    expect(getSessionLabel('project:workspace')).toBe('project / workspace / unknown');
  });

  it('should handle empty string', () => {
    expect(getSessionLabel('')).toBe('unknown / unknown / unknown');
  });
});
