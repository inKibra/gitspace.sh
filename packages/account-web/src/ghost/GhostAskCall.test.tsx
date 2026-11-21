// @vitest-environment happy-dom
import type { ToolCallBlock, TurnBlock } from '@gitspace/blocks';
import type { GhostAskResult } from '@gitspace/protocol-runtime';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TurnTranscript } from '../chat/TurnTranscript.js';
import { useGhostRequest } from './ghost-store.js';

let container: HTMLDivElement;
let root: Root;

const answer = (session: Partial<GhostAskResult['session']>): GhostAskResult => ({
  ghostId: '0b7f3c1e-8a52-4d7a-9a3c-2f1e5d6c7b8a', expiresAt: new Date(Date.now() + 600_000).toISOString(),
  session: { workspaceId: 'billing-1a2b', workspace: 'Billing', conversationId: 'main', title: 'Invoices', main: true, archived: false, ...session },
  answer: 'It moved exports to the archive bucket [#12], as the plan says [drive://workspace/plan.md:3-4].',
  cites: [{ kind: 'entry', from: 12, ref: 'history://billing-1a2b/main#12' }, { kind: 'drive', url: 'drive://workspace/plan.md', lines: [3, 4], generation: 7, ref: 'drive://workspaces/billing-1a2b/plan.md:3-4' }],
  reads: [{ kind: 'search', query: 'bucket', hits: 2 }, { kind: 'read', from: 10, to: 14 }], driveAsOf: new Date().toISOString(),
  draft: 'Please move the remaining exports too.', rounds: 2, truncated: false, usage: { model: 'openai/gpt-fast', requests: 3, input: 30_000, output: 900, costUsd: 0.0123 },
});
const call = (result: GhostAskResult | null, status: ToolCallBlock['status'] = 'done', text = JSON.stringify(result)): ToolCallBlock => ({
  id: 'turn:tool:ghost', type: 'tool-call', toolCallId: 'ghost', tool: 'ghost_ask', status, startedAt: '2026-11-21T10:00:00.000Z', endedAt: '2026-11-21T10:00:20.000Z',
  args: { workspaceId: 'billing-1a2b', question: 'Why the archive bucket?' }, result: status === 'running' ? [] : [{ id: 'turn:tool:ghost:result', type: 'code', text }],
});
const read: ToolCallBlock = { id: 'turn:tool:read', type: 'tool-call', toolCallId: 'read', tool: 'read', target: 'notes.md', status: 'done', args: { path: 'notes.md' }, result: [{ id: 'turn:tool:read:result', type: 'code', text: 'notes' }] };

async function render(items: TurnBlock['items']): Promise<void> {
  await act(async () => root.render(<TurnTranscript turns={[{ id: 'turn', type: 'turn', status: 'done', sideAgents: [], items }]} transport={[]} />));
}
const card = () => container.querySelector<HTMLElement>('[data-ghost-ask]');
const chip = (label: string) => container.querySelector<HTMLElement>(`[data-cite="${label}"]`);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/?project=ledger&workspace=parser-9z8y');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows an agent\'s ghost question as its own card: the session, the question and the cited answer, apart from the calls around it', async () => {
  await render([read, call(answer({})), read]);
  const shown = card();
  expect(shown?.closest('[data-tool-group]')).toBeNull();
  expect(container.querySelectorAll('[data-tool-group]')).toHaveLength(2);
  expect(shown?.textContent).toContain('of Billing · Invoices');
  expect(shown?.textContent).toContain('Why the archive bucket?');
  expect(shown?.querySelector('[data-ghost-answer]')?.textContent).toBe('It moved exports to the archive bucket #12, as the plan says plan.md:3–4.');
  expect(shown?.querySelector('[aria-label="Draft"]')?.textContent).toContain('Please move the remaining exports too.');
  expect(shown?.textContent).toContain('searched “bucket” · 2 hits · read transcript 10–14');
});

it('a citation opens the asked workspace at the entry or the drive lines', async () => {
  await render([call(answer({}))]);
  const request = renderHook(() => useGhostRequest('billing-1a2b'));
  await act(async () => chip('#12')?.click());
  expect(new URL(window.location.href).searchParams.get('workspace')).toBe('billing-1a2b');
  expect(new URL(window.location.href).searchParams.get('project')).toBe('ledger');
  request.rerender();
  expect(request.result.current).toMatchObject({ workspaceId: 'billing-1a2b', kind: 'entry', ordinal: 12 * 1024 });
  await act(async () => chip('plan.md:3–4')?.click());
  request.rerender();
  expect(request.result.current).toMatchObject({ kind: 'drive', url: 'drive://workspace/plan.md:3-4' });
  request.unmount();
});

it('names entries of a conversation the workspace view does not show without linking them; drive lines still open', async () => {
  await render([call(answer({ conversationId: 'subagent-7', main: false }))]);
  expect(chip('#12')?.tagName).toBe('SPAN');
  expect(chip('plan.md:3–4')?.tagName).toBe('BUTTON');
});

it('says when the ghost is still reading, and why a call failed', async () => {
  await render([call(null, 'running')]);
  expect(card()?.querySelector('[role="status"]')?.textContent).toContain('reading');
  await render([call(null, 'error', 'That ghost has faded; ask without ghostId to start a new one.')]);
  expect(card()?.querySelector('[role="alert"]')?.textContent).toBe('That ghost has faded; ask without ghostId to start a new one.');
});
