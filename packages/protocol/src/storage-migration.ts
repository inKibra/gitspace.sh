import { z } from 'zod';

/**
 * The one-time move of a tenant's stored objects from the retired envelope format to R2 SSE-C (`sse/<name>`), run by
 * hand through `storage.migration.*` control operations. Delete with the migration.
 */
export const storageMigrationClassSchema = z.enum([
  /** `accounts/<account>/artifacts/sha256/<hex>`: drive files, their manifests and the parts of chunked drive files. */
  'drive',
  /** `lfs/projects/<project>/objects/<oid>`. */
  'lfs',
  /** `lfs/projects/<project>/objects/<oid>.chunks/<hex>`. */
  'lfsChunk',
  /** `projects/<project>/spaces/<space>/checkpoints/<revision>/manifest.enc` and `…/artifacts/manifests/<revision>/<generation>.enc`. */
  'checkpoint',
  /** `<checkpoint or OMP object>.chunks/<hex>`. */
  'checkpointChunk',
  /** `projects/<project>/spaces/<space>/agent/omp/<revision>.enc`. */
  'omp',
  /** Any other name: reported, never read or changed. */
  'other',
]);
export type StorageMigrationClass = z.infer<typeof storageMigrationClassSchema>;

const tallySchema = z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() });
export const storageMigrationInventorySchema = z.object({
  objects: tallySchema,
  classes: z.record(storageMigrationClassSchema, tallySchema),
  /** `other` objects by their first two name segments. */
  otherPrefixes: z.record(z.string(), tallySchema),
});
export type StorageMigrationInventory = z.infer<typeof storageMigrationInventorySchema>;

export const storageMigrationPhaseSchema = z.enum(['idle', 'inventory', 'references', 'scan', 'convert', 'converted', 'verify', 'verified', 'purge', 'purged']);
const problemSchema = z.object({ key: z.string(), class: storageMigrationClassSchema, size: z.number().int().nonnegative(), error: z.string().nullable() });

export const storageMigrationStatusSchema = z.object({
  phase: storageMigrationPhaseSchema,
  /** An alarm is scheduled to continue the phase. */
  running: z.boolean(),
  cursor: z.string().nullable(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The last error that stopped a step; the next alarm or `start` retries it. */
  error: z.string().nullable(),
  inventory: storageMigrationInventorySchema,
  /** Rows by state: `pending` (to convert), `converted` (one `sse/` object written), `joined` (a chunk or part folded
   * into its converted object), `chunk` (a chunk no converted object named), `part` (a drive part waiting for its
   * object), `orphan` (a drive object no known scope opens), `failed`, `skipped` (`other`). */
  states: z.record(z.string(), tallySchema),
  verify: z.object({ ok: z.number().int().nonnegative(), mismatch: z.number().int().nonnegative(), unverified: z.number().int().nonnegative() }),
  purged: tallySchema,
  /** At most 100 of each, by name. */
  orphans: z.array(problemSchema),
  failures: z.array(problemSchema),
  mismatches: z.array(problemSchema),
});
export type StorageMigrationStatus = z.infer<typeof storageMigrationStatusSchema>;

export const storageMigrationStatusInputSchema = z.object({
  /** Lists and classifies the tenant's objects now, without storing or changing anything. */
  dryRun: z.boolean().optional(),
}).strict();

export const storageMigrationDryRunSchema = z.object({ dryRun: z.literal(true), inventory: storageMigrationInventorySchema });
