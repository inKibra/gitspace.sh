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

/** Cloudflare's API: the account's namespaces, the last hour's writes per object (descending) and today's totals. */
function mockCloudflare(hour: Record<string, number>, today: { rowsWritten: number }) {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/workers/durable_objects/namespaces')) {
      return Response.json({ success: true, result: [{ id: tenantNamespace, class: 'SpaceAuthorityDO', script: `${env.DISPATCH_NAMESPACE}-tenant-${tenant}` }] });
    }
    const body: { query: string } = await request.json();
    const groups = Object.entries(hour).map(([objectId, rowsWritten]) => ({ dimensions: { namespaceId: tenantNamespace, objectId }, sum: { rowsWritten } }));
    if (body.query.includes('StorageWatchdogHour')) return Response.json({ data: { viewer: { accounts: [{ objects: groups }] } } });
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

test('the watchdog reports that it is blind after three runs without analytics', async () => {
  globalThis.fetch = async () => Response.json({ errors: [{ message: 'Rate limiter budget depleted' }] });
  const { emails, run } = platform();
  await run();
  await run(scheduledTime + 10 * 60_000);
  expect(emails).toEqual([]);
  await run(scheduledTime + 20 * 60_000);
  expect(emails).toEqual([expect.objectContaining({ subject: 'GitSpace watchdog is blind', text: expect.stringContaining('Rate limiter budget depleted') })]);
});
