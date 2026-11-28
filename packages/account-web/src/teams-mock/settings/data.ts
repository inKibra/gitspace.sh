// The settings pages' invented resources for the Crumb & Co team: machines, browsers, connections and the Slack app,
// secrets (the team's, each project's, each person's and each bot's own), model credentials and their usage, MCP
// grants, bots' activity, invites and allowed domains, agent permissions and the audit log. Users, bots, projects,
// memberships and holders come from the shell's model (../data.ts); "in use" is derived from current holders.
import { PROJECTS, TEAM, visibleProjects, WORKSPACES, type AccountRoleId } from '../data.js';
import { createStore } from '../store.js';

export const ACCOUNT_NAME = TEAM.name;
export const ACTIVE_PROJECTS = PROJECTS.filter((project) => !project.archived);
export function projectName(id: string): string { return PROJECTS.find((project) => project.id === id)?.name ?? id; }

/** Account resources belong to the team; user resources join a workspace only while their owner holds its handle. */
export type Owner = { scope: 'account' } | { scope: 'user'; userId: string };

/** Any kind of machine at either scope: a Cell container (GitSpace's own), a cloud VM (the team's or yours, e.g. EC2),
 * or a physical computer paired with the installer. */
export type MachineKind = 'container' | 'vm' | 'computer';
export const MACHINE_KIND_LABEL: Readonly<Record<MachineKind, string>> = { container: 'Cell container', vm: 'Cloud VM', computer: 'Physical computer' };
export interface Machine {
  id: string; label: string; kind: MachineKind; owner: Owner; state: 'online' | 'sleeping' | 'offline';
  notes: string;
  /** Processes left running after their user let go of a workspace's handle. */
  detached?: ReadonlyArray<{ workspaceId: string; process: string; since: string }>;
}
export const MACHINES: readonly Machine[] = [
  { id: 'crumb-cloud-1', label: 'crumb-cell-1', kind: 'container', owner: { scope: 'account' }, state: 'online', notes: 'Default for Crumb · Postgres and Redis baked in' },
  { id: 'ledger-cloud-2', label: 'ledger-cloud-2', kind: 'container', owner: { scope: 'account' }, state: 'online', notes: 'Ledger only · bank sandbox egress allowed' },
  { id: 'ec2-fleet', label: 'crumb-ec2 fleet', kind: 'vm', owner: { scope: 'account' }, state: 'online', notes: 'AWS eu-west-1 · 3 × c7g.xlarge · load tests and Ship-phase deploys' },
  { id: 'counter-mini', label: 'Back-office Mac mini', kind: 'computer', owner: { scope: 'account' }, state: 'online', notes: 'At the shop · receipt printer and kitchen display attached' },
  { id: 'maya-mbp', label: 'Maya’s MacBook Pro', kind: 'computer', owner: { scope: 'user', userId: 'maya' }, state: 'online', notes: 'Xcode, Apple Pay sandbox certificates',
    detached: [{ workspaceId: 'loyalty-stamps', process: 'vite dev · port 5173', since: '2h ago' }] },
  { id: 'maya-vm', label: 'maya-gpu', kind: 'vm', owner: { scope: 'user', userId: 'maya' }, state: 'sleeping', notes: 'Her own EC2 g6.xlarge · image models' },
  { id: 'rina-box', label: 'rina-workstation', kind: 'computer', owner: { scope: 'user', userId: 'rina' }, state: 'online', notes: 'Linux · 64 GB · GPU for photo models' },
  { id: 'rina-cloud', label: 'rina-scratch', kind: 'container', owner: { scope: 'user', userId: 'rina' }, state: 'sleeping', notes: 'Her own Cell container' },
  { id: 'theo-laptop', label: 'Theo’s laptop', kind: 'computer', owner: { scope: 'user', userId: 'theo' }, state: 'offline', notes: '' },
  { id: 'jules-mba', label: 'Jules’s MacBook Air', kind: 'computer', owner: { scope: 'user', userId: 'jules' }, state: 'offline', notes: '' },
];

export interface Browser { id: string; label: string; detail: string; owner: Owner; online: boolean; projects: readonly string[]; lastUsed: string; builtIn?: boolean; detached?: ReadonlyArray<{ workspaceId: string; process: string; since: string }> }
export const BROWSERS: readonly Browser[] = [
  { id: 'cloud', label: 'Cloud browser', detail: 'Built in · one profile per workspace', owner: { scope: 'account' }, online: true, projects: ['crumb', 'ledger', 'field-notes'], lastUsed: 'now · bank-feed-sync', builtIn: true },
  { id: 'counter-chrome', label: 'Back-office Chrome', detail: 'Chrome 142 on the Back-office Mac mini · signed in to the shop’s Square and supplier portals', owner: { scope: 'account' }, online: true, projects: ['crumb'], lastUsed: '2h ago · kitchen-display-queue' },
  { id: 'maya-chrome', label: 'Maya’s Chrome', detail: 'Chrome 142 · macOS · work profile', owner: { scope: 'user', userId: 'maya' }, online: true, projects: ['crumb', 'ledger', 'field-notes'], lastUsed: '20m ago · slot-holds' },
  { id: 'rina-chrome', label: 'Rina’s Chrome', detail: 'Chrome 141 · Linux', owner: { scope: 'user', userId: 'rina' }, online: true, projects: ['crumb', 'ledger'], lastUsed: '35m ago · tax-rates-2027',
    detached: [{ workspaceId: 'tax-rates-2027', process: '2 tabs in the agent’s group', since: '35m ago' }] },
  { id: 'theo-chrome', label: 'Theo’s Chrome', detail: 'Chrome 142 · Windows · profile “Crumb”', owner: { scope: 'user', userId: 'theo' }, online: true, projects: ['crumb', 'ledger'], lastUsed: 'yesterday · menu-cache' },
  { id: 'sam-chrome', label: 'Sam’s Chrome', detail: 'Chrome 142 · macOS · Figma signed in', owner: { scope: 'user', userId: 'sam' }, online: false, projects: ['crumb', 'field-notes'], lastUsed: 'last week · loyalty-stamps' },
];

/** Plugins, as the real app's Plugins page tabs them: Composio toolkits, custom MCP servers (and the team's Slack app,
 * which GitSpace runs itself), and browsers (above). A team plugin is set up once and switched on per project in its
 * settings; a person's joins a workspace while they hold its handle, in projects whose settings allow holders' own
 * plugins. */
export type PluginTab = 'composio' | 'mcp' | 'browsers';
export interface Plugin {
  id: string; name: string; tab: 'composio' | 'mcp'; owner: Owner;
  /** How it signs in: a service token, OAuth as the person, a Composio link. Values never show. */
  auth: string;
  detail: string; status: 'connected' | 'sign-in-required' | 'off';
  lastUsed: string;
  /** Today's tool calls through it. */
  calls: number;
}
export const PLUGINS: readonly Plugin[] = [
  { id: 'team-composio', name: 'Composio · team account', tab: 'composio', owner: { scope: 'account' }, auth: 'Team Composio account', detail: 'crumbco on composio.dev · off: no team toolkits are connected through it', status: 'off', lastUsed: 'never', calls: 0 },
  { id: 'jira', name: 'Jira', tab: 'mcp', owner: { scope: 'account' }, auth: 'Service token', detail: 'crumbco.atlassian.net · service account gitspace-bot@crumbco.example', status: 'connected', lastUsed: '8m ago · invoice-pdf-export', calls: 212 },
  { id: 'internal-mcp', name: 'Crumb internal MCP', tab: 'mcp', owner: { scope: 'account' }, auth: 'Service token', detail: 'https://mcp.internal.crumbco.example · menu, orders and pickup-slot APIs', status: 'connected', lastUsed: '2m ago · slot-holds', calls: 1480 },
  { id: 'slack-app', name: 'Slack app', tab: 'mcp', owner: { scope: 'account' }, auth: 'Installed by Theo', detail: 'GitSpace for Slack in crumbco.slack.com · posts to channels, answers @GitSpace', status: 'connected', lastUsed: '4m ago · #kitchen-dev', calls: 64 },
  { id: 'maya-gdrive', name: 'Google Drive', tab: 'composio', owner: { scope: 'user', userId: 'maya' }, auth: 'Composio link', detail: 'maya@crumbco.example · read only', status: 'connected', lastUsed: 'yesterday · loyalty-stamps', calls: 3 },
  { id: 'maya-notion', name: 'Notion', tab: 'composio', owner: { scope: 'user', userId: 'maya' }, auth: 'Composio link', detail: 'Maya’s workspace · product notes', status: 'connected', lastUsed: '2h ago · slot-holds', calls: 11 },
  { id: 'maya-slack', name: 'Slack', tab: 'mcp', owner: { scope: 'user', userId: 'maya' }, auth: 'OAuth as Maya', detail: 'Her Slack sign-in · her channels and DMs, posts as Maya', status: 'connected', lastUsed: '30m ago · slot-holds', calls: 18 },
  { id: 'maya-linear', name: 'Linear', tab: 'mcp', owner: { scope: 'user', userId: 'maya' }, auth: 'OAuth as Maya', detail: 'Her Linear sign-in · issues assigned to her', status: 'connected', lastUsed: 'today 09:10 · checkout-apple-pay', calls: 7 },
  { id: 'rina-slack', name: 'Slack', tab: 'mcp', owner: { scope: 'user', userId: 'rina' }, auth: 'OAuth as Rina', detail: 'Her Slack sign-in · reads #ledger and her DMs, posts as Rina', status: 'connected', lastUsed: '12m ago · bank-feed-sync', calls: 41 },
  { id: 'rina-linear', name: 'Linear', tab: 'mcp', owner: { scope: 'user', userId: 'rina' }, auth: 'OAuth as Rina', detail: 'Her Linear sign-in · her assigned issues', status: 'connected', lastUsed: '1h ago · slot-picker-ui', calls: 9 },
  { id: 'rina-gcal', name: 'Google Calendar', tab: 'composio', owner: { scope: 'user', userId: 'rina' }, auth: 'Composio link', detail: 'rina@crumbco.example · free/busy only', status: 'sign-in-required', lastUsed: '3 days ago', calls: 0 },
  { id: 'theo-calendar', name: 'Google Calendar', tab: 'composio', owner: { scope: 'user', userId: 'theo' }, auth: 'Composio link', detail: 'theo@crumbco.example · free/busy only', status: 'connected', lastUsed: 'today 10:02 · invoice-pdf-export', calls: 2 },
  { id: 'sam-figma', name: 'Figma', tab: 'mcp', owner: { scope: 'user', userId: 'sam' }, auth: 'OAuth as Sam', detail: 'His Figma · edit access to the design system', status: 'connected', lastUsed: 'yesterday · loyalty-stamps', calls: 5 },
  { id: 'release-bot-slack', name: 'Slack', tab: 'mcp', owner: { scope: 'user', userId: 'release-bot' }, auth: 'Bot token as Release bot', detail: 'Its own Slack app token · posts release notes to #releases as Release bot', status: 'connected', lastUsed: 'Friday · release-2.14', calls: 6 },
  { id: 'deps-bot-linear', name: 'Linear', tab: 'mcp', owner: { scope: 'user', userId: 'deps-bot' }, auth: 'API key as Deps bot', detail: 'Its own Linear account · opens and updates dependency-upgrade issues', status: 'connected', lastUsed: 'today 09:20 · deps-week-48', calls: 4 },
];

