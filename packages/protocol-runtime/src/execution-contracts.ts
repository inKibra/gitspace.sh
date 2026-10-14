import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeToolResultSchema } from './base.js';

export const RuntimeConversationIdSchema = z.string().min(1).brand<'RuntimeConversationId'>();
export const RuntimeTaskIdSchema = z.string().min(1).brand<'RuntimeTaskId'>();
export const RuntimeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RuntimeRequestIdSchema = z.string().min(1).brand<'RuntimeRequestId'>();
const RuntimeJobIdSchema = z.string().min(1).brand<'RuntimeJobId'>();

export const RuntimeJobHandleSchema = RuntimeIdentitySchema.extend({
  jobId: RuntimeJobIdSchema,
  taskId: RuntimeTaskIdSchema,
  conversationId: RuntimeConversationIdSchema,
  requestId: RuntimeRequestIdSchema,
}).strict();
export const RuntimeJobAcceptanceSchema = z.strictObject({ status: z.literal('accepted'), job: RuntimeJobHandleSchema, acceptedAt: z.iso.datetime() });
/** A background command's state. `terminal` carries the command's tool result as the executor returned it. */
export const RuntimeJobObservationSchema = z.discriminatedUnion('status', [
  RuntimeJobAcceptanceSchema,
  z.strictObject({ status: z.literal('waiting'), job: RuntimeJobHandleSchema, reason: z.enum(['executor', 'reconciliation', 'approval']), observedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('terminal'), job: RuntimeJobHandleSchema, result: RuntimeToolResultSchema, completedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('not-started'), job: RuntimeJobHandleSchema, reason: z.enum(['cancelled', 'deadline', 'admission-failed']), completedAt: z.iso.datetime(), message: z.string().optional() }),
]);
export type RuntimeJobHandle = z.infer<typeof RuntimeJobHandleSchema>;
export type RuntimeJobAcceptance = z.infer<typeof RuntimeJobAcceptanceSchema>;
export type RuntimeJobObservation = z.infer<typeof RuntimeJobObservationSchema>;
