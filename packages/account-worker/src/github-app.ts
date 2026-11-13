import { z } from 'zod';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import {
  GITHUB_REMOVED_KEPT, GitHubAppOwnerSchema, GitHubLoginSchema, GitHubRepositoryNameSchema, GitHubStateSchema, githubRepositoryOf,
  type GitHubAppManifestForm, type GitHubAppOwner, type GitHubInstallationView, type GitHubInstallRequestView, type GitHubPerson, type GitHubProjectAccess,
  type GitHubProjectBridge, type GitHubRepositoryAccess, type GitHubRepositoryToken, type GitHubState,
} from '@gitspace/protocol/github';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { AutomationEventSchema, automationEvent, type AutomationEvent, type WatchedItem } from './automation-events.js';
import type { AutomationWatchOn, PullRequestState } from '@gitspace/protocol/automations-contract';
import { GitHubApiError, base64url, githubRequest } from './github-api.js';
import { completeGuideReaderSignIn } from './guide-shares.js';
import { notifyBrowsers } from './live-notices.js';
import { notifyMachines } from './machine-notices.js';
import { AUTOMATION_DEFAULTS_REVISION } from './project-automations.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

const STATE_TTL_MS = 15 * 60_000;
/** How long an installation nothing explains stays before GitSpace uninstalls it: a setup callback carrying GitSpace's
 * state (an install on an account the person owns) can still claim it meanwhile. */
const UNCLAIMED_GRACE_MS = 10 * 60_000;
/** How long an installation that may answer a request of unknown organization waits for the account to confirm it. */
const CONFIRM_MS = 7 * 24 * 60 * 60_000;
const UNINSTALL_RETRY_MS = 5 * 60_000;
/** An installation token is reused while more than this remains of its hour. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const KEPT_DELIVERIES = 500;
/** A pull request's changed files are read up to GitHub's own limit for the endpoint. */
const PULL_REQUEST_FILE_PAGES = 30;
/** Check run conclusions that fail a pull request's checks; neutral and skipped ones pass. */
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, timed_out: true, cancelled: true, action_required: true, startup_failure: true, stale: true };
const LISTED_DELIVERIES = 50;
const REPOSITORY_PAGE_SIZE = 100;
const REPOSITORY_PAGES = 100;
/** GitHub caps webhook payloads at 25 MB. */
const WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_PERMISSIONS: Record<string, 'read' | 'write'> = {
  metadata: 'read', contents: 'write', workflows: 'write', pull_requests: 'write', issues: 'write', checks: 'write', statuses: 'write', deployments: 'read',
};
/** Installation events reach every App without subscribing, so they are not listed. `release` and `deployment_status`
 * reach watch automations (docs/AUTOMATIONS-DESIGN.md §4a). */
const DEFAULT_EVENTS = ['pull_request', 'pull_request_review', 'issue_comment', 'pull_request_review_comment', 'issues', 'push', 'check_suite', 'release', 'deployment_status'];
/** GitHub remotes as projects record them: https, scp-style SSH and ssh:// URLs, with or without `.git`. */

const GitHubAccountPayloadSchema = z.object({ login: GitHubLoginSchema, type: z.string() });
const ManifestConversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  html_url: z.string().url(),
  owner: GitHubAccountPayloadSchema,
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
});
const InstallationSchema = z.object({
  id: z.number().int().positive(),
  account: GitHubAccountPayloadSchema,
  repository_selection: z.enum(['all', 'selected']),
  permissions: z.record(z.string(), z.string()),
  created_at: z.string(),
});
const RepositoriesPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({ full_name: GitHubRepositoryNameSchema })),
});
/** Only what recording and routing a delivery reads; everything else in the payload is ignored. */
const DeliveryPayloadSchema = z.object({
  action: z.string().max(100).optional(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ full_name: z.string().max(200) }).optional(),
  /** `push`: the pushed ref, its new head, and whether the push deleted it. */
  ref: z.string().max(1_024).optional(),
  after: z.string().max(100).optional(),
  deleted: z.boolean().optional(),
  sender: z.object({ login: z.string().min(1).max(100) }).optional(),
});
/** An `installation.created` delivery: who installed the App where, and on which repositories. */
const InstallationCreatedSchema = z.object({
  installation: z.object({ id: z.number().int().positive(), account: GitHubAccountPayloadSchema, repository_selection: z.enum(['all', 'selected']) }),
  sender: z.object({ login: z.string().min(1).max(100) }),
  repositories: z.array(z.object({ full_name: GitHubRepositoryNameSchema })).optional(),
});
type InstallationCreated = z.infer<typeof InstallationCreatedSchema>;
/** A commit id as a push reports a branch's new head. */
const PushedHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
type DeliveryPayload = z.infer<typeof DeliveryPayloadSchema>;
const SetupActionSchema = z.enum(['install', 'update', 'request']);
type SetupAction = z.infer<typeof SetupActionSchema>;
type StatePurpose = 'create' | 'install';
/** What an install state was started for: a project's repository names the account it is meant for. */
interface InstallTarget {
  organization: string;
  projectId: string;
  repository: string;
}

interface AppRow extends Record<string, SqlStorageValue> {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  owner_login: string;
  owner_kind: string;
  client_id: string;
  created_at: number;
  key_updated_at: number;
}
interface InstallationRow extends Record<string, SqlStorageValue> {
  id: number;
  account_login: string;
  account_kind: string;
  repository_selection: string;
  permissions_json: string;
  installed_at: number;
}
interface DeliveryRow extends Record<string, SqlStorageValue> {
  id: string;
  event: string;
  action: string | null;
  installation_id: number | null;
  repository: string | null;
  received_at: number;
  outcome: string;
  /** The delivery as automations read it (`AutomationEvent`); null for events automations do not start on. */
  event_json: string | null;
}
/** An installation not kept yet. What its delivery said is null on rows recorded before GitSpace kept it. */
interface UnclaimedRow extends Record<string, SqlStorageValue> {
  installation_id: number;
  deadline: number;
  confirm: number;
  account_login: string | null;
  account_kind: string | null;
  installed_by: string | null;
  installed_at: number | null;
  repository_selection: string | null;
  repositories_json: string | null;
}
interface RequestRow extends Record<string, SqlStorageValue> {
  id: string;
  organization: string | null;
  project_id: string | null;
  repository: string | null;
  first_requested_at: number;
  last_requested_at: number;
  times: number;
}
/** A project whose remote is on GitHub; `repository` is lowercased `owner/name` for matching. */
interface RepositoryProject {
  id: string;
  name: string;
  repository: string;
}
/** Why a project is linked: the installation account and the repository name as GitHub reports it. */
interface ProjectLink {
  account: string;
  repository: string;
}

async function installationRepositories(token: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const result = await githubRequest(`/installation/repositories?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`, { token, schema: RepositoriesPageSchema });
    names.push(...result.repositories.map((repository) => repository.full_name));
    if (result.repositories.length < REPOSITORY_PAGE_SIZE || names.length >= result.total_count) return names;
  }
  throw new Error(`This installation covers more than ${REPOSITORY_PAGE_SIZE * REPOSITORY_PAGES} repositories; select fewer on GitHub`);
}

