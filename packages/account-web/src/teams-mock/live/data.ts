// What GitSpace is doing right now, for the app's live pages: project health, the URLs it serves (workspace services
// through the relay, deployed sites and previews, share links), each machine's connection and release, browser
// sessions, sign-ins near expiry, and spend now, today and this week. Configuration is in Settings.
import { createStore } from '../store.js';

/** Each project's repository health and running automations, for its card and overview. */
export interface ProjectHealth {
  origin: string;
  behind: number;
  /** How GitHub is reached: "GitHub App (crumb-co)" or "through <machine>". */
  reach: ReadonlyArray<{ repository: string; via: string }>;
  failed: ReadonlyArray<{ what: string; when: string }>;
}
export const PROJECT_HEALTH: Readonly<Record<string, ProjectHealth>> = {
  crumb: { origin: 'github.com/crumb-co/crumb', behind: 0,
    reach: [{ repository: 'crumb-co/crumb', via: 'GitHub App (crumb-co)' }, { repository: 'crumb-co/crumb-kitchen', via: 'GitHub App (crumb-co)' }, { repository: 'crumb-labs/receipt-printer-driver', via: 'GitHub App (crumb-labs)' }],
    failed: [{ what: 'checkout-apple-pay: iOS profile check “Xcode 16” failed on crumb-ec2 fleet', when: '22m ago' }] },
  ledger: { origin: 'github.com/crumb-co/ledger', behind: 3,
    reach: [{ repository: 'crumb-co/ledger', via: 'GitHub App (crumb-co)' }, { repository: 'bitbucket.org/openbank/sandbox-fixtures', via: 'through ledger-cloud-2 (team SSH key)' }],
    failed: [{ what: 'Fetch from bitbucket.org/openbank/sandbox-fixtures: ledger-cloud-2 offline', when: '2h ago' }, { what: 'Automation Morning bank-feed import: machine offline', when: '07:00' }] },
  'field-notes': { origin: 'github.com/crumb-co/field-notes', behind: 0, reach: [{ repository: 'crumb-co/field-notes', via: 'GitHub App (crumb-co)' }], failed: [] },
};

/** Automation runs: running ones show on the project card and overview; failed ones also go to Needs you. */
export interface AutomationRun { id: string; projectId: string; automation: string; state: 'running' | 'failed' | 'succeeded'; when: string; detail: string; workspaceId?: string }
export const AUTOMATION_RUNS: readonly AutomationRun[] = [
  { id: 'run-deps', projectId: 'crumb', automation: 'Weekly dependency updates', state: 'running', when: 'since Mon 06:00', detail: 'Deps bot in deps-week-48 · running the full test suite', workspaceId: 'deps-week-48' },
  { id: 'run-release', projectId: 'crumb', automation: 'Friday release', state: 'succeeded', when: 'Fri 16:00', detail: 'Release bot cut release 2026.11.3 and opened #47' },
  { id: 'run-bank', projectId: 'ledger', automation: 'Morning bank-feed import', state: 'failed', when: 'today 07:00', detail: 'Couldn’t start: ledger-cloud-2 didn’t answer' },
  { id: 'run-bank-prev', projectId: 'ledger', automation: 'Morning bank-feed import', state: 'succeeded', when: 'yesterday 07:00', detail: 'Imported 41 transactions' },
];