/** Skills: instructions and scripts agents load. The team's apply in every project that turns them on; a person's
 * travel with them into workspaces they hold. */
export interface Skill { id: string; name: string; owner: Owner; description: string; projects?: readonly string[]; updated: string }
export const SKILLS: readonly Skill[] = [
  { id: 'release-checklist', name: 'release-checklist', owner: { scope: 'account' }, description: 'The Friday release: freeze, changelog, tag, deploy order', projects: ['crumb', 'ledger'], updated: 'Nov 12 by Theo' },
  { id: 'pr-review-style', name: 'pr-review-style', owner: { scope: 'account' }, description: 'How Crumb & Co reviews: risk first, then tests, then naming', projects: ['crumb', 'ledger', 'field-notes'], updated: 'Oct 30 by Maya' },
  { id: 'tax-rules', name: 'ledger-tax-rules', owner: { scope: 'account' }, description: 'VAT and sales-tax rules the invoices follow, with sources', projects: ['ledger'], updated: 'Nov 2 by Rina' },
  { id: 'maya-voice', name: 'maya-writing-voice', owner: { scope: 'user', userId: 'maya' }, description: 'Short sentences, no exclamation marks, British spelling', updated: 'Sep 3' },
  { id: 'rina-debug', name: 'rina-redis-debugging', owner: { scope: 'user', userId: 'rina' }, description: 'Her routine for TTL and eviction bugs: MONITOR, keyspace events, then tests', updated: 'Nov 20' },
  { id: 'sam-figma-tokens', name: 'sam-figma-tokens', owner: { scope: 'user', userId: 'sam' }, description: 'Maps Figma variables to the design-system tokens', updated: 'Nov 8' },
  { id: 'deps-bot-policy', name: 'deps-upgrade-policy', owner: { scope: 'user', userId: 'deps-bot' }, description: 'Which upgrades it batches, which wait for a Lead, and how it writes the changelog entry', updated: 'Nov 18 by Maya' },
];

/** Each person's passkeys and devices. */
export const DEVICES: Readonly<Record<string, ReadonlyArray<{ id: string; label: string; kind: string; added: string; lastUsed: string; current?: boolean }>>> = {
  maya: [{ id: 'dev-maya-mbp', label: 'MacBook Pro', kind: 'Touch ID passkey', added: 'Mar 2026', lastUsed: 'now', current: true }, { id: 'dev-maya-iphone', label: 'iPhone', kind: 'iCloud Keychain passkey', added: 'Mar 2026', lastUsed: 'yesterday' }, { id: 'dev-maya-yubikey', label: 'YubiKey 5C', kind: 'Security key · recovery', added: 'Apr 2026', lastUsed: 'Aug 2' }],
  theo: [{ id: 'dev-theo-thinkpad', label: 'ThinkPad', kind: 'Windows Hello passkey', added: 'Jun 2026', lastUsed: '4m ago', current: true }, { id: 'dev-theo-pixel', label: 'Pixel 9', kind: 'Google Password Manager passkey', added: 'Jun 2026', lastUsed: 'today' }],
  rina: [{ id: 'dev-rina-key', label: 'rina-workstation', kind: 'Security key', added: 'Aug 2026', lastUsed: 'now', current: true }, { id: 'dev-rina-iphone', label: 'iPhone', kind: 'iCloud Keychain passkey', added: 'Aug 2026', lastUsed: '3 days ago' }],
  sam: [{ id: 'dev-sam-mba', label: 'MacBook Air', kind: 'Touch ID passkey', added: 'Nov 2026', lastUsed: '1h ago', current: true }],
  jules: [{ id: 'dev-jules-mba', label: 'MacBook Air', kind: 'Touch ID passkey', added: 'Nov 20', lastUsed: 'yesterday', current: true }],
};

/** Things revoked while the mock is open (connections, providers, machines, browsers, MCP clients, devices): lists
 * leave them out. */
export const revoked = createStore<ReadonlySet<string>>(new Set());

/** Per-project settings: its inference profile (which alone decides whether holders' own providers may pay); which
 * team plugins are on and whether holders' own plugins are allowed; the plugins its repository declares; the
 * repositories it uses (its own and any extra ones it declares). */
export interface ProjectSettings { profile: string; teamPlugins: readonly string[]; holdersPlugins: boolean; declared: ReadonlyArray<{ name: string; kind: string; detail: string }>; repositories: readonly string[] }
export const projectSettings = createStore<Readonly<Record<string, ProjectSettings>>>({
  crumb: { profile: 'default', teamPlugins: ['jira', 'internal-mcp', 'slack-app'], holdersPlugins: true, repositories: ['github.com/crumb-co/crumb', 'github.com/crumb-co/crumb-kitchen', 'github.com/crumb-labs/receipt-printer-driver'],
    declared: [{ name: 'Stripe (test mode)', kind: 'Composio toolkit', detail: 'Test-mode account “Crumb checkout” · key from Crumb’s secret STRIPE_SECRET_KEY' }, { name: 'Playwright MCP', kind: 'Custom MCP · stdio', detail: 'npx @playwright/mcp · runs on the workspace machine' }] },
  ledger: { profile: 'ledger', teamPlugins: ['jira', 'slack-app'], holdersPlugins: true, repositories: ['github.com/crumb-co/ledger', 'bitbucket.org/openbank/sandbox-fixtures'],
    declared: [{ name: 'Open Bank sandbox', kind: 'Custom MCP · HTTP', detail: 'https://mcp.sandbox.openbank.example · client secret from Ledger’s secret OPENBANK_CLIENT_SECRET' }] },
  'field-notes': { profile: 'default', teamPlugins: ['internal-mcp'], holdersPlugins: false, repositories: ['github.com/crumb-co/field-notes'],
    declared: [{ name: 'Mapbox', kind: 'Custom MCP · HTTP', detail: 'Geocoding for photo captions · token from Field notes’ secret MAPBOX_TOKEN' }] },
});

/** The account's one GitHub App, installed once per GitHub organization; each installation covers some repositories.
 * An origin it covers uses App tokens on every machine (narrow, short-lived, ending when the person is removed or the
 * App stops covering the repository); anything else uses the machine's own scope's SSH key. */
