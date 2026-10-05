import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema } from './base.js';

export const RuntimeRequestIdSchema = z.string().min(1).brand<'RuntimeRequestId'>();
export const RuntimeAttemptIdSchema = z.string().min(1).brand<'RuntimeAttemptId'>();
export const RuntimeAttachmentIdSchema = z.string().min(1).brand<'RuntimeAttachmentId'>();
export const RuntimeConversationIdSchema = z.string().min(1).brand<'RuntimeConversationId'>();
export const RuntimeTaskIdSchema = z.string().min(1).brand<'RuntimeTaskId'>();
export const RuntimeJobIdSchema = z.string().min(1).brand<'RuntimeJobId'>();
export const RuntimeReceiptIdSchema = z.string().min(1).brand<'RuntimeReceiptId'>();
export const RuntimeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative();

// Branded admission view of the required scoped execution dispatch.
export const RuntimeScopedDispatchSchema = RuntimeToolDispatchSchema.extend({
  requestId: RuntimeRequestIdSchema,
  attemptId: RuntimeAttemptIdSchema,
  parentAttemptId: RuntimeAttemptIdSchema.optional(),
  attachmentId: RuntimeAttachmentIdSchema,
  conversationId: RuntimeConversationIdSchema,
  taskId: RuntimeTaskIdSchema,
}).strict();
export const RuntimeDispatchIdentitySchema = RuntimeIdentitySchema.extend({
  machineId: RuntimeMachineIdSchema,
  attachmentId: RuntimeAttachmentIdSchema,
  generation,
  conversationId: RuntimeConversationIdSchema,
  taskId: RuntimeTaskIdSchema,
  requestId: RuntimeRequestIdSchema,
  attemptId: RuntimeAttemptIdSchema,
  // Digest of the complete admitted scoped dispatch, encoded with RFC 8785 JCS.
  fingerprint: z.strictObject({ algorithm: z.literal('sha256'), encoding: z.literal('rfc8785'), digest: RuntimeSha256Schema }),
}).strict();

// Metadata is not proof that bytes have been checked: consumers must verify both
// digests and AES-GCM authentication before decoding or exposing the result.
export const RuntimeEncryptedOutputReferenceSchema = z.strictObject({
  objectId: z.string().min(1),
  encryption: z.strictObject({ algorithm: z.literal('AES-256-GCM'), keyId: z.string().min(1), nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/) }),
  ciphertext: z.strictObject({ sha256: RuntimeSha256Schema, bytes: z.number().int().nonnegative() }),
  plaintext: z.strictObject({ sha256: RuntimeSha256Schema, bytes: z.number().int().nonnegative(), encoding: z.literal('runtime-tool-result-json-v1') }),
});
const resultIdentity = { requestId: RuntimeRequestIdSchema, attemptId: RuntimeAttemptIdSchema };
export const RuntimeTerminalToolResultSchema = z.discriminatedUnion('status', [
  RuntimeToolResultSchema.options[0].extend(resultIdentity).strict(),
  RuntimeToolResultSchema.options[1].extend(resultIdentity).strict(),
  RuntimeToolResultSchema.options[2].extend(resultIdentity).strict(),
]);
const receipt = {
  version: z.literal(1),
  receiptId: RuntimeReceiptIdSchema,
  dispatch: RuntimeDispatchIdentitySchema,
  observedAt: z.iso.datetime(),
};
export const RuntimeTerminalReceiptSchema = z.strictObject({
  ...receipt, state: z.literal('terminal'), completedAt: z.iso.datetime(),
  result: RuntimeTerminalToolResultSchema, output: RuntimeEncryptedOutputReferenceSchema,
}).superRefine((value, context) => {
  for (const key of ['requestId', 'attemptId'] as const) {
    if (value.result[key] !== value.dispatch[key]) context.addIssue({ code: 'custom', path: ['result', key], message: 'Result must identify the admitted dispatch' });
  }
});
export const RuntimeExecutorReceiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...receipt, state: z.literal('unknown'), reason: z.enum(['unreachable', 'recovered-without-evidence', 'receipt-missing']) }),
  z.strictObject({ ...receipt, state: z.literal('starting'), claimedAt: z.iso.datetime() }),
  z.strictObject({ ...receipt, state: z.literal('running'), startedAt: z.iso.datetime() }),
  z.strictObject({ ...receipt, state: z.literal('fenced-not-started'), evidence: z.strictObject({ kind: z.literal('durable-launch-barrier'), fenceGeneration: generation, recordedAt: z.iso.datetime(), launchPrevented: z.literal(true) }) }),
  RuntimeTerminalReceiptSchema,
]).superRefine((value, context) => {
  if (value.state === 'fenced-not-started' && value.evidence.fenceGeneration < value.dispatch.generation) {
    context.addIssue({ code: 'custom', path: ['evidence', 'fenceGeneration'], message: 'Launch barrier must fence the admitted generation' });
  }
});
export const RuntimeReceiptAcknowledgementSchema = z.strictObject({
  version: z.literal(1),
  receiptId: RuntimeReceiptIdSchema,
  dispatch: RuntimeDispatchIdentitySchema,
  // Digest of the complete receipt using the same canonical encoding as dispatch.
  receiptDigest: RuntimeSha256Schema,
  acknowledgedAt: z.iso.datetime(),
});

