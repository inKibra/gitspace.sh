import { z } from 'zod';
import type { SessionActivity } from './activity.js';
import { SessionPossessionDenied, type AgentFailure } from './errors.js';

export const AgentLifecycleStateSchema = z.enum(['opening', 'active', 'draining', 'closed', 'failed']);
export type AgentLifecycleState = z.infer<typeof AgentLifecycleStateSchema>;
export interface VerifiedAgentPlacement {
  holderId: string;
  generation: number;
  state: 'closed' | 'opening' | 'open' | 'closing';
}
export interface AgentReadinessFacts {
  state: AgentLifecycleState;
  connected: boolean;
  quiesced: boolean;
  machineId: string;
  runtimeGeneration: number;
  placement: VerifiedAgentPlacement | null;
}

/** Facts come from the authenticated machine and committed placement, not request claims. */
export function agentPlacementFailure(spaceId: string, placement: VerifiedAgentPlacement | null, machineId: string, options: { generation?: number; allowOpening?: boolean } = {}): SessionPossessionDenied | null {
  if (!placement || placement.holderId !== machineId
    || (options.generation !== undefined && placement.generation !== options.generation)
    || placement.generation < 1
    || (placement.state !== 'open' && !(options.allowOpening && placement.state === 'opening'))) {
    return new SessionPossessionDenied({ workspaceId: spaceId, message: !placement ? `Space ${spaceId} has no placement` : placement.holderId !== machineId ? `Space ${spaceId} is possessed by ${placement.holderId}` : options.generation !== undefined && placement.generation !== options.generation ? `Space ${spaceId} placement generation changed` : `Space ${spaceId} is not open` });
  }
  return null;
}

export function deriveAgentReadiness(facts: AgentReadinessFacts): { controlsAvailable: boolean; connection: 'connected' | 'disconnected'; action: 'connect' | 'wait' | 'retry' | 'prompt' | 'none' } {
  const owned = !!facts.placement && facts.placement.holderId === facts.machineId && facts.placement.generation === facts.runtimeGeneration && facts.placement.state === 'open';
  const controlsAvailable = owned && facts.connected && !facts.quiesced && facts.state === 'active';
  const action = controlsAvailable ? 'prompt' : !owned || facts.state === 'closed' ? 'none' : facts.quiesced || facts.state === 'opening' || facts.state === 'draining' ? 'wait' : !facts.connected ? 'connect' : 'retry';
  return { controlsAvailable, connection: facts.connected ? 'connected' : 'disconnected', action };
}

export function hasExecutingTurn(activity: SessionActivity | undefined): boolean {
  return activity?.reasons.some((reason) => reason.kind === 'turn' || reason.kind === 'compacting') === true;
}

export function disconnectedAgentActivity(activity: SessionActivity): SessionActivity {
  return { active: false, reasons: activity.reasons.filter((reason) => reason.kind === 'queued' || reason.kind === 'human' || reason.kind === 'subagents') };
}

export function resumeAccepted(input: { activity: SessionActivity; recovering: boolean; controlsAvailable: boolean }): boolean {
  return input.recovering && input.controlsAvailable && input.activity.active;
}

export function agentCheckpointFailure(input: { sessionId: string; activity: SessionActivity; pendingAsk: boolean; steering: number; followUp: number }): AgentFailure | null {
  if (input.pendingAsk || input.steering > 0 || input.followUp > 0 || input.activity.reasons.some((reason) => reason.kind === 'queued' || reason.kind === 'human' || reason.kind === 'subagents')) {
    return { domain: 'agent', code: 'AGENT_NOT_READY', message: 'Pending asks, queued prompts and subagents must be resolved before checkpointing; cancel preparation to continue the session', context: { sessionId: input.sessionId, operation: 'checkpoint' } };
  }
  return null;
}
