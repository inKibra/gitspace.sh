// Invented account for the board mock: three projects (Crumb, a bakery ordering app; Ledger, small-business
// accounting; Field notes, a field-research notebook), their workspaces, stacks and relations, and everything that waits
// on the person. Nothing here is real.
import type { StackStatus } from '@gitspace/protocol';
import type { ChatterLevel } from '@gitspace/protocol/chatter-contract';
import type { WorkspaceStatusColor, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { badgeColors } from '@gitspace/ui';
import type { WorkspaceView } from '../GitSpaceShell.js';
import type { LinkedPullRequest } from '../sidebar/project-graph.js';
import { createStore } from './store.js';

export type Phase = WorkspaceView['phase'];

export interface Goal {
  title: string;
  emoji: string | null;
  requirements: { met: number; total: number };
  steps: readonly string[];
  /** The step in progress (1-based); null while the plan waits for approval. */
  current: number | null;
}

export interface MockWorkspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  phase: Phase;
  /** The status colour its runtime last reported. */
  color: WorkspaceStatusColor;
  /** The main agent's latest message as one line. */
  preview: string;
  stackedOn: string | null;
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  /** Commits its stack parent has that it lacks. */
  parentAhead: number;
  pulls: readonly LinkedPullRequest[];
  goal: Goal;
  /** Its Chatter fader, and whether it posted a moment ago (the indicator glows). */
  volume: ChatterLevel | null;
  posted: boolean;
  archived: boolean;
  /** What it is doing now, for a running card: "running tests · 4 min". */
  activity: string;
  machine: string;
  /** The users holding the handle when the mock loads: any of them prompts. Empty is free. */
  holders: readonly string[];
}

export interface MockProject { id: string; name: string; branch: string; archived: boolean; agentColor: WorkspaceStatusColor }

// ── Principals in the account: people (users) and bots ──

export type AccountRoleId = 'owner' | 'admin' | 'member';

/** One person's user in this team account. One person in two teams is two users. */
export interface User {
  kind: 'person';
  id: string;
  name: string;
  first: string;
  initials: string;
  /** The account role: account pages only (team, inference profiles, account connections and credentials, billing). */
  accountRole: AccountRoleId;
  email: string;
  /** Avatar colour. */
  color: string;
}

/** A bot: a principal that acts only over MCP, signed in as itself, sponsored by an Admin or Owner (the one who created
 * it or took it over). Its account role is Member; its project memberships and roles work as a person's, and it is the
 * commit author of turns it starts. It uses team resources only. */
export interface Bot {
  kind: 'bot';
  id: string;
  name: string;
  /** The bot's name: bots have no first name, so lists that show a first name show this. */
  first: string;
  initials: string;
  accountRole: 'member';
  color: string;
  description: string;
  /** The Admin or Owner who sponsors it; null while its sign-ins are blocked because its sponsor left or lost Admin. */
  sponsor: string | null;
  /** The former sponsor's name and why they stopped sponsoring, while blocked. */
  formerSponsor: string | null;
  lapse: string | null;
  /** While blocked: when its kept sign-ins expire, 30 days after it was blocked, unless an Admin or Owner takes it over.
   * Owners and Admins are told when it's blocked and again a week before this date. */
  expires: string | null;
  created: string;
  /** Its sponsor's and Admins' notes: what it's for, who to ask, what not to give it. */
  notes: string;
}

export type Principal = User | Bot;

export const USERS: readonly User[] = [
  { kind: 'person', id: 'maya', name: 'Maya Okafor', first: 'Maya', initials: 'MO', accountRole: 'owner', email: 'maya@crumbco.example', color: '#e8590c' },
  { kind: 'person', id: 'theo', name: 'Theo Park', first: 'Theo', initials: 'TP', accountRole: 'admin', email: 'theo@crumbco.example', color: '#1c7ed6' },
  { kind: 'person', id: 'rina', name: 'Rina Ortiz', first: 'Rina', initials: 'RO', accountRole: 'member', email: 'rina@crumbco.example', color: '#0ca678' },
  { kind: 'person', id: 'sam', name: 'Sam Lee', first: 'Sam', initials: 'SL', accountRole: 'member', email: 'sam@crumbco.example', color: '#ae3ec9' },
  { kind: 'person', id: 'jules', name: 'Jules Moreau', first: 'Jules', initials: 'JM', accountRole: 'member', email: 'jules@crumbco.example', color: '#868e96' },
];

/** The account's bots, live: Crumb & Co › Bots creates, reassigns and suspends them, and every label reads the current state. */
export const bots = createStore<readonly Bot[]>([
  { kind: 'bot', id: 'release-bot', name: 'Release bot', first: 'Release bot', initials: 'RB', accountRole: 'member', color: '#495057', sponsor: 'theo', formerSponsor: null, lapse: null, expires: null, created: 'Nov 12',
    description: 'Cuts the release branch on Fridays, bumps versions, opens the release pull request and posts notes to #releases.',
    notes: 'Publishes @crumbco/* to npm only from Ship, and only with Theo’s approval. Ask Theo before widening its slice.' },
  { kind: 'bot', id: 'deps-bot', name: 'Deps bot', first: 'Deps bot', initials: 'DB', accountRole: 'member', color: '#5f3dc4', sponsor: 'maya', formerSponsor: null, lapse: null, expires: null, created: 'Oct 30',
    description: 'Every Monday: a workspace for the week’s dependency updates; bumps, runs the tests, proposes Review.',
    notes: 'Never merges: a person moves its workspace into Review. Majors are listed in deps.toml.' },
  { kind: 'bot', id: 'triage-bot', name: 'Support triage bot', first: 'Support triage bot', initials: 'ST', accountRole: 'member', color: '#adb5bd', sponsor: null, formerSponsor: 'Devon Hale', lapse: 'left the team', expires: 'Dec 21', created: 'Sep 8',
    description: 'Turns support emails tagged “bug” into workspaces in Crumb with the customer’s steps.',
    notes: 'Set up by Devon Hale for the support mailbox forwarder.' },
]);

