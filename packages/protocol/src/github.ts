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

/** Who did something on GitHub, as its webhook names them (people, or Apps' `name[bot]` users). */
const GitHubActorSchema = z.string().min(1).max(100);

/** An install GitSpace sent to GitHub that an organization owner has not answered. Repeats for one organization are
 * one request. */
export const GitHubInstallRequestViewSchema = z.object({
  id: z.string().min(1).max(100),
  /** Known when the request started from a project; null from Install on GitHub, since GitHub does not say. */
  organization: GitHubLoginSchema.nullable(),
  project: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
  repository: GitHubRepositoryNameSchema.nullable(),
  firstRequestedAt: z.string().datetime(),
  lastRequestedAt: z.string().datetime(),
  times: z.number().int().positive(),
});
export type GitHubInstallRequestView = z.infer<typeof GitHubInstallRequestViewSchema>;

/** An installation that arrived while a request whose organization GitSpace does not know was pending. GitSpace does
 * not use it until the account confirms it, and uninstalls it at `removeAt`. */
export const GitHubUnconfirmedInstallationViewSchema = z.object({
  id: z.number().int().positive(),
  account: GitHubAccountSchema,
  installedBy: GitHubActorSchema,
  installedAt: z.string().datetime(),
  removeAt: z.string().datetime(),
  repositorySelection: z.enum(['all', 'selected']),
  /** The selected repositories as the install reported them; empty for all repositories. */
  repositories: z.array(GitHubRepositoryNameSchema),
});
export type GitHubUnconfirmedInstallationView = z.infer<typeof GitHubUnconfirmedInstallationViewSchema>;

/** An installation GitSpace uninstalled because no request could be for it and the App's owner did not make it. */
export const GitHubRemovedInstallationViewSchema = z.object({
  account: GitHubLoginSchema,
  installedBy: GitHubActorSchema,
  removedAt: z.string().datetime(),
});
export type GitHubRemovedInstallationView = z.infer<typeof GitHubRemovedInstallationViewSchema>;

/** A kept installation someone uninstalled on GitHub, shown until dismissed or installed again. */
export const GitHubUninstalledInstallationViewSchema = z.object({
  id: z.number().int().positive(),
  account: GitHubAccountSchema,
  uninstalledBy: GitHubActorSchema,
  uninstalledAt: z.string().datetime(),
  projects: z.array(GitHubLinkedProjectSchema),
});
export type GitHubUninstalledInstallationView = z.infer<typeof GitHubUninstalledInstallationViewSchema>;

/** The person's own GitHub login. Workspace agents post on GitHub as the person (they run `gh` signed in as them), so
 * automations deliver nothing this login authored. `source`: saved in Settings, or the owner of a user-owned App when
 * nothing is saved; null login when neither is known. */
export const GitHubPersonSchema = z.object({ login: GitHubLoginSchema.nullable(), source: z.enum(['settings', 'app-owner']).nullable() });
export type GitHubPerson = z.infer<typeof GitHubPersonSchema>;

export const GitHubStateSchema = z.object({
  app: GitHubAppViewSchema.nullable(),
  person: GitHubPersonSchema,
  installations: z.array(GitHubInstallationViewSchema),
  /** Oldest first. */
  requests: z.array(GitHubInstallRequestViewSchema),
  unconfirmed: z.array(GitHubUnconfirmedInstallationViewSchema),
  /** Newest first; the latest `GITHUB_REMOVED_KEPT`. */
  removed: z.array(GitHubRemovedInstallationViewSchema),
  uninstalled: z.array(GitHubUninstalledInstallationViewSchema),
  /** The latest deliveries, newest first. */
  deliveries: z.array(GitHubDeliveryViewSchema),
});
export type GitHubState = z.infer<typeof GitHubStateSchema>;
/** How many removed installations GitSpace keeps listed. */
export const GITHUB_REMOVED_KEPT = 50;

/** The machine attached to a project's base workspace. Without the App it is the project's bridge to GitHub: it reads
 * and fetches the origin with its own git credentials (the account SSH key). `online`: it holds a live relay connection. */
export const GitHubProjectBridgeSchema = z.object({ machineId: z.string().min(1), label: z.string(), online: z.boolean() });
export type GitHubProjectBridge = z.infer<typeof GitHubProjectBridgeSchema>;

/** Whether the cloud reads a project's repository itself, and if not, what stands in the way of the App and which machine
 * bridges it meanwhile. A private GitHub repository the App does not cover is read through the machine attached to the
 * project's base workspace (`bridge`, null when none is); the App, named by `appName` (null before the account creates
 * one), adds pull requests, checks, GitHub-event automations and syncing with no machine. `awaitsCopy`: the cloud's
 * import was refused and the project's repository waits, empty, for one of the account's machines to copy the base
 * branch in (`project.seed`). */
export const GitHubProjectAccessSchema = z.discriminatedUnion('state', [
  /** Not on GitHub, public, or covered by an installation. */
  z.object({ state: z.literal('ready') }),
  /** Not on GitHub or public, but the cloud's import of `origin` was refused (private outside GitHub, or larger than the
   * import limit): the project's repository waits for one of the account's machines to copy the base branch in. */
  z.object({ state: z.literal('awaits-copy'), origin: z.string().min(1) }),
  /** Private, and the App is not installed on its owner. */
  z.object({ state: z.literal('needs-app'), repository: GitHubRepositoryNameSchema, organization: GitHubLoginSchema, appName: z.string().nullable(), bridge: GitHubProjectBridgeSchema.nullable(), awaitsCopy: z.boolean() }),
  /** Private, and an install on its owner waits for an organization owner. */
  z.object({ state: z.literal('requested'), repository: GitHubRepositoryNameSchema, organization: GitHubLoginSchema, appName: z.string(), request: GitHubInstallRequestViewSchema, bridge: GitHubProjectBridgeSchema.nullable(), awaitsCopy: z.boolean() }),
  /** Private, and the App is installed on its owner for other repositories only. */
  z.object({ state: z.literal('not-selected'), repository: GitHubRepositoryNameSchema, organization: GitHubLoginSchema, appName: z.string(), installation: GitHubInstallationViewSchema, bridge: GitHubProjectBridgeSchema.nullable(), awaitsCopy: z.boolean() }),
]);
export type GitHubProjectAccess = z.infer<typeof GitHubProjectAccessSchema>;

/** A browser form POST to GitHub: `action` with one hidden field `manifest`. */
export const GitHubAppManifestFormSchema = z.object({ action: z.string().url(), manifest: z.string().min(2).max(16_384) });
export type GitHubAppManifestForm = z.infer<typeof GitHubAppManifestFormSchema>;

export const GitHubStateCodec = wire.serializable((value): value is GitHubState => GitHubStateSchema.safeParse(value).success, { id: 'gitspace/github-state/v3', jsonSchema: GitHubStateSchema });
export const GitHubProjectAccessCodec = wire.serializable((value): value is GitHubProjectAccess => GitHubProjectAccessSchema.safeParse(value).success, { id: 'gitspace/github-project-access/v3', jsonSchema: GitHubProjectAccessSchema });
export const GitHubAppOwnerCodec = wire.serializable((value): value is GitHubAppOwner => GitHubAppOwnerSchema.safeParse(value).success, { id: 'gitspace/github-app-owner/v1', jsonSchema: GitHubAppOwnerSchema });
export const GitHubAppManifestFormCodec = wire.serializable((value): value is GitHubAppManifestForm => GitHubAppManifestFormSchema.safeParse(value).success, { id: 'gitspace/github-app-manifest-form/v1', jsonSchema: GitHubAppManifestFormSchema });
