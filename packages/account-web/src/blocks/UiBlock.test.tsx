// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { BlockActionsProvider, type BlockActions, type BlockState } from './BlockActions.js';
import { BLOCK_FIXTURES, SVG_DRAWING, type BlockFixture } from './fixtures.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function fence(kind: string, body: string): string {
  return `Before the block.\n\n\`\`\`${kind}\n${body}\n\`\`\`\n\nAfter the block.`;
}

function fixture(id: string): BlockFixture {
  const found = BLOCK_FIXTURES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

/** Waits for the lazily loaded block code and the effects after it. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    });
  }
  throw new Error(`timed out; the page reads: ${container.textContent ?? ''}`);
}

async function click(text: string): Promise<void> {
  const target = [...container.querySelectorAll<HTMLElement>('button, span, div, p')].filter((element) => element.textContent?.trim() === text).at(-1);
  if (!target) throw new Error(`nothing reads "${text}"; the page reads: ${container.textContent ?? ''}`);
  await act(async () => { target.click(); });
}

const EXPECTED: Record<string, readonly string[]> = {
  benchmark: ['First visible text, per message', 'Live chunks (abc1234)', '4.5 s', 'main · text shows after the whole attempt is saved', '4 replies per message.', 'What the member sees'],
  options: ['Where does the live text come from?', 'How text leaves the flow', 'Keep the side channel', 'Use live chunks'],
  question: ['Accept the brief flicker?', '160 benched replies', 'Accept the flicker', 'Hold text until the reply is committed', 'Note for the agent', 'Add to message'],
  steps: ['One reply chunk, end to end', 'provider', 'Step 1 of 4', 'The model streams', 'Play', 'Open this step in the Change Guide'],
  review: ['Three open review threads', '3 of 3 threads included', 'Guard the empty chunk', 'src/processor.ts:88', 'Outdated', 'Open thread'],
  evidence: ['Is first text sooner, with no slower total?', '120 replies · def5678', '18 of 18', 'Total p95', 'abc1234'],
  requirements: ['Requirements', '1 of 3 requirements accepted', 'A withdrawn attempt leaves no text', 'optional'],
  ask: ['Keep the batch-searches prompt rule?', 'Drop it', 'Keep it'],
  drawing: ['Where the chunk goes', 'processor'],
};

describe('gitspace-ui blocks in Markdown', () => {
  it.each(BLOCK_FIXTURES)('draws the $id spec from a fence', async (entry) => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(entry.spec, null, 2))}</GitSpaceMarkdown>);
    await waitFor(() => container.querySelector('[data-gitspace-block="gitspace-ui"]') !== null);
    const text = container.textContent ?? '';
    expect(text).not.toContain('could not be drawn');
    for (const expected of EXPECTED[entry.id] ?? []) expect(text).toContain(expected);
    expect(text).toContain('Before the block.');
    expect(text).toContain('After the block.');
  });

  it('redraws from state when a bound control changes', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('benchmark').spec))}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('4.5 s') ?? false);
    await click('Live chunks (abc1234)');
    await waitFor(() => container.textContent?.includes('3.6 s') ?? false);
    expect(container.textContent).toContain('3 replies per message.');
    expect(container.textContent).not.toContain('4.5 s');
  });

  it('shows the issues of a spec the validator rejects, and its JSON on request', async () => {
    const body = JSON.stringify({ root: 'card', elements: { card: { type: 'Carousel', props: {}, children: [] } } });
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', body)}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('could not be drawn') ?? false);
    expect(container.textContent).toContain('/elements/card/type');
    expect(container.querySelector('pre')).toBeNull();
    await click('Show the JSON');
    expect(container.querySelector('pre')?.textContent?.trim()).toBe(body);
    await click('Hide the JSON');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('shows a fence that is not JSON as an issue', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', '{ "root": card }')}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('could not be drawn') ?? false);
    expect(container.textContent).toContain('the gitspace-ui block is not JSON');
  });

  it('draws a valid svg fence and refuses an unsafe one', async () => {
    await render(<GitSpaceMarkdown>{fence('svg', SVG_DRAWING)}</GitSpaceMarkdown>);
    await waitFor(() => container.querySelector('[data-gitspace-block="svg"] svg') !== null);
    expect(container.querySelector('[data-gitspace-block="svg"] rect')?.getAttribute('stroke')).toBe('currentColor');

    await render(<GitSpaceMarkdown>{fence('svg', '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="alert(1)" fill="#ff0000"/></svg>')}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('could not be drawn') ?? false);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[data-gitspace-block="svg"]')).toBeNull();
    expect(container.textContent).toContain('<script> is not allowed');
    expect(container.textContent).toContain('event handler attributes are not allowed');
  });

  it('shows a quiet placeholder while a block fence is still streaming', async () => {
    await render(<GitSpaceMarkdown streaming>{'Here is the plan:\n\n```gitspace-ui\n{ "root": "card", "elem'}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('Drawing…') ?? false);
    expect(container.textContent).not.toContain('could not be drawn');
    expect(container.textContent).not.toContain('"root"');
  });
});

describe('block actions', () => {
  it('calls the surface handler with parsed params, and the handler writes the block\'s staged and sent state', async () => {
    const calls: unknown[] = [];
    let staged: BlockState | undefined;
    const actions: BlockActions = {
      stage: (params, block) => {
        calls.push(params);
        staged = block;
        block.setStaged(params.key ?? params.kind, params.label);
      },
    };
    await render(<BlockActionsProvider actions={actions}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Use live chunks') ?? false);
    expect(container.textContent).not.toContain('staged · in your message');
    await click('Use live chunks');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ kind: 'decision', key: 'decision', label: 'Live chunks (over the side channel)', payload: { choice: 'Live chunks' } });
    await waitFor(() => container.textContent?.includes('staged · in your message') ?? false);
    await act(async () => { staged?.setSent('decision', 'Live chunks'); });
    expect(container.textContent).toContain('sent · Live chunks');
    expect(container.textContent).not.toContain('staged · in your message');
  });

  it('resolves $computed params from state before the handler runs', async () => {
    const calls: unknown[] = [];
    await render(<BlockActionsProvider actions={{ stage: (params) => { calls.push(params); } }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('question').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Hold text until the reply is committed') ?? false);
    await click('Hold text until the reply is committed');
    await waitFor(() => container.textContent?.includes('No flicker, but text starts later.') ?? false);
    await click('Add to message');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ kind: 'answer', key: 'flicker', label: 'Hold text until the reply is committed', payload: { answer: 'hold', note: '' } });
  });

  it('says an action is not available here when no surface handles it', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('Use live chunks') ?? false);
    await click('Use live chunks');
    await waitFor(() => container.textContent?.includes('Adding to your message is not available here.') ?? false);

    await render(<BlockActionsProvider actions={{ stage: () => undefined }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('steps').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Open this step in the Change Guide') ?? false);
    await click('Open this step in the Change Guide');
    await waitFor(() => container.textContent?.includes('Opening the Change Guide is not available here.') ?? false);
  });

  it('shows a handler\'s failure under the block', async () => {
    await render(<BlockActionsProvider actions={{ stage: () => { throw new Error('the composer is closed'); } }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Use live chunks') ?? false);
    await click('Use live chunks');
    await waitFor(() => container.textContent?.includes('Adding to your message failed: the composer is closed') ?? false);
  });
});