export const TEAM = { name: 'Crumb & Co', host: 'crumbco.gitspace.sh', domains: ['crumbco.example'] };

export function userOf(id: string): User {
  const user = USERS.find((candidate) => candidate.id === id);
  if (!user) throw new Error(`No mock user ${id}`);
  return user;
}

export function findPrincipal(id: string): Principal | undefined {
  return USERS.find((candidate) => candidate.id === id) ?? bots.get().find((candidate) => candidate.id === id);
}

export function principalOf(id: string): Principal {
  const principal = findPrincipal(id);
  if (!principal) throw new Error(`No mock user or bot ${id}`);
  return principal;
}

/** How an actor reads everywhere: a person by first name, a bot with its sponsor ("Release bot (sponsored by Theo)"),
 * either after them the client it acted through ("Maya via Claude Code", "Release bot (sponsored by Theo) via Claude
 * Code"). */
export function actorLabel(id: string, client?: string): string {
  const principal = principalOf(id);
  const via = client ? ` via ${client}` : '';
  if (principal.kind === 'person') return `${principal.first}${via}`;
  return principal.sponsor ? `${principal.name} (sponsored by ${userOf(principal.sponsor).first})${via}` : `${principal.name} (no sponsor · sign-ins blocked)${via}`;
}

/** A project membership: a person's or a bot's (`userId` is either), its project role, and how it began when that is
 * worth showing (an Admin joining). */
export interface Membership { userId: string; projectId: string; roleId: string; joined?: string }

/** Project memberships with their project role (team-defined: Lead, Engineer, Designer, Contributor, Viewer, custom).
 * Owners are implicitly Lead in every project and have no rows; Admins are members only where listed. */
export const MEMBERSHIPS: readonly Membership[] = [
  { userId: 'theo', projectId: 'crumb', roleId: 'lead' }, { userId: 'theo', projectId: 'ledger', roleId: 'lead' },
  { userId: 'rina', projectId: 'crumb', roleId: 'engineer' }, { userId: 'rina', projectId: 'ledger', roleId: 'lead' },
  { userId: 'sam', projectId: 'crumb', roleId: 'designer' }, { userId: 'sam', projectId: 'field-notes', roleId: 'contributor' },
  { userId: 'jules', projectId: 'crumb', roleId: 'contributor' },
  { userId: 'release-bot', projectId: 'crumb', roleId: 'engineer' }, { userId: 'release-bot', projectId: 'ledger', roleId: 'engineer' },
  { userId: 'deps-bot', projectId: 'crumb', roleId: 'contributor' }, { userId: 'deps-bot', projectId: 'ledger', roleId: 'contributor' },
  { userId: 'triage-bot', projectId: 'crumb', roleId: 'contributor' },
];

/** The live memberships: Team, Projects and Join project change them, and every page reads them. */
export const memberships = createStore<readonly Membership[]>(MEMBERSHIPS);

/** Sets one principal's role in one project; null removes the membership. */
export function setMembership(userId: string, projectId: string, roleId: string | null, joined?: string): void {
  const rest = memberships.get().filter((entry) => !(entry.userId === userId && entry.projectId === projectId));
  memberships.set(roleId ? [...rest, { userId, projectId, roleId, joined }] : rest);
}

/** The project role a person or bot acts with in a project: Owners are Lead everywhere, others their membership's;
 * null when they aren't a member (and can't see the project). */
export function projectRoleIdOf(userId: string, projectId: string): string | null {
  if (principalOf(userId).accountRole === 'owner') return 'lead';
  return memberships.get().find((entry) => entry.userId === userId && entry.projectId === projectId)?.roleId ?? null;
}

/** The projects a user sees: a project is visible only to its members (Owners are members of every one). */
export function visibleProjects(userId: string): ReadonlySet<string> {
  return new Set(PROJECTS.filter((project) => projectRoleIdOf(userId, project.id) !== null).map((project) => project.id));
}

/** Who holds each workspace's handle when the mock loads; the rest are free. A bot can hold one. */
const HOLDERS: Readonly<Record<string, readonly string[]>> = {
  'slot-holds': ['maya', 'rina'], 'slot-picker-ui': ['rina'], 'kitchen-display-queue': ['theo'], 'loyalty-stamps': ['sam'], 'menu-cache-invalidation': ['rina'],
  'checkout-apple-pay': ['maya'], 'invoice-pdf-export': ['theo'], 'bank-feed-sync': ['rina'], 'offline-drafts': ['sam'], 'menu-cache': ['theo'], 'deps-week-48': ['deps-bot'],
};

export const VIEWER = 'Maya Okafor';

export const PROJECTS: readonly MockProject[] = [
  { id: 'crumb', name: 'Crumb', branch: 'develop', archived: false, agentColor: 'green' },
  { id: 'ledger', name: 'Ledger', branch: 'main', archived: false, agentColor: 'dim' },
  { id: 'field-notes', name: 'Field notes', branch: 'main', archived: false, agentColor: 'dim' },
  { id: 'bakery-site', name: 'Bakery site (old)', branch: 'main', archived: true, agentColor: 'dim' },
];

function pr(number: number, title: string, state: LinkedPullRequest['state'], checks: LinkedPullRequest['checks']): LinkedPullRequest {
  return { number, title, url: null, state, checks };
}

