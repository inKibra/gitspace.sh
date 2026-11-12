import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';

/** Capabilities a machine must offer; the same list a tool's `on: { needs }` names. */
export const RuntimeMachineNeedsSchema = z.array(z.string().min(1)).describe('Capabilities the machine must offer: a platform (darwin-arm64), operating system (darwin, macos, linux), architecture (arm64, x64) or tool.');
/** Resource selection is available only at task/process dispatch, never ordinary file tools. */
export const RuntimeMachineSelectorSchema = z.union([
  z.string().min(1),
  z.object({ needs: RuntimeMachineNeedsSchema.optional(), profile: z.string().min(1).optional().describe('Environment profile the machine must be set up with.'), prefer: z.literal('idle').optional().describe('idle: of the matching machines, the least busy.') }).strict(),
]).describe('Attached machine to run on: its id or label, or what it must offer; the one ready machine when omitted.');
export const RuntimeDispatchSelectionSchema = z.object({ on: RuntimeMachineSelectorSchema.optional() });
export const RuntimeExecutionObservationSchema = z.object({
  activeExecutions: z.number().int().nonnegative(), observedAt: z.iso.datetime(),
  materializedCommit: RuntimeGitCheckpointSchema.shape.worktreeCommit.nullable().optional(),
}).strict();
export type RuntimeMachineSelector = z.infer<typeof RuntimeMachineSelectorSchema>;
export type RuntimeDispatchSelection = z.infer<typeof RuntimeDispatchSelectionSchema>;
export type RuntimeExecutionObservation = z.infer<typeof RuntimeExecutionObservationSchema>;
