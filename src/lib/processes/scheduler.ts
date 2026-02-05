/**
 * Process scheduler loop
 */

import { getProcessSpecs } from './manager.js';
import { reconcileProcessRestarts } from './watchdog.js';

const DEFAULT_INTERVAL_MS = 5000;

export function startProcessScheduler(workspacePath: string, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timer {
  const timer = setInterval(() => {
    const specs = getProcessSpecs(workspacePath);
    void reconcileProcessRestarts(workspacePath, specs);
  }, intervalMs);

  return timer;
}