function ws(fields: Pick<MockWorkspace, 'id' | 'projectId' | 'name' | 'phase' | 'color' | 'preview' | 'goal' | 'activity'> & Partial<MockWorkspace>): MockWorkspace {
  return {
    branch: fields.name, stackedOn: null, dependsOn: [], relatedTo: [], parentAhead: 0, pulls: [], volume: null, posted: false, archived: false, machine: 'cloud', holders: HOLDERS[fields.id] ?? [],
    ...fields,
  };
}

export const WORKSPACES: readonly MockWorkspace[] = [
  ws({ id: 'slot-holds', projectId: 'crumb', name: 'slot-holds', phase: 'code', color: 'orange', preview: 'An Apple Pay retry takes up to 4 minutes; the hold runs out at 5. Which hold length?',
    goal: { title: 'Hold a pickup slot while the customer pays', emoji: null, requirements: { met: 3, total: 5 }, steps: ['Hold table and expiry job', 'Redis-backed hold', 'Release on payment or timeout', 'Countdown in the slot picker'], current: 2 },
    pulls: [pr(41, 'Hold a pickup slot during checkout', 'draft', 'failing')], activity: 'waiting on you · 14m', posted: true }),
  ws({ id: 'slot-picker-ui', projectId: 'crumb', name: 'slot-picker-ui', phase: 'code', color: 'green', preview: 'Greying out full slots in SlotPicker.tsx; 6 of 9 picker tests pass', stackedOn: 'slot-holds', parentAhead: 2,
    goal: { title: 'Let customers pick a slot that is actually free', emoji: null, requirements: { met: 1, total: 4 }, steps: ['Picker reads live holds', 'Full slots greyed out', 'Next free slot suggested'], current: 2 },
    activity: 'editing SlotPicker.tsx · 3 min', volume: 'high' }),
  ws({ id: 'kitchen-display-queue', projectId: 'crumb', name: 'kitchen-display-queue', phase: 'code', color: 'orange', preview: 'Needs a script approved to seed the ticket fixtures', relatedTo: ['slot-holds'],
    goal: { title: 'The kitchen sees orders in pickup order', emoji: '♨', requirements: { met: 1, total: 3 }, steps: ['Ticket model', 'Ticket view', 'Sort by slot', 'Bump on ready'], current: 2 },
    activity: 'waiting on an approval · 9m' }),
  ws({ id: 'loyalty-stamps', projectId: 'crumb', name: 'loyalty-stamps', phase: 'plan', color: 'orange', preview: 'Plan ready: stamps follow the customer, not the phone. 5 steps.',
    goal: { title: 'Give regulars a stamp card on the receipt', emoji: '☕', requirements: { met: 0, total: 4 }, steps: ['Stamps table', 'Award and refund', 'Stamp card on the receipt', 'Redeem the tenth', 'Tests'], current: null },
    activity: 'plan waiting · 31m', volume: 'low' }),
  ws({ id: 'menu-cache', projectId: 'crumb', name: 'menu-cache', phase: 'review', color: 'blue', preview: 'Change Guide is ready: 4 sections, load test 212 → 38 ms p95.',
    goal: { title: 'Serve the menu from a cache', emoji: '⚡', requirements: { met: 3, total: 4 }, steps: ['Cache layer', 'Warm on deploy', 'Measure', 'Load test'], current: 4 },
    pulls: [pr(38, 'Serve the menu from a cache', 'open', 'passing')], activity: 'in review · idle 40m' }),
  ws({ id: 'menu-cache-invalidation', projectId: 'crumb', name: 'menu-cache-invalidation', phase: 'review', color: 'green', preview: 'Publishing a version bump on every menu edit; running the edit-to-visible test', stackedOn: 'menu-cache',
    goal: { title: 'An edited menu item shows within a minute', emoji: null, requirements: { met: 2, total: 3 }, steps: ['Version the menu', 'Publish on edit', 'Invalidate on edit'], current: 3 },
    pulls: [pr(44, 'Invalidate the menu cache on edit', 'draft', 'pending')], activity: 'running tests · 2 min' }),
  ws({ id: 'allergen-labels', projectId: 'crumb', name: 'allergen-labels', phase: 'review', color: 'dim', preview: 'Waiting for menu-cache to merge before regenerating labels', dependsOn: ['menu-cache'],
    goal: { title: 'Every menu item shows its allergens', emoji: '⚠', requirements: { met: 0, total: 3 }, steps: ['Allergens from recipes', 'Label on the menu', 'Remove hand-entered labels', 'Change Guide'], current: 4 },
    activity: 'idle 2 d', volume: 'mute' }),
  ws({ id: 'checkout-apple-pay', projectId: 'crumb', name: 'checkout-apple-pay', phase: 'ship', color: 'red', preview: 'stopped: the iOS machine profile isn’t ready on crumb-ec2 fleet (no Xcode 16)',
    goal: { title: 'Pay with Apple Pay at checkout', emoji: null, requirements: { met: 4, total: 5 }, steps: ['Merchant setup', 'Payment sheet', 'Webhook', 'Receipts', 'Ship'], current: 5 },
    pulls: [pr(36, 'Apple Pay at checkout', 'open', 'failing')], activity: 'stopped · 22m', machine: 'ec2-fleet' }),
  ws({ id: 'pickup-reminders-sms', projectId: 'crumb', name: 'pickup-reminders-sms', phase: 'plan', color: 'dim', preview: 'Drafted the provider comparison; nothing running',
    goal: { title: 'Text customers 30 minutes before pickup', emoji: '☎', requirements: { met: 0, total: 3 }, steps: ['Send through the SMS provider', 'Schedule from the slot time', 'Opt-out link'], current: 1 },
    activity: 'idle 4 d' }),
  ws({ id: 'deps-week-48', projectId: 'crumb', name: 'deps-week-48', phase: 'code', color: 'green', preview: 'Bumped 7 packages; vitest 4.1 needs one config change. Proposing Review once the suite is green.',
    goal: { title: 'Dependency updates · week 48', emoji: '⟳', requirements: { met: 2, total: 3 }, steps: ['Bump within ranges', 'Fix what breaks', 'Full test run'], current: 3 },
    pulls: [pr(46, 'Dependency updates · week 48', 'draft', 'pending')], activity: 'running tests · 1 min' }),
  ws({ id: 'invoice-pdf-export', projectId: 'ledger', name: 'invoice-pdf-export', phase: 'code', color: 'green', preview: 'Rendering line items with tax per row; 14 of 16 snapshot tests pass',
    goal: { title: 'Send invoices as PDFs', emoji: '✉', requirements: { met: 2, total: 4 }, steps: ['Template', 'Totals and tax', 'Render line items', 'Attach to email', 'Archive'], current: 3 },
    pulls: [pr(112, 'Invoice PDFs', 'draft', 'pending')], activity: 'running tests · 4 min', posted: true }),
  ws({ id: 'bank-feed-sync', projectId: 'ledger', name: 'bank-feed-sync', phase: 'code', color: 'orange', preview: 'Asks to use sandbox.openbank.example in its browser to read the feed', dependsOn: ['invoice-pdf-export'],
    goal: { title: 'Import the bank feed every morning', emoji: '⚖', requirements: { met: 1, total: 4 }, steps: ['Sandbox connection', 'Sandbox feed import', 'Match to invoices', 'Schedule'], current: 2 },
    activity: 'waiting on an approval · 26m', machine: 'ledger-cloud-2' }),
  ws({ id: 'tax-rates-2027', projectId: 'ledger', name: 'tax-rates-2027', phase: 'ship', color: 'blue', preview: 'Merged #109. Waiting for you to close the workspace.',
    goal: { title: 'Use the 2027 tax rates from 1 January', emoji: null, requirements: { met: 3, total: 3 }, steps: ['Rates table', 'Effective dates', 'Review'], current: 3 },
    pulls: [pr(109, 'Tax rates for 2027', 'merged', 'passing')], activity: 'done · idle 3h' }),
  ws({ id: 'offline-drafts', projectId: 'field-notes', name: 'offline-drafts', phase: 'code', color: 'orange', preview: 'Text syncs anywhere; photos are 4–9 MB each. Sync them over cellular?',
    goal: { title: 'Write notes with no signal and sync later', emoji: '✎', requirements: { met: 2, total: 3 }, steps: ['Local drafts', 'Conflict rules', 'Sync queue', 'Cellular rule'], current: 4 },
    pulls: [pr(27, 'Offline drafts', 'draft', 'none')], activity: 'waiting on you · 48m' }),
  ws({ id: 'photo-captions', projectId: 'field-notes', name: 'photo-captions', phase: 'code', color: 'green', preview: 'Reading EXIF GPS from the sample set; 31 of 40 photos placed', stackedOn: 'offline-drafts',
    goal: { title: 'Caption every field photo with its place', emoji: '✦', requirements: { met: 1, total: 3 }, steps: ['Read GPS from photos', 'Place names from the map', 'Caption editor'], current: 1 },
    activity: 'reading photos · 1 min', volume: 'normal' }),
  ws({ id: 'old-hours-banner', projectId: 'crumb', name: 'old-hours-banner', phase: 'ship', color: 'dim', preview: 'Merged and archived', archived: true,
    goal: { title: 'Show holiday hours on the menu', emoji: null, requirements: { met: 2, total: 2 }, steps: ['Banner', 'Ship'], current: 2 }, activity: 'archived' }),
  ws({ id: 'receipt-printer', projectId: 'crumb', name: 'receipt-printer', phase: 'code', color: 'dim', preview: 'Archived', archived: true,
    goal: { title: 'Print receipts at the counter', emoji: null, requirements: { met: 0, total: 3 }, steps: ['Driver', 'Layout'], current: 1 }, activity: 'archived' }),
  ws({ id: 'landing-copy', projectId: 'bakery-site', name: 'landing-copy', phase: 'ship', color: 'dim', preview: 'Archived with the project', archived: true,
    goal: { title: 'New landing page copy', emoji: null, requirements: { met: 1, total: 1 }, steps: ['Copy'], current: 1 }, activity: 'archived' }),
];

