import { z } from 'zod';

/**
 * Daily Cloudflare usage for one Workers for Platforms user worker and its Durable Object namespaces.
 * Shared by the platform cron (`scheduled`) and `scripts/cloudflare-usage-report.ts` so both report identically.
 *
 * Sources (GraphQL Analytics API, account scope; Account Analytics: Read):
 * - `workersInvocationsAdaptive` by `scriptName`: requests, errors, cpuTimeUs (µs), wallTime (µs), duration (GB-s).
 * - `durableObjectsInvocationsAdaptiveGroups` by `scriptName`, grouped by `namespaceId` and `datetimeHour`: requests, errors.
 * - `durableObjectsPeriodicGroups` by `namespaceId_in` (it has no script dimension), grouped by `namespaceId` and
 *   `datetimeHour`: activeTime (µs), rowsRead, rowsWritten.
 * - `durableObjectsSqlStorageGroups` grouped by `namespaceId`: max storedBytes.
 * Namespace class names come from REST `GET /accounts/{id}/workers/durable_objects/namespaces`, which lists
 * dispatch-namespace user-worker namespaces with their `script`; without access the namespace id is the label.
 */

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_HOUR = 3_600 * MICROS_PER_SECOND;
const DAY_MS = 86_400_000;
/** Dataset page size ceiling (`settings.<dataset>.maxPageSize`); a day of one account is far below it. */
const PAGE_LIMIT = 10_000;

/**
 * Daily flag: the window total exceeds `SPIKE_RATIO`× the preceding window total and is at least `SPIKE_FLOORS`.
 * Hourly flag: one hour exceeds `SPIKE_RATIO`× the preceding window's mean hourly value and is at least `HOURLY_SPIKE_FLOORS`.
 */
export const SPIKE_RATIO = 5;
export type DailySpikeMetric = 'rowsWritten' | 'activeHours';
export type HourlySpikeMetric = DailySpikeMetric | 'requests';
export const SPIKE_FLOORS: Record<DailySpikeMetric, number> = { rowsWritten: 10_000, activeHours: 0.1 };
export const HOURLY_SPIKE_FLOORS: Record<HourlySpikeMetric, number> = { rowsWritten: 1_000, activeHours: 0.05, requests: 1_000 };
const DAILY_SPIKE_METRICS: DailySpikeMetric[] = ['rowsWritten', 'activeHours'];
const HOURLY_SPIKE_METRICS: HourlySpikeMetric[] = ['rowsWritten', 'activeHours', 'requests'];
const METRIC_LABELS: Record<HourlySpikeMetric, string> = { rowsWritten: 'rows written', activeHours: 'active h', requests: 'requests' };

