import { z } from 'zod';

export const GitLfsObjectSchema = z.object({
  oid: z.string().regex(/^[a-f0-9]{64}$/u).brand<'GitLfsOid'>(),
  size: z.number().int().nonnegative().safe(),
});
export type GitLfsObject = z.infer<typeof GitLfsObjectSchema>;
export const GitLfsLocationSchema = z.object({ origin: z.string().min(1), endpoint: z.url() });
export type GitLfsLocation = z.infer<typeof GitLfsLocationSchema>;
export const GitLfsConfirmedObjectSchema = GitLfsObjectSchema.extend({ location: GitLfsLocationSchema });
export type GitLfsConfirmedObject = z.infer<typeof GitLfsConfirmedObjectSchema>;
export const GitLfsHeldBackSchema = z.object({
  path: z.string().min(1).refine(path => !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git')),
  kind: z.enum(['modified', 'added', 'staged']),
});
export type GitLfsHeldBack = z.infer<typeof GitLfsHeldBackSchema>;
export const GitLfsRestoredSchema = z.object({
  path: GitLfsHeldBackSchema.shape.path,
  outcome: z.enum(['committed', 'omitted']),
});
export type GitLfsRestored = z.infer<typeof GitLfsRestoredSchema>;
export const GitLfsSnapshotSchema = z.object({
  objects: z.array(z.discriminatedUnion('source', [
    GitLfsObjectSchema.extend({ source: z.literal('r2') }),
    GitLfsObjectSchema.extend({ source: z.literal('origin'), location: GitLfsLocationSchema.optional() }),
  ])),
  heldBack: z.array(GitLfsHeldBackSchema),
});
export type GitLfsSnapshot = z.infer<typeof GitLfsSnapshotSchema>;
export const GitLfsOriginConfirmationSchema = GitLfsLocationSchema.extend({
  objects: z.array(GitLfsObjectSchema),
});
export type GitLfsOriginConfirmation = z.infer<typeof GitLfsOriginConfirmationSchema>;
export const GitLfsProtectionSchema = z.object({ objects: z.array(GitLfsObjectSchema) });

/** Plaintext interface; implementations encrypt storage and verify oid/size. */
export type GitLfsStore = {
  has(object: GitLfsObject): Promise<boolean>;
  /** Pins this publication before checking existence, without downloading payloads. */
  protect?(objects: readonly GitLfsObject[]): Promise<GitLfsObject[]>;
  put(object: GitLfsObject, bytes: Uint8Array): Promise<void>;
  get(object: GitLfsObject): Promise<Uint8Array | null>;
};

/** Git LFS pointers are small ASCII blobs, never payloads. */
export function parseGitLfsPointer(bytes: Uint8Array): GitLfsObject | null {
  if (bytes.byteLength > 1024) return null;
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n')) return null;
  const oid = /^oid sha256:([a-f0-9]{64})$/mu.exec(text)?.[1];
  const size = /^size ([0-9]+)$/mu.exec(text)?.[1];
  const parsed = GitLfsObjectSchema.safeParse({ oid, size: size === undefined ? undefined : Number(size) });
  return parsed.success ? parsed.data : null;
}