/** A dev server or preview a workspace runs, reached through the relay. */
export interface WorkspaceService { id: string; workspaceId: string; name: string; port: number; url: string; machine: string; startedBy: string; since: string; state: 'running' | 'detached' | 'crashed' }
export const WORKSPACE_SERVICES: readonly WorkspaceService[] = [
  { id: 'svc-slot-web', workspaceId: 'slot-holds', name: 'web · vite dev', port: 5173, url: 'https://slot-holds-5173.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'rina', since: '1h ago', state: 'running' },
  { id: 'svc-slot-redis', workspaceId: 'slot-holds', name: 'redis-commander', port: 8081, url: 'https://slot-holds-8081.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'maya', since: '40m ago', state: 'running' },
  { id: 'svc-picker-story', workspaceId: 'slot-picker-ui', name: 'storybook', port: 6006, url: 'https://slot-picker-ui-6006.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'rina', since: '25m ago', state: 'running' },
  { id: 'svc-cache-preview', workspaceId: 'menu-cache-invalidation', name: 'menu preview', port: 3000, url: 'https://menu-cache-invalidation-3000.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'theo', since: '2h ago', state: 'running' },
  { id: 'svc-kds', workspaceId: 'kitchen-display-queue', name: 'kitchen display', port: 4173, url: 'https://kitchen-display-queue-4173.crumbco.gitspace.sh', machine: 'Back-office Mac mini', startedBy: 'theo', since: 'yesterday', state: 'running' },
  { id: 'svc-loyalty', workspaceId: 'loyalty-stamps', name: 'vite dev', port: 5173, url: 'https://loyalty-stamps-5173.crumbco.gitspace.sh', machine: 'Maya’s MacBook Pro', startedBy: 'maya', since: '2h ago', state: 'detached' },
  { id: 'svc-invoice', workspaceId: 'invoice-pdf-export', name: 'pdf preview', port: 4000, url: 'https://invoice-pdf-export-4000.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'theo', since: '3h ago', state: 'running' },
  { id: 'svc-bank', workspaceId: 'bank-feed-sync', name: 'feed importer UI', port: 8080, url: 'https://bank-feed-sync-8080.crumbco.gitspace.sh', machine: 'ledger-cloud-2', startedBy: 'rina', since: '2h ago', state: 'crashed' },
  { id: 'svc-map', workspaceId: 'photo-captions', name: 'map preview', port: 5174, url: 'https://photo-captions-5174.crumbco.gitspace.sh', machine: 'crumb-cell-1', startedBy: 'sam', since: '30m ago', state: 'running' },
];

/** Sites and previews projects deploy. */
export interface Deployment { id: string; projectId: string; name: string; kind: 'Production' | 'Staging' | 'Preview'; url: string; from: string; by: string; when: string }
export const DEPLOYMENTS: readonly Deployment[] = [
  { id: 'dep-crumb-prod', projectId: 'crumb', name: 'Ordering site', kind: 'Production', url: 'https://order.crumb.example', from: 'release 2026.11.3', by: 'release-bot', when: 'Fri 16:20' },
  { id: 'dep-crumb-staging', projectId: 'crumb', name: 'Ordering site', kind: 'Staging', url: 'https://staging.crumb.example', from: 'develop @ 7b20d44', by: 'maya', when: '13:10' },
  { id: 'dep-crumb-pr38', projectId: 'crumb', name: 'PR #38 · menu-cache', kind: 'Preview', url: 'https://pr-38.crumb.preview.crumbco.gitspace.sh', from: 'menu-cache', by: 'theo', when: 'yesterday' },
  { id: 'dep-ledger-pr112', projectId: 'ledger', name: 'PR #112 · invoice PDFs', kind: 'Preview', url: 'https://pr-112.ledger.preview.crumbco.gitspace.sh', from: 'invoice-pdf-export', by: 'theo', when: '11:40' },
  { id: 'dep-notes-pr27', projectId: 'field-notes', name: 'PR #27 · offline drafts', kind: 'Preview', url: 'https://pr-27.field-notes.preview.crumbco.gitspace.sh', from: 'offline-drafts', by: 'sam', when: '10:05' },
];

/** Links someone shared: a Change Guide, a capture, a browser share, a drive file. Revoking one ends it at once. */
export interface ShareLink { id: string; kind: 'Change Guide' | 'Capture' | 'Browser share' | 'Drive file'; title: string; projectId: string; workspaceId: string; url: string; by: string; created: string; expires: string; audience: string; opens: number }
export const shareLinks = createStore<readonly ShareLink[]>([
  { id: 'sh-guide-38', kind: 'Change Guide', title: 'Change Guide · Serve the menu from a cache', projectId: 'crumb', workspaceId: 'menu-cache', url: 'https://crumbco.gitspace.sh/s/g-9f2a', by: 'theo', created: 'yesterday', expires: 'in 6 days', audience: 'Anyone with the link', opens: 4 },
  { id: 'sh-capture-slot', kind: 'Capture', title: 'Capture · slot picker greying full slots', projectId: 'crumb', workspaceId: 'slot-picker-ui', url: 'https://crumbco.gitspace.sh/s/c-41d0', by: 'rina', created: '20m ago', expires: 'in 23 h', audience: 'crumbco.example only', opens: 2 },
  { id: 'sh-browser-bank', kind: 'Browser share', title: 'Live browser · sandbox.openbank.example', projectId: 'ledger', workspaceId: 'bank-feed-sync', url: 'https://crumbco.gitspace.sh/s/b-77c3', by: 'rina', created: '2h ago', expires: 'in 58 min', audience: 'crumbco.example only', opens: 1 },
  { id: 'sh-drive-pdf', kind: 'Drive file', title: 'invoice-sample-2027.pdf', projectId: 'ledger', workspaceId: 'invoice-pdf-export', url: 'https://crumbco.gitspace.sh/s/f-0be8', by: 'theo', created: '11:52', expires: 'in 7 days', audience: 'Anyone with the link', opens: 9 },
  { id: 'sh-drive-photos', kind: 'Drive file', title: 'field-photos-sample.zip', projectId: 'field-notes', workspaceId: 'photo-captions', url: 'https://crumbco.gitspace.sh/s/f-31aa', by: 'sam', created: 'Mon', expires: 'in 2 days', audience: 'crumbco.example only', opens: 3 },
]);

/** Each machine now: connected or not, how busy, its GitSpace release and how its update went. */
export interface MachineLive { connected: boolean; heartbeat: string; load: string; release: string; update: string | null; updateFailed: string | null }
export const MACHINE_LIVE: Readonly<Record<string, MachineLive>> = {
  'crumb-cloud-1': { connected: true, heartbeat: 'now', load: 'Busy · 62% CPU · 9.1 of 16 GB', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'ledger-cloud-2': { connected: false, heartbeat: '2h ago', load: '—', release: 'v0.2.0-rc.61', update: null, updateFailed: 'rc.62 health check timed out; rolled back to rc.61, then stopped answering' },
  'ec2-fleet': { connected: true, heartbeat: 'now', load: '1 of 3 instances busy', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'counter-mini': { connected: true, heartbeat: '30s ago', load: 'Idle · 8% CPU', release: 'v0.2.0-rc.61', update: null, updateFailed: 'macOS asked to approve the new helper; someone at the shop has to click Allow' },
  'maya-mbp': { connected: true, heartbeat: 'now', load: 'Light · 21% CPU', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'maya-vm': { connected: false, heartbeat: 'stopped yesterday', load: '—', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'rina-box': { connected: true, heartbeat: 'now', load: 'Busy · 74% GPU', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'rina-cloud': { connected: false, heartbeat: 'stopped 3 days ago', load: '—', release: 'v0.2.0-rc.60', update: 'rc.62 on next start', updateFailed: null },
  'theo-laptop': { connected: false, heartbeat: 'yesterday 18:40', load: '—', release: 'v0.2.0-rc.62', update: null, updateFailed: null },
  'jules-mba': { connected: false, heartbeat: '2 days ago', load: '—', release: 'v0.2.0-rc.58', update: 'rc.62 when it reconnects', updateFailed: null },
};

/** Browser sessions open now: who or what drives each, what the tab shows (`thumb` picks the drawn thumbnail), how long,
 * actions per minute, and whether the agent waits for a person to take over (a one-time code, a CAPTCHA). */
export type Thumb = 'checkout' | 'dashboard' | 'docs' | 'bank' | 'menu' | 'tables';
export interface BrowserSession { id: string; browser: string; workspaceId: string; driver: string; tabs: number; site: string; url: string; thumb: Thumb; since: string; minutes: number; apm: number; waiting: string | null }
export const BROWSER_SESSIONS: readonly BrowserSession[] = [
  { id: 'bs-bank', browser: 'cloud', workspaceId: 'bank-feed-sync', driver: 'agent', tabs: 2, site: 'Open Bank sandbox · sign-in', url: 'sandbox.openbank.example/login', thumb: 'bank', since: '26m', minutes: 26, apm: 0, waiting: 'Needs a person: the sandbox asks for a one-time code' },
  { id: 'bs-cache', browser: 'cloud', workspaceId: 'menu-cache-invalidation', driver: 'agent', tabs: 1, site: 'Menu preview · edit-to-visible test', url: 'menu-cache-invalidation-3000.crumbco.gitspace.sh/menu', thumb: 'menu', since: '2m', minutes: 2, apm: 34, waiting: null },
  { id: 'bs-docs', browser: 'cloud', workspaceId: 'invoice-pdf-export', driver: 'agent', tabs: 1, site: 'PDFKit docs · tables', url: 'pdfkit.org/docs/tables', thumb: 'docs', since: '6m', minutes: 6, apm: 8, waiting: null },
  { id: 'bs-photo', browser: 'cloud', workspaceId: 'photo-captions', driver: 'sam', tabs: 1, site: 'Mapbox Studio · place names', url: 'studio.mapbox.com/styles', thumb: 'dashboard', since: '12m', minutes: 12, apm: 21, waiting: null },
  { id: 'bs-slot', browser: 'maya-chrome', workspaceId: 'slot-holds', driver: 'agent', tabs: 1, site: 'Staging checkout', url: 'staging.crumb.example/checkout', thumb: 'checkout', since: '20m', minutes: 20, apm: 17, waiting: null },
  { id: 'bs-kds', browser: 'counter-chrome', workspaceId: 'kitchen-display-queue', driver: 'theo', tabs: 1, site: 'Square dashboard', url: 'squareup.com/dashboard/orders', thumb: 'dashboard', since: '2h', minutes: 124, apm: 3, waiting: null },
  { id: 'bs-tax', browser: 'rina-chrome', workspaceId: 'tax-rates-2027', driver: 'detached', tabs: 2, site: 'Government tax tables', url: 'gov.example/vat-rates-2027', thumb: 'tables', since: '35m', minutes: 35, apm: 0, waiting: null },
];
/** Each paired Chrome now: tabs agents use and its last activity. */
export const CHROME_LIVE: Readonly<Record<string, { tabs: number; last: string }>> = {
  'counter-chrome': { tabs: 1, last: '2 min ago · Square dashboard' }, 'maya-chrome': { tabs: 1, last: 'now · staging checkout' }, 'rina-chrome': { tabs: 2, last: '35 min ago · detached tabs' },
  'theo-chrome': { tabs: 0, last: 'yesterday 18:02' }, 'sam-chrome': { tabs: 0, last: 'last week' },
};

/** A deterministic last-hour series (12 five-minute points) around `base`, for sparklines. */
export function series(seed: number, base: number, spread: number): readonly number[] {
  return Array.from({ length: 12 }, (_, index) => Math.max(0, Math.round((base + spread * Math.sin(seed * 1.7 + index * 0.9) + spread * 0.4 * Math.cos(seed + index * 2.3)) * 10) / 10));
}

/** Each machine's load now and over the last hour, what runs on it and for how long, and what happened to it lately. */
export interface MachineMetrics { cpu: number; mem: number; disk: number; memDetail: string; diskDetail: string; load: readonly number[]; processes: ReadonlyArray<{ workspaceId: string; process: string; ran: string }>; events: ReadonlyArray<{ time: string; text: string; tone?: 'good' | 'warn' | 'bad' }>; offlineSince?: string }
export const MACHINE_METRICS: Readonly<Record<string, MachineMetrics>> = {
  'crumb-cloud-1': { cpu: 62, mem: 57, disk: 48, memDetail: '9.1 of 16 GB', diskDetail: '96 of 200 GB', load: series(1, 55, 18),
    processes: [{ workspaceId: 'slot-holds', process: 'vite dev :5173', ran: '1h 02m' }, { workspaceId: 'slot-holds', process: 'redis-commander :8081', ran: '40m' }, { workspaceId: 'slot-picker-ui', process: 'storybook :6006', ran: '25m' }, { workspaceId: 'deps-week-48', process: 'vitest run', ran: '1m 40s' }, { workspaceId: 'menu-cache-invalidation', process: 'node scripts/edit-to-visible.ts', ran: '2m' }, { workspaceId: 'invoice-pdf-export', process: 'pdf preview :4000', ran: '3h 10m' }],
    events: [{ time: '11:34', text: 'Back online', tone: 'good' }, { time: '11:33', text: 'Went offline for 40 s (host maintenance)', tone: 'warn' }, { time: '09:05', text: 'Updated to v0.2.0-rc.62', tone: 'good' }] },
  'ledger-cloud-2': { cpu: 0, mem: 0, disk: 97, memDetail: '—', diskDetail: '194 of 200 GB · nearly full', load: [38, 41, 44, 52, 49, 0, 0, 0, 0, 0, 0, 0],
    processes: [{ workspaceId: 'bank-feed-sync', process: 'feed importer UI :8080 (crashed)', ran: 'stopped 2h ago' }],
    events: [{ time: '07:00', text: 'Automation run “Morning bank-feed import” couldn’t start', tone: 'bad' }, { time: '05:14', text: 'Stopped answering', tone: 'bad' }, { time: '05:12', text: 'Update to rc.62 failed health check; rolled back to rc.61', tone: 'bad' }, { time: '05:10', text: 'Disk 97% full', tone: 'warn' }], offlineSince: '05:14' },
  'ec2-fleet': { cpu: 34, mem: 41, disk: 22, memDetail: '3 × 8 GB · 9.8 GB used', diskDetail: '3 × 100 GB', load: series(3, 30, 14),
    processes: [{ workspaceId: 'checkout-apple-pay', process: 'iOS profile check: xcodebuild -version (exited 127)', ran: 'stopped 22m ago' }, { workspaceId: 'checkout-apple-pay', process: 'k6 load test', ran: '18m' }],
    events: [{ time: '13:01', text: 'Scaled to 3 instances', tone: 'good' }, { time: '09:06', text: 'Updated to v0.2.0-rc.62', tone: 'good' }] },
  'counter-mini': { cpu: 8, mem: 33, disk: 61, memDetail: '5.3 of 16 GB', diskDetail: '312 of 512 GB', load: series(4, 8, 4),
    processes: [{ workspaceId: 'kitchen-display-queue', process: 'kitchen display :4173', ran: '1d 3h' }],
    events: [{ time: '09:10', text: 'Update to rc.62 waiting: macOS asks to approve the new helper', tone: 'warn' }, { time: 'Mon', text: 'Receipt printer reconnected', tone: 'good' }] },
  'maya-mbp': { cpu: 21, mem: 64, disk: 71, memDetail: '20.5 of 32 GB', diskDetail: '710 GB of 1 TB', load: series(5, 22, 9),
    processes: [{ workspaceId: 'loyalty-stamps', process: 'vite dev :5173 (detached)', ran: '2h 05m' }, { workspaceId: 'slot-holds', process: 'Xcode simulator', ran: '35m' }],
    events: [{ time: '06:02', text: 'Joined slot-holds (Maya holds it)', tone: 'good' }, { time: '05:58', text: 'Woke from sleep' }] },
  'maya-vm': { cpu: 0, mem: 0, disk: 18, memDetail: '—', diskDetail: '36 of 200 GB', load: Array.from({ length: 12 }, () => 0), processes: [], events: [{ time: 'yesterday', text: 'Stopped by Maya' }], offlineSince: 'yesterday 19:40' },
  'rina-box': { cpu: 74, mem: 82, disk: 55, memDetail: '52 of 64 GB', diskDetail: '1.1 of 2 TB', load: series(6, 70, 12),
    processes: [{ workspaceId: 'slot-picker-ui', process: 'photo model warm-up', ran: '12m' }, { workspaceId: 'bank-feed-sync', process: 'ssh tunnel to sandbox', ran: '2h' }],
    events: [{ time: '07:10', text: 'Joined slot-holds, slot-picker-ui (Rina holds them)', tone: 'good' }] },
  'rina-cloud': { cpu: 0, mem: 0, disk: 9, memDetail: '—', diskDetail: '9 of 100 GB', load: Array.from({ length: 12 }, () => 0), processes: [], events: [{ time: 'Mon', text: 'Stopped after 2 h idle' }], offlineSince: 'Mon' },
  'theo-laptop': { cpu: 0, mem: 0, disk: 44, memDetail: '—', diskDetail: '220 of 500 GB', load: Array.from({ length: 12 }, () => 0), processes: [], events: [{ time: 'yesterday', text: 'Went to sleep' }], offlineSince: 'yesterday 18:40' },
  'jules-mba': { cpu: 0, mem: 0, disk: 80, memDetail: '—', diskDetail: '200 of 250 GB', load: Array.from({ length: 12 }, () => 0), processes: [], events: [{ time: 'Tue', text: 'Disconnected' }], offlineSince: 'Tue 17:20' },
};

/** Each URL's health over the last hour: up, uptime, requests a minute, error rate, p50 latency; crashed ones keep
 * their last log lines. Keyed by workspace service or deployment id. */
export interface ServiceHealth { up: boolean; uptime: string; rpm: number; errors: number; p50: number; rpmSeries: readonly number[]; errSeries: readonly number[]; latSeries: readonly number[]; logs?: readonly string[] }
export const SERVICE_HEALTH: Readonly<Record<string, ServiceHealth>> = {
  'svc-slot-web': { up: true, uptime: '100%', rpm: 46, errors: 0.4, p50: 38, rpmSeries: series(11, 40, 14), errSeries: series(12, 0.5, 0.4), latSeries: series(13, 38, 8) },
  'svc-slot-redis': { up: true, uptime: '100%', rpm: 3, errors: 0, p50: 12, rpmSeries: series(14, 3, 2), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(15, 12, 3) },
  'svc-picker-story': { up: true, uptime: '100%', rpm: 9, errors: 0, p50: 22, rpmSeries: series(16, 8, 5), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(17, 22, 5) },
  'svc-cache-preview': { up: true, uptime: '99.6%', rpm: 212, errors: 1.2, p50: 41, rpmSeries: series(18, 180, 60), errSeries: series(19, 1.1, 0.7), latSeries: series(20, 42, 9) },
  'svc-kds': { up: true, uptime: '100%', rpm: 18, errors: 0, p50: 30, rpmSeries: series(21, 17, 4), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(22, 30, 4) },
  'svc-loyalty': { up: true, uptime: '100%', rpm: 0, errors: 0, p50: 25, rpmSeries: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(23, 25, 3) },
  'svc-invoice': { up: true, uptime: '100%', rpm: 6, errors: 2.1, p50: 340, rpmSeries: series(24, 6, 3), errSeries: series(25, 2, 1.2), latSeries: series(26, 330, 60) },
  'svc-bank': { up: false, uptime: '71%', rpm: 0, errors: 100, p50: 0, rpmSeries: [12, 14, 11, 13, 9, 0, 0, 0, 0, 0, 0, 0], errSeries: [0, 0, 1, 3, 40, 100, 100, 100, 100, 100, 100, 100], latSeries: [80, 85, 90, 120, 900, 0, 0, 0, 0, 0, 0, 0],
    logs: ['05:13:58 GET /feed 502 upstream timed out (sandbox.openbank.example)', '05:14:02 Error: ENOSPC: no space left on device, write /tmp/feed-cache.json', '05:14:02 process exited with code 1', '05:14:03 relay: ledger-cloud-2 stopped answering'] },
  'svc-map': { up: true, uptime: '100%', rpm: 14, errors: 0, p50: 55, rpmSeries: series(27, 12, 6), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(28, 55, 10) },
  'dep-crumb-prod': { up: true, uptime: '99.98%', rpm: 1840, errors: 0.2, p50: 64, rpmSeries: series(31, 1700, 300), errSeries: series(32, 0.2, 0.1), latSeries: series(33, 62, 8) },
  'dep-crumb-staging': { up: true, uptime: '99.9%', rpm: 38, errors: 0.8, p50: 70, rpmSeries: series(34, 35, 12), errSeries: series(35, 0.7, 0.5), latSeries: series(36, 70, 10) },
  'dep-crumb-pr38': { up: true, uptime: '100%', rpm: 4, errors: 0, p50: 39, rpmSeries: series(37, 4, 3), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(38, 39, 5) },
  'dep-ledger-pr112': { up: true, uptime: '100%', rpm: 2, errors: 0, p50: 310, rpmSeries: series(39, 2, 2), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(40, 300, 40) },
  'dep-notes-pr27': { up: true, uptime: '100%', rpm: 3, errors: 0, p50: 48, rpmSeries: series(41, 3, 2), errSeries: Array.from({ length: 12 }, () => 0), latSeries: series(42, 48, 6) },
};
/** Visitors to each share link (distinct people who opened it) and when it was last opened. */
export const SHARE_VISITORS: Readonly<Record<string, { visitors: number; last: string }>> = {
  'sh-guide-38': { visitors: 3, last: '12 min ago' }, 'sh-capture-slot': { visitors: 2, last: '5 min ago' }, 'sh-browser-bank': { visitors: 1, last: '1 h ago' }, 'sh-drive-pdf': { visitors: 6, last: '09:40' }, 'sh-drive-photos': { visitors: 2, last: 'yesterday' },
};

/** MCP clients now: their last call and calls in the last hour. */
export const MCP_ACTIVITY: Readonly<Record<string, { last: string; perHour: number; series: readonly number[] }>> = {
  g1: { last: '10 min ago · read slot-holds', perHour: 14, series: series(51, 14, 6) }, g2: { last: '13:41 · prompted slot-holds', perHour: 38, series: series(52, 36, 14) },
  g3: { last: '2 min ago · read slot-picker-ui', perHour: 52, series: series(53, 48, 16) }, g4: { last: '3 h ago · moved invoice-pdf-export', perHour: 0, series: [4, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  g5: { last: 'last week', perHour: 0, series: Array.from({ length: 12 }, () => 0) }, g6: { last: '2 days ago', perHour: 0, series: Array.from({ length: 12 }, () => 0) },
};
/** Recent sign-ins, step-ups, expiries and revokes, newest first. */
export const SESSION_TIMELINE: ReadonlyArray<{ time: string; who: string; text: string; kind: 'sign-in' | 'revoke' | 'step-up' | 'expire' }> = [
  { time: '13:41', who: 'maya', text: 'Claude Code (MCP) prompted slot-holds as Maya', kind: 'sign-in' },
  { time: '11:02', who: 'rina', text: 'Stepped up AWS SSO (sandbox) in slot-holds with her passkey', kind: 'step-up' },
  { time: '10:30', who: 'theo', text: 'Revoked a stale ChatGPT grant of Sam’s (as Admin)', kind: 'revoke' },
  { time: '09:15', who: 'sam', text: 'Signed in on MacBook Air with Touch ID', kind: 'sign-in' },
  { time: '08:40', who: 'theo', text: 'Signed in on ThinkPad with Windows Hello', kind: 'sign-in' },
  { time: '07:10', who: 'rina', text: 'Signed in on rina-workstation with a security key', kind: 'sign-in' },
  { time: '06:02', who: 'maya', text: 'Signed in on MacBook Pro with Touch ID', kind: 'sign-in' },
  { time: 'Yesterday', who: 'rina', text: 'Her Google Calendar sign-in (Composio) expired', kind: 'expire' },
];

/** Plugin sign-ins that expire soon or already have. */
export const SIGN_IN_EXPIRY: Readonly<Record<string, string>> = { 'maya-slack': 'expires in 2 days', 'rina-gcal': 'expired · sign in again', 'theo-calendar': 'expires in 5 days' };

/** Spend by period and by who, where and what paid; services (search, dictation, speech, images) and compute
 * (machine hours) beside inference. */
export const SPEND = {
  now: { perHour: 6.4, turns: 5, machines: 4 },
  today: { inference: 115.2, services: 3.8, compute: 21.6 },
  week: { inference: 642.9, services: 19.4, compute: 131.0 },
};
export const SPEND_BY_PROJECT: ReadonlyArray<{ projectId: string; today: number; week: number }> = [
  { projectId: 'crumb', today: 96.4, week: 534.1 }, { projectId: 'ledger', today: 31.0, week: 180.7 }, { projectId: 'field-notes', today: 13.2, week: 78.5 },
];
export const SPEND_BY_PROFILE: ReadonlyArray<{ profile: string; today: number; week: number }> = [{ profile: 'Default', today: 109.6, week: 590.6 }, { profile: 'Ledger (team keys only)', today: 31.0, week: 180.7 }];
export const SPEND_BY_PROVIDER: ReadonlyArray<{ provider: string; today: number; week: number }> = [
  { provider: 'Team Anthropic API key', today: 43.7, week: 251.2 }, { provider: 'AWS Bedrock (crumb-prod)', today: 2.4, week: 30.9 }, { provider: 'Team OpenAI API key', today: 6.2, week: 41.0 },
  { provider: 'Personal subscriptions (Claude Max, ChatGPT Pro)', today: 25.4, week: 140.3 }, { provider: 'Cloudflare Workers AI (services)', today: 3.8, week: 19.4 }, { provider: 'Machines (Cell, EC2)', today: 21.6, week: 131.0 },
];
export const SPEND_BY_PRINCIPAL: ReadonlyArray<{ id: string; today: number; week: number; projects: readonly string[] }> = [
  { id: 'maya', today: 17.7, week: 96.0, projects: ['crumb', 'ledger', 'field-notes'] }, { id: 'rina', today: 29.3, week: 151.2, projects: ['crumb', 'ledger'] }, { id: 'theo', today: 13.7, week: 88.4, projects: ['crumb', 'ledger'] },
  { id: 'sam', today: 9.3, week: 41.9, projects: ['crumb', 'field-notes'] }, { id: 'jules', today: 0, week: 3.1, projects: ['crumb'] }, { id: 'deps-bot', today: 3.4, week: 22.5, projects: ['crumb', 'ledger'] }, { id: 'release-bot', today: 1.9, week: 9.8, projects: ['crumb'] },
];

/** How much of each personal plan's limit is used in its current window. */
export const SUBSCRIPTION_WINDOWS: ReadonlyArray<{ id: string; userId: string; plan: string; window: string; used: number; resets: string }> = [
  { id: 'w-maya-5h', userId: 'maya', plan: 'Maya’s Claude Max', window: '5-hour window', used: 62, resets: 'resets 16:10' },
  { id: 'w-maya-week', userId: 'maya', plan: 'Maya’s Claude Max', window: 'weekly', used: 38, resets: 'resets Mon' },
  { id: 'w-rina-5h', userId: 'rina', plan: 'Rina’s Claude Max', window: '5-hour window', used: 100, resets: 'rate-limited until 14:20' },
  { id: 'w-rina-week', userId: 'rina', plan: 'Rina’s Claude Max', window: 'weekly', used: 71, resets: 'resets Mon' },
  { id: 'w-theo', userId: 'theo', plan: 'Theo’s ChatGPT Pro', window: '5-hour window', used: 20, resets: 'resets 15:30' },
];