export const RuntimeJobHandleSchema = RuntimeIdentitySchema.extend({
  jobId: RuntimeJobIdSchema,
  taskId: RuntimeTaskIdSchema,
  conversationId: RuntimeConversationIdSchema,
  requestId: RuntimeRequestIdSchema,
}).strict();
export const RuntimeJobAcceptanceSchema = z.strictObject({ status: z.literal('accepted'), job: RuntimeJobHandleSchema, acceptedAt: z.iso.datetime() });
export const RuntimeJobObservationSchema = z.discriminatedUnion('status', [
  RuntimeJobAcceptanceSchema,
  z.strictObject({ status: z.literal('waiting'), job: RuntimeJobHandleSchema, reason: z.enum(['executor', 'reconciliation', 'approval']), observedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('executing'), job: RuntimeJobHandleSchema, dispatch: RuntimeDispatchIdentitySchema, observedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('terminal'), job: RuntimeJobHandleSchema, receipt: RuntimeTerminalReceiptSchema, completedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal('not-started'), job: RuntimeJobHandleSchema, reason: z.enum(['cancelled', 'deadline', 'admission-failed', 'fenced']), completedAt: z.iso.datetime(), message: z.string().optional() }),
]).superRefine((value, context) => {
  const dispatch = value.status === 'executing' ? value.dispatch : value.status === 'terminal' ? value.receipt.dispatch : undefined;
  if (!dispatch) return;
  for (const key of ['projectId', 'workspaceId', 'conversationId', 'taskId', 'requestId'] as const) {
    if (value.job[key] !== dispatch[key]) context.addIssue({ code: 'custom', path: ['job', key], message: 'Job and execution scope must agree' });
  }
});
export type RuntimeScopedDispatch = z.infer<typeof RuntimeScopedDispatchSchema>;
export type RuntimeDispatchIdentity = z.infer<typeof RuntimeDispatchIdentitySchema>;
export type RuntimeExecutorReceipt = z.infer<typeof RuntimeExecutorReceiptSchema>;
export type RuntimeReceiptAcknowledgement = z.infer<typeof RuntimeReceiptAcknowledgementSchema>;
export type RuntimeEncryptedOutputReference = z.infer<typeof RuntimeEncryptedOutputReferenceSchema>;
export type RuntimeJobHandle = z.infer<typeof RuntimeJobHandleSchema>;
export type RuntimeJobAcceptance = z.infer<typeof RuntimeJobAcceptanceSchema>;
export type RuntimeJobObservation = z.infer<typeof RuntimeJobObservationSchema>;
export type RuntimeRequestId = z.infer<typeof RuntimeRequestIdSchema>;
export type RuntimeAttemptId = z.infer<typeof RuntimeAttemptIdSchema>;
export type RuntimeAttachmentId = z.infer<typeof RuntimeAttachmentIdSchema>;
export type RuntimeConversationId = z.infer<typeof RuntimeConversationIdSchema>;
export type RuntimeTaskId = z.infer<typeof RuntimeTaskIdSchema>;
export type RuntimeJobId = z.infer<typeof RuntimeJobIdSchema>;
export type RuntimeReceiptId = z.infer<typeof RuntimeReceiptIdSchema>;
export type RuntimeTerminalToolResult = z.infer<typeof RuntimeTerminalToolResultSchema>;
export type RuntimeTerminalReceipt = z.infer<typeof RuntimeTerminalReceiptSchema>;
