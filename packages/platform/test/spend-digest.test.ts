import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
beforeEach(() => env.RELEASES.delete('storage-watchdog/state.json'));
afterEach(() => { globalThis.fetch = originalFetch; });

const spaces = 'a'.repeat(32);
const cells = 'b'.repeat(32);
const HOUR_MICROS = 3_600_000_000;

/** Cloudflare's API with today's usage: GitSpace workspaces wrote 1M rows, a preview worker read 1B rows. Records the
 * windows the digest asked for. */
function mockCloudflare() {
  const windows: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/workers/durable_objects/namespaces')) {
      return Response.json({ success: true, result: [
        { id: spaces, class: 'SpaceAuthorityDO', script: 'gitspace-tenant-acme' },
        { id: cells, class: 'WorkflowCell', script: 'preview-cells' },
      ] });
    }
    const body: { query: string; variables: { start: string } } = await request.json();
    const account = (data: object) => Response.json({ data: { viewer: { accounts: [data] } } });
    if (body.query.includes('StorageWatchdogHour')) return account({ objects: [], alarms: [] });
    if (body.query.includes('StorageWatchdogDay')) return account({ periodic: [], invocations: [], top: [] });
    if (body.query.includes('StorageWatchdogAwake')) return account({ awake: [], reading: [] });
    windows.push(body.variables.start);
    const usage = { [spaces]: { activeTime: 2 * HOUR_MICROS, rowsRead: 0, rowsWritten: 1_000_000 }, [cells]: { activeTime: 0, rowsRead: 1_000_000_000, rowsWritten: 0 } };
    if (body.query.includes('periodic:')) return account({ periodic: Object.entries(usage).map(([namespaceId, sum]) => ({ dimensions: { namespaceId }, sum })) });
    if (body.query.includes('invocations:')) return account({ invocations: [{ dimensions: { namespaceId: spaces }, sum: { requests: 1_000_000 } }] });
    if (body.query.includes('hours:')) return account({ hours: [{ dimensions: { datetimeHour: '2026-10-20T14:00:00Z' }, sum: usage[spaces] }] });
    if (body.query.includes('objects:')) return account({ objects: [{ dimensions: { namespaceId: spaces, objectId: 'c'.repeat(64) }, sum: usage[spaces] }] });
    return account({ workers: [{ dimensions: { scriptName: 'gitspace-tenant-acme' }, sum: { requests: 1_000_000, cpuTimeUs: 0 } }] });
  };
  return windows;
}

async function runAt(at: string) {
  const emails: Array<{ subject: string; text: string }> = [];
  const bindings = { ...env, CF_ANALYTICS_TOKEN: 'test-analytics-token', WATCHDOG_EMAIL: { async send(message: { subject: string; text?: string }) { emails.push({ subject: message.subject, text: message.text ?? '' }); return { messageId: '1' }; } } };
  // @ts-expect-error The test mailbox implements the one method the digest uses.
  await worker.scheduled(createScheduledController({ scheduledTime: Date.parse(at), cron: '*/10 * * * *' }), bindings);
  return emails;
}

test('the digest goes out at 8, 13 and 18 local time, in summer and winter time, and covers the local day so far', async () => {
  const windows = mockCloudflare();
  expect(await runAt('2026-10-20T15:00:00Z')).toHaveLength(1);
  expect(windows[0]).toBe('2026-10-20T07:00:00.000Z');
  expect(await runAt('2026-10-20T15:10:00Z')).toEqual([]);
  expect(await runAt('2026-10-20T16:00:00Z')).toEqual([]);
  expect(await runAt('2026-10-21T01:00:00Z')).toHaveLength(1);
  // Winter time: 8:00 local is 16:00 UTC.
  expect(await runAt('2026-11-10T15:00:00Z')).toEqual([]);
  expect(await runAt('2026-11-10T16:00:00Z')).toHaveLength(1);
});

test('the digest breaks today\'s spend down by worker and class', async () => {
  mockCloudflare();
  const [email] = await runAt('2026-10-20T20:00:00Z');
  // GitSpace: 1M rows written ($1.00) + 2 awake hours ($0.01) + 1M requests ($0.15); previews: 1B rows read ($1.00);
  // Workers: 1M requests ($0.30). 13:00 local is 13 hours into the day.
  expect(email?.subject).toBe('Cloudflare spend today: $2.46 so far (pace $4.54/day)');
  expect(email?.text).toContain('\n  $1.16  gitspace-tenant-acme\n');
  expect(email?.text).toContain('$1.16  SpaceAuthorityDO (writes $1.00, reads $0.00, awake $0.01)');
  expect(email?.text).toContain('\n  $1.00  preview-cells\n');
  expect(email?.text).toContain('gitspace-tenant-acme SpaceAuthorityDO cccccccccccc (1.00M rows written)');
});
