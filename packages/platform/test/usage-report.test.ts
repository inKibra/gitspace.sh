import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { usageReportSchema } from '../src/usage-report.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const script = 'usage-test-tenant';
const loopNamespace = 'a'.repeat(32);
const quietNamespace = 'b'.repeat(32);
const otherScriptNamespace = 'c'.repeat(32);
const growthNamespace = 'd'.repeat(32);
const HOUR_MICROS = 3_600_000_000;

interface HourUsage { requests: number; rowsWritten: number; activeHours: number }
/** Namespace id -> `datetimeHour` -> usage. */
type Usage = Record<string, Record<string, HourUsage>>;

function day(date: string, usage: (hour: number) => HourUsage): Record<string, HourUsage> {
  return Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [`${date}T${String(hour).padStart(2, '0')}:00:00Z`, usage(hour)]));
}

/** Cloudflare API stand-in: namespace listing plus both GraphQL usage queries, keyed by the queried window start. */
function mockCloudflare(byWindowStart: Record<string, Usage>): string[] {
  const queried: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === `/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/durable_objects/namespaces`) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${env.CF_API_TOKEN}`);
      return Response.json({
        success: true,
        result: [
          { id: loopNamespace, class: 'LoopDO', script },
          { id: quietNamespace, class: 'QuietDO', script },
          { id: growthNamespace, class: 'GrowthDO', script },
          { id: otherScriptNamespace, class: 'OtherDO', script: 'someone-else' },
        ],
        result_info: { page: 1, total_pages: 1 },
      });
    }
    expect(url.pathname).toBe('/client/v4/graphql');
    expect(request.headers.get('authorization')).toBe('Bearer test-analytics-token');
    const body: { query: string; variables: { script?: string; namespaceIds?: string[]; start: string } } = await request.json();
    const usage = byWindowStart[body.variables.start] ?? {};
    const groups = (ids: string[]) => ids.flatMap((id) => Object.entries(usage[id] ?? {}).map(([hour, value]) => ({ id, hour, value })));
    if (body.query.includes('durableObjectsPeriodicGroups')) {
      // Periodic data has no script dimension; only the script's namespaces may be requested.
      expect(body.variables.namespaceIds?.sort()).toEqual([loopNamespace, quietNamespace, growthNamespace].sort());
      return Response.json({
        data: { viewer: { accounts: [{
          periodic: groups(body.variables.namespaceIds ?? []).map(({ id, hour, value }) => ({
            dimensions: { namespaceId: id, datetimeHour: hour },
            sum: { activeTime: value.activeHours * HOUR_MICROS, rowsRead: 10, rowsWritten: value.rowsWritten },
          })),
        }] } },
        errors: null,
      });
    }
    expect(body.variables.script).toBe(script);
    queried.push(body.variables.start);
    return Response.json({
      data: { viewer: { accounts: [{
        workers: [{ sum: { requests: 100, errors: 1, cpuTimeUs: 2_000_000, wallTime: 3_000_000, duration: 0.5 } }],
        objects: groups(Object.keys(usage).filter((id) => id !== otherScriptNamespace)).map(({ id, hour, value }) => ({
          dimensions: { namespaceId: id, datetimeHour: hour }, sum: { requests: value.requests, errors: 0 },
        })),
        storage: Object.keys(usage).map((id) => ({ dimensions: { namespaceId: id }, max: { storedBytes: 4096 } })),
      }] } },
      errors: null,
    });
  };
  return queried;
}

function logged(spy: { mock: { calls: unknown[][] } }, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call): unknown => JSON.parse(String(call[0])))
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event);
}

describe('daily usage report cron', () => {
  const scheduledTime = Date.parse('2026-10-14T00:15:00Z');
  const bindings: Env = { ...env, CF_ANALYTICS_TOKEN: 'test-analytics-token' };

  it('logs and returns without querying when the analytics token is missing', async () => {
    const fetched = vi.fn(originalFetch);
    globalThis.fetch = fetched;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.scheduled(createScheduledController({ scheduledTime, cron: '15 0 * * *' }), { ...env, CF_ANALYTICS_TOKEN: '' });
    expect(fetched).not.toHaveBeenCalled();
    expect(logged(errors, 'usage-report-unconfigured')).toHaveLength(1);
  });

  it('stores the previous UTC day and flags spiked hours and >5x days above their floors', async () => {
    const queried = mockCloudflare({
      '2026-10-13T00:00:00.000Z': {
        // A normal day (x3 overall) except one write burst at 02:00 and one request burst at 05:00.
        [loopNamespace]: day('2026-10-13', (hour) => ({
          requests: hour === 5 ? 5_000 : 100, rowsWritten: hour === 2 ? 50_000 : 1_000, activeHours: 0.01,
        })),
        // x90 the hourly mean at 03:00, but below the 1,000 rows/h floor.
        [quietNamespace]: day('2026-10-13', (hour) => ({ requests: 10, rowsWritten: hour === 3 ? 900 : 10, activeHours: 0.001 })),
        // x5.2 for the whole day.
        [growthNamespace]: day('2026-10-13', () => ({ requests: 50, rowsWritten: 2_600, activeHours: 0.001 })),
        [otherScriptNamespace]: day('2026-10-13', () => ({ requests: 0, rowsWritten: 9_000_000, activeHours: 1 })),
      },
      '2026-10-12T00:00:00.000Z': {
        [loopNamespace]: day('2026-10-12', () => ({ requests: 100, rowsWritten: 1_000, activeHours: 0.01 })),
        [quietNamespace]: day('2026-10-12', () => ({ requests: 10, rowsWritten: 10, activeHours: 0.001 })),
        [growthNamespace]: day('2026-10-12', () => ({ requests: 50, rowsWritten: 500, activeHours: 0.001 })),
      },
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(createScheduledController({ scheduledTime, cron: '15 0 * * *' }), bindings);

    // No stored report for 2026-10-12, so that day is queried as the baseline.
    expect(queried.sort()).toEqual(['2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z']);
    expect(logged(errors, 'usage-report-failed')).toEqual([]);
    const stored: unknown = await (await env.RELEASES.get(`usage-reports/${script}/2026-10-13.json`))?.json();
    const report = usageReportSchema.parse(stored);
    expect(report.window).toEqual({ start: '2026-10-13T00:00:00.000Z', end: '2026-10-14T00:00:00.000Z' });
    expect(report.worker).toEqual({ requests: 100, errors: 1, cpuSeconds: 2, wallSeconds: 3, durationGbSeconds: 0.5 });
    // The other script's namespace is excluded.
    expect(report.namespaces.map((namespace) => namespace.className)).toEqual(['LoopDO', 'GrowthDO', 'QuietDO']);
    expect(report.namespaces[0]).toMatchObject({ namespaceId: loopNamespace, requests: 7_300, rowsRead: 240, rowsWritten: 73_000, storedBytes: 4096 });
    expect(report.namespaces[0]!.hourly).toHaveLength(24);
    expect(report.namespaces[0]!.hourly[2]).toMatchObject({ hour: '2026-10-13T02:00:00Z', requests: 100, rowsWritten: 50_000 });

    expect(logged(logs, 'usage-report')).toHaveLength(1);
    const spikes = logged(errors, 'usage-report-spike');
    expect(stored).toMatchObject({ spikes: spikes.map(({ event: _event, date: _date, ...spike }) => spike) });
    expect(spikes.map((spike) => spike.subject)).toEqual(['worker', 'LoopDO', 'GrowthDO']);
    const [workerSpike, loopSpike, growthSpike] = spikes;
    expect(workerSpike).toMatchObject({
      daily: [],
      hours: [{ hour: '2026-10-13T02:00:00Z', metric: 'rowsWritten' }, { hour: '2026-10-13T05:00:00Z', metric: 'requests' }],
    });
    expect(loopSpike).toMatchObject({
      namespaceId: loopNamespace,
      daily: [],
      hours: [
        { hour: '2026-10-13T02:00:00Z', metric: 'rowsWritten', value: 50_000, previousHourlyMean: 1_000, floor: 1_000, ratio: 50 },
        { hour: '2026-10-13T05:00:00Z', metric: 'requests', value: 5_000, previousHourlyMean: 100, floor: 1_000, ratio: 50 },
      ],
    });
    expect(growthSpike).toMatchObject({ daily: [{ metric: 'rowsWritten', previous: 12_000, current: 62_400, floor: 10_000 }] });
    expect(growthSpike!.hours).toHaveLength(24);
  });

  it('uses the stored previous-day report as the baseline instead of querying it again', async () => {
    const baseline = {
      script,
      window: { start: '2026-10-13T00:00:00.000Z', end: '2026-10-14T00:00:00.000Z' },
      worker: { requests: 0, errors: 0, cpuSeconds: 0, wallSeconds: 0, durationGbSeconds: 0 },
      namespaces: [{ namespaceId: loopNamespace, className: 'LoopDO', requests: 2_400, errors: 0, rowsRead: 0, rowsWritten: 100_000, activeHours: 1, storedBytes: null, hourly: [] }],
    };
    await env.RELEASES.put(`usage-reports/${script}/2026-10-13.json`, JSON.stringify(baseline));
    const queried = mockCloudflare({
      '2026-10-14T00:00:00.000Z': { [loopNamespace]: day('2026-10-14', () => ({ requests: 100, rowsWritten: 16_000, activeHours: 0.16 })) },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse('2026-10-15T00:15:00Z'), cron: '15 0 * * *' }), bindings);

    expect(queried).toEqual(['2026-10-14T00:00:00.000Z']);
    // About 4x the stored baseline, daily and per hour: high but not a spike.
    expect(logged(errors, 'usage-report-failed')).toEqual([]);
    expect(logged(errors, 'usage-report-spike')).toEqual([]);
    expect(await env.RELEASES.head(`usage-reports/${script}/2026-10-14.json`)).not.toBeNull();
  });
});