export const GITHUB_APP: { name: string; installations: ReadonlyArray<{ org: string; installed: string; by: string; repositories: readonly string[] }> } = {
  name: 'GitSpace for Crumb & Co',
  installations: [
    { org: 'crumb-co', installed: 'Sep 2', by: 'maya', repositories: ['github.com/crumb-co/crumb', 'github.com/crumb-co/crumb-kitchen', 'github.com/crumb-co/ledger', 'github.com/crumb-co/field-notes', 'github.com/crumb-co/bakery-site'] },
    { org: 'crumb-labs', installed: 'Oct 21', by: 'theo', repositories: ['github.com/crumb-labs/receipt-printer-driver'] },
  ],
};
export function appCovers(repository: string): string | null {
  return GITHUB_APP.installations.find((installation) => installation.repositories.includes(repository))?.org ?? null;
}
/** The team's SSH key: on team machines only, for origins the GitHub App doesn't cover. */
export const TEAM_SSH_KEY = { fingerprint: 'SHA256:q3Vx7mN0b2Lr8KpTz4WcHf1sYeA6uJ9dGiO5nXc0Lk', created: 'Sep 2 by Maya',
  registered: ['Deploy key (read only) on bitbucket.org/openbank/sandbox-fixtures', 'Machine user crumb-ci on gitlab.crumbco.example'] };
/** Each person's SSH key for origins the App doesn't cover, on their own machines only: GitSpace generates one, and a
 * physical personal machine can use its own keys instead. */
export const PERSONAL_SSH_KEYS: Readonly<Record<string, { fingerprint: string; created: string }>> = {
  maya: { fingerprint: 'SHA256:Mk2pQ8vR1sT0wXy3Za7Bc4De5Fg6Hi9Jk0Lm1No2Pq', created: 'Mar 2026' },
  theo: { fingerprint: 'SHA256:Th3oK3yAa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll', created: 'Jun 2026' },
  rina: { fingerprint: 'SHA256:R1naZz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn', created: 'Aug 2026' },
  sam: { fingerprint: 'SHA256:S4mMm1Nn2Oo3Pp4Qq5Rr6Ss7Tt8Uu9Vv0Ww1Xx2Yy', created: 'Nov 2026' },
  jules: { fingerprint: 'SHA256:Ju1esAa2Bb3Cc4Dd5Ee6Ff7Gg8Hh9Ii0Jj1Kk2Ll3', created: 'Nov 20' },
};

/** What a secret holds. A value isn't secret (a region, a flag) and shows on its page; the rest are write-only: a secret
 * string, an API token, a site login (username and password, maybe a one-time code, or a site passkey) or a cloud
 * session. */
export type SecretKind = 'value' | 'secret' | 'token' | 'login' | 'session';
export const SECRET_KIND_LABEL: Readonly<Record<SecretKind, string>> = { value: 'Value', secret: 'Secret', token: 'API token', login: 'Login', session: 'Cloud session' };
/** A secret: the team's (`scope: 'team'`), a project's (its id) or a person's or bot's own (their id). Who may use it,
 * whether only while holding, and how it's delivered is its rule in `secretRules` (../flows/env-model.ts), keyed
 * `${scope}:${name}`. */
export interface SecretEntry {
  id: string;
  /** The env name agents and scripts ask for it by. */
  name: string;
  scope: string;
  kind: SecretKind;
  /** What it is; for a value, the value itself. */
  detail: string;
  /** The host a token, login or session is for. */
  site?: string;
  username?: string;
  /** A login kept as a site passkey, or a cloud session: renewed by signing in again, not by pasting. */
  signIn?: boolean;
  /** Production, money or admin: its rule starts as "only to approved scripts". */
  sensitive: boolean;
  /** Days until it expires (negative: expired); null: no expiry. */
  expires: number | null;
  rotation?: string;
  failing?: string;
  updated: string;
  lastUsed: string;
}
export const SECRETS: readonly SecretEntry[] = [
  { id: 's-sentry', name: 'SENTRY_DSN', scope: 'team', kind: 'secret', detail: 'Sentry error reporting', site: 'crumbco.sentry.io', sensitive: false, expires: null, updated: 'Oct 2 by Theo', lastUsed: '2m ago · slot-holds' },
  { id: 's-region', name: 'AWS_REGION', scope: 'team', kind: 'value', detail: 'eu-west-1', sensitive: false, expires: null, updated: 'Sep 9 by Maya', lastUsed: 'now' },
  { id: 's-cloudflare', name: 'CLOUDFLARE_API_TOKEN', scope: 'team', kind: 'token', detail: 'Cloudflare · Workers Scripts and DNS edit', site: 'api.cloudflare.com', sensitive: true, expires: 12, rotation: 'Rotate every 90 days · reminder to Owners', updated: 'Aug 30 by Theo', lastUsed: '3h ago · deploy-menu-worker in menu-cache' },
  { id: 's-apple', name: 'APPLE_DEVELOPER', scope: 'team', kind: 'login', detail: 'Apple Developer · password and one-time code', site: 'developer.apple.com', username: 'dev@crumbco.example', sensitive: true, expires: null, updated: 'Sep 2 by Maya', lastUsed: 'yesterday · checkout-apple-pay' },
  { id: 's-aws-prod', name: 'AWS_PROD_DEPLOY', scope: 'team', kind: 'session', detail: 'AWS SSO · crumb-prod deploy role', site: 'crumbco.awsapps.com', signIn: true, sensitive: true, expires: 0, rotation: 'Refreshes itself every 8h', updated: 'Nov 1 by Theo', lastUsed: '12m ago · checkout-apple-pay' },
  { id: 's-square', name: 'SQUARE_ACCESS_TOKEN', scope: 'team', kind: 'token', detail: 'Square · the shop’s orders and the kitchen display (sandbox)', site: 'connect.squareupsandbox.com', sensitive: true, expires: null, updated: 'Nov 9 by Maya', lastUsed: 'yesterday · kitchen-display-queue' },
  { id: 's-db', name: 'DATABASE_URL', scope: 'crumb', kind: 'secret', detail: 'Staging Postgres', site: 'staging-db.crumbco.internal', sensitive: true, expires: null, updated: 'Nov 3 by Rina', lastUsed: '09:41 · seed-staging-db in kitchen-display-queue' },
  { id: 's-redis', name: 'REDIS_URL', scope: 'crumb', kind: 'secret', detail: 'Staging Redis (sessions and holds)', sensitive: false, expires: null, updated: 'Nov 19 by Rina', lastUsed: 'now · slot-holds' },
  { id: 's-flag', name: 'CHECKOUT_FLAGS', scope: 'crumb', kind: 'value', detail: 'apple_pay=on,holds=on', sensitive: false, expires: null, updated: 'today by Maya', lastUsed: 'now' },
  { id: 's-stripe', name: 'STRIPE_SECRET_KEY', scope: 'crumb', kind: 'token', detail: 'Stripe test key', site: 'api.stripe.com', sensitive: true, expires: null, updated: 'Oct 14 by Rina', lastUsed: '20m ago · slot-holds' },
  { id: 's-staging-admin', name: 'STAGING_ADMIN', scope: 'crumb', kind: 'login', detail: 'Crumb staging admin', site: 'staging.crumb.example', username: 'admin', sensitive: false, expires: 30, updated: 'Oct 20 by Theo', lastUsed: '1h ago · menu-cache' },
  { id: 's-kds', name: 'KDS_PASSKEY', scope: 'crumb', kind: 'login', detail: 'Kitchen display · site passkey', site: 'kds.crumb.example', signIn: true, sensitive: false, expires: null, updated: 'Nov 9 by Maya', lastUsed: '9m ago · kitchen-display-queue' },
  { id: 's-ledger-db', name: 'LEDGER_DB_URL', scope: 'ledger', kind: 'secret', detail: 'Ledger test database', sensitive: true, expires: null, updated: 'Nov 1 by Theo', lastUsed: '26m ago · bank-feed-sync' },
  { id: 's-openbank', name: 'OPENBANK_LOGIN', scope: 'ledger', kind: 'login', detail: 'Open Bank sandbox · password and one-time code', site: 'sandbox.openbank.example', username: 'ledger-dev', sensitive: false, expires: null, updated: 'Oct 20 by Theo', lastUsed: '26m ago · bank-feed-sync' },
  { id: 's-openbank-secret', name: 'OPENBANK_CLIENT_SECRET', scope: 'ledger', kind: 'token', detail: 'Open Bank client secret', site: 'sandbox.openbank.example', sensitive: true, expires: -2, failing: 'Expired', rotation: 'Expired 2 days ago · refresh-openbank-token and the Open Bank sandbox connection fail until it’s replaced', updated: 'Aug 25 by Theo', lastUsed: '3 days ago' },
  { id: 's-mapstyle', name: 'MAP_STYLE', scope: 'field-notes', kind: 'value', detail: 'outdoors-v12', sensitive: false, expires: null, updated: 'Aug 30 by Sam', lastUsed: 'now' },
  { id: 's-mapbox', name: 'MAPBOX_TOKEN', scope: 'field-notes', kind: 'token', detail: 'Mapbox geocoding', site: 'api.mapbox.com', sensitive: false, expires: 200, updated: 'Aug 30 by Maya', lastUsed: '1 min ago · photo-captions' },
  { id: 's-maya-npm', name: 'NPM_TOKEN', scope: 'maya', kind: 'token', detail: 'npm publish · @crumb packages', site: 'registry.npmjs.org', sensitive: true, expires: 60, updated: 'Oct 2', lastUsed: 'now · checkout-apple-pay' },
  { id: 's-maya-github', name: 'GITHUB_ADMIN_TOKEN', scope: 'maya', kind: 'token', detail: 'GitHub admin · crumb-and-co org settings', site: 'api.github.com', sensitive: true, expires: null, updated: 'Sep 12', lastUsed: '5h ago · slot-holds' },
  { id: 's-rina-aws', name: 'AWS_SANDBOX', scope: 'rina', kind: 'session', detail: 'AWS SSO · crumb-sandbox ElastiCache read/write', site: 'crumbco.awsapps.com', signIn: true, sensitive: false, expires: 0, rotation: 'Refreshes itself every 8h', updated: 'Nov 18', lastUsed: 'now · slot-holds' },
  { id: 's-theo-google', name: 'GOOGLE_DRIVE_TOKEN', scope: 'theo', kind: 'token', detail: 'Google Workspace · Drive invoices folder', site: 'www.googleapis.com', sensitive: true, expires: null, updated: 'Nov 4', lastUsed: 'now · invoice-pdf-export' },
  { id: 's-rel-npm', name: 'NPM_PUBLISH_TOKEN', scope: 'release-bot', kind: 'token', detail: 'npm publish for @crumbco/* packages', site: 'registry.npmjs.org', sensitive: true, expires: null, updated: 'Nov 12 by Theo', lastUsed: 'Fri 16:02 · release-2026-11-3 · approved by Theo' },
  { id: 's-rel-slack', name: 'SLACK_RELEASES_WEBHOOK', scope: 'release-bot', kind: 'secret', detail: 'Posting release notes to #releases', site: 'hooks.slack.com', sensitive: false, expires: null, updated: 'Nov 12 by Theo', lastUsed: 'Mon 16:00 · tax-rates-2027' },
  { id: 's-dep-npm', name: 'NPM_READ_TOKEN', scope: 'deps-bot', kind: 'token', detail: 'Installing private @crumbco/* packages', site: 'registry.npmjs.org', sensitive: false, expires: null, updated: 'Oct 30 by Maya', lastUsed: '13:20 · deps-week-48' },
  { id: 's-tri-desk', name: 'HELPDESK_API_KEY', scope: 'triage-bot', kind: 'token', detail: 'Reading tickets in the support desk', site: 'crumbco.helpdesk.example', sensitive: false, expires: null, updated: 'Sep 8 by Devon Hale', lastUsed: 'Nov 20 · bug-refund-email' },
];

