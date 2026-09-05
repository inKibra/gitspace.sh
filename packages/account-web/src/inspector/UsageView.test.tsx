import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionUsageReport } from '@gitspace/protocol';
import { UsageView } from './UsageView.js';

function totals(overrides: Partial<SessionUsageReport['totals']> = {}): SessionUsageReport['totals'] {
  return { requests: 3, input: 12_000, output: 2_500, cacheRead: 40_000, cacheWrite: 1_000, totalTokens: 55_500, reasoningTokens: 400, costUsd: 0.4321, ...overrides };
}
function reportFixture(): SessionUsageReport {
  return {
    sessionId: 'session-a',
    totals: totals(),
    totalsDeep: totals({ requests: 7, totalTokens: 120_000, costUsd: 1.25 }),
    childSessions: 2,
    byModel: [{ provider: 'anthropic', model: 'claude-fable-5-1', totals: totals() }],
    byRole: [{ role: 'default', models: ['claude-fable-5-1'], totals: totals() }],
    byAgent: [{ agentId: 'agent-1', agent: 'scout', selection: 'pinned', model: 'claude-haiku', spawns: 2, firstAt: '2026-09-01T08:00:00.000Z', lastAt: '2026-09-02T09:30:00.000Z', totals: totals({ costUsd: 0.0042, totalTokens: 900 }) }],
    warnings: ['1 child transcript was missing; parent spawn usage was used instead.'],
  };
}
const noop = (): void => undefined;

describe('UsageView', () => {
  it('renders totals, buckets, and every breakdown from a ready report', () => {
    const html = renderToStaticMarkup(<UsageView sessionId="session-a" report={reportFixture()} status="ready" onLoad={noop} onRefresh={noop} />);
    expect(html).toContain('Session usage');
    expect(html).toContain('aria-label="Refresh usage"');
    expect(html).toContain('$0.43');
    expect(html).toContain('$1.25');
    expect(html).toContain('2 sub-sessions');
    expect(html).toContain('Cache read');
    expect(html).toContain('By provider · model');
    expect(html).toContain('claude-fable-5-1');
    expect(html).toContain('By role');
    expect(html).toContain('By subagent');
    expect(html).toContain('pinned');
    expect(html).toContain('$0.0042');
    expect(html).toContain('child transcript was missing');
  });
  it('shows a retry action on error and a load action while idle', () => {
    const error = renderToStaticMarkup(<UsageView sessionId="session-a" report={null} status="error" error="transcript unreadable" onLoad={noop} onRefresh={noop} />);
    expect(error).toContain('transcript unreadable');
    expect(error).toContain('Retry');
    const idle = renderToStaticMarkup(<UsageView sessionId="session-a" report={null} status="idle" onLoad={noop} onRefresh={noop} />);
    expect(idle).toContain('Load usage');
    const none = renderToStaticMarkup(<UsageView sessionId={null} report={null} status="idle" onLoad={noop} onRefresh={noop} />);
    expect(none).toContain('No live session');
    expect(none).not.toContain('Refresh usage');
  });
});
