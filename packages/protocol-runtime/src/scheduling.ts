import { z } from 'zod';

/** Resource selection is available only at task/process dispatch, never ordinary file tools. */
export const RuntimeMachineSelectorSchema = z.union([
  z.string().min(1),
  z.object({ needs: z.array(z.string().min(1)).optional(), profile: z.string().min(1).optional(), prefer: z.literal('idle').optional() }).strict(),
]);
/** Strings name current, an exact commit, or a branch in this workspace repository. */
export const RuntimeSourceSelectorSchema = z.string().min(1);
export const RuntimeDispatchSelectionSchema = z.object({ on: RuntimeMachineSelectorSchema.optional(), at: RuntimeSourceSelectorSchema.optional() });
export const RuntimeExecutionObservationSchema = z.object({ activeExecutions: z.number().int().nonnegative(), observedAt: z.iso.datetime() }).strict();
export type RuntimeMachineSelector = z.infer<typeof RuntimeMachineSelectorSchema>;
export type RuntimeDispatchSelection = z.infer<typeof RuntimeDispatchSelectionSchema>;
export type RuntimeExecutionObservation = z.infer<typeof RuntimeExecutionObservationSchema>;
