import type { WorkspaceReport } from '@gitspace/protocol-workspace';
import type { RuntimeTurn, WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { RuntimeAutomationInput, RuntimeRequestStatus } from '@gitspace/runtime-core';
import type { RuntimeIdentity } from './runtime-services.js';
import { AUTOMATION_REQUEST_PREFIX, type AutomationTurnReport } from './project-automations.js';

/**
 * An automation run's instruction to this workspace, watched (as `startFromProject` watches the project agent's): the
 * watch is armed before the submission exists, so the turn that submission starts is the one that reports. A retried
 * submission names the same request and delivers nothing new.
 */
export async function submitAutomationTurn(storage: DurableObjectStorage, runtime: WorkspaceRuntime, input: RuntimeAutomationInput): Promise<{ conversationId: string }> {
  if (await runtime.turn(input.requestId) !== null) return runtime.automationSubmit(input);
  storage.sql.exec('INSERT OR IGNORE INTO workspace_automation_turns(request_id) VALUES(?)', input.requestId);
  try { return await runtime.automationSubmit(input); } catch (error) {
    if (await runtime.turn(input.requestId) === null) storage.sql.exec('DELETE FROM workspace_automation_turns WHERE request_id=?', input.requestId);
    throw error;
  }
}

/** A person's cancel of a run: its instruction is withdrawn before it starts, or the workspace agent is stopped. A
 * withdrawn instruction starts no turn, so its watch ends here. */
export async function cancelAutomationTurn(storage: DurableObjectStorage, runtime: WorkspaceRuntime, requestId: string): Promise<RuntimeRequestStatus> {
  const receipt = await runtime.automationCancel(requestId);
  if (receipt.state === 'withdrawn') storage.sql.exec('DELETE FROM workspace_automation_turns WHERE request_id=?', requestId);
  return receipt;
}

export type AutomationTurnHooks = {
  turnChanged(requestId: string, turn: RuntimeTurn): void;
  published(report: WorkspaceReport): void;
};

/**
 * A watched turn reports through `send` when it starts, and once when it ends or stops to ask a person (a run waiting
 * for a person holds no slot). The watch ends only once that report is delivered: a runtime that opens later sends it
 * again (`reconcileAutomationTurns`), and the automations object ignores a report it already has.
 */
export function automationTurnHooks(storage: DurableObjectStorage, identity: RuntimeIdentity, send: (report: AutomationTurnReport) => Promise<void>, waitUntil: (label: string, promise: Promise<unknown>) => void): AutomationTurnHooks {
  const deliver = (report: AutomationTurnReport) => waitUntil('automation report', send(report).then(() => {
    if (report.state === 'ended') storage.sql.exec('DELETE FROM workspace_automation_turns WHERE request_id=?', report.requestId);
  }).catch((error: unknown) => console.error('Automation report was not sent', { workspaceId: identity.workspaceId, requestId: report.requestId, error })));
  return {
    turnChanged: (requestId, turn) => {
      if (!requestId.startsWith(AUTOMATION_REQUEST_PREFIX) || !storage.sql.exec('SELECT 1 FROM workspace_automation_turns WHERE request_id=?', requestId).toArray().length) return;
      if (turn.state === 'running') {
        storage.sql.exec('UPDATE workspace_automation_turns SET started=1 WHERE request_id=?', requestId);
        deliver({ ...identity, requestId, state: 'running' });
      } else if (turn.state === 'ended') deliver({ ...identity, requestId, state: 'ended', outcome: turn.outcome, text: turn.text });
    },
    // A question only counts once the watched turn runs: one still pending from an earlier turn is not this turn's.
    published: report => {
      if (!report.waitingOn) return;
      for (const { request_id: requestId } of storage.sql.exec<{ request_id: string }>('SELECT request_id FROM workspace_automation_turns WHERE started=1').toArray()) {
        deliver({ ...identity, requestId, state: 'ended', outcome: 'asked', text: report.waitingOn.prompt });
      }
    },
  };
}

/** Turns that started or ended while no runtime was open to hear them, or whose report was not delivered, are read
 * once as the runtime opens. */
export async function reconcileAutomationTurns(storage: DurableObjectStorage, runtime: WorkspaceRuntime, hooks: AutomationTurnHooks): Promise<void> {
  for (const { request_id: requestId } of storage.sql.exec<{ request_id: string }>('SELECT request_id FROM workspace_automation_turns').toArray()) {
    const turn = await runtime.turn(requestId);
    if (turn) hooks.turnChanged(requestId, turn);
  }
}
