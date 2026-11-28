// The environment and secrets model (round 7), shared by Project › Environment, Machine profiles, Approved scripts and
// every secret row:
// - Machine profiles: a team library of what a machine must have (checks, a setup and a teardown script, the cloud
//   image that already has it). A team machine runs a profile's scripts once an Admin approves them by content hash; a
//   personal machine's owner approves them per machine, or declines the profile on that machine. A project lists the
//   profiles its work needs; a workspace or a task can add one. Placement prefers a machine that is ready.
// - Approved scripts: agents submit a script (its content, the secrets it needs by name, typed inputs, the prompts it may
//   ask a person while it runs, allowed network destinations, the profile it needs). Approved for the holder ("For
//   me"), for a project (a Lead approves) or for the team (an Admin approves); the approval covers the script's own
//   content hash. Agents then run it by name in their working copy. Secrets go only into that process; output is
//   redacted. A prompt pauses the run and asks one person (a code, a password, a choice, or a link to open); the
//   answer goes straight into the process's input, never into the transcript or the model.
// - Secret rules: who may use each secret (roles; Owners always count as Admins), whether only while holding the
//   workspace's handle, and how it is delivered: only to approved scripts, in a cleared shell for N minutes after a
//   passkey (an Admin can forbid it per secret), by the browser filling its login form on named sites, or (a bot's own
//   secret) to approved scripts once its sponsor approves each use with their passkey.
import { createStore } from '../store.js';

// ── Machine profiles ──

export interface ProfileCheck { label: string; command: string; install: string }
export interface ProfileVersion { n: number; hash: string; setup: string; teardown: string; checks: readonly ProfileCheck[]; by: string; when: string; note: string }
export interface MachineProfile {
  id: string; name: string; summary: string;
  /** For cloud machines: the image that already has everything, so setup is skipped. */
  image: string | null;
  /** Newest first; versions[0] is current. */
  versions: readonly ProfileVersion[];
  /** Team machines run the scripts whose hash an Admin approved. */
  teamApproval: { hash: string; by: string; when: string } | null;
}
export const machineProfiles = createStore<readonly MachineProfile[]>([
  { id: 'web', name: 'Web', summary: 'bun, node 22, gh', image: 'gitspace/web:2026.11',
    versions: [{ n: 3, hash: 'a41f09c', by: 'theo', when: 'Nov 12', note: 'bun 1.3',
      checks: [{ label: 'bun ≥ 1.3', command: 'bun --version', install: 'curl -fsSL https://bun.sh/install | bash' }, { label: 'node 22', command: 'node --version', install: 'mise use -g node@22' }, { label: 'gh', command: 'gh --version', install: 'brew install gh · apt install gh' }],
      setup: 'mise use -g node@22\ncurl -fsSL https://bun.sh/install | bash\ngh auth status || true', teardown: 'rm -rf ~/.bun/install/cache' },
    { n: 2, hash: '58be3d1', by: 'maya', when: 'Oct 21', note: 'node 22',
      checks: [{ label: 'bun ≥ 1.2', command: 'bun --version', install: 'curl -fsSL https://bun.sh/install | bash' }, { label: 'node 22', command: 'node --version', install: 'mise use -g node@22' }, { label: 'gh', command: 'gh --version', install: 'brew install gh · apt install gh' }],
      setup: 'mise use -g node@22\ncurl -fsSL https://bun.sh/install | bash -s bun-v1.2.23\ngh auth status || true', teardown: 'rm -rf ~/.bun/install/cache' },
    { n: 1, hash: '0c7a912', by: 'maya', when: 'Sep 30', note: 'First version',
      checks: [{ label: 'bun', command: 'bun --version', install: 'curl -fsSL https://bun.sh/install | bash' }, { label: 'node 20', command: 'node --version', install: 'mise use -g node@20' }],
      setup: 'mise use -g node@20\ncurl -fsSL https://bun.sh/install | bash', teardown: 'rm -rf ~/.bun/install/cache' }],
    teamApproval: { hash: 'a41f09c', by: 'theo', when: 'Nov 12' } },
  { id: 'ios', name: 'iOS', summary: 'Xcode 16, iOS 18 simulator, CocoaPods', image: null,
    versions: [{ n: 2, hash: '7c2e1b4', by: 'maya', when: 'Nov 18', note: 'iOS 18 simulator runtime',
      checks: [{ label: 'Xcode 16', command: 'xcodebuild -version', install: 'Install Xcode 16 from the App Store, then xcode-select -s' }, { label: 'iOS 18 simulator', command: 'xcrun simctl list runtimes | grep "iOS 18"', install: 'xcodebuild -downloadPlatform iOS' }, { label: 'CocoaPods', command: 'pod --version', install: 'brew install cocoapods' }],
      setup: 'xcodebuild -downloadPlatform iOS\nbrew install cocoapods', teardown: 'xcrun simctl delete unavailable' },
    { n: 1, hash: '2f94c06', by: 'maya', when: 'Oct 9', note: 'First version',
      checks: [{ label: 'Xcode 16', command: 'xcodebuild -version', install: 'Install Xcode 16 from the App Store, then xcode-select -s' }, { label: 'CocoaPods', command: 'pod --version', install: 'brew install cocoapods' }],
      setup: 'brew install cocoapods', teardown: 'xcrun simctl delete unavailable' }],
    teamApproval: { hash: '7c2e1b4', by: 'maya', when: 'Nov 18' } },
  { id: 'data', name: 'Data', summary: 'python 3.12, uv, duckdb', image: 'gitspace/data:2026.10',
    versions: [{ n: 1, hash: 'e90d3aa', by: 'rina', when: 'Oct 28', note: 'First version',
      checks: [{ label: 'python 3.12', command: 'python3 --version', install: 'uv python install 3.12' }, { label: 'uv', command: 'uv --version', install: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }, { label: 'duckdb', command: 'duckdb --version', install: 'uv tool install duckdb' }],
      setup: 'curl -LsSf https://astral.sh/uv/install.sh | sh\nuv python install 3.12\nuv tool install duckdb', teardown: 'uv cache clean' }],
    teamApproval: null },
]);

