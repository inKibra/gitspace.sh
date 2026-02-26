import type { PreferencesService } from '../preferences/index.js';
import type { NotificationConfig } from '../notifications/types.js';
import { DEFAULT_NOTIFICATION_CONFIG } from '../notifications/types.js';
import { notifyOwnerSyncCategoryDirty } from '../core/owner-sync-events.js';

const NOTIFICATION_CONFIG_STORAGE_KEY = 'gitspace:web:notification-config';

/**
 * Browser preferences service backed by localStorage.
 */
export const browserPreferencesService: PreferencesService = {
  async getNotificationConfig(): Promise<NotificationConfig> {
    try {
      const raw = localStorage.getItem(NOTIFICATION_CONFIG_STORAGE_KEY);
      if (!raw) {
        return { ...DEFAULT_NOTIFICATION_CONFIG };
      }

      const parsed = JSON.parse(raw) as Partial<NotificationConfig>;
      return {
        enabled: parsed.enabled ?? DEFAULT_NOTIFICATION_CONFIG.enabled,
        minCommandDurationMs:
          parsed.minCommandDurationMs ?? DEFAULT_NOTIFICATION_CONFIG.minCommandDurationMs,
        types: {
          ...DEFAULT_NOTIFICATION_CONFIG.types,
          ...(parsed.types || {}),
        },
        toast: {
          ...DEFAULT_NOTIFICATION_CONFIG.toast,
          ...(parsed.toast || {}),
        },
      };
    } catch {
      return { ...DEFAULT_NOTIFICATION_CONFIG };
    }
  },

  async updateNotificationConfig(config: NotificationConfig): Promise<NotificationConfig> {
    localStorage.setItem(NOTIFICATION_CONFIG_STORAGE_KEY, JSON.stringify(config));
    notifyOwnerSyncCategoryDirty('preferences');
    return config;
  },
};
