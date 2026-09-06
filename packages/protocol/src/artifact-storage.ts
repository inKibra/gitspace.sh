import { z } from 'zod';

/** Canonical encrypted artifact manifest, shared by machine and cloud readers. */
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
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export async function deriveArtifactScopeKey(projectKey: Uint8Array, scopeId: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new Uint8Array(projectKey).buffer, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('gitspace-artifacts-v1'),
    info: new TextEncoder().encode(scopeId),
  }, material, 256);
  return new Uint8Array(bits);
}
