import { z } from 'zod';
import { durableObjectNamespaces, queryAccount } from './usage-report.js';
import { DURABLE_OBJECT_USD } from './storage-watchdog.js';

/**
 * The spend digest: at `SPEND_DIGEST_HOURS` local time in `SPEND_DIGEST_TIMEZONE`, an email of what the Cloudflare
 * account's Durable Objects and Workers have cost since local midnight, at list prices: by worker and class, by hour,
 * and the objects that wrote most. Run from the watchdog's ten-minute cron, in the run that starts the hour.
 */
const WORKERS_USD = { perRequest: 0.3 / 1_000_000, perCpuMs: 0.02 / 1_000_000 };
const RUN_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

const usageSchema = z.object({ activeTime: z.number(), rowsRead: z.number(), rowsWritten: z.number() });
const namespaceSchema = z.object({ periodic: z.array(z.object({ dimensions: z.object({ namespaceId: z.string() }), sum: usageSchema })) });
const requestsSchema = z.object({ invocations: z.array(z.object({ dimensions: z.object({ namespaceId: z.string() }), sum: z.object({ requests: z.number() }) })) });
const hourSchema = z.object({ hours: z.array(z.object({ dimensions: z.object({ datetimeHour: z.string() }), sum: usageSchema })) });
const objectSchema = z.object({ objects: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: usageSchema })) });
const workerSchema = z.object({ workers: z.array(z.object({ dimensions: z.object({ scriptName: z.string() }), sum: z.object({ requests: z.number(), cpuTimeUs: z.number() }) })) });

interface Cost { writes: number; reads: number; awake: number; requests: number; rowsWritten: number }

/** Local wall-clock hour and minute of `at` in `timeZone`, and the UTC instant of that day's local midnight. */
function localDay(at: number, timeZone: string): { hour: number; minute: number; midnight: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour), minute = Number(parts.minute), second = Number(parts.second);
  return { hour, minute, midnight: at - ((hour * 60 + minute) * 60 + second) * 1000 - (at % 1000) };
}

export async function sendSpendDigestIfDue(env: Env, scheduledTime: number): Promise<void> {
  const local = localDay(scheduledTime, env.SPEND_DIGEST_TIMEZONE);
  const due = env.SPEND_DIGEST_HOURS.split(',').map(Number).includes(local.hour) && local.minute * 60_000 < RUN_MS;
  if (!due || !env.CF_ANALYTICS_TOKEN) return;
  try {
    const digest = await spendDigest(env, local.midnight, scheduledTime);
    const sent = await env.WATCHDOG_EMAIL.send({ from: { email: env.WATCHDOG_EMAIL_FROM, name: 'GitSpace watchdog' }, to: env.WATCHDOG_EMAIL_TO, ...digest });
    console.log(JSON.stringify({ event: 'spend-digest-sent', subject: digest.subject, messageId: sent.messageId }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'spend-digest-failed', message: error instanceof Error ? error.message : String(error) }));
  }
}