/** A profile on one machine: ready, missing something (and what), setup waiting for approval (team machines: an Admin;
 * personal machines: their owner), declined by the owner on that machine, or setup running. */
export type Readiness =
  | { state: 'ready'; hash: string }
  | { state: 'missing'; missing: string; hash: string | null }
  | { state: 'needs-approval'; hash: string }
  | { state: 'declined'; by: string; when: string; note: string }
  | { state: 'running'; started: string };
export const machineReadiness = createStore<Readonly<Record<string, Readonly<Record<string, Readiness>>>>>({
  'crumb-cloud-1': { web: { state: 'ready', hash: 'a41f09c' }, data: { state: 'needs-approval', hash: 'e90d3aa' } },
  'ledger-cloud-2': { web: { state: 'ready', hash: 'a41f09c' }, data: { state: 'needs-approval', hash: 'e90d3aa' } },
  'ec2-fleet': { web: { state: 'ready', hash: 'a41f09c' } },
  'counter-mini': { web: { state: 'ready', hash: 'a41f09c' }, ios: { state: 'missing', missing: 'iOS 18 simulator', hash: '7c2e1b4' } },
  'maya-mbp': { web: { state: 'ready', hash: 'a41f09c' }, ios: { state: 'ready', hash: '7c2e1b4' } },
  'rina-box': { web: { state: 'ready', hash: 'a41f09c' }, data: { state: 'ready', hash: 'e90d3aa' }, ios: { state: 'declined', by: 'rina', when: 'Nov 2', note: 'Linux: no Xcode here' } },
  'theo-laptop': { web: { state: 'needs-approval', hash: 'a41f09c' } },
  'jules-mba': { web: { state: 'missing', missing: 'bun', hash: null } },
});
/** The profiles each project's work needs (a workspace or a task can add one). */
export const projectProfiles = createStore<Readonly<Record<string, readonly string[]>>>({ crumb: ['web', 'ios'], ledger: ['web', 'data'], 'field-notes': ['web'] });
/** Profiles a workspace added beyond its project's (by workspace id). */
export const workspaceProfiles = createStore<Readonly<Record<string, readonly string[]>>>({ 'offline-drafts': ['ios'] });

// ── Approved scripts ──

