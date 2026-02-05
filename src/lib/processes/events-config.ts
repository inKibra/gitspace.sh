/**
 * Process-level events config overrides
 */

import type { EventsConfig } from '../../types/config.js';
import type { ProcessDefinition } from '../../types/processes.js';
import { getProjectEventsConfig } from '../../core/config.js';

export function buildProcessEventsConfig(
  projectName: string,
  definition?: ProcessDefinition
): EventsConfig {
  const baseConfig = getProjectEventsConfig(projectName);

  if (!definition?.events) {
    return baseConfig;
  }

  let merged: EventsConfig = {
    ...baseConfig,
    ...definition.events,
    fields: {
      ...baseConfig.fields,
      ...(definition.events?.fields || {}),
    },
    rotation: {
      ...baseConfig.rotation,
      ...(definition.events?.rotation || {}),
    },
  };

  if (definition.events.enabled === false) {
    merged = { ...merged, enabled: false };
  }

  return merged;
}
