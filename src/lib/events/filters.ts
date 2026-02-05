/**
 * Saved events filter helpers
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventsConfigFile, SavedEventFilter } from '../../types/events.js';

export function getEventsConfigPath(workspacePath: string): string {
  return join(workspacePath, '.gitspace', 'events.json');
}

export function loadSavedEventFilters(workspacePath: string): SavedEventFilter[] {
  const path = getEventsConfigPath(workspacePath);
  if (!existsSync(path)) {
    return [];
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as EventsConfigFile;
    return Array.isArray(parsed.savedFilters) ? parsed.savedFilters : [];
  } catch {
    return [];
  }
}
