/**
 * Shared notification types
 *
 * Types used across TUI, Web, and tmux-lite for notification handling.
 */

import type { InboxItem } from '../types.js';

/**
 * Notification config as used by the shared notification system.
 * This matches the structure from types/config.ts but is redeclared
 * for environments (like web) that can't import node-only config modules.
 */
export interface NotificationConfig {
  enabled: boolean;
  minCommandDurationMs: number;
  types: {
    exit: boolean;
    idle: boolean;
    bell: boolean;
    title: boolean;
    osc: boolean;
  };
  toast: {
    enabled: boolean;
  };
}

/**
 * Default notification config (matches types/config.ts)
 */
export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
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
  },
};

/**
 * Toast notification data
 */
export interface ToastNotification {
  /** Unique ID for deduplication */
  id: string;
  /** Session ID to attach to */
  sessionId: string;
  /** Session display name */
  sessionName: string;
  /** Notification type icon */
  icon: string;
  /** Title for the toast */
  title: string;
  /** Preview/context text */
  preview: string;
  /** Timestamp */
  timestamp: number;
  /** Original inbox item */
  item: InboxItem;
}

/**
 * Result from comparing inbox states
 */
export interface InboxDiff {
  /** Newly added items since last check */
  added: InboxItem[];
  /** Items that were removed */
  removed: InboxItem[];
  /** Items that were marked as read */
  read: InboxItem[];
}