/** What a project's browsers may open and its workspaces may reach, approved by content hash. */
export const ENVIRONMENT: Readonly<Record<string, ReadonlyArray<{ name: string; kind: string; state: string }>>> = {
  crumb: [{ name: 'POST /webhooks/pay', kind: 'Signed-caller route', state: 'Waiting on approval · #b71e04d' }, { name: 'staging.crumb.example', kind: 'Browser site · interact', state: 'Approved' }],
  ledger: [{ name: 'sandbox.openbank.example', kind: 'Browser site · interact', state: 'Waiting on approval · #e02c9aa' }],
  'field-notes': [{ name: 'api.mapbox.com', kind: 'Network egress', state: 'Approved' }],
};
/** A project's automations. */
export const AUTOMATIONS: Readonly<Record<string, ReadonlyArray<{ name: string; trigger: string; state: 'on' | 'paused' | 'proposed'; by: string }>>> = {
  crumb: [{ name: 'Weekly dependency updates', trigger: 'Mondays 06:00 · Deps bot', state: 'on', by: 'rina' }, { name: 'Friday release', trigger: 'Fridays 16:00 · Release bot', state: 'on', by: 'theo' }, { name: 'Nightly flaky-test sweep', trigger: 'Daily 02:00', state: 'proposed', by: 'maya' }],
  ledger: [{ name: 'Morning bank-feed import', trigger: 'Daily 07:00 · on ledger-cloud-2', state: 'on', by: 'theo' }],
  'field-notes': [],
};

/** What a project's work reaches beyond its own secrets: the team secrets it uses, the sites its browsers may open and
 * the hosts its workspaces may reach. */
export interface ProjectReach { teamSecrets: readonly string[]; origins: readonly string[]; network: readonly string[] }
export const PROJECT_REACH: Readonly<Record<string, ProjectReach>> = {
  crumb: { teamSecrets: ['SENTRY_DSN', 'AWS_REGION', 'APPLE_DEVELOPER', 'AWS_PROD_DEPLOY', 'CLOUDFLARE_API_TOKEN'], origins: ['staging.crumb.example', 'dashboard.stripe.com (test mode)', 'appleid.apple.com'], network: ['registry.npmjs.org', 'api.stripe.com', '*.crumbco.internal'] },
  ledger: { teamSecrets: ['SENTRY_DSN'], origins: ['sandbox.openbank.example'], network: ['bitbucket.org', 'sandbox.openbank.example'] },
  'field-notes': { teamSecrets: ['SENTRY_DSN'], origins: ['api.mapbox.com'], network: ['api.mapbox.com'] },
};

/** A project's environment, saved as numbered revisions. Each revision is a whole snapshot: the Instructions ("How to
 * work on this project", markdown agents read) and the machine profiles the project's work needs. A proposal (from an
 * agent in a workspace, from importing the repository's instructions, or from any project member who isn't a Lead)
 * waits for one of the project's Leads; a Lead's own change is saved directly. A proposal records the revision it was
 * made against (`base`); approving it after a newer revision was saved re-applies its change to the current one, with a
 * confirm. */
export interface EnvRevision { n: number; by: string; when: string; summary: string; instructions: string; profiles: readonly string[]; proposal: { from: string; base: number } | null }
const CRUMB_V5 = `# How to work on Crumb

Use the **Web** machine profile.

## Run it
- \`bun install\`, then \`bun run dev\` (port 5173). Start it with your service tool and share it through the relay.
- Redis for holds and sessions: \`redis-server --port 6379\`, also with the service tool.

## Tests
- \`bun test\` runs in CI on the pull request (GitHub Actions); its checks gate Review.

## Fixtures
- Ticket fixtures are in \`db/seed/\`. Ask a Lead before loading them into staging.`;
const CRUMB_V6 = CRUMB_V5.replace('- Ticket fixtures are in `db/seed/`. Ask a Lead before loading them into staging.', '- Run the approved script `seed-staging-db` with FIXTURES=tickets (or holds). Never run psql against staging yourself.\n\n## Secrets\n- DATABASE_URL reaches only `seed-staging-db`. REDIS_URL opens in a cleared shell for 15 min after your passkey.');
const CRUMB_V7 = CRUMB_V6.replace('Use the **Web** machine profile.', 'Use the **Web** machine profile; the **iOS** profile only for the Apple Pay sheet in `ios/`.').replace('- `bun test` runs in CI on the pull request (GitHub Actions); its checks gate Review.', '- `bun test` runs in CI on the pull request (GitHub Actions); its checks gate Review.\n- iOS: `xcodebuild test -scheme CrumbPay -destination \'platform=iOS Simulator,name=iPhone 16\'` runs in the same CI workflow.');
const LEDGER_V2 = `# How to work on Ledger

Use the **Web** and **Data** machine profiles.

## Run it
- \`pnpm i\`, then \`pnpm dev\`. The reconciliation notebooks run with \`uv run marimo edit notebooks/\`.

## Tests
- \`pnpm test\` (snapshot tests) runs in CI on the pull request; its checks gate Review.`;
const LEDGER_V3 = `${LEDGER_V2}

## Bank fixtures
- Clone bitbucket.org/openbank/sandbox-fixtures into \`fixtures/\`: it's reached only through ledger-cloud-2.
- A fresh sandbox token comes from the approved script \`refresh-openbank-token\`.`;
const FIELD_NOTES_V1 = `# How to work on Field notes

Use the **Web** machine profile.

- \`npm ci\`, then \`npm run dev\` for the field app. Maps need MAPBOX_TOKEN.
- The repository has no CI: say in your report which checks you ran, since Review relies on it.`;
export const ENV_REVISIONS: Readonly<Record<string, readonly EnvRevision[]>> = {
  crumb: [
    { n: 8, by: 'deps-bot', when: 'Proposed 13:35', summary: 'vitest 4.1: tests run with --pool=forks', instructions: CRUMB_V7.replace('- `bun test` runs in CI on the pull request (GitHub Actions); its checks gate Review.', '- `bun test --pool=forks` runs in CI on the pull request (vitest 4.1); its checks gate Review.'), profiles: ['web', 'ios'], proposal: { from: 'Deps bot’s agent in deps-week-48', base: 7 } },
    { n: 7, by: 'maya', when: 'Today 10:12', summary: 'Added the iOS machine profile', instructions: CRUMB_V7, profiles: ['web', 'ios'], proposal: null },
    { n: 6, by: 'theo', when: 'Nov 20', summary: 'Fixtures through the approved script seed-staging-db', instructions: CRUMB_V6, profiles: ['web'], proposal: null },
    { n: 5, by: 'maya', when: 'Nov 3', summary: 'Written by Set up with an agent in setup-environment', instructions: CRUMB_V5, profiles: ['web'], proposal: null },
  ],
  ledger: [
    { n: 3, by: 'theo', when: 'Nov 1', summary: 'Bank fixtures and the sandbox token script', instructions: LEDGER_V3, profiles: ['web', 'data'], proposal: null },
    { n: 2, by: 'rina', when: 'Oct 28', summary: 'Added the Data profile for the notebooks', instructions: LEDGER_V2, profiles: ['web', 'data'], proposal: null },
  ],
  'field-notes': [{ n: 1, by: 'sam', when: 'Aug 30', summary: 'Imported from the repository’s AGENTS.md', instructions: FIELD_NOTES_V1, profiles: ['web'], proposal: null }],
};
/** The instruction files each project's repository has, by path (importing proposes one of them as Instructions). */
export const REPO_INSTRUCTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  crumb: { 'AGENTS.md': CRUMB_V7.replace('- Redis for holds and sessions: `redis-server --port 6379`, also with the service tool.', '- Redis for holds and sessions: `redis-server --port 6379`, also with the service tool.\n- The kitchen display: `bun run kds` (port 4173).') },
  ledger: { '.gitspace/instructions.md': LEDGER_V3 },
  'field-notes': { 'AGENTS.md': FIELD_NOTES_V1 },
};
/** The values projects ask holders for that are site logins: their rule may have the browser fill them. */
export const ASKED_LOGINS: Readonly<Record<string, true>> = { STAGING_LOGIN: true };
/** Values projects ask each person for (You › My secrets): used only in workspaces that person holds, under the rule the
 * project sets for each (`secretRules` `personal:<name>`), which the person may narrow for their own value. */