/** A workspace's stack position against its parent, as the project view publishes it. */
export function positionOf(workspace: MockWorkspace): StackStatus | null {
  if (!workspace.stackedOn) return null;
  const parent = WORKSPACES.find((other) => other.id === workspace.stackedOn);
  return { parentId: workspace.stackedOn, parentBranch: parent?.branch ?? null, baseBranch: 'develop', mergeBase: null, parentAhead: workspace.parentAhead, parentMerged: 'not-merged', baseRewritten: false, instruction: null };
}

export function statusSummary(color: WorkspaceStatusColor): WorkspaceStatusSummary {
  return {
    primaryColor: color,
    agents: { green: color === 'green' ? 1 : 0, blue: color === 'blue' ? 1 : 0, orange: color === 'orange' ? 1 : 0, red: color === 'red' ? 1 : 0 },
    machines: { attached: 1, online: 1, ready: 1 },
    sync: { conflicts: 0, problems: 0 },
  };
}

// ── What waits on the person ──

export interface AskOption { id: string; title: string; description?: string }

/** An agent's question or plan, answered in place: pick, add a note, Send. */
export interface QuestionItem { id: string; kind: 'question' | 'plan'; workspaceId: string; since: number; title: string; prompt: string; options: readonly AskOption[]; said: string }
/** Something broken in the workspace that needs a person. */
export interface ProblemItem { id: string; kind: 'problem'; workspaceId: string; since: number; title: string; detail: string; log: string | null; action: { label: string; done: string }; secondary: string }
/** The person was named in a Chatter topic; listed, never counted. */
export interface MentionItem { id: string; kind: 'mention'; workspaceId: string; since: number; title: string; topic: string; posts: number; excerpt: string; to: string }
/** The workspace's agent waits on a declaration's approval; the approval itself is one row per content hash. */
export interface ApprovalWaitItem { id: string; kind: 'approval-wait'; workspaceId: string; since: number; title: string; approval: string }

