import { z } from 'zod';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import {
  GitHubAppOwnerSchema, GitHubLoginSchema, GitHubRepositoryNameSchema, GitHubStateSchema, githubRepositoryOf,
  type GitHubAppManifestForm, type GitHubAppOwner, type GitHubRepositoryAccess, type GitHubRepositoryToken, type GitHubState,
} from '@gitspace/protocol/github';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { AutomationEventSchema, automationEvent, type AutomationEvent } from './automation-events.js';
import { GitHubApiError, base64url, githubRequest } from './github-api.js';
import { completeGuideReaderSignIn } from './guide-shares.js';
import { notifyBrowsers } from './live-notices.js';
import { notifyMachines } from './machine-notices.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

const STATE_TTL_MS = 15 * 60_000;
/** How long an installation GitSpace did not start may stay: its setup callback can still claim it meanwhile. */
const UNCLAIMED_GRACE_MS = 10 * 60_000;
const UNINSTALL_RETRY_MS = 5 * 60_000;
/** An installation token is reused while more than this remains of its hour. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const KEPT_DELIVERIES = 500;
/** A pull request's changed files are read up to GitHub's own limit for the endpoint. */
const PULL_REQUEST_FILE_PAGES = 30;
const LISTED_DELIVERIES = 50;
const REPOSITORY_PAGE_SIZE = 100;
const REPOSITORY_PAGES = 100;
/** GitHub caps webhook payloads at 25 MB. */
const WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_PERMISSIONS: Record<string, 'read' | 'write'> = {
  metadata: 'read', contents: 'write', workflows: 'write', pull_requests: 'write', issues: 'write', checks: 'write', statuses: 'write',
};
/** Installation events reach every App without subscribing, so they are not listed. */
const DEFAULT_EVENTS = ['pull_request', 'pull_request_review', 'issue_comment', 'pull_request_review_comment', 'issues', 'push', 'check_suite'];
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
});
/** A commit id as a push reports a branch's new head. */
const PushedHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
type DeliveryPayload = z.infer<typeof DeliveryPayloadSchema>;
const SetupActionSchema = z.enum(['install', 'update', 'request']);
type SetupAction = z.infer<typeof SetupActionSchema>;
type StatePurpose = 'create' | 'install';

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
      CREATE TABLE IF NOT EXISTS pending_requests (requested_at INTEGER NOT NULL);
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
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(deliveries)').toArray().some(column => column.name === 'event_json')) ctx.storage.sql.exec('ALTER TABLE deliveries ADD COLUMN event_json TEXT');
  }

  async state(): Promise<GitHubState> {
    const projects = await this.repositoryProjects();
    const app = this.app();
    const repositories = new Map<number, string[]>();
    for (const row of this.ctx.storage.sql.exec<{ installation_id: number; full_name: string }>('SELECT installation_id, full_name FROM installation_repositories ORDER BY full_name').toArray()) {
      repositories.set(row.installation_id, [...repositories.get(row.installation_id) ?? [], row.full_name]);
    }
    return GitHubStateSchema.parse({
      app: app ? {
        id: app.id, slug: app.slug, name: app.name, htmlUrl: app.html_url,
        owner: { login: app.owner_login, kind: app.owner_kind },
        createdAt: new Date(app.created_at).toISOString(), keyUpdatedAt: new Date(app.key_updated_at).toISOString(),
      } : null,
      installations: this.ctx.storage.sql.exec<InstallationRow>('SELECT * FROM installations ORDER BY installed_at, id').toArray().map((row) => {
        const names = repositories.get(row.id) ?? [];
        const covered = new Map(names.map((name) => [name.toLowerCase(), name]));
        return {
          id: row.id, account: { login: row.account_login, kind: row.account_kind },
          repositorySelection: row.repository_selection, repositories: names,
          permissions: JSON.parse(row.permissions_json), installedAt: new Date(row.installed_at).toISOString(),
          projects: projects.flatMap((project) => {
            const repository = covered.get(project.repository);
            return repository ? [{ id: project.id, name: project.name, repository }] : [];
          }),
        };
      }),
      pendingRequests: this.ctx.storage.sql.exec<{ requested_at: number }>('SELECT requested_at FROM pending_requests ORDER BY requested_at').toArray()
        .map((row) => ({ requestedAt: new Date(row.requested_at).toISOString() })),
      deliveries: this.ctx.storage.sql.exec<DeliveryRow>('SELECT * FROM deliveries ORDER BY received_at DESC, rowid DESC LIMIT ?', LISTED_DELIVERIES).toArray()
        .map((row) => ({
          id: row.id, event: row.event, action: row.action, installationId: row.installation_id,
          repository: row.repository, receivedAt: new Date(row.received_at).toISOString(), outcome: row.outcome,
        })),
    });
  }

  /** The manifest form that creates the App on GitHub; its state is good for one creation callback. */
  startApp(owner: GitHubAppOwner): GitHubAppManifestForm {
    const parsed = GitHubAppOwnerSchema.parse(owner);
    if (this.app() || this.creating) throw new Error('This account already has a GitHub App');
    const state = this.createState('create');
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
    if (!this.consumeState(state, 'create')) throw new Error('This GitHub App link expired or was already used; start again from Settings');
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

  /** The App's install page, carrying a state the setup callback must present. */
  startInstall(): { url: string } {
    const app = this.app();
    if (!app) throw new Error('Create the GitHub App first');
    return { url: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${this.createState('install')}` };
  }

  /** GitHub's setup redirect. Only a GitSpace-started install claims an installation; an update of a claimed one
   * (GitHub sends those without state) refreshes it. Anything else is left to the webhook and alarm, which remove it. */
  async installed(input: { installationId: number | null; setupAction: SetupAction; state: string | null }): Promise<'installed' | 'updated' | 'requested'> {
    if (!this.app()) throw new Error('This account has no GitHub App');
    const started = this.consumeState(input.state, 'install');
    if (input.setupAction === 'request') {
      if (!started) throw new Error('This install request did not start from GitSpace');
      this.ctx.storage.sql.exec('INSERT INTO pending_requests(requested_at) VALUES (?)', Date.now());
      this.changed();
      return 'requested';
    }
    if (input.installationId === null) throw new Error('GitHub did not say which installation changed');
    const claimed = this.installation(input.installationId) !== undefined;
    if (!started && !(input.setupAction === 'update' && claimed)) {
      throw new Error('GitSpace keeps only installations started from Settings → GitHub; this one is removed');
    }
    await this.syncInstallation(input.installationId, started);
    return input.setupAction === 'update' ? 'updated' : 'installed';
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

  /** Uninstalls installations nobody claimed before their deadline. */
  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql.exec<{ installation_id: number }>('SELECT installation_id FROM unclaimed_installations WHERE deadline <= ?', Date.now()).toArray();
    for (const { installation_id: installationId } of due) {
      if (!this.installation(installationId)) {
        try {
          const token = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).githubAppJwt();
          await githubRequest(`/app/installations/${installationId}`, { method: 'DELETE', token, schema: z.null() });
        } catch (error) {
          // Already gone on GitHub counts as done; anything else is retried.
          if (!(error instanceof GitHubApiError && error.status === 404)) {
            console.error(JSON.stringify({ event: 'github_uninstall_failed', installationId, message: error instanceof Error ? error.message : String(error) }));
            this.ctx.storage.sql.exec('UPDATE unclaimed_installations SET deadline = ? WHERE installation_id = ?', Date.now() + UNINSTALL_RETRY_MS, installationId);
            continue;
          }
        }
      }
      this.ctx.storage.sql.exec('DELETE FROM unclaimed_installations WHERE installation_id = ?', installationId);
    }
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
    return this.installationToken(repository, access === 'write' ? { contents: 'write', workflows: 'write', metadata: 'read' } : { contents: 'read', metadata: 'read' });
  }

  /**
   * Whether anyone may read `repository`: GitHub serves a public repository's refs without credentials (the request the
   * cloud already makes for origins; the REST API's anonymous limit is shared across Cloudflare's addresses). A private
   * repository must be covered by an installation: a reader's user token sees only repositories the App is installed on.
   */
  async repositoryIsPublic(repository: string): Promise<boolean> {
    const response = await fetch(`https://github.com/${repository}.git/info/refs?service=git-upload-pack`, {
      headers: { 'user-agent': 'GitSpace' }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => { throw new Error(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`); });
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status !== 401 && response.status !== 404) throw new Error(`GitHub answered ${response.status} for ${repository}`);
    if (this.coverage(repository) === null) {
      throw new Error(`${repository} is private and the GitHub App is not installed on it, so GitSpace cannot check who may read it. Install the App on ${repository} in Settings → GitHub.`);
    }
    return false;
  }

  /** The tenant's bot as people mention it, `@<slug>`; null without an App. */
  botHandle(): string | null {
    const app = this.app();
    return app ? `@${app.slug}` : null;
  }

  /** Whether `login` may write to `repository` (admin, maintain or write), read through the installation covering it. */
  async canWrite(repository: string, login: string): Promise<boolean> {
    const token = await this.installationToken(repository, { metadata: 'read' });
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
    const token = await this.installationToken(repository, { pull_requests: 'read', metadata: 'read' });
    const paths: string[] = [];
    for (let page = 1; page <= PULL_REQUEST_FILE_PAGES; page++) {
      const files = await githubRequest(`/repos/${repository}/pulls/${number}/files?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`, { token: token.token, schema: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })) });
      for (const file of files) paths.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if (files.length < REPOSITORY_PAGE_SIZE) break;
    }
    return paths;
  }

  /** The repository's recorded deliveries as automations read them, newest first: Test with a past event replays them. */
  recordedEvents(repository: string, limit: number): AutomationEvent[] {
    return this.ctx.storage.sql.exec<DeliveryRow>('SELECT * FROM deliveries WHERE event_json IS NOT NULL AND lower(repository) = lower(?) ORDER BY received_at DESC, rowid DESC LIMIT ?', repository, limit).toArray()
      .map(row => AutomationEventSchema.parse(JSON.parse(row.event_json ?? 'null')));
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
   * shortly before it expires; held in memory only. */
  private async installationToken(repository: string, permissions: Readonly<Record<string, 'read' | 'write'>>): Promise<GitHubRepositoryToken> {
    const installationId = this.coverage(repository);
    if (installationId === null) throw new Error(`No GitHub App installation covers ${repository}`);
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
      if (!unclaimed) {
        this.ctx.storage.sql.exec('INSERT INTO unclaimed_installations(installation_id, deadline) VALUES (?, ?)', installationId, Date.now() + UNCLAIMED_GRACE_MS);
        await this.armAlarm();
      }
      return 'not started from GitSpace: removed unless claimed within 10 minutes';
    }
    if (!claimed && !unclaimed) return 'dropped: unknown installation';
    if (event === 'installation' && action === 'deleted') {
      await this.removeInstallation(installationId);
      return 'installation removed';
    }
    if (!claimed) return 'recorded: installation not started from GitSpace';
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

  /** An event automations start on is kept trimmed (Test with a past event replays it) and sent to the automations of
   * every project whose remote is its repository (several may share one). Null for other events. */
  private async routeToAutomations(event: string, deliveryId: string, raw: unknown): Promise<string | null> {
    const app = this.app();
    const normalized = automationEvent({ event, deliveryId, payload: raw, slug: app?.slug ?? null, receivedAt: Date.now() });
    if (!normalized) return null;
    this.ctx.storage.sql.exec('UPDATE deliveries SET event_json = ? WHERE id = ?', JSON.stringify(normalized), deliveryId);
    const repository = normalized.repository.toLowerCase();
    const projects = (await this.repositoryProjects()).filter((project) => project.repository === repository);
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
        this.ctx.storage.sql.exec('DELETE FROM pending_requests');
      }
      return true;
    });
    if (!stored) return;
    this.announce(before, this.links(projects));
    this.changed();
  }

  private async removeInstallation(installationId: number): Promise<void> {
    const projects = await this.repositoryProjects();
    const before = this.links(projects);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM installation_repositories WHERE installation_id = ?', installationId);
      this.ctx.storage.sql.exec('DELETE FROM installations WHERE id = ?', installationId);
      this.ctx.storage.sql.exec('DELETE FROM unclaimed_installations WHERE installation_id = ?', installationId);
    });
    this.announce(before, this.links(projects));
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
    // A project its repository's installation newly covers gets the default automations that send events to linked
    // workspaces (docs/AUTOMATIONS-DESIGN.md §4), once.
    const bot = this.botHandle();
    for (const projectId of after.keys()) {
      if (before.has(projectId) || bot === null) continue;
      this.ctx.waitUntil(this.env.PROJECT_AUTOMATIONS.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).addDefaults({ projectId, bot })
        .catch((error: unknown) => console.error('Default automations were not added', { projectId, error })));
    }
    // Machines re-apply each checkout's origin route (installation tokens or the SSH key) as they do Git settings.
    if (notices.length > 0) this.ctx.waitUntil(notifyMachines(this.env, 'all', ['settings']));
  }

  private app(): AppRow | undefined {
    return this.ctx.storage.sql.exec<AppRow>('SELECT * FROM app WHERE singleton = 1').toArray()[0];
  }

  private installation(installationId: number): InstallationRow | undefined {
    return this.ctx.storage.sql.exec<InstallationRow>('SELECT * FROM installations WHERE id = ?', installationId).toArray()[0];
  }

  private createState(purpose: StatePurpose): string {
    const now = Date.now();
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    this.ctx.storage.sql.exec('DELETE FROM states WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('INSERT INTO states(state, purpose, expires_at) VALUES (?, ?, ?)', state, purpose, now + STATE_TTL_MS);
    return state;
  }

  /** One use: the row is deleted whether or not it is still fresh. */
  private consumeState(state: string | null, purpose: StatePurpose): boolean {
    if (!state) return false;
    const row = this.ctx.storage.sql.exec<{ expires_at: number }>('DELETE FROM states WHERE state = ? AND purpose = ? RETURNING expires_at', state, purpose).toArray()[0];
    return row !== undefined && row.expires_at > Date.now();
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