export const PERSONAL_VALUES: Readonly<Record<string, ReadonlyArray<{ name: string; projectId: string; detail: string; set: boolean; updated: string }>>> = {
  maya: [{ name: 'STAGING_LOGIN', projectId: 'crumb', detail: 'Your staging.crumb.example login', set: true, updated: 'Nov 20' }, { name: 'FIGMA_TOKEN', projectId: 'crumb', detail: 'Your Figma personal access token', set: false, updated: '—' }, { name: 'SENTRY_AUTH_TOKEN', projectId: 'crumb', detail: 'Your Sentry auth token, for source-map uploads and release markers', set: true, updated: 'Nov 12' }],
  rina: [{ name: 'STAGING_LOGIN', projectId: 'crumb', detail: 'Your staging.crumb.example login', set: true, updated: 'Nov 21' }, { name: 'FIGMA_TOKEN', projectId: 'crumb', detail: 'Your Figma personal access token', set: false, updated: '—' }, { name: 'SENTRY_AUTH_TOKEN', projectId: 'crumb', detail: 'Your Sentry auth token, for source-map uploads and release markers', set: true, updated: 'Nov 19' }],
  theo: [{ name: 'STAGING_LOGIN', projectId: 'crumb', detail: 'Your staging.crumb.example login', set: true, updated: 'Nov 20' }, { name: 'FIGMA_TOKEN', projectId: 'crumb', detail: 'Your Figma personal access token', set: false, updated: '—' }, { name: 'SENTRY_AUTH_TOKEN', projectId: 'crumb', detail: 'Your Sentry auth token, for source-map uploads and release markers', set: false, updated: '—' }],
  sam: [{ name: 'STAGING_LOGIN', projectId: 'crumb', detail: 'Your staging.crumb.example login', set: false, updated: '—' }, { name: 'FIGMA_TOKEN', projectId: 'crumb', detail: 'Your Figma personal access token', set: true, updated: 'Nov 8' }],
  jules: [{ name: 'STAGING_LOGIN', projectId: 'crumb', detail: 'Your staging.crumb.example login', set: false, updated: '—' }],
};
/** Each person's own GitHub account, for their own machines' GitHub setup. */
export const GITHUB_ACCOUNTS: Readonly<Record<string, string | null>> = { maya: 'maya-okafor', theo: 'theopark', rina: 'rina-o', sam: 'samlee-design', jules: null };
/** Repositories a project could connect beyond the GitHub App's, to show every way a repo is reached or isn't. */
export const OTHER_REPOSITORIES: readonly string[] = ['gitlab.crumbco.example/ops/terraform', 'github.com/stripe-samples/apple-pay-js', 'bitbucket.org/openbank/sandbox-fixtures'];

/** The team's Slack app: installed once into the team's Slack by an Owner or Admin; posts to channels as GitSpace and
 * answers @GitSpace. A team resource, not anyone's own Slack connection. */
export const SLACK_APP: { workspace: string; installedBy: string; installed: string; channels: ReadonlyArray<{ name: string; projects: readonly string[]; posts: string }>; answers: string } = {
  workspace: 'crumbco.slack.com', installedBy: 'theo', installed: 'Nov 14',
  channels: [{ name: '#kitchen-dev', projects: ['crumb'], posts: 'Phase moves, questions waiting on someone, merged pull requests' }, { name: '#releases', projects: ['crumb', 'ledger'], posts: 'Release notes from Release bot' }, { name: '#ledger', projects: ['ledger'], posts: 'Approvals waiting and failed setups' }],
  answers: '@GitSpace in any channel it’s in: “@GitSpace what’s waiting on me?”, “@GitSpace status of slot-holds”',
};

/** Providers: the team's (API keys, Bedrock; never a Claude subscription, which is personal) and each person's own
 * (their Claude or ChatGPT subscription, their own keys). */
export type ProviderId = 'anthropic' | 'openai' | 'google';
export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
export interface ModelCredential {
  id: string; provider: ProviderId; label: string; owner: Owner;
  via: 'API key' | 'Bedrock' | 'Subscription';
  state: 'available' | 'rate-limited' | 'exhausted' | 'expired' | 'failing';
  stateDetail?: string;
  spentToday: number;
  lastUsed: string;
}
export const MODEL_CREDENTIALS: readonly ModelCredential[] = [
  { id: 'team-anthropic', provider: 'anthropic', label: 'Team Anthropic API key', via: 'API key', owner: { scope: 'account' }, state: 'available', spentToday: 43.7, lastUsed: 'now · deps-week-48' },
  { id: 'team-bedrock', provider: 'anthropic', label: 'AWS Bedrock (crumb-prod)', via: 'Bedrock', owner: { scope: 'account' }, state: 'available', spentToday: 2.4, lastUsed: '1h ago · invoice-pdf-export' },
  { id: 'team-openai', provider: 'openai', label: 'Team OpenAI API key', via: 'API key', owner: { scope: 'account' }, state: 'available', spentToday: 6.2, lastUsed: '20m ago · menu-cache' },
  { id: 'maya-claude', provider: 'anthropic', label: 'Maya’s Claude Max', via: 'Subscription', owner: { scope: 'user', userId: 'maya' }, state: 'available', spentToday: 9.1, lastUsed: '13:52 · slot-holds' },
  { id: 'rina-claude', provider: 'anthropic', label: 'Rina’s Claude Max', via: 'Subscription', owner: { scope: 'user', userId: 'rina' }, state: 'rate-limited', stateDetail: 'Rate-limited until 14:20', spentToday: 12.3, lastUsed: '13:05 · slot-holds' },
  { id: 'rina-openai', provider: 'openai', label: 'Rina’s OpenAI key', via: 'API key', owner: { scope: 'user', userId: 'rina' }, state: 'available', spentToday: 0, lastUsed: 'last week' },
  { id: 'theo-chatgpt', provider: 'openai', label: 'Theo’s ChatGPT Pro', via: 'Subscription', owner: { scope: 'user', userId: 'theo' }, state: 'available', spentToday: 4.0, lastUsed: '11:47 · menu-cache' },
  { id: 'sam-gemini', provider: 'google', label: 'Sam’s Gemini key', via: 'API key', owner: { scope: 'user', userId: 'sam' }, state: 'available', spentToday: 0, lastUsed: 'never' },
  { id: 'theo-anthropic', provider: 'anthropic', label: 'Theo’s Anthropic key', via: 'API key', owner: { scope: 'user', userId: 'theo' }, state: 'expired', stateDetail: 'Key revoked at Anthropic on Nov 20', spentToday: 0, lastUsed: 'Nov 19' },
  { id: 'release-bot-anthropic', provider: 'anthropic', label: 'Release bot’s Anthropic key', via: 'API key', owner: { scope: 'user', userId: 'release-bot' }, state: 'available', spentToday: 0.8, lastUsed: 'Friday · release-2.14' },
];

