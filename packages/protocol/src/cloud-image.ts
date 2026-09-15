import { wire } from 'result-rpc';
import { z } from 'zod';

/** Registry-qualified OCI reference. Tags and unqualified Docker names are not immutable choices. */
export const cloudImageReferenceSchema = z.string().max(1024).regex(
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?=:[0-9])|\[[a-f0-9:]+\])(?::[0-9]{1,5})?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u,
  'Use a registry-qualified image pinned with @sha256 and a 64-character lowercase digest',
);
export const cloudImageSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform-default') }).strict(),
  z.object({ kind: z.literal('custom'), image: cloudImageReferenceSchema }).strict(),
]);
export type CloudImageSelection = z.infer<typeof cloudImageSelectionSchema>;
export const cloudImageChoiceSchema = z.object({ kind: z.enum(['platform-default', 'custom']), image: cloudImageReferenceSchema }).strict();
export type CloudImageChoice = z.infer<typeof cloudImageChoiceSchema>;
export const cloudImageDiscardReceiptSchema = z.object({ machineId: z.string(), operationId: z.string().uuid(), recoveryOperationId: z.string().uuid(), stopped: z.literal(true) }).strict();
export type CloudImageDiscardReceipt = z.infer<typeof cloudImageDiscardReceiptSchema>;
export const cloudImagePhaseSchema = z.enum(['staging', 'checkpointing', 'discarding', 'fencing', 'replacing', 'resuming', 'confirming', 'cancelling', 'complete', 'cancelled']);
export const cloudImageOperationSchema = z.object({
  id: z.string().uuid(), phase: cloudImagePhaseSchema, barrier: z.boolean(),
  startedAt: z.number(), updatedAt: z.number(), error: z.string().nullable(),
  resumeSpaceIds: z.array(z.string()),
  /** Explicitly supersedes a failed image operation without releasing its admission barrier. */
  recoveryOf: z.string().uuid().optional(),
  discardApproval: z.object({ deviceId: z.string().min(1), at: z.number() }).strict().optional(),
  discardOperationId: z.string().uuid().optional(),
  discardReceipt: cloudImageDiscardReceiptSchema.optional(),
}).strict();
export const cloudImageStateSchema = z.object({
  /** Last image confirmed ready; during replacement the operation phase describes availability. */
  machineId: z.string(), currentImage: cloudImageReferenceSchema.nullable(),
  desiredImage: cloudImageReferenceSchema.nullable(), selection: cloudImageSelectionSchema,
  operation: cloudImageOperationSchema.nullable(),
}).strict();
export type CloudImageState = z.infer<typeof cloudImageStateSchema>;
export const cloudImageProviderStatusSchema = z.object({
  image: cloudImageReferenceSchema.nullable(), operationId: z.string().nullable(), prepared: z.boolean(),
  /** Set before container start, including custom ENTRYPOINT/CMD; false proves no start attempt, null is unknown. */
  runtimeStarted: z.boolean().nullable(),
});
export const cloudImagePreparedSchema = z.object({ image: cloudImageReferenceSchema, deploymentId: z.string().min(1) });
export const CloudImageSelectionCodec = wire.serializable((value): value is CloudImageSelection => cloudImageSelectionSchema.safeParse(value).success, { id: 'gitspace/cloud-image-selection/v1' });
export const CloudImageChoiceCodec = wire.serializable((value): value is CloudImageChoice => cloudImageChoiceSchema.safeParse(value).success, { id: 'gitspace/cloud-image-choice/v1' });
export const CloudImageStateCodec = wire.serializable((value): value is CloudImageState => cloudImageStateSchema.safeParse(value).success, { id: 'gitspace/cloud-image-state/v1' });
export function cloudImageOperationActive(state: CloudImageState | null | undefined): boolean {
  return !!state?.operation && state.operation.phase !== 'complete' && state.operation.phase !== 'cancelled';
}
export function cloudImageOperationCancellable(state: CloudImageState): boolean {
  return !state.operation?.recoveryOf && (state.operation?.phase === 'staging' || state.operation?.phase === 'checkpointing' || state.operation?.phase === 'cancelling');
}
