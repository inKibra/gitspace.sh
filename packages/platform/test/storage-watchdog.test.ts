import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
beforeEach(() => env.RELEASES.delete('storage-watchdog/state.json'));
afterEach(() => { globalThis.fetch = originalFetch; });

const tenant = 'acme';
const tenantNamespace = 'a'.repeat(32);
const scheduledTime = Date.parse('2026-10-14T02:20:00Z');
const HOUR = 3_600_000;
const object = (letter: string) => letter.repeat(64);

/** Cloudflare's API: the account's namespaces, the last hour's writes per object (descending), today's totals, and the
 * last 24 hours of each object's waking and reading. */
function mockCloudflare(hour: Record<string, number>, today: { rowsWritten: number }, lastDay: Record<string, { activeHours: number; rowsRead: number }> = {}) {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/workers/durable_objects/namespaces')) {
      return Response.json({ success: true, result: [{ id: tenantNamespace, class: 'SpaceAuthorityDO', script: `${env.DISPATCH_NAMESPACE}-tenant-${tenant}` }] });
    }
    const body: { query: string } = await request.json();
    const groups = Object.entries(hour).map(([objectId, rowsWritten]) => ({ dimensions: { namespaceId: tenantNamespace, objectId }, sum: { rowsWritten } }));
    if (body.query.includes('StorageWatchdogHour')) return Response.json({ data: { viewer: { accounts: [{ objects: groups }] } } });
    if (body.query.includes('StorageWatchdogAwake')) {
      const objects = Object.entries(lastDay).map(([objectId, usage]) => ({ dimensions: { namespaceId: tenantNamespace, objectId }, sum: { activeTime: usage.activeHours * HOUR * 1000, rowsRead: usage.rowsRead } }));
      return Response.json({ data: { viewer: { accounts: [{
        awake: objects.toSorted((a, b) => b.sum.activeTime - a.sum.activeTime),
        reading: objects.toSorted((a, b) => b.sum.rowsRead - a.sum.rowsRead),
      }] } } });
    }
    return Response.json({ data: { viewer: { accounts: [{
      periodic: [{ sum: { activeTime: 0, rowsRead: 0, rowsWritten: today.rowsWritten } }],
      invocations: [{ sum: { requests: 0 } }],
      top: groups.slice(0, 1),
    }] } } });
  };
}

