/**
 * report-client.web resilient fallbacks (docs/REPORT-A-PROBLEM.md).
 *
 * The whole point of "report a problem" is that it survives a broken app: no
 * backend RPC, a dead relay, and it STILL lands the report locally so the
 * crash evidence isn't lost. Also verifies the broken-state bundle carries the
 * diagnostics ring (where ErrorBoundary parks the react crash entry).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { pushDiagnostic } from '../client-diagnostics.web.js';
import { buildBrokenStateBundle, reportFromBrokenState, submitProblemReport } from '../report-client.web.js';

// saveLocally() needs URL.createObjectURL — happy-dom may not implement it, so
// stub the blob-URL round-trip (and count downloads) without a real browser.
let downloads = 0;
const realCreate = (globalThis.URL as { createObjectURL?: unknown }).createObjectURL;
const realRevoke = (globalThis.URL as { revokeObjectURL?: unknown }).revokeObjectURL;

beforeAll(() => {
  setupTestDom();
  (globalThis.URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => {
    downloads++;
    return 'blob:mock';
  };
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

afterAll(() => {
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreate;
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = realRevoke;
  teardownTestDom();
});

afterEach(() => { downloads = 0; });

describe('buildBrokenStateBundle', () => {
  it('captures the diagnostics ring (including the react crash entry)', () => {
    pushDiagnostic({ kind: 'react', message: 'boom-in-render', detail: 'stack…', source: 'app' });
    const bundle = buildBrokenStateBundle() as { brokenState: boolean; ring: Array<{ kind: string; message: string }> };
    expect(bundle.brokenState).toBe(true);
    expect(bundle.ring.some((e) => e.kind === 'react' && e.message === 'boom-in-render')).toBe(true);
  });
});

describe('submitProblemReport last-resort local fallback', () => {
  it('downloads locally when there is no backend RPC and no relay', async () => {
    const outcome = await submitProblemReport({
      note: 'the app went blank',
      clientBundle: { ring: [] },
      opts: { fileIssue: true },
      report: undefined,
      relayHttpBase: null,
    });
    expect(outcome.via).toBe('local');
    if (outcome.via === 'local') expect(outcome.filename).toMatch(/^gitspace-report-.*\.json$/);
    expect(downloads).toBe(1);
  });

  it('falls through relay failure to a local download (never loses the report)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('relay unreachable'); }) as typeof fetch;
    try {
      const outcome = await reportFromBrokenState('connection failed', {
        relayHttpBase: 'http://127.0.0.1:9/relay',
        projectName: 'demo',
      });
      expect(outcome.via).toBe('local');
      expect(downloads).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
