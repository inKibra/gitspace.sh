import { z } from 'zod';
import { durableObjectNamespaces, queryAccount } from './usage-report.js';
import { platformObjectStorage } from './storage-quarantine.js';

/**
 * The platform's storage watchdog, run every ten minutes. It reads the last hour of Durable Object writes per object
 * and today's Durable Object cost from Cloudflare's analytics, then:
 * - alerts (an error log, and an incident in the owning tenant's Inbox) on an object that wrote at least
 *   `WATCHDOG_ALERT_ROWS` rows in the last hour, and on a day whose Durable Object cost reaches `WATCHDOG_ALERT_DAILY_USD`;
 * - quarantines an object that wrote at least `WATCHDOG_QUARANTINE_ROWS` rows in the last hour, unless it was resumed
 *   within that hour (its earlier writes still count there).
 * Each object's own breaker trips first at 2M rows per ten minutes; this catches what writes more slowly, and objects
 * the breaker does not cover.
 */
export const WATCHDOG_ALERT_ROWS = 1_000_000;
export const WATCHDOG_QUARANTINE_ROWS = 5_000_000;
export const WATCHDOG_ALERT_DAILY_USD = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OBJECT_LIMIT = 100;

/** Workers Paid list prices of Durable Objects, without the monthly allowances: the estimate errs high. */
const DURABLE_OBJECT_USD = {
  perRowWritten: 1 / 1_000_000,
  perRowRead: 0.001 / 1_000_000,
  perRequest: 0.15 / 1_000_000,
  /** Duration is billed at 128 MB per active second, $12.50 per million GB-s. */
  perActiveMicrosecond: (0.125 * 12.5) / 1_000_000 / 1_000_000,
};

const objectHourSchema = z.object({
  objects: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ rowsWritten: z.number() }) })),
});
const daySchema = z.object({
  periodic: z.array(z.object({ sum: z.object({ activeTime: z.number(), rowsRead: z.number(), rowsWritten: z.number() }) })),
  invocations: z.array(z.object({ sum: z.object({ requests: z.number() }) })),
  top: z.array(z.object({ dimensions: z.object({ namespaceId: z.string(), objectId: z.string() }), sum: z.object({ rowsWritten: z.number() }) })),
});
const breakerStatusSchema = z.object({ quarantined: z.boolean(), resumedAt: z.string().nullable() });

interface Owner { className: string; tenant: string | null; script: string | null }
type Control = { action: 'status' } | { action: 'quarantine' | 'alert'; reason: string };

export async function runStorageWatchdog(env: Env, scheduledTime: number): Promise<void> {
  if (!env.CF_ANALYTICS_TOKEN) {
    console.error(JSON.stringify({ event: 'storage-watchdog-unconfigured', message: 'CF_ANALYTICS_TOKEN secret is not set' }));
    return;
  }
  const integer = new Intl.NumberFormat('en-US');
  const end = new Date(scheduledTime);
  const request = { accountId: env.CF_ACCOUNT_ID, script: 'Durable Objects', analyticsToken: env.CF_ANALYTICS_TOKEN, namespaceToken: env.CF_API_TOKEN };
  const usage = await Promise.all([
    queryAccount({ ...request, window: { start: new Date(scheduledTime - HOUR_MS).toISOString(), end: end.toISOString() } }, `query StorageWatchdogHour($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        objects: durableObjectsPeriodicGroups(limit: ${OBJECT_LIMIT}, orderBy: [sum_rowsWritten_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { rowsWritten }
        }
      } }
    }`, {}, objectHourSchema),
    queryAccount({ ...request, window: { start: new Date(scheduledTime - (scheduledTime % DAY_MS)).toISOString(), end: end.toISOString() } }, `query StorageWatchdogDay($accountTag: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        periodic: durableObjectsPeriodicGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { activeTime rowsRead rowsWritten } }
        invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } }
        top: durableObjectsPeriodicGroups(limit: 1, orderBy: [sum_rowsWritten_DESC], filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { namespaceId objectId } sum { rowsWritten }
        }
      } }
    }`, {}, daySchema),
    durableObjectNamespaces(env.CF_ACCOUNT_ID, env.CF_API_TOKEN),
  ]).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'storage-watchdog-failed', message: error instanceof Error ? error.message : String(error) }));
    return null;
  });
  if (!usage) return;
  const [hour, day, namespaces] = usage;
  const tenantPrefix = `${env.DISPATCH_NAMESPACE}-tenant-`;
  const owner = (namespaceId: string): Owner => {
    const namespace = namespaces?.find(item => item.id === namespaceId);
    const script = namespace?.script ?? null;
    return { className: namespace?.className ?? namespaceId, script, tenant: script?.startsWith(tenantPrefix) ? script.slice(tenantPrefix.length) : null };
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

  for (const { dimensions: { namespaceId, objectId }, sum: { rowsWritten } } of hour.objects) {
    if (rowsWritten < WATCHDOG_ALERT_ROWS) break;
    const who = owner(namespaceId);
    const subject = { objectId, namespaceId, className: who.className, script: who.script, rowsWritten };
    try {
      if (rowsWritten >= WATCHDOG_QUARANTINE_ROWS) {
        const status = await control(objectId, who, { action: 'status' });
        const resumedWithinHour = status?.resumedAt != null && Date.parse(status.resumedAt) > scheduledTime - HOUR_MS;
        if (status && !status.quarantined && !resumedWithinHour) {
          await control(objectId, who, { action: 'quarantine', reason: `wrote ${integer.format(rowsWritten)} rows in the last hour (watchdog limit ${integer.format(WATCHDOG_QUARANTINE_ROWS)})` });
          console.error(JSON.stringify({ event: 'storage-watchdog-quarantined', ...subject }));
          continue;
        }
        if (status?.quarantined) continue;
      }
      console.error(JSON.stringify({ event: 'storage-watchdog-alert', ...subject }));
      await control(objectId, who, { action: 'alert', reason: `wrote ${integer.format(rowsWritten)} rows in the last hour (alert at ${integer.format(WATCHDOG_ALERT_ROWS)})` });
    } catch (error) {
      console.error(JSON.stringify({ event: 'storage-watchdog-failed', ...subject, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  const periodic = day.periodic[0]?.sum ?? { activeTime: 0, rowsRead: 0, rowsWritten: 0 };
  const requests = day.invocations[0]?.sum.requests ?? 0;
  const usd = periodic.rowsWritten * DURABLE_OBJECT_USD.perRowWritten + periodic.rowsRead * DURABLE_OBJECT_USD.perRowRead
    + requests * DURABLE_OBJECT_USD.perRequest + periodic.activeTime * DURABLE_OBJECT_USD.perActiveMicrosecond;
  const top = day.top[0];
  if (usd < WATCHDOG_ALERT_DAILY_USD || !top) return;
  const who = owner(top.dimensions.namespaceId);
  console.error(JSON.stringify({ event: 'storage-watchdog-daily-cost', usd: Math.round(usd * 100) / 100, ...periodic, requests, top: { ...top.dimensions, className: who.className, script: who.script, rowsWritten: top.sum.rowsWritten } }));
  try {
    await control(top.dimensions.objectId, who, { action: 'alert', reason: `Durable Objects cost about $${usd.toFixed(2)} today (alert at $${WATCHDOG_ALERT_DAILY_USD}); this object wrote the most: ${integer.format(top.sum.rowsWritten)} rows` });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-watchdog-failed', objectId: top.dimensions.objectId, message: error instanceof Error ? error.message : String(error) }));
  }
}