/** The tenant's worker (its storage route keeps each object's breaker state) and the watchdog's mailbox. */
function platform(statuses: Record<string, { quarantined: boolean; resumedAt: string | null }> = {}) {
  const asked: Array<{ objectId: string; action: string; reason?: string }> = [];
  const emails: Array<{ subject: string; text: string }> = [];
  const dispatcher = {
    get(script: string) {
      expect(script).toBe(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`);
      return {
        async fetch(request: Request) {
          expect(new URL(request.url).pathname).toBe('/__platform/storage');
          expect(request.headers.get('authorization')).toBe(`Bearer ${await env.DEPLOYMENTS.getByName(tenant).providerToken()}`);
          const body: { objectId: string; action: string; reason?: string } = await request.json();
          asked.push(body);
          const status = statuses[body.objectId] ??= { quarantined: false, resumedAt: null };
          if (body.action === 'quarantine') status.quarantined = true;
          return Response.json(status);
        },
      };
    },
  };
  const mailbox = { async send(message: { subject: string; text?: string }) { emails.push({ subject: message.subject, text: message.text ?? '' }); return { messageId: String(emails.length) }; } };
  const bindings = { ...env, CF_ANALYTICS_TOKEN: 'test-analytics-token', DISPATCHER: dispatcher, WATCHDOG_EMAIL: mailbox };
  const run = async (at = scheduledTime) => {
    // @ts-expect-error The test dispatcher and mailbox implement the methods the watchdog uses.
    await worker.scheduled(createScheduledController({ scheduledTime: at, cron: '*/10 * * * *' }), bindings);
  };
  return { asked, emails, run };
}

test('the watchdog pauses an object past 5M rows an hour, reports one between 1M and 5M, and spares one just resumed', async () => {
  mockCloudflare({ [object('2')]: 7_000_000, [object('1')]: 6_000_000, [object('3')]: 1_500_000, [object('4')]: 900_000 }, { rowsWritten: 5_000_000 });
  const { asked, emails, run } = platform({ [object('2')]: { quarantined: false, resumedAt: new Date(scheduledTime - 20 * 60_000).toISOString() } });
  await run();

  expect(asked.filter(item => item.action !== 'status')).toEqual([
    expect.objectContaining({ objectId: object('1'), action: 'quarantine', reason: expect.stringContaining('6,000,000 rows') }),
    expect.objectContaining({ objectId: object('2'), action: 'alert', reason: expect.stringContaining('7,000,000 rows') }),
    expect.objectContaining({ objectId: object('3'), action: 'alert', reason: expect.stringContaining('1,500,000 rows') }),
  ]);
  expect(emails).toHaveLength(1);
  expect(emails[0]?.subject).toBe('GitSpace watchdog paused 1 Durable Object');
  expect(emails[0]?.text).toMatch(/PAUSED SpaceAuthorityDO 111111111111… \(GitSpace tenant acme\): wrote 6,000,000 rows/u);
  expect(emails[0]?.text).toContain('wrote 1,500,000 rows');
  expect(emails[0]?.text).not.toContain('900,000');
});

test('a problem is reported once, and again only if it still holds six hours later', async () => {
  mockCloudflare({ [object('3')]: 1_500_000 }, { rowsWritten: 0 });
  const { asked, emails, run } = platform();
  await run();
  await run(scheduledTime + 10 * 60_000);
  expect(emails).toHaveLength(1);
  expect(asked.filter(item => item.action === 'alert')).toHaveLength(1);

  await run(scheduledTime + 6 * HOUR);
  expect(emails).toHaveLength(2);
  expect(asked.filter(item => item.action === 'alert')).toHaveLength(2);
});

test('the watchdog reports the day\'s top writer once Durable Objects cost $20 today', async () => {
  mockCloudflare({ [object('5')]: 10_000 }, { rowsWritten: 25_000_000 });
  const costly = platform();
  await costly.run();
  expect(costly.emails).toEqual([expect.objectContaining({ text: expect.stringContaining('cost about $25.00 today') })]);
  expect(costly.asked).toEqual([expect.objectContaining({ objectId: object('5'), action: 'alert' })]);

  await env.RELEASES.delete('storage-watchdog/state.json');
  mockCloudflare({ [object('5')]: 10_000 }, { rowsWritten: 19_000_000 });
  const quiet = platform();
  await quiet.run();
  expect(quiet.emails).toEqual([]);
  expect(quiet.asked).toEqual([]);
});

test('the watchdog reports an object awake 20 of the last 24 hours, or reading 20M rows in them, to its tenant once', async () => {
  mockCloudflare({}, { rowsWritten: 0 }, {
    [object('6')]: { activeHours: 22.9, rowsRead: 25_000_000 },
    [object('7')]: { activeHours: 1.3, rowsRead: 21_000_000 },
    [object('8')]: { activeHours: 19.9, rowsRead: 19_000_000 },
  });
  const { asked, emails, run } = platform();
  await run();
  expect(asked).toEqual([
    { objectId: object('6'), className: 'SpaceAuthorityDO', action: 'alert', reason: expect.stringContaining('awake 22.9 of the last 24 hours and read 25,000,000 rows') },
    { objectId: object('7'), className: 'SpaceAuthorityDO', action: 'alert', reason: expect.stringContaining('awake 1.3 of the last 24 hours and read 21,000,000 rows') },
  ]);
  expect(emails).toEqual([expect.objectContaining({ subject: 'GitSpace watchdog: 2 Durable Object alerts' })]);
  await run(scheduledTime + 10 * 60_000);
  expect(emails).toHaveLength(1);
});

test('the watchdog reports that it is blind after three runs without analytics', async () => {
  globalThis.fetch = async () => Response.json({ errors: [{ message: 'Rate limiter budget depleted' }] });
  const { emails, run } = platform();
  await run();
  await run(scheduledTime + 10 * 60_000);
  expect(emails).toEqual([]);
  await run(scheduledTime + 20 * 60_000);
  expect(emails).toEqual([expect.objectContaining({ subject: 'GitSpace watchdog is blind', text: expect.stringContaining('Rate limiter budget depleted') })]);
});
