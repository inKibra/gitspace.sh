import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { GitLfsObjectSchema, spaceCheckpointManifestSchema } from '@gitspace/protocol-workspace';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u);
export const LegacySpaceMigrationInputSchema = z.object({ operationId: z.string().uuid(), projectId: id, workspaceId: id, expectedGeneration: z.number().int().positive().safe(), expectedManifestHash: hash }).strict();
export type LegacySpaceMigrationInput = z.infer<typeof LegacySpaceMigrationInputSchema>;
const historicalLfs = z.array(GitLfsObjectSchema).superRefine((objects, context) => {
  if (new Set(objects.map(object => object.oid)).size !== objects.length) context.addIssue({ code: 'custom', message: 'Historical LFS inventory contains duplicate object identities' });
});
/** Current blobs that cannot be LFS pointers. Reading every checkpoint blob back through the Artifacts binding inside
 * one Durable Object request exceeds the 128 MB isolate limit for ordinary 20 MB trees, and the binding fails outright
 * on a valid 26.6 MB blob (INTERNAL_ERROR 10400). The migration client instead fetches the published checkpoint back
 * through Git transport, where index-pack verifies every object ID, and confirms each declared blob's exact size.
 * The Worker still reads blobs up to this size: they may be LFS pointers it must inventory. */
export const LEGACY_MIGRATION_TRANSPORT_VERIFIED_MIN_BYTES = 1024;
const transportVerifiedBlobs = z.array(z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/u), size: z.number().int().gt(LEGACY_MIGRATION_TRANSPORT_VERIFIED_MIN_BYTES).lte(32_000_000) }).strict()).superRefine((blobs, context) => {
  if (new Set(blobs.map(blob => blob.oid)).size !== blobs.length) context.addIssue({ code: 'custom', message: 'Transport-verified blob inventory contains duplicate object identities' });
});
export const LegacySpaceMigrationFinalizeInputSchema = LegacySpaceMigrationInputSchema.extend({ historicalLfs, transportVerifiedBlobs: transportVerifiedBlobs.default([]) });
export type LegacySpaceMigrationFinalizeInput = z.infer<typeof LegacySpaceMigrationFinalizeInputSchema>;
export const LegacyMigrationSourceSchema = z.object({ accountId: z.string(), projectId: id, workspaceId: id, generation: z.number().int().positive(), revision: z.number().int().positive(), manifestKey: z.string(), manifestHash: hash, sourceDigest: hash });
export type LegacyMigrationSource = z.infer<typeof LegacyMigrationSourceSchema>;
export const LegacySpaceMigrationReceiptSchema = z.object({
  operationId: z.string().uuid(), source: LegacyMigrationSourceSchema, conversationId: z.string(), importedEvents: z.number().int().nonnegative(), importedEntries: z.number().int().nonnegative(),
  checkpoint: RuntimeGitCheckpointSchema, historicalLfs, artifacts: z.object({ scopeId: z.string(), generation: z.number().int().nonnegative(), manifestHash: hash.nullable() }), activatedAt: z.iso.datetime(),
  branchAlignment: z.object({ project: z.object({ before: z.string(), after: z.string() }), workspace: z.object({ before: z.string(), after: z.string() }) }),
});
export type LegacySpaceMigrationReceipt = z.infer<typeof LegacySpaceMigrationReceiptSchema>;
export const LegacySpaceMigrationStageSchema = z.object({
  operationId: z.string().uuid(), source: LegacyMigrationSourceSchema,
  repository: spaceCheckpointManifestSchema.shape.repository.extend({ name: z.string() }),
  credentials: z.object({ remote: z.string(), plaintext: z.string(), expiresAt: z.iso.datetime() }),
});
export type LegacySpaceMigrationStage = z.infer<typeof LegacySpaceMigrationStageSchema>;
export const LegacySpaceMigrationStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), source: LegacyMigrationSourceSchema, repository: spaceCheckpointManifestSchema.shape.repository }),
  z.object({ state: z.literal('staging'), source: LegacyMigrationSourceSchema, repository: spaceCheckpointManifestSchema.shape.repository, lastPhase: z.string().optional() }),
  z.object({ state: z.literal('activated'), source: LegacyMigrationSourceSchema, receipt: LegacySpaceMigrationReceiptSchema }),
]);
export type LegacySpaceMigrationStatus = z.infer<typeof LegacySpaceMigrationStatusSchema>;