/** A kind of personal provider a profile may let holders pay with. */
export type PersonalKind = 'Anthropic subscription' | 'Anthropic API key' | 'OpenAI subscription' | 'OpenAI API key' | 'Google API key';
export const PERSONAL_KINDS: readonly PersonalKind[] = ['Anthropic subscription', 'Anthropic API key', 'OpenAI subscription', 'OpenAI API key', 'Google API key'];
const PERSONAL_KIND: Readonly<Record<ProviderId, { subscription: PersonalKind | null; key: PersonalKind }>> = {
  anthropic: { subscription: 'Anthropic subscription', key: 'Anthropic API key' }, openai: { subscription: 'OpenAI subscription', key: 'OpenAI API key' }, google: { subscription: null, key: 'Google API key' },
};
export function personalKindOf(credential: ModelCredential): PersonalKind {
  return (credential.via === 'Subscription' ? PERSONAL_KIND[credential.provider].subscription : null) ?? PERSONAL_KIND[credential.provider].key;
}
export type ServiceChoice = 'off' | 'workers-ai' | string;
/** An inference profile, edited in the real app's four tabs: Models (a model per role), Providers (the team providers
 * it uses, and which kinds of personal providers holders may pay with; empty: none), Services (each Off, Cloudflare
 * Workers AI on GitSpace's account, or a model from this profile's credentials) and Advanced (other runtime
 * settings). Projects apply a profile in their settings; the profile alone decides personal providers. */
export interface InferenceProfileMock {
  id: string; name: string;
  models: ReadonlyArray<{ role: string; model: string; note: string }>;
  teamProviders: readonly string[];
  personal: readonly PersonalKind[];
  services: Readonly<Record<string, ServiceChoice>>;
  advanced: ReadonlyArray<{ label: string; value: string }>;
}
export const SERVICES: ReadonlyArray<{ id: string; label: string; detail: string; models: readonly string[] }> = [
  { id: 'search', label: 'Web search', detail: 'Agents searching the web', models: ['anthropic/web-search', 'openai/web-search'] },
  { id: 'dictation', label: 'Dictation', detail: 'Voice to text in the composer', models: ['openai/gpt-6-transcribe'] },
  { id: 'images', label: 'Images', detail: 'Generating and editing images', models: ['openai/gpt-image-2'] },
  { id: 'speech', label: 'Speech', detail: 'Spoken replies', models: ['openai/gpt-6-tts'] },
  { id: 'decisions', label: 'Decisions', detail: 'Small yes/no calls: titles, routing, “is this done?”', models: ['anthropic/claude-haiku-5', 'openai/gpt-6-mini'] },
];
export const PROFILES: readonly InferenceProfileMock[] = [
  { id: 'default', name: 'Default', teamProviders: ['team-anthropic', 'team-openai'], personal: ['Anthropic subscription', 'Anthropic API key'],
    models: [{ role: 'default', model: 'anthropic/claude-opus-5:high', note: 'Every turn unless another role applies' }, { role: 'smol', model: 'anthropic/claude-haiku-5', note: 'Quick, cheap steps' },
      { role: 'slow', model: 'anthropic/claude-opus-5:max', note: 'Hard problems, on request' }, { role: 'plan', model: 'anthropic/claude-opus-5:high', note: 'Plan phase' },
      { role: 'commit', model: 'anthropic/claude-haiku-5', note: 'Commit messages' }, { role: 'vision', model: 'openai/gpt-6:high', note: 'Screenshots and images' },
      { role: 'review', model: 'openai/gpt-6:high', note: 'Review phase and Change Guides' }, { role: 'ghost', model: 'anthropic/claude-sonnet-5:medium', note: 'Ghosts reading a workspace' }],
    services: { search: 'anthropic/web-search', dictation: 'workers-ai', images: 'off', speech: 'workers-ai', decisions: 'anthropic/claude-haiku-5' },
    advanced: [{ label: 'Compaction', value: 'At 80% of context' }, { label: 'Thinking', value: 'High for default and plan, off for smol and commit' }, { label: 'Retries', value: '3, then the next credential in rotation' }, { label: 'Daily team spend cap', value: '$40' }] },
  { id: 'ledger', name: 'Ledger (team keys only)', teamProviders: ['team-bedrock'], personal: [],
    models: [{ role: 'default', model: 'bedrock/claude-sonnet-5:medium', note: 'Every turn unless another role applies' }, { role: 'smol', model: 'bedrock/claude-haiku-5', note: 'Quick, cheap steps' },
      { role: 'slow', model: 'bedrock/claude-opus-5:high', note: 'Hard problems, on request' }, { role: 'plan', model: 'bedrock/claude-sonnet-5:high', note: 'Plan phase' },
      { role: 'commit', model: 'bedrock/claude-haiku-5', note: 'Commit messages' }, { role: 'vision', model: 'bedrock/claude-sonnet-5:medium', note: 'Screenshots and images' }],
    services: { search: 'off', dictation: 'workers-ai', images: 'off', speech: 'off', decisions: 'bedrock/claude-haiku-5' },
    advanced: [{ label: 'Compaction', value: 'At 70% of context' }, { label: 'Data residency', value: 'Prompts and outputs stay in AWS eu-west-1 (Bedrock)' }, { label: 'Retries', value: '2' }] },
];

/** Today's usage per person or bot who started turns, split by which credential paid. Visibility only. */
export const USAGE: ReadonlyArray<{ userId: string; turns: number; tokens: number; byCredential: ReadonlyArray<{ credentialId: string; cost: number }> }> = [
  { userId: 'maya', turns: 41, tokens: 3_900_000, byCredential: [{ credentialId: 'maya-claude', cost: 9.1 }, { credentialId: 'team-anthropic', cost: 8.6 }] },
  { userId: 'rina', turns: 58, tokens: 5_200_000, byCredential: [{ credentialId: 'rina-claude', cost: 12.3 }, { credentialId: 'team-anthropic', cost: 14.9 }, { credentialId: 'team-openai', cost: 2.1 }] },
  { userId: 'theo', turns: 22, tokens: 1_700_000, byCredential: [{ credentialId: 'theo-chatgpt', cost: 4.0 }, { credentialId: 'team-anthropic', cost: 9.7 }] },
  { userId: 'sam', turns: 9, tokens: 600_000, byCredential: [{ credentialId: 'team-anthropic', cost: 5.2 }, { credentialId: 'team-openai', cost: 4.1 }] },
  { userId: 'deps-bot', turns: 11, tokens: 300_000, byCredential: [{ credentialId: 'team-anthropic', cost: 3.4 }] },
  { userId: 'release-bot', turns: 3, tokens: 100_000, byCredential: [{ credentialId: 'team-anthropic', cost: 1.9 }] },
];
/** Recent turns: who started it, which credential paid, and why it changed. */
export const RECENT_TURNS: ReadonlyArray<{ time: string; workspaceId: string; startedBy: string; client?: string; holders: readonly string[]; paidBy: string; note: string }> = [
  { time: '13:52', workspaceId: 'slot-holds', startedBy: 'rina', holders: ['maya', 'rina'], paidBy: 'maya-claude', note: 'Rina’s Claude Max is rate-limited → using Maya’s (sticky until it’s out)' },
  { time: '13:41', workspaceId: 'slot-holds', startedBy: 'maya', client: 'Claude Code', holders: ['maya', 'rina'], paidBy: 'maya-claude', note: 'Sent from Maya’s Claude Code: her turn, her credential' },
  { time: '13:20', workspaceId: 'deps-week-48', startedBy: 'deps-bot', holders: ['deps-bot'], paidBy: 'team-anthropic', note: 'Bots use the team’s credentials only' },
  { time: '13:02', workspaceId: 'slot-holds', startedBy: 'rina', holders: ['maya', 'rina'], paidBy: 'rina-claude', note: 'Sticky: Rina’s credential, still available' },
  { time: '12:58', workspaceId: 'invoice-pdf-export', startedBy: 'theo', holders: ['theo'], paidBy: 'team-anthropic', note: 'Ledger’s profile has User credentials off' },
  { time: '12:30', workspaceId: 'menu-cache', startedBy: 'theo', holders: ['theo'], paidBy: 'team-anthropic', note: 'Theo’s Anthropic key expired → the team’s' },
  { time: '12:12', workspaceId: 'loyalty-stamps', startedBy: 'sam', holders: ['sam'], paidBy: 'team-anthropic', note: 'Sam has no Anthropic credential; Google isn’t allowed in Default' },
];

/** What an MCP grant may do, at most what its person may: these are slices of their own permissions. */
export type Capability = 'read' | 'comment' | 'prompt' | 'take the handle' | 'move phases' | 'approve environment';
export const CAPABILITIES: readonly Capability[] = ['read', 'comment', 'prompt', 'take the handle', 'move phases', 'approve environment'];
/** A person's MCP client: it acts as that person, within a slice of their projects and capabilities, until it expires;
 * it prompts under their handle and has none of its own. */
