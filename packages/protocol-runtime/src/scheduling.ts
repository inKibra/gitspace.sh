import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';

/** Capabilities a machine must offer; the same list a tool's `on: { needs }` names. */
export const RuntimeMachineNeedsSchema = z.array(z.string().min(1));
/** Resource selection is available only at task/process dispatch, never ordinary file tools. */
export const RuntimeMachineSelectorSchema = z.union([
  z.string().min(1),
  z.object({ needs: RuntimeMachineNeedsSchema.optional(), profile: z.string().min(1).optional(), prefer: z.literal('idle').optional() }).strict(),
]);
export const RuntimeDispatchSelectionSchema = z.object({ on: RuntimeMachineSelectorSchema.optional() });
export const RuntimeExecutionObservationSchema = z.object({
  activeExecutions: z.number().int().nonnegative(), observedAt: z.iso.datetime(),
  materializedCommit: RuntimeGitCheckpointSchema.shape.worktreeCommit.nullable().optional(),
}).strict();
export type RuntimeMachineSelector = z.infer<typeof RuntimeMachineSelectorSchema>;
export type RuntimeDispatchSelection = z.infer<typeof RuntimeDispatchSelectionSchema>;
export type RuntimeExecutionObservation = z.infer<typeof RuntimeExecutionObservationSchema>;