export type CardItem = QuestionItem | ProblemItem | MentionItem | ApprovalWaitItem;

export const CARD_ITEMS: readonly CardItem[] = [
  { id: 'q-slot-hold', kind: 'question', workspaceId: 'slot-holds', since: 14, title: 'How long should a pickup slot stay held?',
    prompt: 'How long should a pickup slot stay **held** while the customer is at checkout? After that the slot goes back on sale.',
    said: 'An Apple Pay retry on a weak signal takes up to 4 minutes, and the hold runs out at 5.',
    options: [{ id: '5m', title: '5 minutes' }, { id: '10m', title: '10 minutes · recommended' }, { id: 'abandon', title: 'Until the basket is abandoned' }] },
  { id: 'q-loyalty', kind: 'plan', workspaceId: 'loyalty-stamps', since: 31, title: 'Plan: Loyalty stamps on the order receipt',
    prompt: 'Every paid order earns a stamp; ten make a free pastry. Stamps belong to the **customer**, so a new phone keeps them. A refund takes its stamp back.',
    said: 'Customers already sign in with their phone number, so stamps can follow them.',
    options: [{ id: 'approve', title: 'Approve · moves to Code' }, { id: 'reject', title: 'Reject' }] },
  { id: 'p-certs', kind: 'problem', workspaceId: 'checkout-apple-pay', since: 22, title: 'Machine not ready: iOS profile', detail: 'crumb-ec2 fleet fails the iOS profile’s check “Xcode 16”. Maya’s MacBook Pro is ready for Web and iOS.',
    log: 'check Xcode 16: xcodebuild -version · xcodebuild: command not found', action: { label: 'Move to a ready machine', done: 'Moving to Maya’s MacBook Pro' }, secondary: 'Open log' },
  { id: 'a-wait-bank', kind: 'approval-wait', workspaceId: 'bank-feed-sync', since: 26, title: 'Waits on sandbox.openbank.example · interact', approval: 'ap-bank-site' },
  { id: 'q-offline', kind: 'question', workspaceId: 'offline-drafts', since: 48, title: 'Should drafts with photos sync over cellular?',
    prompt: 'Should drafts with photos sync over **cellular** data, or wait for Wi-Fi?', said: 'Text syncs anywhere; photos are 4–9 MB each.',
    options: [{ id: 'always', title: 'Always sync' }, { id: 'wifi', title: 'Wi-Fi only' }, { id: 'text', title: 'Text now, photos on Wi-Fi' }] },
  { id: 'm-sync-rules', kind: 'mention', workspaceId: 'offline-drafts', since: 65, title: 'Mentioned in sync conflict rules', topic: 'sync conflict rules', posts: 2, to: 'maya',
    excerpt: '“@maya do two edits to the same note merge, or does the newest win?”' },
];

/** One approval per content hash: where it is declared and which agents wait on it. */
export interface ApprovalEntry {
  id: string;
  projectId: string;
  kindLabel: string;
  file: string;
  hash: string;
  detail: string;
  declared: { base: string | null; workspaces: readonly string[] };
  waitingIn: ReadonlyArray<{ workspaceId: string; since: number }>;
}
export interface ApprovalGroup { id: string; projectId: string; label: string; entries: readonly ApprovalEntry[] }

export const APPROVAL_GROUPS: readonly ApprovalGroup[] = [
  { id: 'g-crumb-develop', projectId: 'crumb', label: 'Declared on develop', entries: [
    { id: 'ap-route', projectId: 'crumb', kindLabel: 'Signed-caller route · services.json', file: '.gitspace/services.json', hash: 'b71e04d', detail: 'POST /webhooks/pay on checkout, from the payment provider',
      declared: { base: 'develop', workspaces: ['checkout-apple-pay'] }, waitingIn: [] },
  ] },
  { id: 'g-ledger-bank', projectId: 'ledger', label: 'Declared in bank-feed-sync', entries: [
    { id: 'ap-bank-site', projectId: 'ledger', kindLabel: 'Browser site · interact', file: '.gitspace/bundle.json', hash: 'e02c9aa', detail: 'sandbox.openbank.example: open, click and type to read the sandbox feed',
      declared: { base: null, workspaces: ['bank-feed-sync'] }, waitingIn: [{ workspaceId: 'bank-feed-sync', since: 26 }] },
  ] },
];

/** Account-level rows: no one workspace owns them; they head the Inbox. They go to Owners and Admins, plus `to`; a
 * failed automation run also goes to the project's Leads and whoever enabled it. An environment proposal goes to the
 * project's Leads only (Owners are Lead everywhere). A machine-profile proposal (`proposal` names it in profiles'
 * profileProposals) goes to Owners and Admins only. A blocked bot goes to Owners and Admins when it's blocked and
 * again a week before its sign-ins expire. A bot's request to use one of its own secrets whose rule waits for its
 * sponsor's approval goes to that sponsor only (`bot` names the bot, `secret` the secret's rule key). A script waiting for
 * approval (`script` names it in env-model's approvedScripts) goes to whoever may approve its pending version for the
 * scope it is requested for: the holder for For me, the project's Leads, or Owners and Admins for the team; its title
 * and detail come from the script. A paused run's prompt (`run` names it in scripts-rules' scriptRuns) goes to whoever
 * answers it: the holder (a bot's sponsor) or anyone who can see the run's workspace (its project's members, Owners included). */
