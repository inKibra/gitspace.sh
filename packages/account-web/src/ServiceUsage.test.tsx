// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceUsageSection } from './ServiceUsage.js';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('lists ghosts\' and decisions\' usage by day, model and workspace, with totals per service', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<ServiceUsageSection status="ready" rows={[
    { day: '2026-11-21', service: 'ghost', model: 'openai/fast', workspaceId: '', requests: 3, input: 30_000, output: 900, costUsd: 0.12 },
    { day: '2026-11-21', service: 'ghost', model: 'openai/fast', workspaceId: 'parser-1a2b', requests: 2, input: 10_000, output: 400, costUsd: 0.05 },
    { day: '2026-11-20', service: 'decision', model: 'cloudflare/clef-flash', workspaceId: '', requests: 40, input: 80_000, output: 40, costUsd: 0.002 },
  ]} />));
  const rows = [...container.querySelectorAll('[data-service-usage]')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
  expect(rows).toEqual([
    ['2026-11-21', 'Ghosts', 'openai/fast', 'You', '3×', '30K / 900', '$0.12'],
    ['2026-11-21', 'Ghosts', 'openai/fast', 'parser-1a2b', '2×', '10K / 400', '$0.05'],
    ['2026-11-20', 'Decisions', 'cloudflare/clef-flash', 'No workspace', '40×', '80K / 40', '$0.0020'],
  ]);
  expect(container.textContent).toContain('$0.17');
});
