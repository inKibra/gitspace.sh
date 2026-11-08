// @vitest-environment happy-dom
import type { ToolCallBlock, TurnBlock } from '@gitspace/blocks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TurnTranscript } from './TurnTranscript.js';

let container: HTMLDivElement;
let root: Root;

const read: ToolCallBlock = {
  id: 'turn:tool:read', type: 'tool-call', toolCallId: 'read', tool: 'bash', target: 'ls notes', status: 'done',
  startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:02.000Z',
  args: { command: 'ls notes' }, result: [{ id: 'turn:tool:read:result', type: 'code', text: 'alpha.txt\nbeta.txt\nerror: gamma.txt unreadable' }],
};
const edit: ToolCallBlock = {
  id: 'turn:tool:edit', type: 'tool-call', toolCallId: 'edit', tool: 'edit', target: 'src/greeting.ts', status: 'done',
  startedAt: '2026-01-01T10:00:02.000Z', endedAt: '2026-01-01T10:00:05.000Z',
  args: { path: 'src/greeting.ts', edits: [{ oldText: 'const hello = "hi";\nexport { hello };', newText: 'const hello = "hello";\nexport { hello };' }] },
  result: [{ id: 'turn:tool:edit:result', type: 'code', text: 'Edited src/greeting.ts' }],
};
const failed: ToolCallBlock = {
  id: 'turn:tool:fetch', type: 'tool-call', toolCallId: 'fetch', tool: 'fetch', target: 'https://example.test', status: 'error',
  startedAt: '2026-01-01T10:01:00.000Z', endedAt: '2026-01-01T10:01:01.000Z', result: [{ id: 'turn:tool:fetch:result', type: 'code', text: 'connection refused' }],
};

function turn(items: TurnBlock['items']): TurnBlock[] {
  return [{ id: 'turn', type: 'turn', status: 'done', sideAgents: [], items }];
}

async function render(turns: TurnBlock[]): Promise<void> {
  await act(async () => root.render(<TurnTranscript turns={turns} transport={[]} />));
}

function groups(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-tool-group]')];
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Missing element to click');
  await act(async () => element.click());
}

function tab(label: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.includes(label));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('draws consecutive calls of a turn as one closed group with their count, total time, tools and edited files', async () => {
  await render(turn([read, edit]));
  expect(groups()).toHaveLength(1);
  const header = groups()[0]!.querySelector('button[aria-expanded]')!;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(header.textContent).toContain('2 tool calls');
  expect(header.querySelector('[data-group-duration]')?.textContent).toBe('5.0 s');
  expect(header.textContent).toContain('bash');
  expect(header.textContent).toContain('edit');
  expect(container.querySelector('[data-edited-file="src/greeting.ts"]')?.textContent).toBe('greeting.ts+1 −1');
  expect(container.querySelector('[data-call]')).toBeNull();
});

it('lists each call of an open group with its duration', async () => {
  await render(turn([read, edit]));
  await click(groups()[0]!.querySelector('button[aria-expanded]'));
  const rows = [...container.querySelectorAll<HTMLElement>('[data-call]')];
  expect(rows.map((row) => row.dataset.call)).toEqual([read.id, edit.id]);
  expect(rows.map((row) => row.querySelector('[data-call-took]')?.textContent)).toEqual(['2.0 s', '3.0 s']);
  expect(rows[0]!.textContent).toContain('ls notes');
});

it('draws each call from its start to its end on the group\'s axis, a running call reaching now and growing with it', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    // Overlapping: `make` starts before `ls` ends; `tidy` is still running at 10:00:10.
    const ls: ToolCallBlock = { ...read, startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:02.000Z' };
    const make: ToolCallBlock = { ...read, id: 'turn:tool:make', toolCallId: 'make', target: 'make', startedAt: '2026-01-01T10:00:01.000Z', endedAt: '2026-01-01T10:00:06.000Z' };
    const tidy: ToolCallBlock = { ...read, id: 'turn:tool:tidy', toolCallId: 'tidy', target: 'tidy', status: 'running', startedAt: '2026-01-01T10:00:04.000Z', endedAt: undefined, result: [] };
    vi.setSystemTime(new Date('2026-01-01T10:00:10.000Z'));
    await render(turn([ls, make, tidy]));
    const group = groups()[0]!;
    await click(group.querySelector('button[aria-expanded]'));
    // The closed-group waterfall is 112 wide; open rows place bars by percentages of the shared axis.
    const bars = () => ({
      mini: [...group.querySelectorAll('svg [data-call-bar]')].map((bar) => [Number(bar.getAttribute('x')), Number(bar.getAttribute('width'))].map((value) => Math.round(value * 10) / 10)),
      rows: [...group.querySelectorAll<HTMLElement>('li [data-call-bar]')].map((bar) => [bar.style.left, bar.style.width].map((value) => Math.round(Number.parseFloat(value)))),
    });
    // 10 s of axis: 11.2 per second, 10% per second.
    expect(bars()).toEqual({ mini: [[0, 22.4], [11.2, 56], [44.8, 67.2]], rows: [[0, 20], [10, 50], [40, 60]] });
    expect([...group.querySelectorAll('[data-call-took]')].map((took) => took.textContent)).toEqual(['2.0 s', '5.0 s', '6.0 s…']);
    await act(async () => { vi.advanceTimersByTime(5000); });
    // At 10:00:15 the axis is 15 s long and only the running call grew.
    expect(bars()).toEqual({ mini: [[0, 14.9], [7.5, 37.3], [29.9, 82.1]], rows: [[0, 13], [7, 33], [27, 73]] });
    expect([...group.querySelectorAll('[data-call-took]')].at(-1)?.textContent).toBe('11 s…');
  } finally {
    vi.useRealTimers();
  }
});

