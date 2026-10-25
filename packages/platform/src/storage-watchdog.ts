import { z } from 'zod';
import { durableObjectNamespaces, queryAccount, type DurableObjectNamespaceEntry } from './usage-report.js';
import { platformObjectStorage } from './storage-quarantine.js';

/**
 * The platform's storage watchdog, run every ten minutes over every Durable Object of the Cloudflare account (not
 * only GitSpace's). It reads the last hour of writes and alarms per object and today's Durable Object cost from
 * Cloudflare's analytics, then:
 * - quarantines an object that wrote at least `WATCHDOG_QUARANTINE_ROWS` rows in the last hour, unless it is already
 *   quarantined or was resumed within that hour (its earlier writes still count there). Only GitSpace's tenant and
 *   platform objects can be quarantined; any other object is reported;
 * - reports an object that wrote at least `WATCHDOG_ALERT_ROWS` rows in the last hour, and a day whose Durable Object
 *   cost reaches `WATCHDOG_ALERT_DAILY_USD`;
 * - reports an object awake at least `WATCHDOG_AWAKE_HOURS` of the last 24 hours, or that read at least
 *   `WATCHDOG_READ_ROWS` rows in them. An idle workspace sleeps: one that does not holds an alarm, timer or request
 *   open, and is billed for every hour of it;
 * - reports an object that ran more than `WATCHDOG_ALARMS_PER_HOUR` alarms in the last hour. An object should wake
 *   only for a deadline, the heartbeat that resumes in-flight work, or a retry with backoff. The limit sits above a
 *   running conversation's 30 s heartbeat (about 120 alarms an hour) and below the slowest polling loop seen in
 *   production (one alarm every 6.5 s, about 550 an hour).
 * Reports go by email (`WATCHDOG_EMAIL`) and, for a tenant's object, to its Inbox. A report is sent once, and again
 * only if the problem still holds `WATCHDOG_REPEAT_MS` later; quarantines are reported each time. After
 * `WATCHDOG_BLIND_RUNS` runs in a row without analytics, the watchdog reports that it is blind.
 * Each object's own breaker trips first at 2M rows per ten minutes; this catches what writes more slowly, and objects
 * the breaker does not cover.
 */
export const WATCHDOG_ALERT_ROWS = 1_000_000;
export const WATCHDOG_QUARANTINE_ROWS = 5_000_000;
export const WATCHDOG_ALERT_DAILY_USD = 20;
export const WATCHDOG_AWAKE_HOURS = 20;
export const WATCHDOG_READ_ROWS = 20_000_000;
export const WATCHDOG_ALARMS_PER_HOUR = 300;
const WATCHDOG_REPEAT_MS = 6 * 3_600_000;
const WATCHDOG_BLIND_RUNS = 3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OBJECT_LIMIT = 100;
/** What has been reported and when, and how many runs in a row failed; written only when it changes. */
const STATE_KEY = 'storage-watchdog/state.json';

/** Workers Paid list prices of Durable Objects, without the monthly allowances: the estimate errs high. */
export const DURABLE_OBJECT_USD = {
  perRowWritten: 1 / 1_000_000,
  perRowRead: 0.001 / 1_000_000,
  perRequest: 0.15 / 1_000_000,
  /** Duration is billed at 128 MB per active second, $12.50 per million GB-s. */
  perActiveMicrosecond: (0.125 * 12.5) / 1_000_000 / 1_000_000,
};

const objectHourSchema = z.object({
  objects: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ rowsWritten: z.number() }) })),
  alarms: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ requests: z.number() }) })),
});
const daySchema = z.object({
  periodic: z.array(z.object({ sum: z.object({ activeTime: z.number(), rowsRead: z.number(), rowsWritten: z.number() }) })),
  invocations: z.array(z.object({ sum: z.object({ requests: z.number() }) })),
  top: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ rowsWritten: z.number() }) })),
});
const objectDayGroupsSchema = z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ activeTime: z.number(), rowsRead: z.number() }) }));
const objectDaySchema = z.object({ awake: objectDayGroupsSchema, reading: objectDayGroupsSchema });
const breakerStatusSchema = z.object({ quarantined: z.boolean(), resumedAt: z.string().nullable() });
const stateSchema = z.object({ reported: z.record(z.string(), z.number()), failedRuns: z.number() });

