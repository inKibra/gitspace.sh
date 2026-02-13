import {
  getNotificationConfig,
  updateNotificationConfig as updateNotificationConfigCore,
} from './config.js';
import type { PreferencesService } from '../preferences/index.js';

/**
 * Preferences service backed by local gitspace config files.
 */
export const localPreferencesService: PreferencesService = {
  async getNotificationConfig() {
    return getNotificationConfig();
  },
  async updateNotificationConfig(config) {
    return updateNotificationConfigCore(config);
  },
};
