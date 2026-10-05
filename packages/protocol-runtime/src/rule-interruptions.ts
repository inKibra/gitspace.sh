import { z } from 'zod';
import { RuntimeIdentitySchema } from './base.js';
import { RuntimeConversationIdSchema, RuntimeTaskIdSchema, RuntimeSha256Schema } from './execution-contracts.js';

export const RuntimeRunIdSchema = z.string().min(1).brand<'RuntimeRunId'>();
export const RuntimeGenerationIdSchema = z.string().min(1).brand<'RuntimeGenerationId'>();
export const RuntimeRuleIdSchema = z.string().min(1).brand<'RuntimeRuleId'>();
export const RuntimeInterruptionIdSchema = z.string().min(1).brand<'RuntimeInterruptionId'>();
const identity = RuntimeIdentitySchema.extend({
  conversationId: RuntimeConversationIdSchema,
  taskId: RuntimeTaskIdSchema,
  runId: RuntimeRunIdSchema,
  generationId: RuntimeGenerationIdSchema,
  interruptionId: RuntimeInterruptionIdSchema,
  ruleId: RuntimeRuleIdSchema,
  ruleRevision: RuntimeSha256Schema,
}).shape;
export const RuntimeRuleProvenanceSchema = z.strictObject({
  source: z.literal('project-rule'),
  path: z.string().min(1),
  matcher: z.enum(['text', 'ast']),
  output: z.enum(['text', 'thinking', 'tool']),
  outputOrdinal: z.number().int().nonnegative(),
  matchedDigest: RuntimeSha256Schema,
  observedAt: z.iso.datetime(),
});
const interruption = {
  ...identity,
  version: z.literal(1),
  kind: z.literal('rule-interruption'),
  provenance: RuntimeRuleProvenanceSchema,
  instruction: z.string().min(1),
  // An interrupted generation is never committed as an ordinary successful reply.
  discard: z.strictObject({ state: z.literal('discarded'), generationId: RuntimeGenerationIdSchema, toolCalls: z.literal('not-dispatched') }),
};
export const RuntimeRuleInterruptionSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...interruption, state: z.literal('pending'), continuation: z.strictObject({ state: z.literal('pending') }) }),
  z.strictObject({ ...interruption, state: z.literal('continuing'), continuation: z.strictObject({ state: z.literal('scheduled'), generationId: RuntimeGenerationIdSchema, taskId: RuntimeTaskIdSchema, scheduledAt: z.iso.datetime() }) }),
  z.strictObject({ ...interruption, state: z.literal('resolved'), continuation: z.strictObject({ state: z.literal('completed'), generationId: RuntimeGenerationIdSchema, taskId: RuntimeTaskIdSchema, completedAt: z.iso.datetime() }) }),
  z.strictObject({ ...interruption, state: z.literal('cancelled'), continuation: z.strictObject({ state: z.literal('cancelled'), cancelledAt: z.iso.datetime(), reason: z.string().min(1) }) }),
]).superRefine((value, context) => {
  if (value.discard.generationId !== value.generationId) context.addIssue({ code: 'custom', path: ['discard', 'generationId'], message: 'Discard must identify the interrupted generation' });
  if ('generationId' in value.continuation && value.continuation.generationId === value.generationId) context.addIssue({ code: 'custom', path: ['continuation', 'generationId'], message: 'Continuation requires a new generation' });
});
export type RuntimeRuleInterruption = z.infer<typeof RuntimeRuleInterruptionSchema>;
export type RuntimeRuleProvenance = z.infer<typeof RuntimeRuleProvenanceSchema>;
export type RuntimeRunId = z.infer<typeof RuntimeRunIdSchema>;
export type RuntimeGenerationId = z.infer<typeof RuntimeGenerationIdSchema>;
export type RuntimeRuleId = z.infer<typeof RuntimeRuleIdSchema>;
export type RuntimeInterruptionId = z.infer<typeof RuntimeInterruptionIdSchema>;
