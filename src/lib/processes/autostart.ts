/**
 * Process autostart helpers
 */

import type { ProcessInstanceSpec } from '../../types/processes.js';
import { startProcessInstance } from './manager.js';

export async function autostartProcesses(
  workspacePath: string,
  specs: ProcessInstanceSpec[]
): Promise<void> {
  const autostart = specs.filter((spec) => spec.definition.autostart);
  for (const spec of autostart) {
    await startProcessInstance(workspacePath, spec);
  }
}
