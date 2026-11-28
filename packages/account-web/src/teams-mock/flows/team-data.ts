// The team pages' live mock state: allowed email domains and pending invites (People & roles), secrets (the team's,
// each project's, each person's and each bot's own: Secrets, each project's Secrets, My secrets, a bot's secrets),
// custom domains (Domains),
// the release channel and releases (Source & releases), the GitHub App and its installations (GitHub App). Each starts
// from the settings data and changes as the flows finish.
import { TEAM } from '../data.js';
import { GITHUB_APP, INVITES, SECRETS, type Invite, type SecretEntry } from '../settings/data.js';
import { createStore } from '../store.js';

/** The domains invites may go to. */
export const allowedDomains = createStore<readonly string[]>(TEAM.domains);
/** Pending invites, newest first. */
export const invites = createStore<readonly Invite[]>(INVITES);
/** Webmail and other public domains: allowing one would let anyone with a free address be invited. */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me'];

/** Every secret: the team's (`scope: 'team'`), each project's (its id) and each person's own (their user id). Values
 * are write-only except for kind `value`. */
export const secrets = createStore<readonly SecretEntry[]>(SECRETS);

/** An env var name: UPPER_SNAKE_CASE, starting with a letter. */
export const ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/** Service tokens the mock can "read back" from the service: the scopes each one carries. Any other token of a known
 * service carries every scope the service needs. */
export interface TokenService { id: string; label: string; host: string; prefix: string; example: string; needs: readonly string[]; where: string }
export const TOKEN_SERVICES: readonly TokenService[] = [
  { id: 'cloudflare', label: 'Cloudflare', host: 'api.cloudflare.com', prefix: 'cf_', example: 'cf_8Qm…', needs: ['Zone:DNS:Edit', 'Workers Scripts:Edit'], where: 'dash.cloudflare.com → My Profile → API Tokens → Edit token' },
  { id: 'stripe', label: 'Stripe (restricted key)', host: 'api.stripe.com', prefix: 'rk_test_', example: 'rk_test_51N…', needs: ['Charges: write', 'Customers: read'], where: 'dashboard.stripe.com → Developers → API keys → Restricted keys → Edit' },
  { id: 'sentry', label: 'Sentry auth token', host: 'crumbco.sentry.io', prefix: 'sntrys_', example: 'sntrys_eyJ…', needs: ['project:releases', 'org:read'], where: 'crumbco.sentry.io → Settings → Auth Tokens → the token’s scopes' },
];
/** A token the service reports as missing a scope: its value, and which scope it lacks. */
export const SHORT_SCOPED_TOKENS: Readonly<Record<string, string>> = {
  cf_8QmZt1readonlyDNSv2Kk: 'Workers Scripts:Edit',
  rk_test_51NcrumbReadOnly0001: 'Charges: write',
  sntrys_eyJcrumbOrgReadOnly: 'project:releases',
};

/** The account's custom domains (besides its GitSpace address). */
export interface CustomDomain { name: string; purpose: 'address' | 'previews'; state: 'verified' | 'pending'; detail: string }
export const customDomains = createStore<readonly CustomDomain[]>([
  { name: 'gitspace.crumbco.example', purpose: 'address', state: 'verified', detail: 'Custom domain · CNAME to crumbco.gitspace.sh · verified Nov 3' },
  { name: '*.preview.crumbco.dev', purpose: 'previews', state: 'pending', detail: 'Workspace previews · each workspace’s services at <workspace>.preview.crumbco.dev' },
]);
/** A domain name or a wildcard one (`*.preview.example.com`). */
export const DOMAIN_NAME = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Releases, newest first. A release after a database migration can't be rolled back past it. */
export interface Release { version: string; commit: string; deployed: string; notes: string; migration?: string }
export const RELEASES: readonly Release[] = [
  { version: '2026.11.3', commit: '4be91c0', deployed: 'Nov 21', notes: 'Bots act only over MCP; blocked sign-ins expire after 30 days' },
  { version: '2026.11.2', commit: 'a17c3de', deployed: 'Nov 14', notes: 'Audit log export; People page presence' },
  { version: '2026.11.1', commit: '9e02b4f', deployed: 'Nov 7', notes: 'Inference budgets; Slack app answers in threads' },
  { version: '2026.10.4', commit: '31d8a66', deployed: 'Oct 31', notes: 'Workspace credentials per phase', migration: '2026.11.1 migrated credentials to per-phase rows (0142); it can’t be undone' },
];
export const release = createStore<{ channel: 'stable' | 'beta'; running: string; rolledBack: boolean; auto: boolean }>({ channel: 'stable', running: '2026.11.3', rolledBack: false, auto: true });

/** The GitHub organizations the viewer's GitHub account belongs to, and who owns each. */
export interface GitHubOrg { login: string; owners: readonly string[]; members: readonly string[]; repositories: readonly string[] }
export const GITHUB_ORGS: readonly GitHubOrg[] = [
  { login: 'crumb-co', owners: ['maya'], members: ['theo', 'rina', 'sam', 'jules'], repositories: ['crumb', 'crumb-kitchen', 'ledger', 'field-notes', 'bakery-site', 'design-tokens', 'ops-runbooks'] },
  { login: 'crumb-labs', owners: ['theo', 'maya'], members: ['rina'], repositories: ['receipt-printer-driver', 'kds-firmware', 'label-printer'] },
  { login: 'crumb-events', owners: ['maya', 'theo'], members: ['sam'], repositories: ['popup-site', 'tickets-api', 'event-photos'] },
  { login: 'bakery-partners', owners: ['nadia-k (not on Crumb & Co)'], members: ['maya', 'theo'], repositories: ['wholesale-portal', 'orders-feed'] },
];
export interface Installation { org: string; installed: string; by: string; selection: 'all' | 'selected'; repositories: readonly string[] }
/** The App (null until it's created: `?app=none` opens the page as a team that hasn't made one) and its installations. */
export const githubApp = createStore<{ name: string; slug: string; installations: readonly Installation[] } | null>(
  new URLSearchParams(window.location.search).get('app') === 'none' ? null : {
    name: GITHUB_APP.name, slug: 'gitspace-for-crumb-co',
    installations: GITHUB_APP.installations.map((entry) => ({ ...entry, selection: 'selected', repositories: entry.repositories })),
  },
);
/** The permissions the App asks for, as its manifest declares them. */
export const APP_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ['Contents', 'Read and write'], ['Pull requests', 'Read and write'], ['Checks', 'Read and write'], ['Commit statuses', 'Read and write'],
  ['Workflows', 'Read and write'], ['Issues', 'Read'], ['Metadata', 'Read (always)'],
];
export const APP_EVENTS = 'push, pull_request, pull_request_review, check_suite, check_run, installation, installation_repositories';

/** The audit log's day: "Today" is Nov 23 in the mock's entries. */
export const AUDIT_TODAY = 23;
