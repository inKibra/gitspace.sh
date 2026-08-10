/** @jsxImportSource react */
/**
 * ErrorBoundary "Report a problem" from a crashed render (docs/REPORT-A-PROBLEM.md).
 *
 * A render throw must (a) fall back to the recovery panel, (b) show a Report
 * button placed BEFORE Reload, and (c) on click submit a bundle that carries
 * the crash's react entry from the diagnostics ring — captured BEFORE any
 * reload could wipe it. The report transport is mocked so nothing leaves the
 * process; we assert on what the boundary handed it.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { getDiagnosticsRing } from '../../lib/client-diagnostics.web.js';

// Captured calls to the resilient transport (the boundary's report path).
interface SubmitParams { note: string; clientBundle: unknown; report?: unknown; relayHttpBase?: string | null }
const submitCalls: SubmitParams[] = [];
const submitProblemReport = mock(async (params: SubmitParams) => {
  submitCalls.push(params);
  return { via: 'local' as const, filename: 'gitspace-report-test.json' };
});

// Mirror the REAL report-client wiring: reportFromBrokenState builds the bundle
// from the (unmocked) diagnostics ring and calls submitProblemReport with NO
// backend RPC. Mocking here is the only way to intercept that internal call.
mock.module('../../lib/report-client.web.js', () => ({
  submitProblemReport,
  buildBrokenStateBundle: () => ({ brokenState: true, ring: getDiagnosticsRing() }),
  reportFromBrokenState: (note: string, opts: { relayHttpBase?: string | null; projectName?: string }) =>
    submitProblemReport({
      note,
      clientBundle: { brokenState: true, ring: getDiagnosticsRing() },
      report: undefined,
      relayHttpBase: opts.relayHttpBase ?? null,
    }),
}));

// Keep analytics inert (its dynamic import in componentDidCatch shouldn't pull
// PostHog into the test process).
mock.module('../../lib/analytics.web.js', () => ({
  captureException: () => {},
  getSessionContext: () => null,
  initAnalytics: async () => {},
}));

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

function Boom(): React.ReactElement {
  throw new Error('kaboom-render');
}

describe('ErrorBoundary report-a-problem', () => {
  it('falls back on a render throw, offers Report before Reload, and submits the crash bundle', async () => {
    submitCalls.length = 0;
    const { ErrorBoundary } = await import('../ErrorBoundary.web.js');

    const view = render(
      <ErrorBoundary surface="app">
        <Boom />
      </ErrorBoundary>,
    );

    // (a) fallback rendered instead of a blank tree
    expect(view.container.textContent).toContain('stopped rendering');
    expect(view.container.textContent).toContain('kaboom-render');

    // (b) Report button present and ordered BEFORE Reload. (happy-dom's
    // querySelectorAll is unreliable here, so filter tags manually.)
    const buttons = Array.from(view.container.getElementsByTagName('button')) as HTMLButtonElement[];
    const reportBtn = buttons.find((b) => b.getAttribute('data-testid') === 'eb-report-button')!;
    expect(reportBtn).toBeDefined();
    expect(reportBtn.textContent).toContain('Report a problem');
    const reloadBtn = buttons.find((b) => b.textContent?.trim() === 'Reload');
    expect(reloadBtn).toBeDefined();
    // Report precedes Reload in document order (getElementsByTagName is ordered).
    expect(buttons.indexOf(reportBtn)).toBeLessThan(buttons.indexOf(reloadBtn!));

    // (c) clicking submits a bundle that contains the ring's react entry
    await act(async () => {
      fireEvent.click(reportBtn);
      await Promise.resolve();
    });

    expect(submitCalls.length).toBe(1);
    const bundle = submitCalls[0]!.clientBundle as { ring: Array<{ kind: string; message: string }> };
    const reactEntry = bundle.ring.find((e) => e.kind === 'react');
    expect(reactEntry).toBeDefined();
    expect(reactEntry!.message).toBe('kaboom-render');
    // No backend RPC on this broken screen — relay/local only.
    expect(submitCalls[0]!.report).toBeUndefined();

    // Outcome surfaced inline (no reload needed).
    await act(async () => { await Promise.resolve(); });
    expect(view.container.textContent).toContain('Report downloaded');

    view.unmount();
  });

  it('pane variant isolates the crash: siblings keep rendering, and Retry recovers', async () => {
    // Dynamic (as above): the report transport must be mocked before the
    // boundary module binds it, and a static import would hoist past mock.module.
    const { ErrorBoundary } = await import('../ErrorBoundary.web.js');

    // Two sibling panes, each with its own boundary — the DockPanel shape.
    // Before per-pane boundaries the nearest boundary was the app root, so one
    // bad pane replaced the whole workspace (terminals and agent sessions with
    // it). This is the property that must hold.
    let explode = true;
    function Flaky(): React.ReactElement {
      if (explode) throw new Error('pane-kaboom');
      return <div>guide recovered</div>;
    }

    const view = render(
      <div>
        <ErrorBoundary surface="pane:guide" variant="pane"><Flaky /></ErrorBoundary>
        <ErrorBoundary surface="pane:terminal" variant="pane"><div>terminal alive</div></ErrorBoundary>
      </div>,
    );

    // The sibling survived — the whole point.
    expect(view.container.textContent).toContain('terminal alive');
    // The dead pane names itself and does NOT claim the app stopped.
    expect(view.container.textContent).toContain('pane:guide');
    expect(view.container.textContent).toContain('pane-kaboom');
    expect(view.container.textContent).not.toContain('stopped rendering');

    // Retry, not Reload: a reload would cost every other pane.
    expect(view.queryByTestId('eb-reload-button')).toBeNull();
    const retry = view.getByTestId('eb-retry-button');

    explode = false;
    await act(async () => { fireEvent.click(retry); });
    expect(view.container.textContent).toContain('guide recovered');
    expect(view.container.textContent).toContain('terminal alive');
  });

  it('page variant still owns the viewport and offers Reload', async () => {
    const { ErrorBoundary } = await import('../ErrorBoundary.web.js');

    const view = render(<ErrorBoundary surface="app"><Boom /></ErrorBoundary>);

    expect(view.container.textContent).toContain('stopped rendering');
    expect(view.queryByTestId('eb-retry-button')).toBeNull();
    expect(view.getByTestId('eb-reload-button')).toBeDefined();
  });
});
