// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
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

it('shows unavailable files separately while keeping valid agents selectable and editable', async () => {
  const report = {
    sessionId: 'main',
    agents: [{ name: 'reviewer', description: 'Available reviewer', source: 'workspace', path: '.agents/agents/reviewer.md', editable: true, content: 'Read-only reviewer persona', revision: 'revision', modelSelectors: [], role: null, provider: null, model: null, selection: 'definition' as const, tools: ['read'], spawns: null }],
    definitionErrors: [{ path: '.omp/agents/legacy-writer.md', message: 'Unsupported tool "write": subagents may only use read-only tools.' }],
  };
  const state: InspectorAgentSetupState = { sessionId: 'main', report, status: 'ready', load() {}, refresh() {}, save: async () => report };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AgentSetupView state={state} />));
    const diagnostic = container.querySelector('[role="alert"][aria-label="Unavailable agent definitions"]');
    expect(diagnostic?.textContent).toContain('.omp/agents/legacy-writer.md');
    expect(diagnostic?.textContent).toContain('Unsupported tool "write": subagents may only use read-only tools.');
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Agent definition source"]');
    expect(editor?.value).toBe('Read-only reviewer persona');
    expect(editor?.readOnly).toBe(false);
    expect(editor?.disabled).toBe(false);
    const selector = container.querySelector<HTMLButtonElement>('[aria-label="Agent definition"]');
    expect(selector?.disabled).toBe(false);
    await act(async () => selector!.click());
    expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim())).toEqual(['reviewer']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
    vi.unstubAllGlobals();
  }
});
