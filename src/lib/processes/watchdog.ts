/**
 * Process watchdog for restart policies
 */

import type { ProcessInstanceSpec } from '../../types/processes.js';
import { listSessions } from '../tmux-lite/cli.js';
import { parseProcessSessionName, startProcessInstance, getRestartConfig } from './manager.js';
import { isProcessRestartDisabled, disableProcessRestart } from './control.js';

export interface ProcessRestartState {
  attempts: number;
  lastStart: number;
  nextDelay: number;
  disabled?: boolean;
}

const restartState = new Map<string, ProcessRestartState>();

function getRestartKey(spec: ProcessInstanceSpec): string {
  return `${spec.name}:${spec.instance}`;
}

export async function reconcileProcessRestarts(
  workspacePath: string,
  specs: ProcessInstanceSpec[]
): Promise<void> {
  const sessions = await listSessions();

  for (const spec of specs) {
    const key = getRestartKey(spec);
    const restart = getRestartConfig(spec.definition);
    if (restart.policy === 'never') continue;

    const existing = sessions.find((session) => {
      const parsed = parseProcessSessionName(session.name);
      return parsed?.processName === spec.name && parsed.instance === spec.instance;
    });

    if (!existing) {
      continue;
    }

    if (isProcessRestartDisabled(workspacePath, spec.name, spec.instance)) {
      continue;
    }

    const state = restartState.get(key) ?? { attempts: 0, lastStart: 0, nextDelay: restart.backoffMs };
    if (state.disabled) {
      continue;
    }

    if (existing.exitCode === undefined) {
      restartState.set(key, { ...state, lastStart: Date.now() });
      continue;
    }

    if (restart.policy === 'on-failure' && existing.exitCode === 0) {
      restartState.delete(key);
      continue;
    }

    if (state.attempts >= restart.maxAttempts) {
      restartState.set(key, { ...state, disabled: true });
      disableProcessRestart(workspacePath, spec.name, spec.instance);
      continue;
    }

    const now = Date.now();
    if (now - state.lastStart < state.nextDelay) {
      continue;
    }

    await startProcessInstance(workspacePath, spec);
    const nextDelay = Math.min(state.nextDelay * 2, restart.maxBackoffMs);
    restartState.set(key, { attempts: state.attempts + 1, lastStart: now, nextDelay });
  }
}
