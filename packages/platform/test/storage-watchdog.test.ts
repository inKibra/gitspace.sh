import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, test } from 'vitest';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const tenant = 'acme';
const tenantNamespace = 'a'.repeat(32);
const scheduledTime = Date.parse('2026-10-14T02:20:00Z');
const object = (letter: string) => letter.repeat(64);

/** Cloudflare's API: the account's namespaces, the last hour's writes per object, and today's totals. */
function mockCloudflare(hour: Record<string, number>, today: { rowsWritten: number }) {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/workers/durable_objects/namespaces')) {
      return Response.json({ success: true, result: [{ id: tenantNamespace, class: 'SpaceAuthorityDO', script: `${env.DISPATCH_NAMESPACE}-tenant-${tenant}` }] });
    }
    const body: { query: string } = await request.json();
    const query = body.query;
    const groups = Object.entries(hour).map(([objectId, rowsWritten]) => ({ dimensions: { namespaceId: tenantNamespace, objectId }, sum: { rowsWritten } }));
    if (query.includes('StorageWatchdogHour')) return Response.json({ data: { viewer: { accounts: [{ objects: groups }] } } });
    return Response.json({ data: { viewer: { accounts: [{
      periodic: [{ sum: { activeTime: 0, rowsRead: 0, rowsWritten: today.rowsWritten } }],
      invocations: [{ sum: { requests: 0 } }],
      top: groups.slice(0, 1),
    }] } } });
  };
}

/** The tenant's worker: answers the storage route from `statuses` and records what the platform asked. */
function tenantWorker(statuses: Record<string, { quarantined: boolean; resumedAt: string | null }>) {
  const asked: Array<{ objectId: string; action: string; reason?: string }> = [];
  const dispatcher = {
    get(script: string) {
      expect(script).toBe(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`);
      return {
        async fetch(request: Request) {
          expect(new URL(request.url).pathname).toBe('/__platform/storage');
          expect(request.headers.get('authorization')).toBe(`Bearer ${await env.DEPLOYMENTS.getByName(tenant).providerToken()}`);
          const body: { objectId: string; action: string; reason?: string } = await request.json();
          asked.push(body);
          return Response.json(statuses[body.objectId] ?? { quarantined: false, resumedAt: null });
        },
      };
    },
  };
  return { asked, bindings: { ...env, CF_ANALYTICS_TOKEN: 'test-analytics-token', DISPATCHER: dispatcher } };
}

test('the watchdog quarantines an object past 5M rows an hour, alerts between 1M and 5M, and spares one just resumed', async () => {
  const resumed = new Date(scheduledTime - 20 * 60_000).toISOString();
  mockCloudflare({ [object('2')]: 7_000_000, [object('1')]: 6_000_000, [object('3')]: 1_500_000, [object('4')]: 900_000 }, { rowsWritten: 5_000_000 });
  const { asked, bindings } = tenantWorker({ [object('2')]: { quarantined: false, resumedAt: resumed } });
  // @ts-expect-error The test dispatcher implements the one method the watchdog uses.
  await worker.scheduled(createScheduledController({ scheduledTime, cron: '*/10 * * * *' }), bindings);

  expect(asked.filter(item => item.action !== 'status')).toEqual([
    expect.objectContaining({ objectId: object('2'), action: 'alert', reason: expect.stringContaining('7,000,000 rows') }),
    expect.objectContaining({ objectId: object('1'), action: 'quarantine', reason: expect.stringContaining('6,000,000 rows') }),
    expect.objectContaining({ objectId: object('3'), action: 'alert', reason: expect.stringContaining('1,500,000 rows') }),
  ]);
});

test('the watchdog alerts on the day\'s top writer once Durable Objects cost $20 today', async () => {
  mockCloudflare({ [object('5')]: 10_000 }, { rowsWritten: 25_000_000 });
  const { asked, bindings } = tenantWorker({});
  // @ts-expect-error The test dispatcher implements the one method the watchdog uses.
  await worker.scheduled(createScheduledController({ scheduledTime, cron: '*/10 * * * *' }), bindings);
  expect(asked).toEqual([expect.objectContaining({ objectId: object('5'), action: 'alert', reason: expect.stringContaining('$25.00 today') })]);

  mockCloudflare({ [object('5')]: 10_000 }, { rowsWritten: 19_000_000 });
  const quiet = tenantWorker({});
  // @ts-expect-error The test dispatcher implements the one method the watchdog uses.
  await worker.scheduled(createScheduledController({ scheduledTime, cron: '*/10 * * * *' }), quiet.bindings);
  expect(quiet.asked).toEqual([]);
});
