import { z } from 'zod';
import { RuntimeIdentitySchema } from './base.js';
import type { AgentFailure, SessionActivity } from '@gitspace/protocol-agent';
import { SessionHistoryPageSchema, SessionHistoryPageRequestSchema } from '@gitspace/protocol-agent';
import { transcriptPageRequestSchema, transcriptContentRequestSchema, transcriptPageSchema, transcriptContentPageSchema } from '@gitspace/blocks';
import { SessionUsageReportSchema } from './usage.js';
import { RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema } from './browser.js';
export { SessionUsageReportSchema, UsageTotalsSchema, type SessionUsageReport, type UsageTotals } from './usage.js';

export const ModelSelectionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({ kind: z.literal('role'), role: z.string().min(1) }),
  z.object({ kind: z.literal('explicit'), provider: z.string().min(1), modelId: z.string().min(1) }),
]);
export type ModelSelectionIntent = z.infer<typeof ModelSelectionIntentSchema>;

export const PendingAskAnswerSchema = z.object({ id: z.string(), selectedOptions: z.array(z.string()).readonly(), customInput: z.string().nullable() });
export type PendingAskAnswer = z.infer<typeof PendingAskAnswerSchema>;
export const PendingAskSchema = z.object({ id: z.string(), source: z.enum(['ask-tool', 'gitspace']), links: z.array(z.object({ label: z.string(), uri: z.string() })), questions: z.array(z.object({ id: z.string(), question: z.string(), header: z.string().nullable(), options: z.array(z.object({ label: z.string(), description: z.string().nullable(), preview: z.string().nullable() })), multi: z.boolean(), recommended: z.number().nullable() })) });
export const SessionControlSchema = z.object({
  sessionId: z.string(), inference: z.object({ profileId: z.string(), profileName: z.string(), profileRevision: z.number(), assignmentRevision: z.number() }).optional(),
  role: z.string().nullable(), roleLabel: z.string().nullable(), roles: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string(), model: z.string(), thinking: z.string().nullable(), current: z.boolean() })),
  provider: z.string().nullable(), models: z.array(z.object({ provider: z.string(), id: z.string(), name: z.string(), contextWindow: z.number().nullable() })), model: z.string().nullable(), thinking: z.string().nullable(), fastMode: z.boolean(), planMode: z.boolean(), approvalMode: z.enum(['always-ask', 'write', 'yolo']),
  context: z.object({ tokens: z.number(), contextWindow: z.number(), percent: z.number() }).nullable(), cost: z.number(),
  todos: z.array(z.object({ name: z.string(), tasks: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']), blocker: z.string().nullable() })) })),
  queue: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }), historyAnchorId: z.string().nullable(), history: z.array(z.object({ entryId: z.string(), text: z.string() })),
  goal: z.object({ id: z.string(), status: z.enum(['active', 'paused', 'budget-limited', 'complete', 'dropped']), objective: z.string(), tokenBudget: z.number().nullable(), tokensUsed: z.number(), timeUsedSeconds: z.number() }).nullable(), pendingAsk: PendingAskSchema.nullable(),
});
export type SessionControlView = z.infer<typeof SessionControlSchema>;
export const AgentDefinitionSchema = z.object({ name: z.string(), description: z.string(), source: z.string(), path: z.string(), editable: z.boolean(), content: z.string(), revision: z.string(), modelSelectors: z.array(z.string()), role: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(), thinking: z.string().nullable().default(null), selection: z.enum(['definition', 'settings']), tools: z.array(z.string()), spawns: z.string().nullable() });
export const RuntimeSubagentRecordSchema = z.object({ parentId: z.string(), name: z.string(), attemptId: z.string(), definition: AgentDefinitionSchema.nullable(), selection: ModelSelectionIntentSchema, role: z.string().nullable(), thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(), tools: z.array(z.string()), model: z.object({ provider: z.string(), modelId: z.string() }).nullable() });
export type RuntimeSubagentRecord = z.infer<typeof RuntimeSubagentRecordSchema>;
export const AgentSetupSchema = z.object({ sessionId: z.string(), agents: z.array(AgentDefinitionSchema) });
const simple = ['control', 'agentSetup', 'historyAnchorId', 'messages', 'usage', 'persist', 'handoff', 'resume', 'stop', 'clearQueue', 'reloadSettings', 'instructionsChanged', 'inferenceChanged'] as const;
export const RuntimeSessionCommandSchema = z.union([
  z.object({ type: z.literal('browserStatus'), machineId: z.string().optional() }),
  z.object({ type: z.literal('browserRevoke'), machineId: z.string().optional(), groupId: z.string().uuid() }),
  z.object({ type: z.literal('browserReconcile'), machineId: z.string(), recordId: z.string() }),
  z.object({ type: z.literal('browserDiscard'), machineId: z.string(), recordId: z.string() }),
  z.object({ type: z.literal('browserArtifact'), machineId: z.string().optional(), artifactId: z.string(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(65536) }),
  z.object({ type: z.enum(simple) }),
  z.object({ type: z.literal('prompt'), text: z.string(), draftRevision: z.number().int().nonnegative().optional(), streamingBehavior: z.enum(['steer', 'followUp']).optional(), images: z.array(z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })).optional() }),
  z.object({ type: z.literal('setWorkspacePhase'), phase: z.enum(['plan', 'code', 'review', 'ship']) }),
  z.object({ type: z.literal('cycleRole'), direction: z.enum(['forward', 'backward']) }),
  z.object({ type: z.literal('setModel'), provider: z.string(), model: z.string() }),
  z.object({ type: z.literal('setThinking'), thinking: z.string().nullable() }),
  z.object({ type: z.literal('setFast'), enabled: z.boolean() }),
  z.object({ type: z.literal('setApproval'), approvalMode: SessionControlSchema.shape.approvalMode }),
  z.object({ type: z.literal('setGoal'), enabled: z.boolean(), objective: z.string().optional() }),
  z.object({ type: z.literal('compact'), instructions: z.string().optional() }),
  z.object({ type: z.literal('removeQueuedMessage'), kind: z.enum(['steering', 'followUp']), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('promoteQueuedMessage'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('answerAsk'), id: z.string(), answers: z.array(PendingAskAnswerSchema).readonly() }),
  z.object({ type: z.literal('navigateTree'), entryId: z.string() }),
  z.object({ type: z.literal('historyPage'), request: SessionHistoryPageRequestSchema }),
  z.object({ type: z.literal('transcriptPage'), request: transcriptPageRequestSchema }),
  z.object({ type: z.literal('transcriptContent'), request: transcriptContentRequestSchema }),
  z.object({ type: z.literal('saveAgentDefinition'), path: z.string(), expectedRevision: z.string().nullable(), content: z.string() }),
]);
export const RuntimeSessionInputSchema = RuntimeIdentitySchema.extend({ conversationId: z.string().optional(), command: RuntimeSessionCommandSchema });
export const RuntimeSessionResultSchema = z.object({ control: SessionControlSchema, browserStatus: RuntimeBrowserStatusSchema.optional(), browserArtifact: RuntimeBrowserArtifactPageSchema.optional(), setup: AgentSetupSchema.optional(), messages: z.array(z.unknown()).optional(), historyPage: SessionHistoryPageSchema.optional(), transcriptPage: transcriptPageSchema.optional(), transcriptContent: transcriptContentPageSchema.optional(), usage: SessionUsageReportSchema.optional() });
export type RuntimeSessionCommand = z.infer<typeof RuntimeSessionCommandSchema>;
export type RuntimeSessionInput = z.infer<typeof RuntimeSessionInputSchema>;
export type RuntimeSessionResult = z.infer<typeof RuntimeSessionResultSchema>;
export type AgentSetupView = z.infer<typeof AgentSetupSchema>;
export type SaveAgentDefinitionInput = Omit<Extract<RuntimeSessionCommand, { type: 'saveAgentDefinition' }>, 'type'>;
export type WorkspacePhase = 'plan' | 'code' | 'review' | 'ship';
export type RuntimeEvent = { type: string; [key: string]: unknown };
export const TranscriptEventSchema = z.object({ ordinal: z.number().int().nonnegative(), kind: z.string(), payload: z.record(z.string(), z.unknown()), createdAt: z.string() });
export const RuntimeTranscriptSchema = z.array(TranscriptEventSchema.extend({ sessionId: z.string() }));
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;
export interface RuntimeSession {
  id: string; sessionFile: string;
  isAvailable(): boolean;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<boolean>;
  subscribe(handler: (event: RuntimeEvent) => void): () => void;
  subscribeActivity(handler: (activity: SessionActivity, failure: AgentFailure | null) => void): () => void;
  activity(): { activity: SessionActivity; failure: AgentFailure | null };
  persist(): Promise<void>; handoff(): Promise<boolean>; reloadSettings(): Promise<void>; instructionsChanged(): Promise<void>; inferenceChanged(): Promise<void>;
  setWorkspacePhase(phase: WorkspacePhase): Promise<void>; resume(): Promise<void>; dispose(): Promise<void>;
  control(): Promise<SessionControlView>; agentSetup(): Promise<AgentSetupView>; saveAgentDefinition(input: SaveAgentDefinitionInput): Promise<AgentSetupView>; historyAnchorId(): Promise<string | null>;
  cycleRole(direction: 'forward' | 'backward'): Promise<SessionControlView>; setModel(provider: string, model: string): Promise<SessionControlView>; setThinking(thinking: string | null): Promise<SessionControlView>; setFast(enabled: boolean): Promise<SessionControlView>; setApproval(approvalMode: SessionControlView['approvalMode']): Promise<SessionControlView>; setGoal(input: { enabled: boolean; objective?: string }): Promise<SessionControlView>; compact(instructions?: string): Promise<SessionControlView>; clearQueue(): Promise<SessionControlView>; removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<SessionControlView>; promoteQueuedMessage(index: number): Promise<SessionControlView>; answerAsk(id: string, answers: readonly PendingAskAnswer[]): Promise<SessionControlView>; stop(): Promise<SessionControlView>; navigateTree(entryId: string): Promise<SessionControlView>; messages(): Promise<unknown[]>;
}
export type RuntimeOpenInput = { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string; executionFailure?: AgentFailure | null };
export interface AgentRuntime { create(input: RuntimeOpenInput, signal?: AbortSignal): Promise<RuntimeSession>; open(input: RuntimeOpenInput & { sessionFile: string }, signal?: AbortSignal): Promise<RuntimeSession>; transcript(sessionFile: string): Promise<TranscriptEvent[]>; checkpointTranscript(bytes: Uint8Array): Promise<TranscriptEvent[]>; checkpointReference(sessionFile: string): Promise<{ conversationId: string; cursor: number }>; }