/** The digest email's subject and text for `[start, end)`. */
async function spendDigest(env: Env, start: number, end: number): Promise<{ subject: string; text: string }> {
  // Small queries one after another: one large query spends the analytics rate limit faster.
  const request = { accountId: env.CF_ACCOUNT_ID, script: 'spend digest', analyticsToken: env.CF_ANALYTICS_TOKEN, window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } };
  const filter = 'filter: { datetime_geq: $start, datetime_lt: $end }';
  const query = (body: string) => `query SpendDigest($accountTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { ${body} } } }`;
  const sum = 'sum { activeTime rowsRead rowsWritten }';
  const byNamespace = await queryAccount(request, query(`periodic: durableObjectsPeriodicGroups(limit: 1000, ${filter}) { dimensions { namespaceId } ${sum} }`), {}, namespaceSchema);
  const requests = await queryAccount(request, query(`invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, ${filter}) { dimensions { namespaceId } sum { requests } }`), {}, requestsSchema);
  const byHour = await queryAccount(request, query(`hours: durableObjectsPeriodicGroups(limit: 48, orderBy: [datetimeHour_ASC], ${filter}) { dimensions { datetimeHour } ${sum} }`), {}, hourSchema);
  const top = await queryAccount(request, query(`objects: durableObjectsPeriodicGroups(limit: 5, orderBy: [sum_rowsWritten_DESC], ${filter}) { dimensions { namespaceId objectId } ${sum} }`), {}, objectSchema);
  const workers = await queryAccount(request, query(`workers: workersInvocationsAdaptive(limit: 1000, ${filter}) { dimensions { scriptName } sum { requests cpuTimeUs } }`), {}, workerSchema);
  const namespaces = await durableObjectNamespaces(env.CF_ACCOUNT_ID, env.CF_API_TOKEN) ?? [];
  const owner = (namespaceId: string) => {
    const namespace = namespaces.find(item => item.id === namespaceId);
    return { script: namespace?.script ?? 'unknown worker', className: namespace?.className ?? `namespace ${namespaceId}` };
  };
  const cost = (usage: z.infer<typeof usageSchema>, requestCount = 0): Cost => ({
    writes: usage.rowsWritten * DURABLE_OBJECT_USD.perRowWritten, reads: usage.rowsRead * DURABLE_OBJECT_USD.perRowRead,
    awake: usage.activeTime * DURABLE_OBJECT_USD.perActiveMicrosecond, requests: requestCount * DURABLE_OBJECT_USD.perRequest, rowsWritten: usage.rowsWritten,
  });
  const usd = (part: Cost) => part.writes + part.reads + part.awake + part.requests;
  const money = (value: number) => `$${value.toFixed(2)}`;
  const plus = (into: Cost, part: Cost) => { into.writes += part.writes; into.reads += part.reads; into.awake += part.awake; into.requests += part.requests; into.rowsWritten += part.rowsWritten; };
  const empty = (): Cost => ({ writes: 0, reads: 0, awake: 0, requests: 0, rowsWritten: 0 });

  // Worker → class → cost.
  const scripts = new Map<string, Map<string, Cost>>();
  const classCost = (namespaceId: string) => {
    const { script, className } = owner(namespaceId);
    const classes = scripts.get(script) ?? new Map<string, Cost>();
    scripts.set(script, classes);
    const entry = classes.get(className) ?? empty();
    classes.set(className, entry);
    return entry;
  };
  for (const group of byNamespace.periodic) plus(classCost(group.dimensions.namespaceId), cost(group.sum));
  for (const group of requests.invocations) plus(classCost(group.dimensions.namespaceId), cost({ activeTime: 0, rowsRead: 0, rowsWritten: 0 }, group.sum.requests));
  const total = empty();
  const ranked = [...scripts].map(([script, classes]) => {
    const scriptTotal = empty();
    for (const part of classes.values()) plus(scriptTotal, part);
    plus(total, scriptTotal);
    return { script, scriptTotal, classes: [...classes].sort((a, b) => usd(b[1]) - usd(a[1])) };
  }).sort((a, b) => usd(b.scriptTotal) - usd(a.scriptTotal));
  const workerUsd = workers.workers.reduce((sum, group) => sum + group.sum.requests * WORKERS_USD.perRequest + (group.sum.cpuTimeUs / 1000) * WORKERS_USD.perCpuMs, 0);
  const workerRequests = workers.workers.reduce((sum, group) => sum + group.sum.requests, 0);
  const hours = Math.max((end - start) / HOUR_MS, 1);
  const pace = (usd(total) + workerUsd) / hours * 24;

  const lines = [
    `Durable Objects ${money(usd(total))} = writes ${money(total.writes)} (${(total.rowsWritten / 1e6).toFixed(2)}M rows) + reads ${money(total.reads)} + awake time ${money(total.awake)} + requests ${money(total.requests)}`,
    `Workers ${money(workerUsd)} (${Math.round(workerRequests / 1000)}k requests)`,
    `Pace: about ${money(pace)} for the whole day.`,
    '',
    'BY WORKER',
    ...ranked.filter(entry => usd(entry.scriptTotal) >= 0.01).flatMap(entry => [
      `${money(usd(entry.scriptTotal)).padStart(7)}  ${entry.script}`,
      ...entry.classes.filter(([, part]) => usd(part) >= 0.01).map(([className, part]) =>
        `${money(usd(part)).padStart(15)}  ${className} (writes ${money(part.writes)}, reads ${money(part.reads)}, awake ${money(part.awake)})`),
    ]),
    '',
    'BY HOUR (local)',
    ...byHour.hours.map(group => {
      const at = Date.parse(group.dimensions.datetimeHour);
      const label = new Intl.DateTimeFormat('en-US', { timeZone: env.SPEND_DIGEST_TIMEZONE, hour: 'numeric' }).format(new Date(at));
      const value = usd(cost(group.sum));
      return `${label.padStart(6)}  ${money(value).padStart(6)}  ${'#'.repeat(Math.min(Math.round(value * 20), 60))}`;
    }),
    '',
    'MOST ROWS WRITTEN',
    ...top.objects.map(group => {
      const { script, className } = owner(group.dimensions.namespaceId);
      return `${money(usd(cost(group.sum))).padStart(7)}  ${script} ${className} ${group.dimensions.objectId.slice(0, 12)} (${(group.sum.rowsWritten / 1e6).toFixed(2)}M rows written)`;
    }),
    '',
    'List prices; Durable Object storage, R2 and Containers are not included.',
  ];
  return { subject: `Cloudflare spend today: ${money(usd(total) + workerUsd)} so far (pace ${money(pace)}/day)`, text: lines.join('\n') };
}
