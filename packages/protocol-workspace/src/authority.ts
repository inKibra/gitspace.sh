import { z } from 'zod';
import { WorkspaceFailureSchema, type WorkspaceFailure } from './errors.js';

export const SpaceAuthorityStateSchema = z.enum(['open', 'closing', 'closed', 'opening']);
export type SpaceAuthorityState = z.infer<typeof SpaceAuthorityStateSchema>;
export const SpaceAuthorityRecordSchema = z.object({
  projectId: z.string(), spaceId: z.string(), state: SpaceAuthorityStateSchema,
  machineId: z.string().nullable(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  checkpointRevision: z.number().int().nonnegative(), publishedRevision: z.number().int().nonnegative(),
  manifestKey: z.string().nullable(), manifestHash: z.string().nullable(),
  failures: z.object({ open: WorkspaceFailureSchema.nullable(), close: WorkspaceFailureSchema.nullable() }),
  resumeMachineId: z.string().nullable(), updatedAt: z.string(),
}).strict();
export type SpaceAuthorityRecord = z.infer<typeof SpaceAuthorityRecordSchema>;
export type SpaceAuthorityResult<T> = { status: 'ok'; value: T } | { status: 'error'; failure: WorkspaceFailure };