const usageWindowSchema = z.object({ start: z.string(), end: z.string() });
const workerUsageSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  cpuSeconds: z.number(),
  wallSeconds: z.number(),
  durationGbSeconds: z.number(),
});
const hourlyUsageSchema = z.object({ hour: z.string(), requests: z.number(), rowsWritten: z.number(), activeHours: z.number() });
const namespaceUsageSchema = z.object({
  namespaceId: z.string(),
  className: z.string().nullable(),
  requests: z.number(),
  errors: z.number(),
  rowsRead: z.number(),
  rowsWritten: z.number(),
  activeHours: z.number(),
  storedBytes: z.number().nullable(),
  /** Hours with any activity, ascending. */
  hourly: z.array(hourlyUsageSchema),
});
export const usageReportSchema = z.object({
  script: z.string(),
  window: usageWindowSchema,
  worker: workerUsageSchema,
  namespaces: z.array(namespaceUsageSchema),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type HourlyUsage = z.infer<typeof hourlyUsageSchema>;
export type NamespaceUsage = z.infer<typeof namespaceUsageSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;

export interface DailySpike {
  metric: DailySpikeMetric;
  previous: number;
  current: number;
  floor: number;
  /** `null` when the preceding window had none of this usage. */
  ratio: number | null;
}

export interface HourlySpike {
  hour: string;
  metric: HourlySpikeMetric;
  value: number;
  previousHourlyMean: number;
  floor: number;
  ratio: number | null;
}

/** Every flag of one subject: `worker` (sum over its namespaces) or one namespace. */
export interface UsageSpike {
  script: string;
  /** `worker` for the script-wide total, otherwise the namespace class (or id when unlabeled). */
  subject: string;
  namespaceId: string | null;
  daily: DailySpike[];
  hours: HourlySpike[];
}

export interface UsageReportRequest {
  accountId: string;
  script: string;
  window: UsageWindow;
  /** Account Analytics: Read. */
  analyticsToken: string;
  /** Optional token allowed to list Durable Object namespaces; class names fall back to namespace ids. */
  namespaceToken?: string;
}

const USAGE_QUERY = `query UsageReport($accountTag: String!, $script: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: ${PAGE_LIMIT}, filter: { scriptName: $script, datetime_geq: $start, datetime_lt: $end }) {
        sum { requests errors cpuTimeUs wallTime duration }
      }
      objects: durableObjectsInvocationsAdaptiveGroups(limit: ${PAGE_LIMIT}, filter: { scriptName: $script, datetime_geq: $start, datetime_lt: $end }) {
        dimensions { namespaceId datetimeHour }
        sum { requests errors }
      }
      storage: durableObjectsSqlStorageGroups(limit: ${PAGE_LIMIT}, filter: { datetime_geq: $start, datetime_lt: $end }) {
        dimensions { namespaceId }
        max { storedBytes }
      }
    }
  }
}`;

const PERIODIC_QUERY = `query UsageReportPeriodic($accountTag: String!, $namespaceIds: [String!], $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      periodic: durableObjectsPeriodicGroups(limit: ${PAGE_LIMIT}, filter: { namespaceId_in: $namespaceIds, datetime_geq: $start, datetime_lt: $end }) {
        dimensions { namespaceId datetimeHour }
        sum { activeTime rowsRead rowsWritten }
      }
    }
  }
}`;

const namespaceDimensionsSchema = z.object({ namespaceId: z.string() });
const namespaceHourSchema = z.object({ namespaceId: z.string(), datetimeHour: z.string() });
const accountUsageSchema = z.object({
  workers: z.array(z.object({
    sum: z.object({ requests: z.number(), errors: z.number(), cpuTimeUs: z.number(), wallTime: z.number(), duration: z.number() }),
  })),
  objects: z.array(z.object({ dimensions: namespaceHourSchema, sum: z.object({ requests: z.number(), errors: z.number() }) })),
  storage: z.array(z.object({ dimensions: namespaceDimensionsSchema, max: z.object({ storedBytes: z.number() }) })),
});
const accountPeriodicSchema = z.object({
  periodic: z.array(z.object({
    dimensions: namespaceHourSchema,
    sum: z.object({ activeTime: z.number(), rowsRead: z.number(), rowsWritten: z.number() }),
  })),
});
const graphQlErrorsSchema = z.object({ errors: z.array(z.object({ message: z.string() })).nullable().optional() });

const namespaceListSchema = z.object({
  success: z.boolean(),
  result: z.array(z.object({ id: z.string(), class: z.string().optional(), script: z.string().nullable().optional() })).nullable(),
  result_info: z.object({ page: z.number(), total_pages: z.number().optional() }).optional(),
});

/** `[start, start + 24h)` of the UTC calendar day `date` (YYYY-MM-DD). */
export function utcDayWindow(date: string): UsageWindow {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(start)) throw new Error(`Invalid UTC date: ${date}`);
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

/** The `hours` ending at `end`. */
export function rollingWindow(end: Date, hours: number): UsageWindow {
  return { start: new Date(end.getTime() - hours * 3_600_000).toISOString(), end: end.toISOString() };
}

/** The equal-length window immediately before `window`. */
export function precedingWindow(window: UsageWindow): UsageWindow {
  const start = Date.parse(window.start);
  return { start: new Date(start - (Date.parse(window.end) - start)).toISOString(), end: window.start };
}

/** UTC day (YYYY-MM-DD) `offsetDays` from the day containing `time`. */
export function utcDate(time: number, offsetDays = 0): string {
  return new Date(time + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export function usageReportKey(script: string, date: string): string {
  return `usage-reports/${script}/${date}.json`;
}

export function usageReportScripts(value: string | undefined): string[] {
  return (value ?? '').split(',').map((script) => script.trim()).filter(Boolean);
}

/** Class names of the script's Durable Object namespaces, or null when the token cannot list them. */
/** One of the account's Durable Object namespaces: the script and class that own it. */
export interface DurableObjectNamespaceEntry { id: string; className: string; script: string | null }

/** The account's Durable Object namespaces, or null when Cloudflare does not answer. */
export async function durableObjectNamespaces(accountId: string, token: string): Promise<DurableObjectNamespaceEntry[] | null> {
  const all: DurableObjectNamespaceEntry[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces?per_page=1000&page=${page}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = namespaceListSchema.safeParse(await response.json());
    if (!body.success || !body.data.success) return null;
    const namespaces = body.data.result ?? [];
    for (const namespace of namespaces) all.push({ id: namespace.id, className: namespace.class ?? namespace.id, script: namespace.script ?? null });
    if (namespaces.length === 0 || page >= (body.data.result_info?.total_pages ?? page)) return all;
  }
}

async function namespaceClasses(accountId: string, script: string, token: string): Promise<Map<string, string> | null> {
  const namespaces = await durableObjectNamespaces(accountId, token);
  return namespaces && new Map(namespaces.filter(namespace => namespace.script === script).map(namespace => [namespace.id, namespace.className]));
}

/** One account-scoped GraphQL query; GraphQL errors and truncated pages fail the report rather than under-count. */
export async function queryAccount<S extends z.ZodType>(request: UsageReportRequest, query: string, variables: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const response = await fetch(`${CLOUDFLARE_API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${request.analyticsToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag: request.accountId, start: request.window.start, end: request.window.end, ...variables } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cloudflare GraphQL rejected the usage query (${response.status})`);
  const json: unknown = await response.json();
  const errors = graphQlErrorsSchema.safeParse(json);
  if (errors.success && errors.data.errors?.length) throw new Error(`Cloudflare GraphQL errors: ${errors.data.errors.map((error) => error.message).join('; ').slice(0, 512)}`);
  const body = z.object({ data: z.object({ viewer: z.object({ accounts: z.array(schema) }) }) }).safeParse(json);
  if (!body.success) throw new Error(`Unexpected Cloudflare GraphQL response: ${body.error.message.slice(0, 512)}`);
  const account = body.data.data.viewer.accounts[0];
  if (account === undefined) throw new Error(`Cloudflare GraphQL returned no analytics for account ${request.accountId}`);
  if (Object.values(z.record(z.string(), z.array(z.unknown())).parse(account)).some((groups) => groups.length >= PAGE_LIMIT)) {
    throw new Error(`Cloudflare GraphQL usage for ${request.script} exceeds ${PAGE_LIMIT} groups; shorten the window`);
  }
  return account;
}

/** Usage of `request.script` and its Durable Object namespaces over `request.window`, with hourly detail. */
export async function fetchUsageReport(request: UsageReportRequest): Promise<UsageReport> {
  const [usage, classes] = await Promise.all([
    queryAccount(request, USAGE_QUERY, { script: request.script }, accountUsageSchema),
    request.namespaceToken ? namespaceClasses(request.accountId, request.script, request.namespaceToken) : Promise.resolve(null),
  ]);
  // The script's namespaces are the listed ones plus any it invoked; periodic and storage data have no script dimension.
  const namespaceIds = [...new Set([...classes?.keys() ?? [], ...usage.objects.map((group) => group.dimensions.namespaceId)])];
  const { periodic } = namespaceIds.length === 0
    ? { periodic: [] }
    : await queryAccount(request, PERIODIC_QUERY, { namespaceIds }, accountPeriodicSchema);
  const namespaces = new Map(namespaceIds.map((namespaceId): [string, NamespaceUsage] => [namespaceId, {
    namespaceId, className: classes?.get(namespaceId) ?? null, requests: 0, errors: 0, rowsRead: 0, rowsWritten: 0, activeHours: 0, storedBytes: null, hourly: [],
  }]));
  const hours = new Map<string, Map<string, HourlyUsage>>();
  const hourOf = (namespaceId: string, hour: string): HourlyUsage => {
    const byHour = hours.get(namespaceId) ?? new Map<string, HourlyUsage>();
    hours.set(namespaceId, byHour);
    const entry = byHour.get(hour) ?? { hour, requests: 0, rowsWritten: 0, activeHours: 0 };
    byHour.set(hour, entry);
    return entry;
  };
  for (const group of usage.objects) {
    const namespace = namespaces.get(group.dimensions.namespaceId);
    if (!namespace) continue;
    namespace.requests += group.sum.requests;
    namespace.errors += group.sum.errors;
    hourOf(namespace.namespaceId, group.dimensions.datetimeHour).requests += group.sum.requests;
  }
  for (const group of periodic) {
    const namespace = namespaces.get(group.dimensions.namespaceId);
    if (!namespace) continue;
    const activeHours = group.sum.activeTime / MICROS_PER_HOUR;
    namespace.rowsRead += group.sum.rowsRead;
    namespace.rowsWritten += group.sum.rowsWritten;
    namespace.activeHours += activeHours;
    const hour = hourOf(namespace.namespaceId, group.dimensions.datetimeHour);
    hour.rowsWritten += group.sum.rowsWritten;
    hour.activeHours += activeHours;
  }
  for (const group of usage.storage) {
    const namespace = namespaces.get(group.dimensions.namespaceId);
    if (namespace) namespace.storedBytes = Math.max(namespace.storedBytes ?? 0, group.max.storedBytes);
  }
  for (const namespace of namespaces.values()) {
    namespace.hourly = [...hours.get(namespace.namespaceId)?.values() ?? []].sort((a, b) => a.hour.localeCompare(b.hour));
  }
  const worker = { requests: 0, errors: 0, cpuSeconds: 0, wallSeconds: 0, durationGbSeconds: 0 };
  for (const group of usage.workers) {
    worker.requests += group.sum.requests;
    worker.errors += group.sum.errors;
    worker.cpuSeconds += group.sum.cpuTimeUs / MICROS_PER_SECOND;
    worker.wallSeconds += group.sum.wallTime / MICROS_PER_SECOND;
    worker.durationGbSeconds += group.sum.duration;
  }
  return {
    script: request.script,
    window: request.window,
    worker,
    namespaces: [...namespaces.values()].sort((a, b) => b.requests - a.requests || a.namespaceId.localeCompare(b.namespaceId)),
  };
}

/** Totals and hourly series of one spike subject. */
interface UsageSeries {
  requests: number;
  rowsWritten: number;
  activeHours: number;
  hourly: HourlyUsage[];
}

/** The worker-wide series: every namespace summed per hour. */
function workerSeries(report: UsageReport): UsageSeries {
  const hours = new Map<string, HourlyUsage>();
  for (const entry of report.namespaces.flatMap((namespace) => namespace.hourly)) {
    const hour = hours.get(entry.hour) ?? { hour: entry.hour, requests: 0, rowsWritten: 0, activeHours: 0 };
    hour.requests += entry.requests;
    hour.rowsWritten += entry.rowsWritten;
    hour.activeHours += entry.activeHours;
    hours.set(entry.hour, hour);
  }
  return {
    requests: report.namespaces.reduce((sum, namespace) => sum + namespace.requests, 0),
    rowsWritten: report.namespaces.reduce((sum, namespace) => sum + namespace.rowsWritten, 0),
    activeHours: report.namespaces.reduce((sum, namespace) => sum + namespace.activeHours, 0),
    hourly: [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

function subjectSpike(script: string, subject: string, namespaceId: string | null, current: UsageSeries, previous: UsageSeries | undefined, previousHours: number): UsageSpike | null {
  const daily: DailySpike[] = [];
  for (const metric of DAILY_SPIKE_METRICS) {
    const before = previous?.[metric] ?? 0;
    const floor = SPIKE_FLOORS[metric];
    if (current[metric] >= floor && current[metric] > before * SPIKE_RATIO) {
      daily.push({ metric, previous: before, current: current[metric], floor, ratio: before > 0 ? current[metric] / before : null });
    }
  }
  const hours: HourlySpike[] = [];
  for (const entry of current.hourly) {
    for (const metric of HOURLY_SPIKE_METRICS) {
      const mean = (previous?.[metric] ?? 0) / previousHours;
      const floor = HOURLY_SPIKE_FLOORS[metric];
      if (entry[metric] >= floor && entry[metric] > mean * SPIKE_RATIO) {
        hours.push({ hour: entry.hour, metric, value: entry[metric], previousHourlyMean: mean, floor, ratio: mean > 0 ? entry[metric] / mean : null });
      }
    }
  }
  return daily.length === 0 && hours.length === 0 ? null : { script, subject, namespaceId, daily, hours };
}

/** Worker-wide and per-namespace flags: daily totals and individual hours that rose more than `SPIKE_RATIO`× above their floors. */
export function usageSpikes(current: UsageReport, previous: UsageReport): UsageSpike[] {
  const previousHours = Math.max(1, (Date.parse(previous.window.end) - Date.parse(previous.window.start)) / 3_600_000);
  const before = new Map(previous.namespaces.map((namespace) => [namespace.namespaceId, namespace]));
  return [
    subjectSpike(current.script, 'worker', null, workerSeries(current), workerSeries(previous), previousHours),
    ...current.namespaces.map((namespace) => subjectSpike(current.script, namespace.className ?? namespace.namespaceId, namespace.namespaceId, namespace, before.get(namespace.namespaceId), previousHours)),
  ].filter((spike): spike is UsageSpike => spike !== null);
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function bytes(value: number | null): string {
  if (value === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit += 1; }
  return `${unit === 0 ? integer.format(scaled) : decimal.format(scaled)} ${units[unit]}`;
}

function change(current: number, previous: number | undefined): string {
  if (previous === undefined) return 'new';
  if (previous === 0) return current === 0 ? '-' : 'from 0';
  return `x${decimal.format(current / previous)}`;
}

function amount(metric: HourlySpikeMetric, value: number): string {
  return metric === 'activeHours' ? `${decimal.format(value)} h` : compact.format(value);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)).join('  ').trimEnd()).join('\n');
}

function spikeLines(spike: UsageSpike): string[] {
  return [
    `  SPIKE ${spike.subject}${spike.namespaceId ? ` (${spike.namespaceId})` : ''}`,
    ...spike.daily.map((entry) => `    window ${METRIC_LABELS[entry.metric]} ${amount(entry.metric, entry.current)} (prev ${amount(entry.metric, entry.previous)}, ${entry.ratio === null ? 'from zero' : `x${decimal.format(entry.ratio)}`})`),
    ...spike.hours.map((entry) => `    ${entry.hour.slice(0, 16)}Z ${METRIC_LABELS[entry.metric]} ${amount(entry.metric, entry.value)} (${entry.ratio === null ? 'prev hourly mean 0' : `x${integer.format(entry.ratio)} vs prev hourly mean ${amount(entry.metric, entry.previousHourlyMean)}`})`),
  ];
}

/** Human-readable report: worker totals, per-namespace table with change vs `previous`, spike rules and flags. */
export function formatUsageReport(current: UsageReport, previous: UsageReport, spikes: UsageSpike[]): string {
  const before = new Map(previous.namespaces.map((namespace) => [namespace.namespaceId, namespace]));
  const worker = current.worker;
  const totals = workerSeries(current);
  const previousTotals = workerSeries(previous);
  const rows = [
    ['Durable Object namespace', 'requests', 'errors', 'rows read', 'rows written', 'active h', 'stored', 'rows written vs prev', 'active h vs prev'],
    ...current.namespaces.map((namespace) => {
      const prior = before.get(namespace.namespaceId);
      return [
        namespace.className ?? namespace.namespaceId,
        integer.format(namespace.requests),
        integer.format(namespace.errors),
        integer.format(namespace.rowsRead),
        integer.format(namespace.rowsWritten),
        decimal.format(namespace.activeHours),
        bytes(namespace.storedBytes),
        change(namespace.rowsWritten, prior?.rowsWritten),
        change(namespace.activeHours, prior?.activeHours),
      ];
    }),
    [
      'TOTAL',
      integer.format(totals.requests),
      integer.format(current.namespaces.reduce((sum, namespace) => sum + namespace.errors, 0)),
      integer.format(current.namespaces.reduce((sum, namespace) => sum + namespace.rowsRead, 0)),
      integer.format(totals.rowsWritten),
      decimal.format(totals.activeHours),
      bytes(current.namespaces.reduce((sum, namespace) => sum + (namespace.storedBytes ?? 0), 0)),
      change(totals.rowsWritten, previousTotals.rowsWritten),
      change(totals.activeHours, previousTotals.activeHours),
    ],
  ];
  return [
    `Cloudflare usage: ${current.script}`,
    `Window:   ${current.window.start} -> ${current.window.end} (UTC)`,
    `Previous: ${previous.window.start} -> ${previous.window.end} (UTC)`,
    '',
    `Worker: requests ${integer.format(worker.requests)} (prev ${integer.format(previous.worker.requests)}), errors ${integer.format(worker.errors)} (prev ${integer.format(previous.worker.errors)}), CPU ${decimal.format(worker.cpuSeconds)} s (prev ${decimal.format(previous.worker.cpuSeconds)} s), wall ${decimal.format(worker.wallSeconds)} s, duration ${decimal.format(worker.durationGbSeconds)} GB-s`,
    '',
    table(rows),
    '',
    `Window rule: rows written or active h > ${SPIKE_RATIO}x the previous window and >= ${integer.format(SPIKE_FLOORS.rowsWritten)} rows / ${SPIKE_FLOORS.activeHours} h.`,
    `Hourly rule: one hour's rows written, active h or DO requests > ${SPIKE_RATIO}x the previous window's hourly mean and >= ${integer.format(HOURLY_SPIKE_FLOORS.rowsWritten)} rows / ${HOURLY_SPIKE_FLOORS.activeHours} active h / ${integer.format(HOURLY_SPIKE_FLOORS.requests)} requests per hour.`,
    'Subjects: each namespace, and "worker" = sum over its namespaces.',
    spikes.length === 0 ? 'Spikes: none' : `Spikes: ${spikes.length} subject(s)\n${spikes.flatMap(spikeLines).join('\n')}`,
  ].join('\n');
}
