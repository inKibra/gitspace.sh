import { z } from 'zod';
import { RuntimeIdentitySchema } from './base.js';

/** One text-only draft for the workspace's root conversation. */
export const WORKSPACE_DRAFT_MAX_LENGTH = 256 * 1024;
export const WorkspaceDraftTextSchema = z.string().max(WORKSPACE_DRAFT_MAX_LENGTH);
export const WorkspaceDraftSchema = z.object({
  text: WorkspaceDraftTextSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
  deviceId: z.string().min(1).nullable(),
});
export type WorkspaceDraft = z.infer<typeof WorkspaceDraftSchema>;
export const WorkspaceDraftSaveSchema = z.object({ text: WorkspaceDraftTextSchema, expectedRevision: z.number().int().nonnegative() });
export type WorkspaceDraftSave = z.infer<typeof WorkspaceDraftSaveSchema>;
export const RuntimeDraftSaveInputSchema = RuntimeIdentitySchema.extend(WorkspaceDraftSaveSchema.shape);
export type RuntimeDraftSaveInput = z.infer<typeof RuntimeDraftSaveInputSchema>;
export const WorkspaceDraftSaveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), draft: WorkspaceDraftSchema }),
  z.object({ status: z.literal('conflict'), draft: WorkspaceDraftSchema }),
]);
export type WorkspaceDraftSaveResult = z.infer<typeof WorkspaceDraftSaveResultSchema>;
export function emptyWorkspaceDraft(): WorkspaceDraft { return { text: '', revision: 0, updatedAt: null, deviceId: null }; }