export interface McpGrant { id: string; userId: string; client: string; via: 'OAuth' | 'Token'; projects: readonly string[]; capabilities: readonly Capability[]; expires: string; lastUsed: string; host: string }
export const MCP_GRANTS: readonly McpGrant[] = [
  { id: 'g1', userId: 'maya', client: 'Claude Desktop', via: 'OAuth', projects: ['crumb', 'ledger', 'field-notes'], capabilities: ['read', 'comment', 'prompt'], expires: 'in 30 days', lastUsed: '10m ago', host: 'claude.ai' },
  { id: 'g2', userId: 'maya', client: 'Claude Code', via: 'OAuth', projects: ['crumb'], capabilities: ['read', 'comment', 'prompt', 'take the handle'], expires: 'in 7 days', lastUsed: '13:41 · prompted slot-holds', host: 'claude.ai' },
  { id: 'g3', userId: 'rina', client: 'Cursor', via: 'OAuth', projects: ['crumb', 'ledger'], capabilities: ['read', 'prompt', 'take the handle'], expires: 'in 14 days', lastUsed: '2m ago', host: 'cursor.com' },
  { id: 'g4', userId: 'theo', client: 'Claude Code', via: 'OAuth', projects: ['ledger'], capabilities: ['read', 'prompt', 'move phases'], expires: 'in 30 days', lastUsed: '3h ago', host: 'claude.ai' },
  { id: 'g5', userId: 'sam', client: 'ChatGPT', via: 'OAuth', projects: ['crumb'], capabilities: ['read', 'comment'], expires: 'in 2 days', lastUsed: 'last week', host: 'chatgpt.com' },
  { id: 'g6', userId: 'jules', client: 'Claude Desktop', via: 'OAuth', projects: ['crumb'], capabilities: ['read', 'comment'], expires: 'in 30 days', lastUsed: '2 days ago', host: 'claude.ai' },
];

/** How a bot signs in: a Connected client (its MCP client ran the normal MCP sign-in and its sponsor or an Admin
 * approved “Connect as …” with their passkey; no secret was copied) or a Client secret (only Owners and Admins make one,
 * with a passkey; shown once, exchanged for short-lived access tokens with OAuth client_credentials, for scripts, CI and
 * cron). Like a person's MCP client, each is a slice: some of the bot's projects and capabilities, its roles the ceiling.
 * While the bot has no Admin sponsor, its sign-ins are blocked, not deleted. */
export interface BotSignIn { id: string; bot: string; kind: 'connected' | 'secret'; label: string; detail: string; by: string; created: string; lastUsed: string; projects: readonly string[]; capabilities: readonly Capability[] }
export const botSignIns = createStore<readonly BotSignIn[]>([
  { id: 'bs-rel-cc', bot: 'release-bot', kind: 'connected', label: 'Claude Code on build-01', detail: 'MCP client on the team’s build server · approved in Theo’s browser', by: 'Theo', created: 'Nov 12', lastUsed: '09:30 today', projects: ['crumb', 'ledger'], capabilities: ['read', 'comment', 'prompt', 'move phases'] },
  { id: 'bs-rel-ci', bot: 'release-bot', kind: 'secret', label: 'release-ci', detail: 'Client ID gsc_rel_7Hq2… · GitHub Actions workflow release.yml', by: 'Theo', created: 'Nov 12', lastUsed: 'Fri 16:00', projects: ['crumb'], capabilities: ['read', 'comment'] },
  { id: 'bs-dep-cc', bot: 'deps-bot', kind: 'connected', label: 'Claude Code on crumb-cell-1', detail: 'MCP client in the bot’s container · approved in Maya’s browser', by: 'Maya', created: 'Oct 30', lastUsed: '1 min ago', projects: ['crumb'], capabilities: ['read', 'comment', 'prompt', 'take the handle'] },
  { id: 'bs-dep-cron', bot: 'deps-bot', kind: 'secret', label: 'monday-cron', detail: 'Client ID gsc_dep_4Lm8… · cron on crumb-cell-1, opens the week’s workspace', by: 'Maya', created: 'Oct 30', lastUsed: 'Mon 06:00', projects: ['crumb'], capabilities: ['read', 'prompt'] },
  { id: 'bs-tri-secret', bot: 'triage-bot', kind: 'secret', label: 'support-inbox', detail: 'Client ID gsc_tri_0Pz5… · the support mailbox’s forwarder', by: 'Devon Hale', created: 'Sep 8', lastUsed: 'Nov 21', projects: ['crumb'], capabilities: ['read', 'comment'] },
]);
/** One thing a bot did: a turn it started, a commit it authored (with its sha), a comment, a phase move or a sign-in
 * event, in a workspace when there was one. */
export interface BotActivity { time: string; kind: 'turn' | 'commit' | 'comment' | 'phase' | 'sign-in'; text: string; workspace?: string; sha?: string }
/** What each bot did lately, newest first. */
export const BOT_ACTIVITY: Readonly<Record<string, readonly BotActivity[]>> = {
  'release-bot': [
    { time: '09:30', kind: 'comment', workspace: 'slot-holds', text: 'Commented: release 2026.11.4 is cut Friday 16:00' },
    { time: '09:14', kind: 'commit', workspace: 'tax-rates-2027', sha: 'a41c9e2', text: 'chore(release): 2026.11.4-rc.1 · bumped 3 packages' },
    { time: '09:12', kind: 'phase', workspace: 'tax-rates-2027', text: 'Moved into Ship' },
    { time: '09:05', kind: 'turn', workspace: 'tax-rates-2027', text: 'Started a turn: “Cut the release candidate and write the notes”' },
    { time: 'Mon 16:00', kind: 'commit', workspace: 'tax-rates-2027', sha: '7d02b5f', text: 'Opened #47 “Release 2026.11.3” and posted notes to #releases' },
  ],
  'deps-bot': [
    { time: '13:30', kind: 'phase', workspace: 'deps-week-48', text: 'Proposed moving into Review · its role (Contributor) can’t; waiting on a person' },
    { time: '13:24', kind: 'commit', workspace: 'deps-week-48', sha: 'e9f3a10', text: 'build(deps): vitest 4.1, rename poolOptions in vitest.config.ts' },
    { time: '13:20', kind: 'turn', workspace: 'deps-week-48', text: 'Prompted: update vitest.config.ts, rerun the suite' },
    { time: '11:06', kind: 'commit', workspace: 'deps-week-48', sha: '3b77c0d', text: 'build(deps): bump 7 packages within their semver range' },
    { time: '11:00', kind: 'turn', workspace: 'deps-week-48', text: 'Claimed the handle and moved it into Code' },
  ],
  'triage-bot': [
    { time: 'Nov 21', kind: 'sign-in', text: 'Sign-ins blocked: its sponsor Devon Hale left the team; waiting for an Admin to take it over' },
    { time: 'Nov 20', kind: 'turn', workspace: 'bug-refund-email', text: 'Created bug-refund-email in Crumb from a support email' },
  ],
};

export interface Invite { id: string; to: string; how: 'email' | 'link'; accountRole: string; projects: ReadonlyArray<{ projectId: string; roleId: string }>; by: string; expires: string; uses?: string }
export const INVITES: readonly Invite[] = [
  { id: 'inv1', to: 'pat@crumbco.example', how: 'email', accountRole: 'member', projects: [{ projectId: 'crumb', roleId: 'designer' }], by: 'maya', expires: 'in 6 days' },
  { id: 'inv2', to: 'Anyone at crumbco.example with the link', how: 'link', accountRole: 'member', projects: [{ projectId: 'field-notes', roleId: 'viewer' }], by: 'theo', expires: 'in 2 days', uses: '1 of 3 used' },
];

/** What users told an agent it may do, by talking to it: who said it, where, and how far it reaches. */
export const AGENT_PERMISSIONS: ReadonlyArray<{ id: string; grantedBy: string; text: string; scope: string; where: string; when: string }> = [
  { id: 'ap1', grantedBy: 'rina', text: 'May push to staging/* branches without asking', scope: 'Crumb · this workspace', where: 'slot-holds', when: 'today 11:20' },
  { id: 'ap2', grantedBy: 'maya', text: 'May run database migrations against the staging database', scope: 'Crumb · every workspace', where: 'kitchen-display-queue', when: 'yesterday' },
  { id: 'ap3', grantedBy: 'theo', text: 'May open pull requests and request review from Maya', scope: 'Ledger · every workspace', where: 'invoice-pdf-export', when: 'Nov 18' },
  { id: 'ap4', grantedBy: 'sam', text: 'May post design screenshots to #kitchen-dev', scope: 'Crumb · this workspace', where: 'loyalty-stamps', when: 'Nov 21' },
];

