// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AgentSetupView, type InspectorAgentSetupState } from './AgentSetupView.js';

it('explains the ignored definition without blocking the winning agent editor', () => {
  const report = {
    sessionId: 'main',
    agents: [{ name: 'reviewer', description: 'Selected reviewer', source: 'workspace', path: '.agents/agents/canonical.md', editable: true, content: 'Canonical persona', revision: 'revision', modelSelectors: [], role: null, provider: null, model: null, selection: 'definition' as const, tools: ['read'], spawns: null }],
    diagnostics: [{ name: 'reviewer', winnerPath: '.agents/agents/canonical.md', ignoredPath: '.omp/agents/legacy.md' }],
  };
  const state: InspectorAgentSetupState = { sessionId: 'main', report, status: 'ready', load() {}, refresh() {}, save: async () => report };
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<AgentSetupView state={state} />);
  const diagnostic = container.querySelector('[role="status"]');
  expect(diagnostic?.textContent).toContain('reviewer');
  expect(diagnostic?.textContent).toContain('.agents/agents/canonical.md');
  expect(diagnostic?.textContent).toContain('.omp/agents/legacy.md');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Agent definition source"]');
  expect(editor?.value).toBe('Canonical persona');
  expect(editor?.readOnly).toBe(false);
});
