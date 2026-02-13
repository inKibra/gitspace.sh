import type { NotificationConfig } from '../notifications/types.js';

/**
 * Shared preferences service interface for local/remote contexts.
 */
export interface PreferencesService {
  getNotificationConfig(): Promise<NotificationConfig>;
  updateNotificationConfig(config: NotificationConfig): Promise<NotificationConfig>;
}
