import { z } from 'zod';
import { RuntimeCacheObservationSchema, RuntimeMachineIdSchema } from './base.js';

/** The one status summary of a workspace. UI, agent and CLI all read it; nothing else derives status. */
export const RuntimeWorkspaceStatusSchema = z.object({
  cloud: z.object({ version: z.string().nullable(), conflicts: z.array(z.string()) }),
  machines: z.array(z.object({
    machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative(),
    online: z.boolean(),
    /** Online, checkout exists and sync is running. */
    ready: z.boolean(),
    setup: RuntimeCacheObservationSchema.shape.setup,
    sync: z.object({
      lastSyncAt: z.iso.datetime().nullable(),
      /** Local changes the machine has not sent; `null` until it reports them. */
      unsent: z.number().int().nonnegative().nullable(),
      /** The cloud has changes the machine has not applied yet. */
      unapplied: z.boolean(),
      problem: z.string().nullable(),
      conflicts: z.array(z.string()),
    }),
  })),
});
export type RuntimeWorkspaceStatus = z.infer<typeof RuntimeWorkspaceStatusSchema>;