export type ScriptScope = { kind: 'me'; userId: string } | { kind: 'project'; projectId: string } | { kind: 'team' };
/** Typed inputs only: one of a list, or text matching a pattern. Never free text. */
export type ScriptInput = { name: string; kind: 'enum'; values: readonly string[] } | { name: string; kind: 'pattern'; pattern: string; example: string };
/** What a script may ask a person while it runs. `answeredBy`: the workspace's holder (for a bot: its sponsor), or
 * anyone in the approval's scope. A `link` prompt shows a URL and a code to open (an SSO device sign-in) and waits for
 * the script to continue. */
export interface ScriptPrompt {
  name: string; label: string;
  kind: 'code' | 'password' | 'choice' | 'link';
  /** For `choice`: the options. For `code`: the pattern the answer must match. */
  choices?: readonly string[]; pattern?: string;
  answeredBy: 'holder' | 'scope';
}
export interface ScriptVersion {
  n: number; hash: string; body: string;
  secrets: readonly string[]; inputs: readonly ScriptInput[]; prompts: readonly ScriptPrompt[]; network: readonly string[];
  profile: string | null;
  submittedBy: string; submittedIn: string; when: string;
  state: 'approved' | 'pending' | 'declined' | 'revoked';
  approvedBy: string | null; approvedWhen: string | null;
}
export interface ScriptRun { who: string; workspace: string; when: string; exit: number; version: number; inputs: string }
export interface ApprovedScript { id: string; name: string; description: string; scope: ScriptScope; versions: readonly ScriptVersion[]; runs: readonly ScriptRun[] }
export const approvedScripts = createStore<readonly ApprovedScript[]>([
  { id: 'seed-staging', name: 'seed-staging-db', description: 'Resets the staging Postgres schema and loads the ticket fixtures', scope: { kind: 'project', projectId: 'crumb' },
    versions: [
      { n: 2, hash: '5d1c7e2', body: 'psql "$DATABASE_URL" -f db/reset.sql\npsql "$DATABASE_URL" -f db/seed/${FIXTURES}.sql', secrets: ['DATABASE_URL'], inputs: [{ name: 'FIXTURES', kind: 'enum', values: ['tickets', 'holds', 'empty'] }], prompts: [], network: ['staging-db.crumbco.internal:5432'], profile: 'web', submittedBy: 'agent in kitchen-display-queue (Theo holds it)', submittedIn: 'kitchen-display-queue', when: 'Nov 20', state: 'approved', approvedBy: 'theo', approvedWhen: 'Nov 20' },
      { n: 1, hash: '91aa04b', body: 'psql "$DATABASE_URL" -f db/seed/tickets.sql', secrets: ['DATABASE_URL'], inputs: [], prompts: [], network: ['staging-db.crumbco.internal:5432'], profile: 'web', submittedBy: 'agent in slot-holds (Maya holds it)', submittedIn: 'slot-holds', when: 'Nov 3', state: 'approved', approvedBy: 'maya', approvedWhen: 'Nov 3' },
    ],
    runs: [
      { who: 'agent in kitchen-display-queue (Theo)', workspace: 'kitchen-display-queue', when: 'today 09:41', exit: 0, version: 2, inputs: 'FIXTURES=tickets' },
      { who: 'agent in slot-picker-ui (Rina)', workspace: 'slot-picker-ui', when: 'today 08:02', exit: 0, version: 2, inputs: 'FIXTURES=holds' },
      { who: 'Deps bot (sponsored by Maya)', workspace: 'deps-week-48', when: 'yesterday 17:10', exit: 1, version: 2, inputs: 'FIXTURES=empty' },
    ] },
  { id: 'deploy-worker', name: 'deploy-menu-worker', description: 'Deploys the menu cache worker to Cloudflare', scope: { kind: 'team' },
    versions: [{ n: 1, hash: '3e8b5f1', body: 'bunx wrangler deploy --env ${ENVIRONMENT}', secrets: ['CLOUDFLARE_API_TOKEN'], inputs: [{ name: 'ENVIRONMENT', kind: 'enum', values: ['staging', 'production'] }], prompts: [], network: ['api.cloudflare.com'], profile: 'web', submittedBy: 'agent in menu-cache (Theo holds it)', submittedIn: 'menu-cache', when: 'Nov 14', state: 'approved', approvedBy: 'theo', approvedWhen: 'Nov 14' }],
    runs: [{ who: 'agent in menu-cache (Theo)', workspace: 'menu-cache', when: '3h ago', exit: 0, version: 1, inputs: 'ENVIRONMENT=staging' }] },
  { id: 'deploy-checkout', name: 'deploy-checkout-prod', description: 'Deploys the checkout service to production on AWS, after the holder’s MFA code', scope: { kind: 'team' },
    versions: [{ n: 1, hash: '8a3f6d2', body: 'aws sts get-session-token --serial-number "$MFA_DEVICE" --token-code "$(gitspace prompt MFA_CODE)"\nREGION=$(gitspace prompt REGION)\nsst deploy --stage production --region "$REGION"', secrets: ['AWS_PROD_DEPLOY'], inputs: [],
      prompts: [{ name: 'MFA_CODE', label: 'AWS MFA code for crumb-prod', kind: 'code', pattern: '^[0-9]{6}$', answeredBy: 'holder' }, { name: 'REGION', label: 'Deploy to which region?', kind: 'choice', choices: ['eu-west-1', 'us-east-1'], answeredBy: 'holder' }],
      network: ['*.amazonaws.com'], profile: 'web', submittedBy: 'agent in checkout-apple-pay (Maya holds it)', submittedIn: 'checkout-apple-pay', when: 'Nov 18', state: 'approved', approvedBy: 'theo', approvedWhen: 'Nov 18' }],
    runs: [{ who: 'agent in checkout-apple-pay (Maya)', workspace: 'checkout-apple-pay', when: 'yesterday 16:02', exit: 0, version: 1, inputs: 'REGION=eu-west-1 (asked Maya)' }] },
  { id: 'aws-sso-sandbox', name: 'aws-sso-sandbox', description: 'Signs in to the AWS sandbox account with SSO and writes a short-lived profile', scope: { kind: 'me', userId: 'rina' },
    versions: [{ n: 1, hash: '0e47b9a', body: 'aws sso login --profile sandbox --use-device-code | gitspace prompt-link SSO_SIGN_IN\naws sts get-caller-identity --profile sandbox', secrets: [], inputs: [],
      prompts: [{ name: 'SSO_SIGN_IN', label: 'Open the AWS sign-in page and enter the code', kind: 'link', answeredBy: 'holder' }],
      network: ['*.awsapps.com', 'oidc.eu-west-1.amazonaws.com'], profile: 'data', submittedBy: 'agent in bank-feed-sync (Rina holds it)', submittedIn: 'bank-feed-sync', when: 'Nov 21', state: 'approved', approvedBy: 'rina', approvedWhen: 'Nov 21' }],
    runs: [{ who: 'agent in bank-feed-sync (Rina)', workspace: 'bank-feed-sync', when: 'today 07:15', exit: 0, version: 1, inputs: 'SSO sign-in opened by Rina' }] },
  { id: 'figma-export', name: 'export-figma-frames', description: 'Exports the frames of a Figma page as PNGs into design/', scope: { kind: 'me', userId: 'sam' },
    versions: [{ n: 1, hash: 'b77c3d0', body: 'bun scripts/figma-export.ts --page "$PAGE_ID"', secrets: ['FIGMA_TOKEN'], inputs: [{ name: 'PAGE_ID', kind: 'pattern', pattern: '^[0-9]+:[0-9]+$', example: '12:345' }], prompts: [], network: ['api.figma.com'], profile: 'web', submittedBy: 'agent in loyalty-stamps (Sam holds it)', submittedIn: 'loyalty-stamps', when: 'Nov 19', state: 'approved', approvedBy: 'sam', approvedWhen: 'Nov 19' }],
    runs: [{ who: 'agent in loyalty-stamps (Sam)', workspace: 'loyalty-stamps', when: 'today 09:20', exit: 0, version: 1, inputs: 'PAGE_ID=12:345' }] },
  { id: 'bank-sandbox-token', name: 'refresh-openbank-token', description: 'Gets a fresh sandbox access token for the bank feed', scope: { kind: 'project', projectId: 'ledger' },
    versions: [{ n: 1, hash: 'f20a6c8', body: 'curl -s -u "$OPENBANK_CLIENT_ID:$OPENBANK_CLIENT_SECRET" https://sandbox.openbank.example/oauth/token -d grant_type=client_credentials > .tokens/openbank.json', secrets: ['OPENBANK_CLIENT_SECRET'], inputs: [], prompts: [], network: ['sandbox.openbank.example'], profile: 'data', submittedBy: 'agent in bank-feed-sync (Rina holds it)', submittedIn: 'bank-feed-sync', when: '12 min ago', state: 'pending', approvedBy: null, approvedWhen: null }],
    runs: [] },
  { id: 'loyalty-export', name: 'export-loyalty-orders', description: 'Copies last month’s orders with stamp counts from staging into a CSV for the loyalty plan', scope: { kind: 'project', projectId: 'crumb' },
    versions: [{ n: 1, hash: '2a9d4f0', body: 'psql "$DATABASE_URL" -c "\\copy (select * from orders where placed_at >= now() - interval \'${RANGE}\') to \'out/orders.csv\' csv header"', secrets: ['DATABASE_URL'], inputs: [{ name: 'RANGE', kind: 'enum', values: ['7 days', '30 days', '90 days'] }], prompts: [], network: ['staging-db.crumbco.internal:5432'], profile: 'web', submittedBy: 'agent in loyalty-stamps (Sam holds it)', submittedIn: 'loyalty-stamps', when: '6 min ago', state: 'pending', approvedBy: null, approvedWhen: null }],
    runs: [] },
  { id: 'pickup-smoke', name: 'check-staging-pickups', description: 'Signs in to staging and lists tomorrow’s pickup slots, to test the reminder schedule against', scope: { kind: 'project', projectId: 'crumb' },
    versions: [{ n: 1, hash: '6be1c05', body: 'bun scripts/staging-pickups.ts --day "$DAY" --otp "$(gitspace prompt STAGING_OTP)"', secrets: ['STAGING_LOGIN'], inputs: [{ name: 'DAY', kind: 'pattern', pattern: '^2026-[0-9]{2}-[0-9]{2}$', example: '2026-11-28' }],
      prompts: [{ name: 'STAGING_OTP', label: 'Staging one-time password', kind: 'password', answeredBy: 'scope' }], network: ['staging.crumb.example'], profile: 'web', submittedBy: 'agent in pickup-reminders-sms', submittedIn: 'pickup-reminders-sms', when: '3 min ago', state: 'pending', approvedBy: null, approvedWhen: null }],
    runs: [] },
  { id: 'vitest-codemod', name: 'apply-vitest-codemod', description: 'Applies the vitest 4.1 config codemod across the workspace packages', scope: { kind: 'project', projectId: 'crumb' },
    versions: [{ n: 1, hash: 'c41d9e2', body: 'bunx @vitest/codemod@4.1 ${PACKAGE}', secrets: [], inputs: [{ name: 'PACKAGE', kind: 'enum', values: ['apps/web', 'apps/kitchen', 'packages/menu'] }], prompts: [], network: ['registry.npmjs.org'], profile: 'web', submittedBy: 'Deps bot (sponsored by Maya) in deps-week-48', submittedIn: 'deps-week-48', when: '18 min ago', state: 'pending', approvedBy: null, approvedWhen: null }],
    runs: [] },
]);

