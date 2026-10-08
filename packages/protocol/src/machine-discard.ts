import { TaggedError } from 'better-result';
import { z } from 'zod';
import { wire } from './json-wire.js';

export const machineDiscardConfirmationSchema = z.object({
  machineId: z.string().min(1), action: z.enum(['sleep', 'destroy']), token: z.string().min(1),
}).strict();
export type MachineDiscardConfirmation = z.infer<typeof machineDiscardConfirmationSchema>;
export const machineDiscardScopeSchema = z.object({
  projectId: z.string().min(1), workspaceId: z.string().min(1), generation: z.number().int().nonnegative(),
  reason: z.literal('unpublished-local-work'),
}).strict();
export const machineDiscardRequiredSchema = z.object({
  _tag: z.literal('MachineDiscardRequired'), message: z.string(),
  confirmation: machineDiscardConfirmationSchema, workspaces: z.array(machineDiscardScopeSchema),
});
export type MachineDiscardScope = z.infer<typeof machineDiscardScopeSchema>;
export const machineReplacementPreparedSchema = z.object({
  prepared: z.boolean(), discard: z.array(machineDiscardScopeSchema).optional(),
});
export class MachineDiscardRequired extends TaggedError('MachineDiscardRequired')<{
  message: string; confirmation: MachineDiscardConfirmation; workspaces: MachineDiscardScope[];
}> {}
export const MachineDiscardConfirmationCodec = wire.serializable((value): value is MachineDiscardConfirmation => machineDiscardConfirmationSchema.safeParse(value).success, { id: 'gitspace/machine-discard-confirmation/v1', jsonSchema: machineDiscardConfirmationSchema });
const failureDataSchema = machineDiscardRequiredSchema.omit({ _tag: true });
export const MachineDiscardRequiredCodec = wire.serializable((value): value is z.infer<typeof failureDataSchema> => failureDataSchema.safeParse(value).success, { id: 'gitspace/machine-discard-required/v1', jsonSchema: failureDataSchema });
