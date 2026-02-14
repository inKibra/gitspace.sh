/**
 * Process watchdog for restart policies
 */

import type { ProcessInstanceSpec } from '../../types/processes.js';
import { listSessions } from '../tmux-lite/cli.js';
import { parseProcessSessionName, startProcessInstance, getRestartConfig } from './manager.js';
import { isProcessRestartDisabled, disableProcessRestart } from './control.js';
import { hasProcessStarted, readProcessExit } from './state.js';

export interface ProcessRestartState {
  attempts: number;
  lastStart: number;
  nextDelay: number;
  disabled?: boolean;
}

export interface ProcessWatchdogDeps {
  listSessions?: typeof listSessions;
  startProcessInstance?: typeof startProcessInstance;
  isProcessRestartDisabled?: typeof isProcessRestartDisabled;
  disableProcessRestart?: typeof disableProcessRestart;
  hasProcessStarted?: typeof hasProcessStarted;
  readProcessExit?: typeof readProcessExit;
  now?: () => number;
}

const restartState = new Map<string, ProcessRestartState>();

function getRestartKey(spec: ProcessInstanceSpec): string {
  return `${spec.name}:${spec.instance}`;
}

export async function reconcileProcessRestarts(
  workspacePath: string,
  specs: ProcessInstanceSpec[],
  deps: ProcessWatchdogDeps = {}
): Promise<void> {
  const listSessionsFn = deps.listSessions ?? listSessions;
  const startProcessInstanceFn = deps.startProcessInstance ?? startProcessInstance;
  const isProcessRestartDisabledFn = deps.isProcessRestartDisabled ?? isProcessRestartDisabled;
  const disableProcessRestartFn = deps.disableProcessRestart ?? disableProcessRestart;
  const hasProcessStartedFn = deps.hasProcessStarted ?? hasProcessStarted;
  const readProcessExitFn = deps.readProcessExit ?? readProcessExit;
  const nowFn = deps.now ?? Date.now;

  const sessions = await listSessionsFn();

  for (const spec of specs) {
    const key = getRestartKey(spec);
    const restart = getRestartConfig(spec.definition);
    if (restart.policy === 'never') continue;

    const existing = sessions.find((session) => {
      const parsed = parseProcessSessionName(session.name);
      return parsed?.processName === spec.name && parsed.instance === spec.instance;
    });

    if (isProcessRestartDisabledFn(workspacePath, spec.name, spec.instance)) {
      continue;
    }

    const state = restartState.get(key) ?? { attempts: 0, lastStart: 0, nextDelay: restart.backoffMs };
    if (state.disabled) {
      continue;
    }

    if (existing) {
      restartState.set(key, { ...state, lastStart: nowFn() });
      continue;
    }

    if (!hasProcessStartedFn(workspacePath, spec.name, spec.instance)) {
      continue;
    }

    if (restart.policy === 'on-failure') {
      const exitInfo = readProcessExitFn(workspacePath, spec.name, spec.instance);
      if (exitInfo?.exitCode === 0) {
        restartState.delete(key);
        continue;
      }
    }

    if (state.attempts >= restart.maxAttempts) {
      restartState.set(key, { ...state, disabled: true });
      disableProcessRestartFn(workspacePath, spec.name, spec.instance);
      continue;
    }

    const now = nowFn();
    if (state.lastStart > 0 && now - state.lastStart < state.nextDelay) {
      continue;
    }

    await startProcessInstanceFn(workspacePath, spec);
    const nextDelay = Math.min(state.nextDelay * 2, restart.maxBackoffMs);
    restartState.set(key, { attempts: state.attempts + 1, lastStart: now, nextDelay });
  }
}