interface Owner { className: string; tenant: string | null; script: string | null }
type Control = { action: 'status' } | { action: 'quarantine' | 'alert'; reason: string };
/** One line of a report; `inbox` is posted to the owning tenant's Inbox with the email. */
interface Finding { key: string; line: string; inbox: { objectId: string; owner: Owner; reason: string } | null }

export async function runStorageWatchdog(env: Env, scheduledTime: number): Promise<void> {
  if (!env.CF_ANALYTICS_TOKEN) {
    console.error(JSON.stringify({ event: 'storage-watchdog-unconfigured', message: 'CF_ANALYTICS_TOKEN secret is not set' }));
    return;
  }
  const stored = await env.RELEASES.get(STATE_KEY).then(object => object?.json()).catch(() => null);
  const parsedState = stateSchema.safeParse(stored);
  const state = parsedState.success ? parsedState.data : { reported: {}, failedRuns: 0 };
  const saveState = () => env.RELEASES.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  const integer = new Intl.NumberFormat('en-US');
  const end = new Date(scheduledTime).toISOString();
  const request = { accountId: env.CF_ACCOUNT_ID, script: 'Durable Objects', analyticsToken: env.CF_ANALYTICS_TOKEN, namespaceToken: env.CF_API_TOKEN };
  const usage = await Promise.all([
    queryAccount({ ...request, window: { start: new Date(scheduledTime - HOUR_MS).toISOString(), end } }, `query StorageWatchdogHour($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        objects: durableObjectsPeriodicGroups(limit: ${OBJECT_LIMIT}, orderBy: [sum_rowsWritten_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { rowsWritten }
        }
        alarms: durableObjectsInvocationsAdaptiveGroups(limit: ${OBJECT_LIMIT}, orderBy: [sum_requests_DESC], filter: { datetime_geq: $start, datetime_lt: $end, type: "alarm" }) {
          dimensions { namespaceId objectId } sum { requests }
        }
      } }
    }`, {}, objectHourSchema),
    queryAccount({ ...request, window: { start: new Date(scheduledTime - (scheduledTime % DAY_MS)).toISOString(), end } }, `query StorageWatchdogDay($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        periodic: durableObjectsPeriodicGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { activeTime rowsRead rowsWritten } }
        invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } }
        top: durableObjectsPeriodicGroups(limit: 1, orderBy: [sum_rowsWritten_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { rowsWritten }
        }
      } }
    }`, {}, daySchema),
    queryAccount({ ...request, window: { start: new Date(scheduledTime - DAY_MS).toISOString(), end } }, `query StorageWatchdogAwake($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        awake: durableObjectsPeriodicGroups(limit: ${OBJECT_LIMIT}, orderBy: [sum_activeTime_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { activeTime rowsRead }
        }
        reading: durableObjectsPeriodicGroups(limit: ${OBJECT_LIMIT}, orderBy: [sum_rowsRead_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { activeTime rowsRead }
        }
      } }
    }`, {}, objectDaySchema),
  ]).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'storage-watchdog-failed', failedRuns: state.failedRuns + 1, message }));
    return message;
  });

  const findings: Finding[] = [];
  if (typeof usage === 'string') {
    state.failedRuns += 1;
    if (state.failedRuns >= WATCHDOG_BLIND_RUNS) findings.push({ key: 'blind', line: `The watchdog could not read Cloudflare analytics for ${state.failedRuns} runs in a row (${state.failedRuns * 10} minutes); nothing is being watched. Last error: ${usage}`, inbox: null });
    await report(env, state, findings, scheduledTime);
    await saveState();
    return;
  }
  const recovered = state.failedRuns > 0;
  state.failedRuns = 0;
  const [hour, day, lastDay] = usage;

  // Which script and class own a namespace: read only when something is reported.
  let namespaces: DurableObjectNamespaceEntry[] | null | undefined;
  const tenantPrefix = `${env.DISPATCH_NAMESPACE}-tenant-`;
  const owner = async (namespaceId: string): Promise<Owner> => {
    namespaces ??= await durableObjectNamespaces(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);
    const namespace = namespaces?.find(item => item.id === namespaceId);
    const script = namespace?.script ?? null;
    return { className: namespace?.className ?? `namespace ${namespaceId}`, script, tenant: script?.startsWith(tenantPrefix) ? script.slice(tenantPrefix.length) : null };
  };
  // A tenant's object through its worker's platform route; any other object is tried as one of the platform's own.
  const control = async (objectId: string, who: Owner, input: Control): Promise<z.infer<typeof breakerStatusSchema> | null> => {
    if (who.tenant === null) {
      if (input.action === 'alert') return null;
      return platformObjectStorage(env, { objectId, action: input.action, ...(input.action === 'quarantine' ? { reason: input.reason } : {}) });
    }
    const response = await env.DISPATCHER.get(`${tenantPrefix}${who.tenant}`).fetch(new Request(`https://${who.tenant}.gitspace.sh/__platform/storage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await env.DEPLOYMENTS.getByName(who.tenant).providerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ objectId, className: who.className, ...input }),
    }));
    if (!response.ok) throw new Error(`Tenant ${who.tenant} answered ${response.status} to ${input.action}`);
    const status = breakerStatusSchema.safeParse(await response.json());
    if (!status.success) throw new Error(`Tenant ${who.tenant} answered ${input.action} without a breaker status`);
    return status.data;
  };
  const describe = (who: Owner, objectId: string) => `${who.className} ${objectId.slice(0, 12)}… (${who.tenant ? `GitSpace tenant ${who.tenant}` : who.script ?? 'unknown script'})`;

  for (const { dimensions: { namespaceId, objectId }, sum: { rowsWritten } } of hour.objects) {
    if (rowsWritten < WATCHDOG_ALERT_ROWS) break;
    const who = await owner(namespaceId);
    const subject = { objectId, namespaceId, className: who.className, script: who.script, rowsWritten };
    const rows = integer.format(rowsWritten);
    try {
      let pausable = true;
      if (rowsWritten >= WATCHDOG_QUARANTINE_ROWS) {
        const status = await control(objectId, who, { action: 'status' });
        pausable = status !== null;
        if (status?.quarantined) continue;
        const resumedWithinHour = status?.resumedAt != null && Date.parse(status.resumedAt) > scheduledTime - HOUR_MS;
        if (status && !resumedWithinHour) {
          await control(objectId, who, { action: 'quarantine', reason: `wrote ${rows} rows in the last hour (watchdog limit ${integer.format(WATCHDOG_QUARANTINE_ROWS)})` });
          console.error(JSON.stringify({ event: 'storage-watchdog-quarantined', ...subject }));
          findings.push({ key: `quarantine:${objectId}:${scheduledTime}`, line: `PAUSED ${describe(who, objectId)}: wrote ${rows} rows in the last hour. It refuses all storage until resumed from the Inbox.`, inbox: null });
          continue;
        }
      }
      console.error(JSON.stringify({ event: 'storage-watchdog-alert', ...subject }));
      findings.push({
        key: `alert:${objectId}`,
        line: `${describe(who, objectId)}: wrote ${rows} rows in the last hour (alert at ${integer.format(WATCHDOG_ALERT_ROWS)}).${pausable ? '' : ' It is not a GitSpace object, so the watchdog cannot pause it.'}`,
        inbox: { objectId, owner: who, reason: `wrote ${rows} rows in the last hour (alert at ${integer.format(WATCHDOG_ALERT_ROWS)})` },
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'storage-watchdog-failed', ...subject, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  const sleepless = new Map(lastDay.awake.concat(lastDay.reading)
    .filter(({ sum }) => sum.activeTime >= WATCHDOG_AWAKE_HOURS * HOUR_MS * 1000 || sum.rowsRead >= WATCHDOG_READ_ROWS)
    .map(group => [group.dimensions.objectId, group]));
  for (const { dimensions: { namespaceId, objectId }, sum } of sleepless.values()) {
    const who = await owner(namespaceId);
    const hours = (sum.activeTime / (HOUR_MS * 1000)).toFixed(1);
    const reason = `was awake ${hours} of the last 24 hours and read ${integer.format(sum.rowsRead)} rows (alert at ${WATCHDOG_AWAKE_HOURS} hours or ${integer.format(WATCHDOG_READ_ROWS)} rows); an idle object should sleep`;
    console.error(JSON.stringify({ event: 'storage-watchdog-sleepless', objectId, namespaceId, className: who.className, script: who.script, ...sum }));
    findings.push({ key: `sleepless:${objectId}`, line: `${describe(who, objectId)}: ${reason}.`, inbox: { objectId, owner: who, reason } });
  }

  for (const { dimensions: { namespaceId, objectId }, sum: { requests } } of hour.alarms) {
    if (requests <= WATCHDOG_ALARMS_PER_HOUR) break;
    const who = await owner(namespaceId);
    const reason = `ran ${integer.format(requests)} alarms in the last hour (alert above ${WATCHDOG_ALARMS_PER_HOUR}); an object should wake only for a deadline, the heartbeat of in-flight work, or a retry with backoff`;
    console.error(JSON.stringify({ event: 'storage-watchdog-alarms', objectId, namespaceId, className: who.className, script: who.script, alarms: requests }));
    findings.push({ key: `alarms:${objectId}`, line: `${describe(who, objectId)}: ${reason}.`, inbox: { objectId, owner: who, reason } });
  }

  const periodic = day.periodic[0]?.sum ?? { activeTime: 0, rowsRead: 0, rowsWritten: 0 };
  const requests = day.invocations[0]?.sum.requests ?? 0;
  const usd = periodic.rowsWritten * DURABLE_OBJECT_USD.perRowWritten + periodic.rowsRead * DURABLE_OBJECT_USD.perRowRead
    + requests * DURABLE_OBJECT_USD.perRequest + periodic.activeTime * DURABLE_OBJECT_USD.perActiveMicrosecond;
  // One line per run, so a quiet watchdog can be told from a stopped one.
  console.log(JSON.stringify({ event: 'storage-watchdog', usdToday: Math.round(usd * 100) / 100, topHourRowsWritten: hour.objects[0]?.sum.rowsWritten ?? 0, topHourObjectId: hour.objects[0]?.dimensions.objectId ?? null }));
  const top = day.top[0];
  if (usd >= WATCHDOG_ALERT_DAILY_USD && top) {
    const who = await owner(top.dimensions.namespaceId);
    const reason = `Durable Objects across the Cloudflare account cost about $${usd.toFixed(2)} today (alert at $${WATCHDOG_ALERT_DAILY_USD}); this object wrote the most: ${integer.format(top.sum.rowsWritten)} rows`;
    console.error(JSON.stringify({ event: 'storage-watchdog-daily-cost', usd: Math.round(usd * 100) / 100, ...periodic, requests, top: { ...top.dimensions, className: who.className, script: who.script } }));
    findings.push({ key: `daily:${end.slice(0, 10)}`, line: `${reason}: ${describe(who, top.dimensions.objectId)}.`, inbox: { objectId: top.dimensions.objectId, owner: who, reason } });
  }

  const sent = await report(env, state, findings, scheduledTime);
  for (const finding of sent) {
    if (!finding.inbox) continue;
    await control(finding.inbox.objectId, finding.inbox.owner, { action: 'alert', reason: finding.inbox.reason })
      .catch((error: unknown) => console.error(JSON.stringify({ event: 'storage-watchdog-failed', objectId: finding.inbox?.objectId, message: error instanceof Error ? error.message : String(error) })));
  }
  if (sent.length || recovered) await saveState();
}

/**
 * Emails the findings not reported within `WATCHDOG_REPEAT_MS` as one message, and records them in `state`. Returns
 * the findings it sent; none when the email fails, so the next run tries again.
 */
async function report(env: Env, state: z.infer<typeof stateSchema>, findings: Finding[], now: number): Promise<Finding[]> {
  const fresh = findings.filter(finding => now - (state.reported[finding.key] ?? 0) >= WATCHDOG_REPEAT_MS);
  if (!fresh.length) return [];
  const paused = fresh.filter(finding => finding.key.startsWith('quarantine:')).length;
  const subject = fresh.some(finding => finding.key === 'blind') ? 'GitSpace watchdog is blind'
    : paused ? `GitSpace watchdog paused ${paused} Durable Object${paused === 1 ? '' : 's'}`
    : `GitSpace watchdog: ${fresh.length} Durable Object alert${fresh.length === 1 ? '' : 's'}`;
  try {
    await env.WATCHDOG_EMAIL.send({
      from: { email: env.WATCHDOG_EMAIL_FROM, name: 'GitSpace watchdog' },
      to: env.WATCHDOG_EMAIL_TO,
      subject,
      text: `${fresh.map(finding => `- ${finding.line}`).join('\n')}\n\nChecked at ${new Date(now).toISOString()}. A problem that persists is reported again after ${WATCHDOG_REPEAT_MS / 3_600_000} hours.`,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-watchdog-email-failed', subject, message: error instanceof Error ? error.message : String(error) }));
    return [];
  }
  for (const finding of fresh) state.reported[finding.key] = now;
  state.reported = Object.fromEntries(Object.entries(state.reported).filter(([, at]) => now - at < DAY_MS));
  return fresh;
}
