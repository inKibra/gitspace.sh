// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionUsageReport } from '@gitspace/protocol';
import { UsageView } from './UsageView.js';

function totals(requests: number, input: number, costUsd: number): SessionUsageReport['totals'] {
  return { requests, input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, reasoningTokens: 0, costUsd };
}
function reportFixture(): SessionUsageReport {
  return {
    sessionId: 'session-a', totals: totals(1, 100, 0.1), totalsDeep: totals(3, 300, 0.6), childSessions: 2,
    byModel: [{ provider: 'provider', model: 'historical-model', totals: totals(3, 300, 0.6) }],
    byRole: [{ role: 'smol', models: ['historical-model'], totals: totals(1, 100, 0.2) }, { role: null, models: ['historical-model'], totals: totals(2, 200, 0.4) }],
    byAgent: [
      { agentId: 'agent-1', agent: 'scout', selection: 'role', role: 'smol', provider: 'provider', model: 'historical-model', definitionSource: 'project', definitionPath: '.omp/agents/scout.md', definitionRevision: 'recorded-revision', spawns: 1, firstAt: null, lastAt: null, totals: totals(1, 100, 0.2) },
      { agentId: 'agent-2', agent: 'legacy', selection: 'unknown', role: null, provider: 'provider', model: 'historical-model', definitionSource: null, definitionPath: null, definitionRevision: null, spawns: 1, firstAt: null, lastAt: null, totals: totals(1, 100, 0.3) },
    ],
    byCompletion: [{ kind: 'completion', role: null, provider: 'provider', model: 'historical-model', totals: totals(1, 100, 0.1) }], warnings: [],
  };
}
const noop = (): void => undefined;
function rendered(status: 'ready' | 'loading' | 'error', error?: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<UsageView sessionId="session-a" report={reportFixture()} status={status} error={error} onLoad={noop} onRefresh={noop} />);
  return container;
}
function section(container: HTMLElement, title: string): HTMLElement {
  const found = [...container.querySelectorAll('section')].find((node) => node.querySelector('h3')?.textContent === title);
  if (!found) throw new Error(`Missing usage section: ${title}`);
  return found;
}

describe('UsageView', () => {
  it('shows the combined tree while keeping root, child, and direct-call scope distinct', () => {
    const container = rendered('ready');
    const firstCost = container.textContent?.indexOf('$0.60') ?? -1;
    expect(firstCost).toBeGreaterThan(-1);
    expect(firstCost).toBeLessThan(container.textContent!.indexOf('$0.10'));
    const scopes = [...section(container, 'Session scope').querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(scopes[0]).toContain('$0.10');
    expect(scopes[1]).toContain('$0.50');
    const bucket = section(container, 'Token buckets · entire tree').querySelector('tbody tr');
    expect(bucket?.textContent).toContain('300');
    const definitions = section(container, 'By agent definition');
    expect(definitions.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(definitions.textContent).not.toContain('completion');
    expect(section(container, 'Direct model calls').textContent).toContain('$0.10');
  });

  it('keeps historical role and actual model together and does not guess missing provenance', () => {
    const rows = [...section(rendered('ready'), 'By agent definition').querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('Role: smol');
    expect(rows[0]?.textContent).toContain('historical-model');
    expect(rows[0]?.textContent).toContain('.omp/agents/scout.md');
    expect(rows[1]?.textContent).toContain('Not recorded');
    expect(rows[1]?.textContent).not.toContain('default');
  });

  it('retains a loaded report through refresh and exposes its refresh error alongside the figures', () => {
    const loading = rendered('loading');
    expect(section(loading, 'By agent definition').textContent).toContain('historical-model');
    expect(loading.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')?.disabled).toBe(true);
    const failed = rendered('error', 'transcript unreadable');
    expect(section(failed, 'By agent definition').textContent).toContain('historical-model');
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain('transcript unreadable');
    expect(failed.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')?.disabled).toBe(false);
  });
});