export interface AccountItem { id: string; kind: 'machine' | 'incident' | 'automation' | 'environment' | 'profile-proposal' | 'bot' | 'bot-secret' | 'script'; since: number; title: string; detail: string; signals: readonly string[]; projectId: string | null; workspaces: readonly string[]; to?: readonly string[]; bot?: string; secret?: string; script?: string; run?: string; proposal?: string }
export const ACCOUNT_ITEMS: readonly AccountItem[] = [
  { id: 'acc-machine', kind: 'machine', since: 124, title: 'Machine ledger-cloud-2 is offline', detail: 'Last heartbeat 2 h ago. bank-feed-sync runs on it and waits.', signals: [], projectId: 'ledger', workspaces: ['bank-feed-sync'] },
  { id: 'acc-automation', kind: 'automation', since: 412, title: 'Automation failed: Morning bank-feed import', detail: 'Enabled by Theo. The 07:00 run couldn’t start: ledger-cloud-2 didn’t answer. Next run tomorrow 07:00.', signals: ['run #214 · 07:00 · machine offline'], projectId: 'ledger', workspaces: [], to: ['rina', 'theo'] },
  { id: 'acc-env-proposal', kind: 'environment', since: 25, title: 'Instructions proposal: Crumb revision 8', detail: 'Deps bot proposed it from deps-week-48: since vitest 4.1, tests run with --pool=forks.', signals: ['Tests: bun test → bun test --pool=forks'], projectId: 'crumb', workspaces: [], to: [] },
  { id: 'acc-profile-proposal', kind: 'profile-proposal', since: 40, title: 'Machine profile proposal: Data v2', detail: 'Rina (Lead in Ledger) proposed adding marimo for the reconciliation notebooks.', signals: ['check marimo · setup: uv tool install marimo'], projectId: null, workspaces: [], proposal: 'pp-data-marimo' },
  { id: 'acc-incident', kind: 'incident', since: 37, title: 'Paused: Crumb’s Chatter object', detail: 'The storage breaker paused ProjectChatterDO after a write burst.', signals: ['1.2M rows written · 10 min', '96 MB stored · +40 MB/h'], projectId: 'crumb', workspaces: [] },
  { id: 'acc-bot-blocked', kind: 'bot', since: 4320, title: 'Support triage bot is blocked', detail: 'Its sponsor Devon Hale left the team. Its sign-in is kept and refused; it expires Dec 21, 30 days after, unless an Admin or Owner takes the bot over. You’re told again Dec 14, a week before.', signals: ['blocked Nov 21 · 1 sign-in kept · expires Dec 21'], projectId: null, workspaces: [] },
  { id: 'acc-bot-secret', kind: 'bot-secret', since: 6, title: 'Release bot asks for NPM_PUBLISH_TOKEN in release-2026-11', detail: 'Its turn in Crumb’s release-2026-11 (Ship) wants its approved release script to run npm publish for @crumbco/menu 4.2.0. Approve once with your passkey: Release bot’s own NPM_PUBLISH_TOKEN goes into that run only and is gone when the turn ends.', signals: ['rule: to approved scripts once Theo approves each use with a passkey', 'via Claude Code on build-01'], projectId: 'crumb', workspaces: [], bot: 'release-bot', secret: 'release-bot:NPM_PUBLISH_TOKEN' },
  ...([['bank-sandbox-token', 'ledger', 12], ['loyalty-export', 'crumb', 6], ['pickup-smoke', 'crumb', 3], ['vitest-codemod', 'crumb', 18], ['seed-staging', 'crumb', 0], ['deploy-worker', 'crumb', 0], ['figma-export', 'crumb', 0]] as const)
    .map(([script, projectId, since]): AccountItem => ({ id: `acc-script-${script}`, kind: 'script', since, title: script, detail: '', signals: [], projectId, workspaces: [], script })),
  ...([['run-checkout', 'crumb'], ['run-sso', 'ledger'], ['run-pickup-smoke-1', 'crumb']] as const)
    .map(([run, projectId]): AccountItem => ({ id: `acc-${run}`, kind: 'script', since: 1, title: run, detail: '', signals: [], projectId, workspaces: [], run })),
];

/** Open Chatter issue topics, one row each; listed, never counted. */
export interface IssueTopic { id: string; projectId: string; title: string; posts: number; workspaces: number; scope: 'gitspace' | 'project'; agent: string | null }
export const ISSUE_TOPICS: readonly IssueTopic[] = [
  { id: 'i-bun-hang', projectId: 'crumb', title: 'bun test hangs in watch mode', posts: 7, workspaces: 3, scope: 'gitspace', agent: 'marked for filing' },
  { id: 'i-cent', projectId: 'crumb', title: 'Menu prices off by a cent after tax', posts: 3, workspaces: 2, scope: 'project', agent: 'started fix-rounding' },
];

/** Tile colours: a stable pick per workspace from the badge palette (the Inbox mock's identity tiles). */
const TILE_COLORS: readonly string[] = [badgeColors.orange, badgeColors.teal, badgeColors.violet, badgeColors.blue, badgeColors.lime, badgeColors.purple, badgeColors.cyan, badgeColors.amber, badgeColors.indigo, badgeColors.emerald];
export function tileColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length] ?? badgeColors.gray;
}

