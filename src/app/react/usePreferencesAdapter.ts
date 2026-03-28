import { useState, useEffect, useCallback } from 'react';
import type { NotificationConfig } from '../../types/config.js';

export interface PreferencesService {
  getNotificationConfig(): Promise<NotificationConfig | null>;
  updateNotificationConfig(config: NotificationConfig): Promise<void | NotificationConfig>;
}

export interface UsePreferencesAdapterOptions {
  service: PreferencesService;
  backendNotificationConfig: NotificationConfig | null;
  defaultConfig: NotificationConfig;
}

export interface UsePreferencesAdapterResult {
  activeNotificationConfig: NotificationConfig;
  /** Read the current persisted config (for populating settings UI). */
  loadConfig: () => Promise<NotificationConfig>;
  /** Persist a new config and update local state. */
  updateConfig: (config: NotificationConfig) => Promise<void>;
}

export function usePreferencesAdapter(options: UsePreferencesAdapterOptions): UsePreferencesAdapterResult {
  const { service, backendNotificationConfig, defaultConfig } = options;
  const [localConfig, setLocalConfig] = useState<NotificationConfig | null>(null);

  useEffect(() => {
    let mounted = true;
    void service.getNotificationConfig().then((config) => {
      if (mounted) setLocalConfig(config);
    });
    return () => { mounted = false; };
  }, [service]);

  useEffect(() => {
    if (!backendNotificationConfig) return;
    void service.updateNotificationConfig(backendNotificationConfig);
    setLocalConfig(backendNotificationConfig);
  }, [backendNotificationConfig, service]);

  const activeNotificationConfig = backendNotificationConfig ?? localConfig ?? defaultConfig;

  const loadConfig = useCallback(async (): Promise<NotificationConfig> => {
    const config = await service.getNotificationConfig();
    return config ?? defaultConfig;
  }, [service, defaultConfig]);

  const updateConfig = useCallback(async (config: NotificationConfig): Promise<void> => {
    await service.updateNotificationConfig(config);
    setLocalConfig(config);
  }, [service]);

  return { activeNotificationConfig, loadConfig, updateConfig };
}