export type AuditKind = 'team' | 'prompt' | 'comment' | 'handle' | 'phase' | 'approval' | 'resource' | 'setting' | 'agent' | 'bot';
/** One audit row: `actor` is a person or a bot; `client` is the person's MCP client when it acted for them. */
export interface AuditEntry { time: string; actor: string; client?: string; kind: AuditKind; text: string; project?: string }
const AUDIT: readonly AuditEntry[] = [
  { time: 'Today 13:52', actor: 'rina', kind: 'setting', text: 'Turn in slot-holds paid by Maya’s Claude Max (Rina’s rate-limited)', project: 'crumb' },
  { time: 'Today 13:41', actor: 'maya', client: 'Claude Code', kind: 'prompt', text: 'Prompted slot-holds under Maya’s handle: “Run the hold-expiry tests against the staging Redis…”', project: 'crumb' },
  { time: 'Today 13:40', actor: 'maya', kind: 'handle', text: 'Accepted Rina’s request for the handle of slot-holds · now held by Maya and Rina', project: 'crumb' },
  { time: 'Today 13:30', actor: 'deps-bot', client: 'Claude Code', kind: 'phase', text: 'Proposed moving deps-week-48 into Review · its project role in Crumb (Contributor) can’t; waiting on a person', project: 'crumb' },
  { time: 'Today 13:12', actor: 'theo', kind: 'handle', text: 'Took over menu-cache from Sam (Sam was idle 40m)', project: 'crumb' },
  { time: 'Today 12:58', actor: 'rina', kind: 'phase', text: 'Moved invoice-pdf-export into Code', project: 'ledger' },
  { time: 'Today 12:44', actor: 'sam', kind: 'phase', text: 'Accepted the agent’s proposal to move loyalty-stamps into Plan', project: 'crumb' },
  { time: 'Today 12:31', actor: 'maya', kind: 'setting', text: 'Saved revision 7 of Crumb’s environment: added the iOS machine profile', project: 'crumb' },
  { time: 'Today 11:20', actor: 'rina', kind: 'agent', text: 'Told the agent in slot-holds: “you may push to staging/* without asking”', project: 'crumb' },
  { time: 'Today 11:02', actor: 'rina', kind: 'resource', text: 'Stepped up AWS SSO (sandbox) in slot-holds with a passkey · 60 min, her turns only', project: 'crumb' },
  { time: 'Today 10:05', actor: 'theo', kind: 'setting', text: 'Default profile · Providers: holders may pay with Anthropic subscriptions and Anthropic API keys; OpenAI subscriptions no longer' },
  { time: 'Today 09:47', actor: 'theo', kind: 'resource', text: 'Enabled Linear (account connection) in Ledger', project: 'ledger' },
  { time: 'Today 09:30', actor: 'release-bot', client: 'Claude Code', kind: 'comment', text: 'Commented on slot-holds: “Release 2026.11.4 is cut from develop on Friday 16:00…”', project: 'crumb' },
  { time: 'Today 09:12', actor: 'release-bot', client: 'release-ci', kind: 'phase', text: 'Moved tax-rates-2027 into Ship', project: 'ledger' },
  { time: 'Yesterday 18:05', actor: 'theo', kind: 'bot', text: 'Connected Claude Code on build-01 as Release bot · approved with Theo’s passkey (ThinkPad)' },
  { time: 'Yesterday 18:02', actor: 'theo', kind: 'bot', text: 'Created Release bot (sponsored by Theo) · Engineer in Crumb and Ledger · confirmed with Theo’s passkey (ThinkPad)' },
  { time: 'Yesterday 16:30', actor: 'maya', kind: 'team', text: 'Changed Rina Ortiz’s project role in Ledger: Engineer → Lead', project: 'ledger' },
  { time: 'Yesterday 16:05', actor: 'rina', kind: 'team', text: 'Added Deps bot to Ledger as Contributor (Rina is Lead in Ledger)', project: 'ledger' },
  { time: 'Yesterday 15:10', actor: 'theo', kind: 'resource', text: 'Rotated Cloudflare API token (team credential)' },
  { time: 'Nov 21 14:00', actor: 'maya', kind: 'team', text: 'Removed Devon Hale (former contractor): 2 passkeys, 1 device, 1 MCP grant and 2 personal resources deleted; released 1 handle; Support triage bot suspended until an Owner or Admin reassigns it. History keeps the name.' },
  { time: 'Nov 20 10:12', actor: 'maya', kind: 'team', text: 'Invited jules@crumbco.example with account role Member · Contributor in Crumb · confirmed with Maya’s passkey (MacBook Pro)' },
  { time: 'Nov 19 09:00', actor: 'theo', kind: 'team', text: 'Created project role Designer from Contributor' },
  { time: 'Nov 18 17:40', actor: 'maya', kind: 'team', text: 'Changed Theo Park’s account role: Member → Admin' },
  { time: 'Nov 14 11:00', actor: 'theo', kind: 'resource', text: 'Installed the Slack app in crumbco.slack.com · #kitchen-dev, #releases, #ledger' },
];

/** The audit log: the entries the mock starts with, under what people do while it's open (Join project, members). */
export const audit = createStore<readonly AuditEntry[]>(AUDIT);
export function recordAudit(entry: Omit<AuditEntry, 'time'>): void { audit.set([{ time: 'Just now', ...entry }, ...audit.get()]); }

/** Monthly budgets, set in Crumb & Co › Inference and shown on Usage against month-to-date spend (inference, services
 * and compute). Reaching the alert level tells Owners, Admins and the project's Leads; turns keep running. */
export interface Budget { id: string; scope: 'team' | 'project' | 'person'; target: string; label: string; monthly: number; alertAt: number; covers: string; spent: number }
export const budgets = createStore<readonly Budget[]>([
  { id: 'b-team', scope: 'team', target: 'team', label: 'Crumb & Co', monthly: 1500, alertAt: 80, covers: 'inference, services and compute', spent: 912.4 },
  { id: 'b-crumb', scope: 'project', target: 'crumb', label: 'Crumb', monthly: 900, alertAt: 80, covers: 'turns and compute in Crumb’s workspaces', spent: 618.2 },
  { id: 'b-ledger', scope: 'project', target: 'ledger', label: 'Ledger', monthly: 300, alertAt: 75, covers: 'turns and compute in Ledger’s workspaces', spent: 241.9 },
  { id: 'b-deps-bot', scope: 'person', target: 'deps-bot', label: 'Deps bot', monthly: 60, alertAt: 90, covers: 'turns it starts', spent: 22.5 },
]);

/** Account-role changes and removals made while the mock is open: People and Settings › People & roles show them. */
export const accountRoleChanges = createStore<Readonly<Record<string, AccountRoleId>>>({});
export const removedUsers = createStore<ReadonlySet<string>>(new Set());
/** Who is signed in now and what they're doing: online in a workspace, away, or offline since. */
export interface Presence { state: 'online' | 'away' | 'offline'; where: string | null; doing: string; since: string; device: string }
export const PRESENCE: Readonly<Record<string, Presence>> = {
  maya: { state: 'online', where: 'slot-holds', doing: 'Reading the Change Guide', since: '06:02', device: 'MacBook Pro' },
  rina: { state: 'online', where: 'bank-feed-sync', doing: 'Answering a browser approval · sandbox.openbank.example', since: '07:10', device: 'rina-workstation' },
  theo: { state: 'away', where: 'kitchen-display-queue', doing: 'Idle 12 min', since: '08:40', device: 'ThinkPad' },
  sam: { state: 'online', where: 'offline-drafts', doing: 'Trying sync with the network off', since: '09:15', device: 'MacBook Air' },
  jules: { state: 'offline', where: null, doing: 'Last seen yesterday 17:20', since: 'yesterday', device: 'MacBook Air' },
  'release-bot': { state: 'online', where: 'slot-holds', doing: 'Commented 09:30 · via Claude Code on build-01', since: '09:30', device: 'build-01' },
  'deps-bot': { state: 'online', where: 'deps-week-48', doing: 'Running the test suite · via Claude Code', since: '11:00', device: 'crumb-cell-1' },
  'triage-bot': { state: 'offline', where: null, doing: 'Sign-ins blocked since Nov 21', since: 'Nov 21', device: '—' },
};

/** A presence as one viewer sees it. `limited`: the viewer isn't in the project of the workspace it's in (or, outside a
 * workspace, shares no project with it), so it reads only online or offline: no workspace, activity, time or device. */
export interface SeenPresence extends Presence { limited: boolean }
const OFFLINE: Presence = { state: 'offline', where: null, doing: '', since: '', device: '' };

export function presenceSeenBy(viewerId: string, subjectId: string): SeenPresence {
  const presence = PRESENCE[subjectId] ?? OFFLINE;
  if (viewerId === subjectId) return { ...presence, limited: false };
  const seen = visibleProjects(viewerId);
  const project = presence.where ? WORKSPACES.find((workspace) => workspace.id === presence.where)?.projectId : null;
  const shared = project ? seen.has(project) : [...visibleProjects(subjectId)].some((id) => seen.has(id));
  if (shared) return { ...presence, limited: false };
  return { state: presence.state === 'offline' ? 'offline' : 'online', where: null, doing: '', since: '', device: '', limited: true };
}

/** The one line a card shows: "Online in slot-holds · Reading the Change Guide", or just "Online" when limited. */
export function presenceLine(presence: SeenPresence): string {
  const label = presence.state === 'online' ? 'Online' : presence.state === 'away' ? 'Away' : 'Offline';
  return `${label}${presence.where ? ` in ${presence.where}` : ''}${presence.doing ? ` · ${presence.doing}` : ''}`;
}

/** Said beside a limited presence. */
export const LIMITED_PRESENCE = 'Where and what show only to people in the same project';