export function waitedFor(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Today's spend by project (the account's is their sum), the daily budget, and the account's machines. */
export const TODAY: { spendByProject: Readonly<Record<string, number>>; budget: number; machines: number } = { spendByProject: { crumb: 11.2, ledger: 5.1, 'field-notes': 2.1 }, budget: 40, machines: 4 };

// ── The handle, notes, resources, credentials and commits ──

/** A user asking a workspace's holders for the handle; lands in every holder's Inbox. */
export interface HandleRequest { id: string; workspaceId: string; from: string; since: number; note: string }
export const HANDLE_REQUESTS: readonly HandleRequest[] = [
  { id: 'hr-sam-picker', workspaceId: 'slot-picker-ui', from: 'sam', since: 12, note: 'I’d like to adjust how full slots grey out.' },
  { id: 'hr-jules-loyalty', workspaceId: 'loyalty-stamps', from: 'jules', since: 40, note: 'Can I try the stamp card copy on the receipt?' },
];
/** The request that arrives while the mock is open: Theo asks Maya and Rina for slot-holds. */
export const ARRIVING_REQUEST: HandleRequest = { id: 'hr-theo-slot', workspaceId: 'slot-holds', from: 'theo', since: 0, note: 'I can take the Redis expiry while you two do the picker.' };

/** Notes beside the composer: left by people or bots without the handle. Open until a holder sends one to the agent
 * (it becomes their prompt) or dismisses it; the writer edits or deletes their own while it's open. They don't expire:
 * they survive phase moves and handle changes, a new holder inherits them, and archiving the workspace closes them.
 * `by` is who sent or dismissed it. */
export interface Note { id: string; workspaceId: string; from: string; since: number; text: string; state: 'open' | 'sent' | 'dismissed'; by?: string; edited?: boolean }
export const NOTES: readonly Note[] = [
  { id: 'n-sam-countdown', workspaceId: 'slot-holds', from: 'sam', since: 22, text: 'The countdown should sit in the picker’s top-right corner, not under the Pay button (Figma: “Slot picker / held”).', state: 'open' },
  { id: 'n-jules-copy', workspaceId: 'slot-holds', from: 'jules', since: 9, text: 'Copy for the timer: “Your slot is held for 10:00”.', state: 'open' },
  { id: 'n-release-cut', workspaceId: 'slot-holds', from: 'release-bot', since: 5, text: 'Release 2026.11.4 is cut from develop on Friday 16:00. slot-holds is in it only if #41 merges by then.', state: 'open' },
  { id: 'n-sam-orange', workspaceId: 'slot-holds', from: 'sam', since: 140, text: 'Use the brand orange for the held state, not red: red reads as an error.', state: 'sent', by: 'maya' },
  { id: 'n-jules-emoji', workspaceId: 'slot-holds', from: 'jules', since: 95, text: 'Could the held slot show a ⏳ emoji?', state: 'dismissed', by: 'rina' },
  { id: 'n-theo-hours', workspaceId: 'old-hours-banner', from: 'theo', since: 4000, text: 'Boxing Day hours are 10–2, not 9–3.', state: 'open' },
];

/** Something that happened to a person and is listed (never counted) in their Inbox: a note of theirs dismissed, a
 * resource of theirs revoked by an Owner or Admin. A bot's go to its sponsor. */
export interface Notice { id: string; to: string; from: string; text: string; detail: string; at: string }
export const notices = createStore<readonly Notice[]>([
  { id: 'nt-jules-emoji', to: 'jules', from: 'rina', text: 'Rina dismissed your note in slot-holds', detail: '“Could the held slot show a ⏳ emoji?”', at: '1h ago' },
]);
export function notify(notice: Omit<Notice, 'id' | 'at'>): void {
  const principal = findPrincipal(notice.to);
  const to = principal?.kind === 'bot' ? principal.sponsor ?? notice.to : notice.to;
  notices.set([{ id: `nt-${Date.now()}-${notices.get().length}`, at: 'just now', ...notice, to }, ...notices.get()]);
}

/** Labelled prompts in a workspace's conversation, oldest first; `via` marks a note a holder sent on, `client` the
 * person's MCP client that sent it (it acts as that person, under their handle). */
export interface Prompt { id: string; workspaceId: string; from: string; minutesAgo: number; text: string; via?: string; client?: string }
export const PROMPTS: readonly Prompt[] = [
  { id: 'p1', workspaceId: 'slot-holds', from: 'maya', minutesAgo: 130, text: 'Hold a pickup slot while the customer pays. Work in `slot-holds`; keep the tests green.' },
  { id: 'p-cc', workspaceId: 'slot-holds', from: 'maya', client: 'Claude Code', minutesAgo: 90, text: 'Run the hold-expiry tests against the staging Redis and tell me which ones flake.' },
  { id: 'p2', workspaceId: 'slot-holds', from: 'rina', minutesAgo: 64, text: 'Use the Redis we already run for sessions for the hold, with a TTL; no new table for the expiry.' },
  { id: 'p-deps-1', workspaceId: 'deps-week-48', from: 'deps-bot', client: 'Claude Code', minutesAgo: 180, text: 'Weekly dependency updates for Crumb: bump everything within its semver range, then the majors listed in `deps.toml`; keep the tests green.' },
  { id: 'p-deps-2', workspaceId: 'deps-week-48', from: 'deps-bot', client: 'Claude Code', minutesAgo: 40, text: 'vitest 4.1 renamed `poolOptions`; update `vitest.config.ts` and rerun the full suite.' },
];

/** A resource and where it comes from. `state` is what the Environment shows next to it. */
export interface Resource { kind: 'machine' | 'browser' | 'connection' | 'model'; name: string; detail: string; state?: 'ok' | 'out' | 'off' }