// ── Who may use each secret ──

/** How a secret reaches work. Approved scripts get it under every delivery; on top of that: a cleared shell for
 * `minutes` after the holder's passkey, or the browser filling the login form on `origins` (the agent never sees the
 * value). `sponsor`: a bot's own secret goes to the approved scripts its turns run only after its sponsor approves each
 * use with their passkey (a bot has no passkey, so never a shell). */
export type Delivery = { kind: 'scripts' } | { kind: 'shell'; minutes: number } | { kind: 'autofill'; origins: readonly string[] } | { kind: 'sponsor' };
export interface SecretRule {
  /** Who may use it: account roles ('owner' | 'admin' | 'member'; Owners count as Admins) and project roles per project ('lead', 'engineer' …). */
  accountRoles: readonly string[];
  projectRoles: ReadonlyArray<{ projectId: string; roles: readonly string[] }>;
  /** Only while holding the workspace's handle: dropped on Let go. */
  whileHolding: boolean;
  delivery: Delivery;
  /** An Admin forbade shell delivery for this secret. */
  shellForbidden: boolean;
}
/** Keyed by secret name and scope: `${scope}:${name}` (scope 'team', a project id, or 'personal' for the values a
 * project asks each holder for). A person's or a bot's own secrets, and a holder's narrowing of a value a project asks
 * them for, use their id as the scope (`rina:STAGING_LOGIN`, `release-bot:NPM_PUBLISH_TOKEN`). */