/** The raw body up to GitHub's payload cap; null beyond it. */
async function readWebhookBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > WEBHOOK_MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** GitHub's requests to the tenant: signed webhooks and the browser callbacks that end in Settings → GitHub. */
export async function githubRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const route = `${request.method} ${url.pathname}`;
  if (route !== 'POST /github/webhook' && route !== 'GET /github/app/created' && route !== 'GET /github/installed' && route !== 'GET /github/callback') return null;
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  if (route === 'GET /github/callback') return completeGuideReaderSignIn(request, env, url);
  const github = env.GITHUB_APP.getByName(env.ACCOUNT_ID);
  if (route === 'POST /github/webhook') {
    const event = request.headers.get('x-github-event') ?? '';
    const deliveryId = request.headers.get('x-github-delivery') ?? '';
    const signature = request.headers.get('x-hub-signature-256') ?? '';
    if (!/^[a-z_]{1,100}$/u.test(event) || !/^[A-Za-z0-9-]{1,100}$/u.test(deliveryId) || !signature) {
      return new Response('GitHub delivery headers are missing', { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    const body = await readWebhookBody(request);
    if (!body) return new Response('GitHub delivery is too large', { status: 413, headers: { 'cache-control': 'no-store' } });
    if (!await env.CREDENTIALS.getByName(env.ACCOUNT_ID).verifyGitHubWebhook(body, signature)) {
      return new Response('GitHub delivery signature rejected', { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    await github.webhook(event, deliveryId, new TextDecoder().decode(body));
    return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  }
  const target = new URL('/settings', env.ACCOUNT_URL);
  target.searchParams.set('section', 'github');
  try {
    if (route === 'GET /github/app/created') {
      await github.appCreated(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '');
      target.searchParams.set('github', 'created');
    } else {
      const setupAction = SetupActionSchema.safeParse(url.searchParams.get('setup_action'));
      if (!setupAction.success) throw new Error('GitHub sent an unknown setup action');
      const installationId = url.searchParams.get('installation_id') ?? '';
      target.searchParams.set('github', await github.installed({
        installationId: /^[1-9][0-9]{0,14}$/u.test(installationId) ? Number(installationId) : null,
        setupAction: setupAction.data,
        state: url.searchParams.get('state'),
      }));
    }
  } catch (error) {
    target.searchParams.set('github', 'error');
    target.searchParams.set('message', (error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
  return new Response(null, { status: 303, headers: { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/** The account's GitHub App: its public record, the installations GitSpace started, and recorded webhook deliveries.
 * Secrets live in the credential vault. */
export class GitHubAppDO extends BudgetedDurableObject {
  /** Installation tokens issued, by installation, repository and access; memory only, never stored. */
  private readonly issued = new Map<string, GitHubRepositoryToken>();
  /** A manifest conversion is in flight: a second callback must not create another App meanwhile. */
  private creating = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS app (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id INTEGER NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        html_url TEXT NOT NULL,
        owner_login TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        key_updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS states (
        state TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('create', 'install')),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installations (
        id INTEGER PRIMARY KEY,
        account_login TEXT NOT NULL,
        account_kind TEXT NOT NULL,
        repository_selection TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        installed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installation_repositories (
        installation_id INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        PRIMARY KEY (installation_id, full_name)
      );
      CREATE TABLE IF NOT EXISTS unclaimed_installations (
        installation_id INTEGER PRIMARY KEY,
        deadline INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS install_requests (
        id TEXT PRIMARY KEY,
        organization TEXT,
        project_id TEXT,
        repository TEXT,
        first_requested_at INTEGER NOT NULL,
        last_requested_at INTEGER NOT NULL,
        times INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS removed_installations (
        account_login TEXT NOT NULL,
        installed_by TEXT NOT NULL,
        removed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uninstalled_installations (
        id INTEGER PRIMARY KEY,
        account_login TEXT NOT NULL,
        account_kind TEXT NOT NULL,
        uninstalled_by TEXT NOT NULL,
        uninstalled_at INTEGER NOT NULL,
        projects_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_defaults (project_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS person (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), login TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT,
        installation_id INTEGER,
        repository TEXT,
        received_at INTEGER NOT NULL,
        outcome TEXT NOT NULL
      );
    `);
    const added: Array<[table: string, column: string, type: string]> = [
      ['deliveries', 'event_json', 'TEXT'],
      ['states', 'organization', 'TEXT'], ['states', 'project_id', 'TEXT'], ['states', 'repository', 'TEXT'],
      // An unclaimed installation that waits for confirmation (`confirm` 1) is shown with what its delivery said.
      ['unclaimed_installations', 'confirm', 'INTEGER NOT NULL DEFAULT 0'], ['unclaimed_installations', 'account_login', 'TEXT'],
      ['unclaimed_installations', 'account_kind', 'TEXT'], ['unclaimed_installations', 'installed_by', 'TEXT'],
      ['unclaimed_installations', 'installed_at', 'INTEGER'], ['unclaimed_installations', 'repository_selection', 'TEXT'],
      ['unclaimed_installations', 'repositories_json', 'TEXT'],
      // Projects given defaults before revisions were recorded received the first revision.
      ['automation_defaults', 'revision', 'INTEGER NOT NULL DEFAULT 1'],
    ];
    for (const [table, column, type] of added) {
      if (!ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(existing => existing.name === column)) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    // Requests recorded before organizations were: one request whose organization is unknown.
    if (ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_requests'").toArray().length > 0) {
      const pending = ctx.storage.sql.exec<{ first: number | null; last: number | null; times: number }>('SELECT MIN(requested_at) AS first, MAX(requested_at) AS last, COUNT(*) AS times FROM pending_requests').one();
      if (pending.first !== null && pending.last !== null) {
        ctx.storage.sql.exec('INSERT INTO install_requests(id, organization, project_id, repository, first_requested_at, last_requested_at, times) VALUES (?, NULL, NULL, NULL, ?, ?, ?)',
          base64url(crypto.getRandomValues(new Uint8Array(12))), pending.first, pending.last, pending.times);
      }
      ctx.storage.sql.exec('DROP TABLE pending_requests');
    }
  }

  async state(): Promise<GitHubState> {
    const projects = await this.repositoryProjects();
    const app = this.app();
    return GitHubStateSchema.parse({
      app: app ? {
        id: app.id, slug: app.slug, name: app.name, htmlUrl: app.html_url,
        owner: { login: app.owner_login, kind: app.owner_kind },
        createdAt: new Date(app.created_at).toISOString(), keyUpdatedAt: new Date(app.key_updated_at).toISOString(),
      } : null,
      person: this.person(),
      installations: this.installationViews(projects),
      requests: this.requestViews(projects),
      unconfirmed: this.ctx.storage.sql.exec<UnclaimedRow>('SELECT * FROM unclaimed_installations WHERE confirm = 1 ORDER BY installed_at, installation_id').toArray().map((row) => ({
        id: row.installation_id, account: { login: row.account_login, kind: row.account_kind },
        installedBy: row.installed_by, installedAt: new Date(row.installed_at ?? row.deadline).toISOString(), removeAt: new Date(row.deadline).toISOString(),
        repositorySelection: row.repository_selection, repositories: JSON.parse(row.repositories_json ?? '[]'),
      })),
      removed: this.ctx.storage.sql.exec<{ account_login: string; installed_by: string; removed_at: number }>('SELECT * FROM removed_installations ORDER BY removed_at DESC, rowid DESC').toArray()
        .map((row) => ({ account: row.account_login, installedBy: row.installed_by, removedAt: new Date(row.removed_at).toISOString() })),
      uninstalled: this.ctx.storage.sql.exec<{ id: number; account_login: string; account_kind: string; uninstalled_by: string; uninstalled_at: number; projects_json: string }>('SELECT * FROM uninstalled_installations ORDER BY uninstalled_at DESC').toArray()
        .map((row) => ({ id: row.id, account: { login: row.account_login, kind: row.account_kind }, uninstalledBy: row.uninstalled_by, uninstalledAt: new Date(row.uninstalled_at).toISOString(), projects: JSON.parse(row.projects_json) })),
      deliveries: this.ctx.storage.sql.exec<DeliveryRow>('SELECT * FROM deliveries ORDER BY received_at DESC, rowid DESC LIMIT ?', LISTED_DELIVERIES).toArray()
        .map((row) => ({
          id: row.id, event: row.event, action: row.action, installationId: row.installation_id,
          repository: row.repository, receivedAt: new Date(row.received_at).toISOString(), outcome: row.outcome,
        })),
    });
  }

  /** The person's own GitHub login (`GitHubPersonSchema`): saved in Settings, else the owner of a user-owned App. */
  person(): GitHubPerson {
    const saved = this.ctx.storage.sql.exec<{ login: string }>('SELECT login FROM person WHERE singleton = 1').toArray()[0];
    if (saved) return { login: saved.login, source: 'settings' };
    const app = this.app();
    return app?.owner_kind === 'user' ? { login: app.owner_login, source: 'app-owner' } : { login: null, source: null };
  }

  /** Saves the person's own GitHub login (a leading `@` is dropped); null forgets it. */
  async setPerson(login: string | null): Promise<GitHubState> {
    if (login === null) this.ctx.storage.sql.exec('DELETE FROM person');
    else this.ctx.storage.sql.exec('INSERT OR REPLACE INTO person(singleton, login) VALUES (1, ?)', GitHubLoginSchema.parse(login.trim().replace(/^@/u, '')));
    return this.state();
  }

  /**
   * Whether the cloud reads a project's repository itself. A repository not on GitHub, public, or covered by an
   * installation is ready, unless the cloud's import was refused anyway (`awaits-copy`). A private one the App does not
   * cover is read through the machine attached to the project's base workspace, its `bridge`; the answer also says what
   * stands in the way of the App: no install on its owner, a request an owner there has not answered, or an install that
   * leaves this repository out, and whether the project's repository waits for a machine to copy it in (`awaitsCopy`).
   */
  async projectAccess(projectId: string): Promise<GitHubProjectAccess> {
    const project = (await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).list('active')).find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    const origin = project.repositoryReference;
    if (origin === null) return { state: 'ready' };
    const repository = githubRepositoryOf(origin);
    if (repository !== null && this.coverage(repository) !== null) return { state: 'ready' };
    const awaitsCopy = await new ArtifactsCodeStore(this.env.ARTIFACTS).awaitsMachineSeed(project.id, project.baseBranch);
    if (repository === null || await this.publicOnGitHub(repository)) return awaitsCopy ? { state: 'awaits-copy', origin } : { state: 'ready' };
    const organization = repository.slice(0, repository.indexOf('/'));
    const bridge = await this.projectBridge(projectId);
    const appName = this.app()?.name ?? null;
    if (appName === null) return { state: 'needs-app', repository, organization, appName, bridge, awaitsCopy };
    const projects = await this.repositoryProjects();
    const request = this.requestViews(projects).find((candidate) => candidate.organization?.toLowerCase() === organization.toLowerCase());
    if (request) return { state: 'requested', repository, organization, appName, request, bridge, awaitsCopy };
    const installation = this.installationViews(projects).find((candidate) => candidate.account.login.toLowerCase() === organization.toLowerCase());
    if (installation) return { state: 'not-selected', repository, organization, appName, installation, bridge, awaitsCopy };
    return { state: 'needs-app', repository, organization, appName, bridge, awaitsCopy };
  }

  /** The machine a ref import or a checkout's origin fetch goes through: one attached (not detached) to the project's
   * base workspace, an online one first. Its attachments are read without starting the workspace's runtime. */
  private async projectBridge(projectId: string): Promise<GitHubProjectBridge | null> {
    const attachments = (await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).runtimeAttachmentRecords({ projectId, workspaceId: projectId }))
      .filter((attachment) => attachment.state !== 'detached');
    const attachment = attachments.find((candidate) => candidate.online) ?? attachments[0];
    if (!attachment) return null;
    const machine = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(attachment.machineId);
    return { machineId: attachment.machineId, label: machine?.label ?? attachment.machineId, online: attachment.online };
  }

  /** The manifest form that creates the App on GitHub; its state is good for one creation callback. */
  startApp(owner: GitHubAppOwner): GitHubAppManifestForm {
    const parsed = GitHubAppOwnerSchema.parse(owner);
    if (this.app() || this.creating) throw new Error('This account already has a GitHub App');
    const state = this.createState('create', null);
    const manifest = {
      name: `GitSpace ${this.env.TENANT_ID}`,
      url: this.env.ACCOUNT_URL,
      description: `Connects GitHub to the GitSpace account ${this.env.TENANT_ID}.`,
      hook_attributes: { url: new URL('/github/webhook', this.env.ACCOUNT_URL).href, active: true },
      redirect_url: new URL('/github/app/created', this.env.ACCOUNT_URL).href,
      setup_url: new URL('/github/installed', this.env.ACCOUNT_URL).href,
      setup_on_update: true,
      callback_urls: [new URL('/github/callback', this.env.ACCOUNT_URL).href],
      public: true,
      default_permissions: DEFAULT_PERMISSIONS,
      default_events: DEFAULT_EVENTS,
    };
    const action = parsed.kind === 'organization'
      ? `https://github.com/organizations/${encodeURIComponent(parsed.login)}/settings/apps/new`
      : 'https://github.com/settings/apps/new';
    return { action: `${action}?state=${state}`, manifest: JSON.stringify(manifest) };
  }

  /** GitHub's redirect after the App was created: exchange the code for the App and its secrets, once. */
  async appCreated(code: string, state: string): Promise<void> {
    if (this.consumeState(state, 'create') === null) throw new Error('This GitHub App link expired or was already used; start again from Settings');
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(code)) throw new Error('GitHub sent an invalid App code');
    if (this.app() || this.creating) throw new Error('This account already has a GitHub App');
    this.creating = true;
    try {
      const created = await githubRequest(`/app-manifests/${code}/conversions`, { method: 'POST', schema: ManifestConversionSchema });
      await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).putGitHubApp({
        appId: created.id, privateKey: created.pem, webhookSecret: created.webhook_secret, clientSecret: created.client_secret,
      });
      const now = Date.now();
      this.ctx.storage.sql.exec(
        'INSERT INTO app(singleton, id, slug, name, html_url, owner_login, owner_kind, client_id, created_at, key_updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        created.id, created.slug, created.name, created.html_url, created.owner.login,
        created.owner.type === 'Organization' ? 'organization' : 'user', created.client_id, now, now,
      );
    } finally {
      this.creating = false;
    }
    this.changed();
  }

  /** The App's install page, carrying a state the setup callback must present. Started from a project, the state names
   * the account owning the project's repository, and GitHub opens with that account chosen when its id can be read. */
  async startInstall(projectId?: string): Promise<{ url: string }> {
    const app = this.app();
    if (!app) throw new Error('Create the GitHub App first');
    const base = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
    if (projectId === undefined) return { url: `${base}?state=${this.createState('install', null)}` };
    const target = await this.installTarget(projectId);
    const state = this.createState('install', target);
    const account = await githubRequest(`/users/${encodeURIComponent(target.organization)}`, { token: await this.readToken(target.repository), schema: z.object({ id: z.number().int().positive() }) })
      .catch((error: unknown) => { console.error(JSON.stringify({ event: 'github_install_target_unread', organization: target.organization, message: error instanceof Error ? error.message : String(error) })); return null; });
    return { url: account ? `${base}/permissions?target_id=${account.id}&state=${state}` : `${base}?state=${state}` };
  }

  /** GitHub's setup redirect. An install GitSpace started is kept, and a request it started is recorded (one per
   * organization; requests whose organization is unknown are one). An update of a kept installation refreshes it.
   * GitHub drops the state when it routes an install through its own pages (a request already pending sends it to
   * the target picker), so a request without one is left for the signed-in app to record (`recordStartedRequest`);
   * this unauthenticated redirect never records one. Any other redirect changes nothing: the installation webhook
   * decides. */
  async installed(input: { installationId: number | null; setupAction: SetupAction; state: string | null }): Promise<'installed' | 'updated' | 'requested' | 'request-unrecorded' | 'received'> {
    if (!this.app()) throw new Error('This account has no GitHub App');
    const started = this.consumeState(input.state, 'install');
    if (input.setupAction === 'request') {
      if (started === null) return 'request-unrecorded';
      this.recordRequest(started.target);
      this.changed();
      return 'requested';
    }
    if (input.installationId === null) throw new Error('GitHub did not say which installation changed');
    if (started !== null) {
      await this.syncInstallation(input.installationId, true);
      return input.setupAction === 'update' ? 'updated' : 'installed';
    }
    if (input.setupAction === 'update' && this.installation(input.installationId)) {
      await this.syncInstallation(input.installationId, false);
      return 'updated';
    }
    return 'received';
  }

  /** Records a request the account's own browser reports making on GitHub after GitHub returned without state: for a
   * project's repository owner when it started from that project, of unknown organization otherwise. */
  async recordStartedRequest(projectId?: string): Promise<GitHubState> {
    if (!this.app()) throw new Error('This account has no GitHub App');
    this.recordRequest(projectId === undefined ? null : await this.installTarget(projectId));
    this.changed();
    return this.state();
  }

  /** The account owning a project's GitHub repository, which an install started from the project is meant for. */
  private async installTarget(projectId: string): Promise<InstallTarget> {
    const project = (await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).list('active')).find((candidate) => candidate.id === projectId);
    const repository = project?.repositoryReference ? githubRepositoryOf(project.repositoryReference) : null;
    if (!project || repository === null) throw new Error('This project has no GitHub repository');
    return { organization: repository.slice(0, repository.indexOf('/')), projectId, repository };
  }

  /** Forgets a request. GitHub keeps its own until an organization owner answers or the requester cancels it there. */
  async cancelRequest(requestId: string): Promise<GitHubState> {
    this.ctx.storage.sql.exec('DELETE FROM install_requests WHERE id = ?', requestId);
    this.changed();
    return this.state();
  }

  /** Keeps an installation that waited for confirmation. It answers the request whose organization was unknown, which
   * then counts one fewer. */
  async confirmInstallation(installationId: number): Promise<GitHubState> {
    const waiting = this.ctx.storage.sql.exec('SELECT 1 FROM unclaimed_installations WHERE installation_id = ? AND confirm = 1', installationId).toArray().length > 0;
    if (!waiting) throw new Error('This installation is not waiting for confirmation');
    await this.syncInstallation(installationId, true);
    this.ctx.storage.sql.exec('DELETE FROM install_requests WHERE organization IS NULL AND times <= 1');
    this.ctx.storage.sql.exec('UPDATE install_requests SET times = times - 1 WHERE organization IS NULL');
    this.changed();
    return this.state();
  }

  /** Uninstalls the App from an account on GitHub: a kept installation, or one waiting for confirmation. GitSpace stops
   * using it first, so the deletion's webhook finds nothing to record. */
  async uninstall(installationId: number): Promise<GitHubState> {
    const known = this.installation(installationId) !== undefined
      || this.ctx.storage.sql.exec('SELECT 1 FROM unclaimed_installations WHERE installation_id = ?', installationId).toArray().length > 0;
    if (!known) throw new Error('GitSpace has no such installation');
    await this.deleteOnGitHub(installationId);
    await this.removeInstallation(installationId, null);
    this.changed();
    return this.state();
  }

  async dismissUninstalled(installationId: number): Promise<GitHubState> {
    this.ctx.storage.sql.exec('DELETE FROM uninstalled_installations WHERE id = ?', installationId);
    this.changed();
    return this.state();
  }

  async clearRemoved(): Promise<GitHubState> {
    this.ctx.storage.sql.exec('DELETE FROM removed_installations');
    this.changed();
    return this.state();
  }

  /** A delivery whose signature the vault verified. Its id is recorded once; a redelivery changes nothing. */
  async webhook(event: string, deliveryId: string, payloadJson: string): Promise<void> {
    // A delivery can change what an installation covers: tokens are minted afresh after it.
    this.issued.clear();
    let payload: DeliveryPayload | null = null;
    let raw: unknown = null;
    try {
      raw = JSON.parse(payloadJson);
      payload = DeliveryPayloadSchema.parse(raw);
    } catch {
      // Recorded below as unreadable.
    }
    const installationId = payload?.installation?.id ?? null;
    const inserted = this.ctx.storage.sql.exec(
      `INSERT INTO deliveries(id, event, action, installation_id, repository, received_at, outcome) VALUES (?, ?, ?, ?, ?, ?, 'received')
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      deliveryId, event, payload?.action ?? null, installationId, payload?.repository?.full_name ?? null, Date.now(),
    ).toArray();
    if (inserted.length === 0) return;
    let outcome: string;
    try {
      outcome = payload ? await this.deliver(event, deliveryId, payload, raw) : 'dropped: unreadable payload';
    } catch (error) {
      outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(JSON.stringify({ event: 'github_delivery_failed', deliveryId, githubEvent: event, message: outcome }));
    }
    this.ctx.storage.sql.exec('UPDATE deliveries SET outcome = ? WHERE id = ?', outcome.slice(0, 300), deliveryId);
    this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE id NOT IN (SELECT id FROM deliveries ORDER BY received_at DESC, rowid DESC LIMIT ?)', KEPT_DELIVERIES);
    this.changed();
  }

  /** Uninstalls installations nobody claimed or confirmed before their deadline, and lists each one removed. */
  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql.exec<UnclaimedRow>('SELECT * FROM unclaimed_installations WHERE deadline <= ?', Date.now()).toArray();
    for (const row of due) {
      if (!this.installation(row.installation_id)) {
        try {
          await this.deleteOnGitHub(row.installation_id);
        } catch (error) {
          console.error(JSON.stringify({ event: 'github_uninstall_failed', installationId: row.installation_id, message: error instanceof Error ? error.message : String(error) }));
          this.ctx.storage.sql.exec('UPDATE unclaimed_installations SET deadline = ? WHERE installation_id = ?', Date.now() + UNINSTALL_RETRY_MS, row.installation_id);
          continue;
        }
        if (row.account_login !== null) {
          this.ctx.storage.sql.exec('INSERT INTO removed_installations(account_login, installed_by, removed_at) VALUES (?, ?, ?)', row.account_login, row.installed_by ?? 'unknown', Date.now());
          this.ctx.storage.sql.exec('DELETE FROM removed_installations WHERE rowid NOT IN (SELECT rowid FROM removed_installations ORDER BY removed_at DESC, rowid DESC LIMIT ?)', GITHUB_REMOVED_KEPT);
        }
      }
      this.ctx.storage.sql.exec('DELETE FROM unclaimed_installations WHERE installation_id = ?', row.installation_id);
    }
    if (due.length > 0) this.changed();
    // The alarm that fired is no longer set: arm the next deadline explicitly.
    await this.armAlarm();
  }

  /** The installation covering a repository (`owner/name`, any case), or null. A covered repository is reached only
   * with installation tokens; the account SSH key serves only repositories no installation covers. */
  coverage(repository: string): number | null {
    return this.ctx.storage.sql.exec<{ installation_id: number }>(
      'SELECT installation_id FROM installation_repositories WHERE lower(full_name) = lower(?) ORDER BY installation_id LIMIT 1', repository,
    ).toArray()[0]?.installation_id ?? null;
  }

  /** A token for one covered repository, narrowed to it and to reading or writing its contents (and workflow files). */
  async repositoryToken(repository: string, access: GitHubRepositoryAccess): Promise<GitHubRepositoryToken> {
    return this.installationToken(repository, access === 'write' ? { contents: 'write', workflows: 'write', metadata: 'read' } : { contents: 'read', metadata: 'read' }, `Reaching ${repository} from the cloud`);
  }

  /** Whether anyone may read `repository`. A private repository must be covered by an installation: a reader's user
   * token sees only repositories the App is installed on. */
  async repositoryIsPublic(repository: string): Promise<boolean> {
    if (await this.publicOnGitHub(repository)) return true;
    if (this.coverage(repository) === null) {
      throw new Error(`${repository} is private and the GitHub App is not installed on it, so GitSpace cannot check who may read it. Install the App on ${repository} in Settings → GitHub.`);
    }
    return false;
  }

  /** GitHub serves a public repository's refs without credentials (the request the cloud already makes for origins; the
   * REST API's anonymous limit is shared across Cloudflare's addresses), and answers 401 or 404 for a private one. */
  private async publicOnGitHub(repository: string): Promise<boolean> {
    const response = await fetch(`https://github.com/${repository}.git/info/refs?service=git-upload-pack`, {
      headers: { 'user-agent': 'GitSpace' }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => { throw new Error(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`); });
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status !== 401 && response.status !== 404) throw new Error(`GitHub answered ${response.status} for ${repository}`);
    return false;
  }

  /** Every project the App covers gets the default automations (docs/AUTOMATIONS-DESIGN.md §4), whenever its coverage
   * began: projects linked before the defaults existed, and projects created under an existing installation. The
   * revision of the defaults a project received is recorded here, so later calls open no project's automations until
   * the defaults gain one; its automations object offers each default at most once, so one a person deleted does not
   * come back. */
  async provideAutomationDefaults(): Promise<void> {
    const bot = this.botHandle();
    if (bot === null) return;
    const provided = new Set(this.ctx.storage.sql.exec<{ project_id: string }>('SELECT project_id FROM automation_defaults WHERE revision >= ?', AUTOMATION_DEFAULTS_REVISION).toArray().map(row => row.project_id));
    const due = [...this.links(await this.repositoryProjects()).keys()].filter(projectId => !provided.has(projectId));
    const results = await Promise.allSettled(due.map(async projectId => {
      await this.env.PROJECT_AUTOMATIONS.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).addDefaults({ projectId, bot });
      this.ctx.storage.sql.exec('INSERT INTO automation_defaults(project_id, revision) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision', projectId, AUTOMATION_DEFAULTS_REVISION);
    }));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') console.error('Default automations were not added', { projectId: due[index], error: result.reason });
    }
  }

  /** The tenant's bot as people mention it, `@<slug>`; null without an App. */
  botHandle(): string | null {
    const app = this.app();
    return app ? `@${app.slug}` : null;
  }

  /** Whether `login` may write to `repository` (admin, maintain or write), read through the installation covering it. */
  async canWrite(repository: string, login: string): Promise<boolean> {
    const token = await this.installationToken(repository, { metadata: 'read' }, `Checking who may write to ${repository}`);
    try {
      const access = await githubRequest(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, { token: token.token, schema: z.object({ permission: z.string() }) });
      return access.permission === 'admin' || access.permission === 'write';
    } catch (error) {
      // Not a collaborator, or not a user at all (an App's bot).
      if (error instanceof GitHubApiError && error.status === 404) return false;
      throw error;
    }
  }

  /** The paths a pull request changes, read through the installation covering its repository. */
  async pullRequestFiles(repository: string, number: number): Promise<string[]> {
    const token = await this.installationToken(repository, { pull_requests: 'read', metadata: 'read' }, `Reading the files of ${repository} pull request #${number}`);
    const paths: string[] = [];
    for (let page = 1; page <= PULL_REQUEST_FILE_PAGES; page++) {
      const files = await githubRequest(`/repos/${repository}/pulls/${number}/files?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`, { token: token.token, schema: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })) });
      for (const file of files) paths.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if (files.length < REPOSITORY_PAGE_SIZE) break;
    }
    return paths;
  }

  /** A pull request's state, title and link, and its head commit's check runs and commit statuses together (see
   * `PullRequestState`), read through the installation covering its repository. */
  async pullRequestState(repository: string, number: number): Promise<PullRequestState & { title: string; url: string }> {
    const token = (await this.installationToken(repository, { pull_requests: 'read', checks: 'read', statuses: 'read', metadata: 'read' }, `Reading ${repository} pull request #${number}`)).token;
    const pull = await githubRequest(`/repos/${repository}/pulls/${number}`, { token, schema: z.object({ state: z.enum(['open', 'closed']), draft: z.boolean().optional(), merged: z.boolean(), title: z.string(), html_url: z.string(), head: z.object({ sha: z.string() }) }) });
    const [runs, statuses] = await Promise.all([
      githubRequest(`/repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`, { token, schema: z.object({ check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })) }) }),
      githubRequest(`/repos/${repository}/commits/${pull.head.sha}/status`, { token, schema: z.object({ statuses: z.array(z.object({ state: z.string() })) }) }),
    ]);
    const outcomes = [
      ...runs.check_runs.map(run => run.status !== 'completed' ? 'pending' : Object.hasOwn(FAILED_CONCLUSIONS, run.conclusion ?? '') ? 'failing' : 'passing'),
      ...statuses.statuses.map(status => status.state === 'pending' ? 'pending' : status.state === 'success' ? 'passing' : 'failing'),
    ];
    return {
      state: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open',
      checks: outcomes.includes('failing') ? 'failing' : outcomes.includes('pending') ? 'pending' : outcomes.length ? 'passing' : 'none',
      readAt: new Date().toISOString(), title: pull.title, url: pull.html_url,
    };
  }

  /**
   * What a watched repository published lately, newest first (docs/AUTOMATIONS-DESIGN.md §4a): its releases, its tags,
   * or its deployments with each one's latest status. Read with a token of the installation covering it, else of any of
   * the account's installations (which reads any public repository), else anonymously.
   */
  async watchedItems(repository: string, on: AutomationWatchOn): Promise<WatchedItem[]> {
    const token = await this.readToken(repository);
    const user = z.object({ login: z.string() }).nullish();
    switch (on) {
      case 'release': {
        const releases = await githubRequest(`/repos/${repository}/releases?per_page=30`, { token, schema: z.array(z.object({ tag_name: z.string(), name: z.string().nullish(), html_url: z.string(), body: z.string().nullish(), published_at: z.string().nullish(), prerelease: z.boolean(), draft: z.boolean(), author: user })) });
        return releases.filter(release => !release.draft).map(release => ({
          on: 'release', tag: release.tag_name, name: release.name ?? release.tag_name, url: release.html_url, notes: release.body ?? '',
          publishedAt: release.published_at ?? '', prerelease: release.prerelease, author: release.author?.login ?? null,
        }));
      }
      case 'tag': {
        const tags = await githubRequest(`/repos/${repository}/tags?per_page=100`, { token, schema: z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) })) });
        return tags.map(tag => ({ on: 'tag', name: tag.name, commit: tag.commit.sha, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag.name)}` }));
      }
      case 'deployment': {
        const deployments = await githubRequest(`/repos/${repository}/deployments?per_page=20`, { token, schema: z.array(z.object({ id: z.number().int(), environment: z.string(), sha: z.string(), ref: z.string(), url: z.string(), creator: user })) });
        const items: WatchedItem[] = [];
        for (const deployment of deployments) {
          const [latest] = await githubRequest(`/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`, { token, schema: z.array(z.object({ state: z.string(), environment_url: z.string().nullish(), target_url: z.string().nullish() })) });
          if (latest) items.push({ on: 'deployment', id: deployment.id, environment: deployment.environment, state: latest.state, sha: deployment.sha, ref: deployment.ref, url: latest.environment_url ?? latest.target_url ?? deployment.url, creator: deployment.creator?.login ?? null });
        }
        return items;
      }
    }
  }

  /** The repository a fork was made from, or null for one that is not a fork. */
  async upstreamOf(repository: string): Promise<string | null> {
    const found = await githubRequest(`/repos/${repository}`, { token: await this.readToken(repository), schema: z.object({ fork: z.boolean(), parent: z.object({ full_name: z.string() }).optional() }) });
    return found.fork && found.parent ? found.parent.full_name : null;
  }

  /** A token that reads `repository`: the covering installation's, else any installation's (any public repository),
   * else none (anonymous, under GitHub's limit per address). */
  private async readToken(repository: string): Promise<string | undefined> {
    if (this.coverage(repository) !== null) return (await this.installationToken(repository, { metadata: 'read', contents: 'read' }, `Reading ${repository}`)).token;
    const installationId = this.ctx.storage.sql.exec<{ id: number }>('SELECT id FROM installations ORDER BY installed_at, id LIMIT 1').toArray()[0]?.id;
    if (installationId === undefined || !this.app()) return undefined;
    const key = `${installationId}:*`;
    const held = this.issued.get(key);
    if (held && Date.parse(held.expiresAt) - Date.now() > TOKEN_REUSE_MARGIN_MS) return held.token;
    const jwt = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).githubAppJwt();
    const issued = await githubRequest(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: jwt, body: { permissions: { metadata: 'read' } }, schema: z.object({ token: z.string().min(1), expires_at: z.string().datetime() }) });
    this.issued.set(key, { token: issued.token, expiresAt: issued.expires_at });
    return issued.token;
  }

  /** The repository's recorded deliveries as automations read them, newest first: Test with a past event replays them. */
  recordedEvents(repository: string, limit: number): AutomationEvent[] {
    return this.ctx.storage.sql.exec<DeliveryRow>('SELECT * FROM deliveries WHERE event_json IS NOT NULL AND lower(repository) = lower(?) ORDER BY received_at DESC, rowid DESC LIMIT ?', repository, limit).toArray()
      .map(row => AutomationEventSchema.parse(JSON.parse(row.event_json ?? 'null')));
  }

  /** Who wrote the repository's latest `limit` recorded deliveries of `events`, newest first; one without an author (a
   * check suite) is left out. */
  recordedAuthors(repository: string, events: readonly string[], limit: number): Array<{ login: string; receivedAt: number }> {
    if (events.length === 0) return [];
    return this.ctx.storage.sql.exec<{ login: string | null; received_at: number }>(
      `SELECT json_extract(event_json, '$.author') AS login, received_at FROM deliveries WHERE event_json IS NOT NULL AND lower(repository) = lower(?) AND event IN (${events.map(() => '?').join(', ')}) ORDER BY received_at DESC, rowid DESC LIMIT ?`,
      repository, ...events, limit,
    ).toArray().flatMap(row => row.login === null ? [] : [{ login: row.login, receivedAt: row.received_at }]);
  }

  /** One recorded delivery as automations read it, if it belongs to `repository`. */
  recordedEvent(repository: string, deliveryId: string): AutomationEvent | null {
    const row = this.ctx.storage.sql.exec<DeliveryRow>('SELECT * FROM deliveries WHERE id = ? AND event_json IS NOT NULL AND lower(repository) = lower(?)', deliveryId, repository).toArray()[0];
    return row ? AutomationEventSchema.parse(JSON.parse(row.event_json ?? 'null')) : null;
  }

  /** The App's OAuth client id: a shared guide's reader signs in through the App's user authorization. */
  readerClientId(): string {
    const app = this.app();
    if (!app) throw new Error('This account has no GitHub App, so readers cannot sign in with GitHub');
    return app.client_id;
  }

  /** Stores a key generated on GitHub once the vault confirmed GitHub accepts it for this App. */
  async rotateKey(privateKey: string): Promise<GitHubState> {
    if (!this.app()) throw new Error('This account has no GitHub App');
    await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).rotateGitHubAppKey(privateKey);
    this.ctx.storage.sql.exec('UPDATE app SET key_updated_at = ?', Date.now());
    this.changed();
    return this.state();
  }

  /** An installation token narrowed to one covered repository and `permissions`. A token lasts an hour: machines
   * authenticate git to GitHub on every fetch and push, and minted one each time (about 5,400 a day). Reused until
   * shortly before it expires; held in memory only. `feature` names what needs it in the error an uncovered repository gets. */
  private async installationToken(repository: string, permissions: Readonly<Record<string, 'read' | 'write'>>, feature: string): Promise<GitHubRepositoryToken> {
    const installationId = this.coverage(repository);
    if (installationId === null) throw new Error(`${feature} needs the GitSpace App on ${repository.slice(0, repository.indexOf('/'))}: install it from the project's page.`);
    const key = `${installationId}:${repository.toLowerCase()}:${JSON.stringify(permissions)}`;
    const held = this.issued.get(key);
    if (held && Date.parse(held.expiresAt) - Date.now() > TOKEN_REUSE_MARGIN_MS) return held;
    const jwt = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).githubAppJwt();
    const name = repository.slice(repository.indexOf('/') + 1);
    const issued = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST', token: jwt, body: { repositories: [name], permissions },
      schema: z.object({ token: z.string().min(1), expires_at: z.string().datetime() }),
    });
    const token = { token: issued.token, expiresAt: issued.expires_at };
    this.issued.set(key, token);
    return token;
  }

  private async deliver(event: string, deliveryId: string, payload: DeliveryPayload, raw: unknown): Promise<string> {
    const action = payload.action ?? null;
    const installationId = payload.installation?.id ?? null;
    if (installationId === null) return 'recorded';
    const claimed = this.installation(installationId) !== undefined;
    const unclaimed = this.ctx.storage.sql.exec('SELECT 1 FROM unclaimed_installations WHERE installation_id = ?', installationId).toArray().length > 0;
    if (event === 'installation' && action === 'created') {
      if (claimed) return 'recorded';
      const created = InstallationCreatedSchema.safeParse(raw);
      return created.success ? this.installationCreated(created.data) : 'dropped: unreadable installation';
    }
    if (!claimed && !unclaimed) return 'dropped: unknown installation';
    if (event === 'installation' && action === 'deleted') {
      const by = payload.sender?.login ?? 'someone';
      await this.removeInstallation(installationId, claimed ? by : null);
      return claimed ? `installation removed on GitHub by ${by}` : 'installation removed';
    }
    if (!claimed) return 'recorded: installation not kept';
    const routed = await this.routeToAutomations(event, deliveryId, raw);
    if (event === 'push') return routed === null ? this.recordPush(payload) : `${await this.recordPush(payload)}; ${routed}`;
    if (routed !== null) return routed;
    if (event === 'installation_repositories') {
      await this.syncInstallation(installationId, false);
      return 'repositories refreshed';
    }
    if (event === 'installation' && (action === 'new_permissions_accepted' || action === 'unsuspend')) {
      await this.syncInstallation(installationId, false);
      return 'installation refreshed';
    }
    return event === 'installation' && action === 'suspend' ? 'installation suspended on GitHub' : 'recorded';
  }

  /**
   * Decides an installation GitSpace's setup callback has not claimed. Kept when the App's owner made it, or when a
   * request names its account. Otherwise, while a request whose organization is unknown is pending, it waits for the
   * account to confirm it; with none pending it is uninstalled after a grace a setup callback carrying GitSpace's state
   * can still claim it in. Until kept, GitSpace uses none of it.
   */
  private async installationCreated(created: InstallationCreated): Promise<string> {
    const { installation, sender } = created;
    const account = installation.account.login;
    const app = this.app();
    if (app?.owner_kind === 'user' && sender.login.toLowerCase() === app.owner_login.toLowerCase()) {
      await this.syncInstallation(installation.id, true);
      return `kept: installed on ${account} by the App's owner`;
    }
    if (this.ctx.storage.sql.exec('SELECT 1 FROM install_requests WHERE lower(organization) = lower(?)', account).toArray().length > 0) {
      await this.syncInstallation(installation.id, true);
      return `kept: answers the request for ${account}`;
    }
    const confirm = this.ctx.storage.sql.exec('SELECT 1 FROM install_requests WHERE organization IS NULL').toArray().length > 0;
    const now = Date.now();
    this.ctx.storage.sql.exec(`
      INSERT OR REPLACE INTO unclaimed_installations(installation_id, deadline, confirm, account_login, account_kind, installed_by, installed_at, repository_selection, repositories_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, installation.id, now + (confirm ? CONFIRM_MS : UNCLAIMED_GRACE_MS), confirm ? 1 : 0, account, installation.account.type === 'Organization' ? 'organization' : 'user',
    sender.login, now, installation.repository_selection, JSON.stringify((created.repositories ?? []).map((repository) => repository.full_name)));
    await this.armAlarm();
    return confirm
      ? `waiting for confirmation: installed on ${account} by ${sender.login} while a request of unknown organization is pending`
      : `not expected: installed on ${account} by ${sender.login}; removed in 10 minutes unless GitSpace's setup callback claims it`;
  }

  /** An event automations start on is kept trimmed (Test with a past event replays it) and sent to the automations of
   * every project whose remote is its repository (several may share one); a release, tag or deployment goes to every
   * project, whose watches may name any repository. Null for other events. */
  private async routeToAutomations(event: string, deliveryId: string, raw: unknown): Promise<string | null> {
    const app = this.app();
    const normalized = automationEvent({ event, deliveryId, payload: raw, slug: app?.slug ?? null, receivedAt: Date.now() });
    if (!normalized) return null;
    this.ctx.storage.sql.exec('UPDATE deliveries SET event_json = ? WHERE id = ?', JSON.stringify(normalized), deliveryId);
    const repository = normalized.repository.toLowerCase();
    const projects = normalized.watchKey !== null
      ? (await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).list()).filter((project) => project.lifecycle !== 'deleting').map((project) => ({ id: project.id }))
      : (await this.repositoryProjects()).filter((project) => project.repository === repository);
    const bot = app ? `@${app.slug}` : null;
    const results = await Promise.allSettled(projects.map((project) =>
      this.env.PROJECT_AUTOMATIONS.getByName(`${this.env.ACCOUNT_ID}:${project.id}`).receive({ projectId: project.id, event: normalized, bot })));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    const runs = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0);
    const sent = `automations: ${runs} ${runs === 1 ? 'run' : 'runs'} in ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`;
    return failures.length === 0 ? sent : `${sent}; ${failures.length} failed: ${failures[0]}`;
  }

  /** A push to a branch moves that branch's origin head in every project whose remote is the repository (several may
   * share one); a push to any other ref is only recorded. */
  private async recordPush(payload: DeliveryPayload): Promise<string> {
    const branch = payload.ref?.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : '';
    const repository = payload.repository?.full_name.toLowerCase();
    if (!branch || !repository) return 'recorded';
    const pushed = PushedHeadSchema.safeParse(payload.after);
    if (!payload.deleted && !pushed.success) return 'dropped: push without a head commit';
    const head = payload.deleted || !pushed.success ? null : pushed.data;
    const projects = (await this.repositoryProjects()).filter((project) => project.repository === repository);
    const results = await Promise.allSettled(projects.map((project) =>
      this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${project.id}`).recordRemoteHeads([{ branch, head }])));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    const moved = `${branch} → ${head === null ? 'deleted' : head.slice(0, 7)} for ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`;
    return failures.length === 0 ? moved : `${moved}; ${failures.length} failed: ${failures[0]}`;
  }

  /** Reads the installation and its repositories from GitHub and stores them. `claim` records a new installation;
   * otherwise only one still recorded is refreshed. */
  private async syncInstallation(installationId: number, claim: boolean): Promise<void> {
    const jwt = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).githubAppJwt();
    const installation = await githubRequest(`/app/installations/${installationId}`, { token: jwt, schema: InstallationSchema });
    const access = await githubRequest(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: jwt, schema: z.object({ token: z.string().min(1) }) });
    const repositories = await installationRepositories(access.token);
    const projects = await this.repositoryProjects();
    const before = this.links(projects);
    const installedAt = Date.parse(installation.created_at);
    const stored = this.ctx.storage.transactionSync(() => {
      if (!claim && !this.installation(installationId)) return false;
      this.ctx.storage.sql.exec(`
        INSERT INTO installations(id, account_login, account_kind, repository_selection, permissions_json, installed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login, account_kind=excluded.account_kind,
          repository_selection=excluded.repository_selection, permissions_json=excluded.permissions_json
      `, installationId, installation.account.login, installation.account.type === 'Organization' ? 'organization' : 'user',
      installation.repository_selection, JSON.stringify(installation.permissions), Number.isFinite(installedAt) ? installedAt : Date.now());
      this.ctx.storage.sql.exec('DELETE FROM installation_repositories WHERE installation_id = ?', installationId);
      for (const repository of repositories) {
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO installation_repositories(installation_id, full_name) VALUES (?, ?)', installationId, repository);
      }
      if (claim) {
        this.ctx.storage.sql.exec('DELETE FROM unclaimed_installations WHERE installation_id = ?', installationId);
        this.ctx.storage.sql.exec('DELETE FROM install_requests WHERE lower(organization) = lower(?)', installation.account.login);
        this.ctx.storage.sql.exec('DELETE FROM uninstalled_installations WHERE lower(account_login) = lower(?)', installation.account.login);
      }
      return true;
    });
    if (!stored) return;
    this.announce(before, this.links(projects));
    this.changed();
  }

  /** Stops using an installation. `uninstalledBy` names who removed a kept one on GitHub: it stays listed, with the
   * projects it covered, until dismissed or installed again. */
  private async removeInstallation(installationId: number, uninstalledBy: string | null): Promise<void> {
    const projects = await this.repositoryProjects();
    const before = this.links(projects);
    const kept = this.installation(installationId);
    const covered = new Map(this.ctx.storage.sql.exec<{ full_name: string }>('SELECT full_name FROM installation_repositories WHERE installation_id = ?', installationId).toArray()
      .map((row) => [row.full_name.toLowerCase(), row.full_name]));
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM installation_repositories WHERE installation_id = ?', installationId);
      this.ctx.storage.sql.exec('DELETE FROM installations WHERE id = ?', installationId);
      this.ctx.storage.sql.exec('DELETE FROM unclaimed_installations WHERE installation_id = ?', installationId);
      if (kept && uninstalledBy !== null) {
        const affected = projects.flatMap((project) => {
          const repository = covered.get(project.repository);
          return repository ? [{ id: project.id, name: project.name, repository }] : [];
        });
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO uninstalled_installations(id, account_login, account_kind, uninstalled_by, uninstalled_at, projects_json) VALUES (?, ?, ?, ?, ?, ?)',
          installationId, kept.account_login, kept.account_kind, uninstalledBy, Date.now(), JSON.stringify(affected));
      }
    });
    this.announce(before, this.links(projects));
  }

  /** Uninstalls the App from an installation's account; already gone counts as done. */
  private async deleteOnGitHub(installationId: number): Promise<void> {
    const token = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).githubAppJwt();
    await githubRequest(`/app/installations/${installationId}`, { method: 'DELETE', token, schema: z.null() }).catch((error: unknown) => {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    });
  }

  /** Records a request GitSpace started: one per organization, repeats counted; one for every unknown organization. */
  private recordRequest(target: InstallTarget | null): void {
    const now = Date.now();
    const existing = target === null
      ? this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM install_requests WHERE organization IS NULL').toArray()[0]
      : this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM install_requests WHERE lower(organization) = lower(?)', target.organization).toArray()[0];
    if (existing) {
      this.ctx.storage.sql.exec('UPDATE install_requests SET last_requested_at = ?, times = times + 1, project_id = coalesce(?, project_id), repository = coalesce(?, repository) WHERE id = ?',
        now, target?.projectId ?? null, target?.repository ?? null, existing.id);
      return;
    }
    this.ctx.storage.sql.exec('INSERT INTO install_requests(id, organization, project_id, repository, first_requested_at, last_requested_at, times) VALUES (?, ?, ?, ?, ?, ?, 1)',
      base64url(crypto.getRandomValues(new Uint8Array(12))), target?.organization ?? null, target?.projectId ?? null, target?.repository ?? null, now, now);
  }

  private installationViews(projects: RepositoryProject[]): GitHubInstallationView[] {
    const repositories = new Map<number, string[]>();
    for (const row of this.ctx.storage.sql.exec<{ installation_id: number; full_name: string }>('SELECT installation_id, full_name FROM installation_repositories ORDER BY full_name').toArray()) {
      repositories.set(row.installation_id, [...repositories.get(row.installation_id) ?? [], row.full_name]);
    }
    return this.ctx.storage.sql.exec<InstallationRow>('SELECT * FROM installations ORDER BY installed_at, id').toArray().map((row) => {
      const names = repositories.get(row.id) ?? [];
      const covered = new Map(names.map((name) => [name.toLowerCase(), name]));
      return {
        id: row.id, account: { login: row.account_login, kind: row.account_kind === 'organization' ? 'organization' : 'user' },
        repositorySelection: row.repository_selection === 'all' ? 'all' : 'selected', repositories: names,
        permissions: z.record(z.string(), z.string()).parse(JSON.parse(row.permissions_json)), installedAt: new Date(row.installed_at).toISOString(),
        projects: projects.flatMap((project) => {
          const repository = covered.get(project.repository);
          return repository ? [{ id: project.id, name: project.name, repository }] : [];
        }),
      };
    });
  }

  private requestViews(projects: RepositoryProject[]): GitHubInstallRequestView[] {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return this.ctx.storage.sql.exec<RequestRow>('SELECT * FROM install_requests ORDER BY first_requested_at').toArray().map((row) => {
      const name = row.project_id === null ? undefined : names.get(row.project_id);
      return {
        id: row.id, organization: row.organization, repository: row.repository,
        project: row.project_id !== null && name !== undefined ? { id: row.project_id, name } : null,
        firstRequestedAt: new Date(row.first_requested_at).toISOString(), lastRequestedAt: new Date(row.last_requested_at).toISOString(), times: row.times,
      };
    });
  }

  private async repositoryProjects(): Promise<RepositoryProject[]> {
    const projects = await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).list('active');
    return projects.flatMap((project) => {
      const repository = project.repositoryReference === null ? null : githubRepositoryOf(project.repositoryReference);
      return repository ? [{ id: project.id, name: project.name, repository: repository.toLowerCase() }] : [];
    });
  }

  /** Each linked project, by id, with the installation that covers its repository. */
  private links(projects: RepositoryProject[]): Map<string, ProjectLink> {
    const covered = new Map<string, ProjectLink>();
    const rows = this.ctx.storage.sql.exec<{ full_name: string; account_login: string }>(
      'SELECT r.full_name, i.account_login FROM installation_repositories r JOIN installations i ON i.id = r.installation_id ORDER BY i.installed_at, i.id',
    ).toArray();
    for (const row of rows) {
      const key = row.full_name.toLowerCase();
      if (!covered.has(key)) covered.set(key, { account: row.account_login, repository: row.full_name });
    }
    const links = new Map<string, ProjectLink>();
    for (const project of projects) {
      const link = covered.get(project.repository);
      if (link) links.set(project.id, link);
    }
    return links;
  }

  /** A line in each project's conversation whose link changed; a failed notice is logged, never fails the change. */
  private announce(before: Map<string, ProjectLink>, after: Map<string, ProjectLink>): void {
    const appName = this.app()?.name ?? 'The GitHub App';
    const notices: Array<[string, string]> = [];
    for (const [projectId, link] of after) {
      if (!before.has(projectId)) notices.push([projectId, `Linked to GitHub: ${appName} on ${link.account} covers ${link.repository}.`]);
    }
    for (const [projectId, link] of before) {
      if (!after.has(projectId)) notices.push([projectId, `Unlinked from GitHub: ${link.account} no longer covers ${link.repository}.`]);
    }
    for (const [projectId, text] of notices) {
      this.ctx.waitUntil(this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).runtimeProjectNotice({ projectId, workspaceId: projectId }, text)
        .catch((error: unknown) => console.error('GitHub link notice was not sent', { projectId, error })));
    }
    // Every covered project gets the default automations that send events to linked workspaces, once.
    this.ctx.waitUntil(this.provideAutomationDefaults());
    // Machines re-apply each checkout's origin route (installation tokens or the SSH key) as they do Git settings.
    if (notices.length > 0) this.ctx.waitUntil(notifyMachines(this.env, 'all', ['settings']));
  }

  private app(): AppRow | undefined {
    return this.ctx.storage.sql.exec<AppRow>('SELECT * FROM app WHERE singleton = 1').toArray()[0];
  }

  private installation(installationId: number): InstallationRow | undefined {
    return this.ctx.storage.sql.exec<InstallationRow>('SELECT * FROM installations WHERE id = ?', installationId).toArray()[0];
  }

  private createState(purpose: StatePurpose, target: InstallTarget | null): string {
    const now = Date.now();
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    this.ctx.storage.sql.exec('DELETE FROM states WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('INSERT INTO states(state, purpose, expires_at, organization, project_id, repository) VALUES (?, ?, ?, ?, ?, ?)',
      state, purpose, now + STATE_TTL_MS, target?.organization ?? null, target?.projectId ?? null, target?.repository ?? null);
    return state;
  }

  /** One use: the row is deleted whether or not it is still fresh. Null when the state is unknown or expired. */
  private consumeState(state: string | null, purpose: StatePurpose): { target: InstallTarget | null } | null {
    if (!state) return null;
    const row = this.ctx.storage.sql.exec<{ expires_at: number; organization: string | null; project_id: string | null; repository: string | null }>(
      'DELETE FROM states WHERE state = ? AND purpose = ? RETURNING expires_at, organization, project_id, repository', state, purpose,
    ).toArray()[0];
    if (row === undefined || row.expires_at <= Date.now()) return null;
    return { target: row.organization !== null && row.project_id !== null && row.repository !== null ? { organization: row.organization, projectId: row.project_id, repository: row.repository } : null };
  }

  private async armAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ deadline: number | null }>('SELECT MIN(deadline) AS deadline FROM unclaimed_installations').one().deadline;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private changed(): void {
    this.ctx.waitUntil(notifyBrowsers(this.env, [{ ...accountLiveKey('github'), version: Date.now() }]));
  }
}