/** The account's resources (every workspace uses them; the only ones a bot uses) and each person's own: their providers,
 * MCP connections, browsers and machines, which join while they hold the handle. */
export const ACCOUNT_RESOURCES: readonly Resource[] = [
  { kind: 'machine', name: 'crumb-cell-1', detail: 'Cell container · 4 vCPU · runs the agent' },
  { kind: 'browser', name: 'Team Chromium', detail: 'Cloud browser · 3 tabs' },
  { kind: 'connection', name: 'GitHub · crumb-and-co', detail: 'Team OAuth · enabled for Crumb' },
  { kind: 'connection', name: 'Linear · Crumb team', detail: 'Team OAuth · enabled for Crumb' },
  { kind: 'model', name: 'Anthropic · team key', detail: 'Used when every holder is out', state: 'ok' },
];
export const USER_RESOURCES: Readonly<Record<string, readonly Resource[]>> = {
  maya: [
    { kind: 'machine', name: 'Maya’s MacBook', detail: 'Physical computer · online' },
    { kind: 'browser', name: 'Maya’s Chrome', detail: 'Profile “Work” · 1 tab shared' },
    { kind: 'connection', name: 'Figma · Maya', detail: 'Her own MCP connection' },
    { kind: 'connection', name: 'Slack · Maya', detail: 'Her own Slack over MCP' },
    { kind: 'model', name: 'Anthropic · Maya’s plan', detail: '$3.10 spent today', state: 'ok' },
  ],
  rina: [
    { kind: 'machine', name: 'rina-workstation', detail: 'Physical computer · online' },
    { kind: 'connection', name: 'Linear · Rina', detail: 'Her own MCP connection' },
    { kind: 'model', name: 'Anthropic · Rina’s plan', detail: 'Rate-limited · resets 11:30', state: 'out' },
    { kind: 'model', name: 'OpenAI · Rina’s key', detail: 'Provider not allowed in this profile', state: 'off' },
  ],
  theo: [
    { kind: 'machine', name: 'theo-mbp', detail: 'Physical computer · online' },
    { kind: 'browser', name: 'Theo’s Chrome', detail: 'Profile “Crumb”' },
    { kind: 'model', name: 'Anthropic · Theo’s plan', detail: '$0.80 spent today', state: 'ok' },
  ],
  sam: [
    { kind: 'connection', name: 'Figma · Sam', detail: 'His own MCP connection' },
    { kind: 'browser', name: 'Sam’s Safari', detail: 'Shared tabs' },
  ],
  jules: [],
};

/** A cleared shell open now: a secret whose rule delivers it "in a cleared shell for N minutes with a passkey" (a
 * person's own, or a team or project one), unlocked with the person's passkey in one workspace they hold. `credential`
 * is the secret's name and `scope` what it unlocks. Only turns that person starts get it (never their co-holders');
 * it ends when the time runs out, when they Drop it or when they let go of the handle. */
export interface StepUp { id: string; credential: string; userId: string; workspaceId: string; scope: string; minutesLeft: number }
export const stepUps = createStore<readonly StepUp[]>([
  { id: 'su-rina-aws', credential: 'AWS_SANDBOX', userId: 'rina', workspaceId: 'slot-holds', scope: 'crumb-sandbox · ElastiCache read/write', minutesLeft: 38 },
  { id: 'su-rina-redis', credential: 'REDIS_URL', userId: 'rina', workspaceId: 'slot-holds', scope: 'Crumb · staging Redis', minutesLeft: 9 },
  { id: 'su-maya-npm', credential: 'NPM_TOKEN', userId: 'maya', workspaceId: 'checkout-apple-pay', scope: 'registry.npmjs.org · @crumb packages', minutesLeft: 12 },
  { id: 'su-theo-google', credential: 'GOOGLE_DRIVE_TOKEN', userId: 'theo', workspaceId: 'invoice-pdf-export', scope: 'www.googleapis.com · Drive invoices folder', minutesLeft: 51 },
]);

/** Today's spend on each user's own model credential (rotation picks the least spent). */
export const SPENT_TODAY: Readonly<Record<string, number>> = { maya: 3.1, rina: 1.4, theo: 0.8, sam: 0, jules: 0 };

/** Processes that kept running after their user let go of the handle. */
export const DETACHED: Readonly<Record<string, readonly { user: string; what: string }[]>> = {
  'slot-holds': [{ user: 'theo', what: 'redis-cli monitor on theo-mbp' }],
};

/** Commits on a workspace's pull request, with their attribution. */
export interface Commit { sha: string; subject: string; author: string; coAuthors: readonly string[]; minutesAgo: number; turn: number }
export const COMMITS: Readonly<Record<string, readonly Commit[]>> = {
  'slot-holds': [
    { sha: 'a1f3c9e', subject: 'Add the slot hold and its expiry', author: 'maya', coAuthors: [], minutesAgo: 118, turn: 3 },
    { sha: '7b20d44', subject: 'Keep holds in Redis with a TTL', author: 'rina', coAuthors: ['maya'], minutesAgo: 52, turn: 9 },
    { sha: 'c90e1a2', subject: 'Release the hold on payment or timeout', author: 'maya', coAuthors: ['rina'], minutesAgo: 21, turn: 14 },
  ],
  'menu-cache': [
    { sha: '5d1e0b7', subject: 'Serve the menu from a read-through cache', author: 'theo', coAuthors: [], minutesAgo: 300, turn: 4 },
    { sha: 'e44a9f0', subject: 'Warm the cache on deploy', author: 'theo', coAuthors: ['rina'], minutesAgo: 180, turn: 8 },
  ],
};
