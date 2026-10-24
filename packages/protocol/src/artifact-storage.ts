import { z } from 'zod';

/** Canonical drive manifest, shared by machine and cloud readers. */
export const artifactManifestSchema = z.object({
  version: z.literal(1),
  scopeId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  entries: z.array(z.object({
    path: z.string().min(1).refine((path) =>
      !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
      && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
    blobHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    size: z.number().int().nonnegative(),
    mediaType: z.string().nullable(),
    /** Set for a file streamed before its digest was known: the id of its object (`driveUploadObjectKey`), read against
     * `blobHash` and `size`. Absent: the object named by `blobHash` (`artifactObjectKey`). */
    object: z.string().uuid().optional(),
  })),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

/** Append-only provenance for an independent copy, not a relationship between live paths. */
export interface ArtifactCopyRecord {
  id: string;
  sourceScopeId: string;
  sourceWorkspaceId: string;
  sourceGeneration: number;
  sourcePath: string;
  sourceHash: `sha256:${string}`;
  destinationScopeId: string;
  destinationPath: string;
  destinationHash: `sha256:${string}`;
  destinationGeneration: number;
  createdAt: string;
}

export interface ArtifactShareRecord {
  token: string;
  scopeId: string;
  workspaceId: string;
  path: string;
  hash: `sha256:${string}`;
  size: number;
  mediaType: string | null;
  /** The manifest entry's `object` when the shared version was streamed (see `artifactManifestSchema`). */
  object?: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** Plaintext bytes one `data.put` may carry, and the uniform part size of a multipart tenant object (the last part may be
 * smaller). Larger objects use the `data.multipart.*` operations. */
export const TENANT_OBJECT_PART_BYTES = 32 * 1024 * 1024;
export const DATA_PUT_MAX_BYTES = TENANT_OBJECT_PART_BYTES;

/** The largest drive file: uploads, machine transfers, browser downloads and captures. */
export const DRIVE_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/** The storage prefix of one drive scope's objects under its account's storage prefix (`users/<account>/`). */
export function driveScopeKeyPrefix(accountId: string, scopeId: string): string {
  if (!/^space:[A-Za-z0-9._-]{1,128}$/u.test(scopeId)) throw new Error('Artifact scope is invalid');
  const account = btoa(String.fromCharCode(...new TextEncoder().encode(accountId))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `accounts/${account}/artifacts/${scopeId}/`;
}

/** Where a drive file streamed before its digest was known lives: one multipart object per upload, named by its id. */
export function driveUploadObjectKey(accountId: string, scopeId: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new Error('Drive upload id is invalid');
  return `${driveScopeKeyPrefix(accountId, scopeId)}upload/${id}`;
}

/** Where a drive object lives under its account's storage prefix (`users/<account>/`). Names are content addressed per
 * scope: `hash` is the reference a drive manifest records (the plaintext SHA-256 of objects written since storage moved
 * to R2 SSE-C), and the scope segment keeps one plaintext stored in two scopes at two names, each under its own key. */
export function artifactObjectKey(accountId: string, scopeId: string, hash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error('Artifact hash is invalid');
  return `${driveScopeKeyPrefix(accountId, scopeId)}sha256/${hash.slice(7)}`;
}

/** Signed payloads of the data endpoint (`/v1/data/<key>`) beyond `key`. Objects carry plaintext; the account encrypts
 * them at rest under their scope's key. Drive objects also name the workspace (`projectId`, `workspaceId`) the machine is
 * attached to: its drive is writable, and the drives its sessions read are readable. */
const sha256Schema = z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]);
const uploadIdSchema = z.string().min(1).max(1_024);
const partNumberSchema = z.number().int().min(1).max(10_000);
/** `data.head` and `data.get`: the digest the reader expects, if any. A drive file streamed before its digest was known
 * (`driveUploadObjectKey`) records none itself, so it is read only with the digest its manifest entry names. */
export const dataObjectReadSchema = z.object({ hash: sha256Schema.optional() });
/** `data.put` (size at most `DATA_PUT_MAX_BYTES`) and `data.multipart.create` (the whole object). */
export const dataObjectWriteSchema = z.object({ hash: sha256Schema, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
/** `data.multipart.part`: the digest and size of this part's bytes. */
export const dataMultipartPartSchema = z.object({ uploadId: uploadIdSchema, partNumber: partNumberSchema, hash: sha256Schema, size: z.number().int().min(1).max(TENANT_OBJECT_PART_BYTES) });
export const dataMultipartCompleteSchema = z.object({ uploadId: uploadIdSchema, parts: z.array(z.object({ partNumber: partNumberSchema, etag: z.string().min(1).max(256) })).min(1).max(10_000) });
export const dataMultipartAbortSchema = z.object({ uploadId: uploadIdSchema });
