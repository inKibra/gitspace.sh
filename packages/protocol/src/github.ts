import { z } from 'zod';
import { wire } from './json-wire.js';

/** GitHub login: an account or organization name. */
export const GitHubLoginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);
/** A repository GitHub names `owner/name`. */
export const GitHubRepositoryNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u);
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/iu;
/** The `owner/name` of a project remote on GitHub (HTTPS, scp-style SSH or ssh:// form), or null for any other remote. */
export function githubRepositoryOf(reference: string): string | null {
  const match = GITHUB_REMOTE.exec(reference.trim())?.[1];
  return match !== undefined && GitHubRepositoryNameSchema.safeParse(match).success ? match : null;
}
/** Reading fetches and imports; writing pushes branches, workflow files included. */
export type GitHubRepositoryAccess = 'read' | 'write';
/** A short-lived installation token narrowed to one repository. */
export const GitHubRepositoryTokenSchema = z.object({ token: z.string().min(1), expiresAt: z.string().datetime() });
export type GitHubRepositoryToken = z.infer<typeof GitHubRepositoryTokenSchema>;
/** How a machine checkout reaches its project's origin: a repository an installation of the account's GitHub App
 * covers only over HTTPS with installation tokens, any other origin with the account SSH key. */
export const MachineOriginAccessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-app'), repository: GitHubRepositoryNameSchema }),
  z.object({ kind: z.literal('ssh') }),
]);
export type MachineOriginAccess = z.infer<typeof MachineOriginAccessSchema>;

export const GitHubAccountSchema = z.object({ login: GitHubLoginSchema, kind: z.enum(['user', 'organization']) });

/** Who owns the tenant's App: the signed-in person's account by default, or an organization they administer. */
export const GitHubAppOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('organization'), login: GitHubLoginSchema }),
]);
export type GitHubAppOwner = z.infer<typeof GitHubAppOwnerSchema>;

export const GitHubAppViewSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  htmlUrl: z.string().url(),
  owner: GitHubAccountSchema,
  createdAt: z.string().datetime(),
  /** When the private key GitSpace signs with was last stored (creation or rotation). */
  keyUpdatedAt: z.string().datetime(),
});
export type GitHubAppView = z.infer<typeof GitHubAppViewSchema>;

/** A tenant project whose recorded remote is a repository an installation covers. */
export const GitHubLinkedProjectSchema = z.object({ id: z.string().min(1), name: z.string(), repository: GitHubRepositoryNameSchema });

export const GitHubInstallationViewSchema = z.object({
  id: z.number().int().positive(),
  account: GitHubAccountSchema,
  repositorySelection: z.enum(['all', 'selected']),
  repositories: z.array(GitHubRepositoryNameSchema),
  permissions: z.record(z.string(), z.string()),
  installedAt: z.string().datetime(),
  projects: z.array(GitHubLinkedProjectSchema),
});
export type GitHubInstallationView = z.infer<typeof GitHubInstallationViewSchema>;

/** One webhook delivery, recorded once by its `X-GitHub-Delivery` id. */
export const GitHubDeliveryViewSchema = z.object({
  id: z.string().min(1).max(100),
  event: z.string().min(1).max(100),
  action: z.string().max(100).nullable(),
  installationId: z.number().int().positive().nullable(),
  repository: z.string().max(200).nullable(),
  receivedAt: z.string().datetime(),
  /** What GitSpace did with it, in a few words ("recorded", "installation removed: not started from GitSpace"). */
  outcome: z.string().max(300),
});
export type GitHubDeliveryView = z.infer<typeof GitHubDeliveryViewSchema>;

export const GitHubStateSchema = z.object({
  app: GitHubAppViewSchema.nullable(),
  installations: z.array(GitHubInstallationViewSchema),
  /** Organizations where an install was requested and waits for an organization owner's approval on GitHub. */
  pendingRequests: z.array(z.object({ requestedAt: z.string().datetime() })),
  /** The latest deliveries, newest first. */
  deliveries: z.array(GitHubDeliveryViewSchema),
});
export type GitHubState = z.infer<typeof GitHubStateSchema>;

/** A browser form POST to GitHub: `action` with one hidden field `manifest`. */
export const GitHubAppManifestFormSchema = z.object({ action: z.string().url(), manifest: z.string().min(2).max(16_384) });
export type GitHubAppManifestForm = z.infer<typeof GitHubAppManifestFormSchema>;

export const GitHubStateCodec = wire.serializable((value): value is GitHubState => GitHubStateSchema.safeParse(value).success, { id: 'gitspace/github-state/v1', jsonSchema: GitHubStateSchema });
export const GitHubAppOwnerCodec = wire.serializable((value): value is GitHubAppOwner => GitHubAppOwnerSchema.safeParse(value).success, { id: 'gitspace/github-app-owner/v1', jsonSchema: GitHubAppOwnerSchema });
export const GitHubAppManifestFormCodec = wire.serializable((value): value is GitHubAppManifestForm => GitHubAppManifestFormSchema.safeParse(value).success, { id: 'gitspace/github-app-manifest-form/v1', jsonSchema: GitHubAppManifestFormSchema });