it('shows a selected call’s output as numbered log lines and its arguments as a JSON tree', async () => {
  await render(turn([read, edit]));
  await click(groups()[0]!.querySelector('button[aria-expanded]'));
  await click(container.querySelector(`[data-call="${read.id}"] > button`));
  const log = container.querySelector('[data-log-view]')!;
  expect(log.querySelector('[data-log-command]')?.textContent).toBe('$ls notes');
  expect([...log.querySelectorAll('[data-log-line]')].map((line) => `${line.getAttribute('data-log-line')}:${line.textContent}`))
    .toEqual(['plain:1alpha.txt', 'plain:2beta.txt', 'error:3error: gamma.txt unreadable']);
  await click(tab('Arguments'));
  expect(container.querySelector('[role="tree"][aria-label="args"]')?.textContent).toContain('command:"ls notes"');
});

it('opens an edit call on its diff of removed and added lines, drawn by the diff viewer', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  await render(turn([read, edit]));
  await click(container.querySelector('[data-edited-file="src/greeting.ts"]'));
  expect(tab('Diff')?.getAttribute('aria-selected')).toBe('true');
  // Pierre draws into its container's shadow root.
  const viewer = container.querySelector(`[data-call="${edit.id}"] [data-call-diff="src/greeting.ts"] diffs-container`);
  await vi.waitFor(() => {
    const lines = [...viewer?.shadowRoot?.querySelectorAll('[data-content] > [data-line-type]') ?? []].map((line) => `${line.getAttribute('data-line-type')}:${line.textContent}`);
    expect(lines).toEqual(['change-deletion:const hello = "hi";', 'change-addition:const hello = "hello";', 'context:export { hello };']);
  }, { timeout: 4_000 });
  // The edit's hunk does not know where in the file it is: no line numbers.
  expect(viewer?.shadowRoot?.querySelector('pre')?.hasAttribute('data-disable-line-numbers')).toBe(true);
});

it('numbers a write call\'s diff with the written file\'s lines', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const write: ToolCallBlock = { id: 'turn:tool:write', type: 'tool-call', toolCallId: 'write', tool: 'write', target: 'notes/todo.md', status: 'done', args: { path: 'notes/todo.md', content: '# Todo\n- ship\n' } };
  await render(turn([read, write]));
  await click(container.querySelector('[data-edited-file="notes/todo.md"]'));
  const viewer = container.querySelector(`[data-call="${write.id}"] [data-call-diff="notes/todo.md"] diffs-container`);
  await vi.waitFor(() => {
    const numbers = [...viewer?.shadowRoot?.querySelectorAll('[data-gutter] > [data-line-type="change-addition"]') ?? []].map((line) => line.textContent);
    expect(numbers).toEqual(['1', '2']);
  }, { timeout: 4_000 });
  expect(viewer?.shadowRoot?.querySelector('pre')?.hasAttribute('data-disable-line-numbers')).toBe(false);
});

it('marks a group holding a failed call', async () => {
  await render(turn([read, failed]));
  expect(groups()[0]!.querySelector('button[aria-expanded]')?.textContent).toContain('1 failed');
  await render(turn([read]));
  expect(groups()[0]!.textContent).not.toContain('failed');
});

it('starts a new group after anything between calls', async () => {
  await render(turn([read, { id: 'turn:message', type: 'message', role: 'assistant', text: 'Now the edit.' }, edit]));
  expect(groups().map((group) => group.getAttribute('aria-label'))).toEqual(['1 tool call', '1 tool call']);
  await render(turn([read, edit, failed]));
  expect(groups().map((group) => group.getAttribute('aria-label'))).toEqual(['3 tool calls']);
});
