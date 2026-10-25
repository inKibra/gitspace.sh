import { defineDoc } from '@earendil-works/pi-durable';
import type { RuntimeSubagentRecord } from '@gitspace/protocol-runtime';
export type SubagentMetadata = RuntimeSubagentRecord;
export const AgentDefinitionContextDoc = defineDoc<{ child: SubagentMetadata | null }>({ kind: 'gitspace.agent-definition', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ child: null }) });
/**
 * Subagents of a workspace that run at once. A workspace object has 128 MB, and a model request is in memory three
 * times while it is built and sent (the loaded history, the SDK's JSON string, the encoded bytes). Workspaces reset
 * with the main conversation's 17.6 MB request (about 53 MB) building beside 1–4 subagent requests of 0.5–0.9 MB
 * (up to about 3 MB each); four subagents keep theirs near 11 MB, however many are spawned.
 */
export const MAX_RUNNING_SUBAGENTS = 4;
/** What a spawn or message that waits for a run slot tells the agent. */
export const SUBAGENT_QUEUED = `queued: starts when one of the ${MAX_RUNNING_SUBAGENTS} running subagents finishes`;
/**
 * A subagent waiting for a run slot. `input` is a spawn's task, submitted under the spawn's request id; without it the
 * run starts from what the conversation already has waiting: delivered events, or input a run left queued.
 */
export type QueuedSubagentRun = { conversationId: string; input?: { requestId: string; content: string } };
/** Subagents waiting for a run slot, oldest first; one item per subagent. */
export const SubagentRunQueueDoc = defineDoc<{ queue: QueuedSubagentRun[] }>({ kind: 'gitspace.subagent-run-queue', version: 1, scope: 'session', initial: () => ({ queue: [] }) });