export const secretRules = createStore<Readonly<Record<string, SecretRule>>>({
  'team:SENTRY_DSN': { accountRoles: ['owner', 'admin', 'member'], projectRoles: [], whileHolding: false, delivery: { kind: 'scripts' }, shellForbidden: false },
  'team:AWS_REGION': { accountRoles: ['owner', 'admin', 'member'], projectRoles: [], whileHolding: false, delivery: { kind: 'shell', minutes: 0 }, shellForbidden: false },
  'team:CLOUDFLARE_API_TOKEN': { accountRoles: ['admin'], projectRoles: [], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: true },
  'crumb:DATABASE_URL': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
  'crumb:REDIS_URL': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'shell', minutes: 15 }, shellForbidden: false },
  'crumb:STRIPE_SECRET_KEY': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: true },
  'ledger:LEDGER_DB_URL': { accountRoles: [], projectRoles: [{ projectId: 'ledger', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
  'ledger:OPENBANK_CLIENT_SECRET': { accountRoles: [], projectRoles: [{ projectId: 'ledger', roles: ['lead'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: true },
  'personal:STAGING_LOGIN': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer', 'designer', 'contributor'] }], whileHolding: true, delivery: { kind: 'autofill', origins: ['staging.crumb.example'] }, shellForbidden: false },
  'personal:FIGMA_TOKEN': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer', 'designer'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
  'personal:SENTRY_AUTH_TOKEN': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'shell', minutes: 30 }, shellForbidden: false },
  'team:APPLE_DEVELOPER': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'autofill', origins: ['developer.apple.com', 'appleid.apple.com'] }, shellForbidden: true },
  'team:AWS_PROD_DEPLOY': { accountRoles: ['admin'], projectRoles: [{ projectId: 'crumb', roles: ['lead'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: true },
  'team:SQUARE_ACCESS_TOKEN': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'shell', minutes: 15 }, shellForbidden: false },
  'crumb:CHECKOUT_FLAGS': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer', 'designer', 'contributor'] }], whileHolding: false, delivery: { kind: 'shell', minutes: 0 }, shellForbidden: false },
  'crumb:STAGING_ADMIN': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'autofill', origins: ['staging.crumb.example'] }, shellForbidden: false },
  'crumb:KDS_PASSKEY': { accountRoles: [], projectRoles: [{ projectId: 'crumb', roles: ['lead', 'engineer', 'designer'] }], whileHolding: true, delivery: { kind: 'autofill', origins: ['kds.crumb.example'] }, shellForbidden: true },
  'ledger:OPENBANK_LOGIN': { accountRoles: [], projectRoles: [{ projectId: 'ledger', roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'autofill', origins: ['sandbox.openbank.example'] }, shellForbidden: false },
  'field-notes:MAPBOX_TOKEN': { accountRoles: [], projectRoles: [{ projectId: 'field-notes', roles: ['lead', 'engineer', 'contributor'] }], whileHolding: false, delivery: { kind: 'shell', minutes: 60 }, shellForbidden: false },
  'maya:NPM_TOKEN': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'shell', minutes: 30 }, shellForbidden: false },
  'maya:GITHUB_ADMIN_TOKEN': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'shell', minutes: 15 }, shellForbidden: false },
  'rina:AWS_SANDBOX': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'shell', minutes: 60 }, shellForbidden: false },
  'theo:GOOGLE_DRIVE_TOKEN': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'shell', minutes: 60 }, shellForbidden: false },
  'release-bot:NPM_PUBLISH_TOKEN': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'sponsor' }, shellForbidden: false },
  'release-bot:SLACK_RELEASES_WEBHOOK': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
  'deps-bot:NPM_READ_TOKEN': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
  'triage-bot:HELPDESK_API_KEY': { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false },
});
/** The rule a secret without one gets: project Leads and Engineers (or Owners and Admins for a team secret), only
 * while holding, only to approved scripts. */
export function defaultRule(scope: string): SecretRule {
  return scope === 'team'
    ? { accountRoles: ['owner', 'admin'], projectRoles: [], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false }
    : { accountRoles: [], projectRoles: [{ projectId: scope, roles: ['lead', 'engineer'] }], whileHolding: true, delivery: { kind: 'scripts' }, shellForbidden: false };
}
