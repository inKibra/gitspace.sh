// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { BlockActionsProvider, type BlockActions, type BlockState } from './BlockActions.js';
import { BLOCK_FIXTURES, SVG_DRAWING, type BlockFixture } from './fixtures.js';
import { UI_BLOCK_EXAMPLES } from '@gitspace/protocol/gitspace-ui';

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
  benchmark: ['Menu ready, per page', 'Menu cache (abc1234)', '1.1 s', 'main · menu read from the database', '4 loads per page.', 'What the customer sees'],
  options: ['Where should the menu cache live?', 'Survives a deploy', 'Keep it in memory', 'Use Redis'],
  question: ['Show sold-out items greyed out?', '40 test orders', 'Grey them out', 'Hide them until restocked', 'Note for the agent', 'Add to message'],
  steps: ['One order, end to end', 'storefront', 'Step 1 of 4', 'The customer taps', 'Play', 'Open this step in the Change Guide'],
  review: ['Three open review threads', '3 of 3 threads included', 'Guard the empty basket', 'src/kitchen.ts:88', 'Outdated', 'Open thread'],
  evidence: ['Is the menu faster, with no slower checkout?', '200 loads · def5678', '17 of 18', 'Checkout p95', 'abc1234'],
  requirements: ['Requirements', '1 of 3 requirements accepted', 'An edited item shows within a minute', 'optional'],
  ask: ['Keep the pastry photos on the menu?', 'Drop them', 'Keep them'],
  drawing: ['Where an order goes', 'kitchen'],
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

  // What each example the gitspace-ui skill teaches shows once drawn: its chart values formatted by unit, the
  // FlowMap's areas and step player, the staged choice and the checklist's progress.
  const SKILL_EXAMPLES: Record<string, readonly string[]> = {
    'Results of a run': ['Cold start after the cache change', '1.8 s', 'Before', 'After', '4f2c9a1'],
    'Values over time': ['Memory per turn', 'Read per turn', '128.0 MB', '11.1 MB'],
    'Options compared': ['Where replies are cached', 'Durable Object', '$12'],
    'How it flows': ['tool-result store', 'conversation entries', 'Play the steps', 'unchanged'],
    'A choice for the person': ['Which cache keeps the replies?', 'Workers KV', 'Add to message'],
    'A plan to tick off': ['Before the release', '1 of 3 checks done', 'Smoke run on the release'],
    'Before and after': ['The board in the transcript', 'A notice'],
    'A layout or anything the components cannot express': ['Workspace board', 'Composer'],
  };
  it.each(UI_BLOCK_EXAMPLES.filter((example) => example.fence !== 'mermaid'))('draws the skill example "$title" as an agent writes it', async (example) => {
    await render(<GitSpaceMarkdown>{fence(example.fence, example.body)}</GitSpaceMarkdown>);
    await waitFor(() => container.querySelector(`[data-gitspace-block="${example.fence}"]`) !== null);
    const text = container.textContent ?? '';
    expect(text).not.toContain('could not be drawn');
    for (const expected of SKILL_EXAMPLES[example.title] ?? ['missing expectations']) expect(text).toContain(expected);
    // A line chart draws one line per series, not columns.
    if (example.title === 'Values over time') expect(container.querySelectorAll('figure svg polyline')).toHaveLength(2);
  });

  it('redraws from state when a bound control changes', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('benchmark').spec))}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('1.1 s') ?? false);
    await click('Menu cache (abc1234)');
    await waitFor(() => container.textContent?.includes('0.4 s') ?? false);
    expect(container.textContent).toContain('5 loads per page.');
    expect(container.textContent).not.toContain('1.1 s');
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

  it.each([
    '<svg viewBox="0 0 10 10"><!-- --!><img src=x onerror=alert(1)> --></svg>',
    '<svg viewBox="0 0 10 10"><!--><img src=x onerror=alert(1)>--></svg>',
    '<svg viewBox="0 0 10 10"><![CDATA[<img src=x onerror=alert(1)>]]></svg>',
    '<svg viewBox="0 0 10 10"></svg><img src=x onerror=alert(1)>',
    '<svg viewBox="0 0 10 10"><title><img src=x onerror=alert(1)></title></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>',
  ])('puts no element or handler from %s in the page', async (svg) => {
    await render(<GitSpaceMarkdown>{fence('svg', svg)}</GitSpaceMarkdown>);
    await waitFor(() => container.querySelector('[data-gitspace-block="svg"]') !== null || (container.textContent?.includes('could not be drawn') ?? false));
    expect(container.querySelector('img, script, foreignObject, div[onclick]')).toBeNull();
    expect([...container.querySelectorAll('*')].flatMap((element) => element.getAttributeNames()).filter((name) => /^on/i.test(name))).toEqual([]);
  });

  it('draws a themed drawing element by element', async () => {
    const themed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><defs><marker id="arrow"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>'
      + '<line x1="0" y1="10" x2="30" y2="10" stroke="var(--muted-foreground)" marker-end="url(#arrow)"/><text x="2" y="8" style="fill: var(--foreground)">a &amp; b</text><use xlink:href="#arrow"/></svg>';
    await render(<GitSpaceMarkdown>{fence('svg', themed)}</GitSpaceMarkdown>);
    await waitFor(() => container.querySelector('[data-gitspace-block="svg"] svg') !== null);
    const drawing = container.querySelector('[data-gitspace-block="svg"] svg')!;
    expect(drawing.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(drawing.getAttribute('viewBox')).toBe('0 0 40 20');
    expect(drawing.querySelector('defs > marker#arrow > path')?.getAttribute('fill')).toBe('currentColor');
    expect(drawing.querySelector('line')?.getAttribute('stroke')).toBe('var(--muted-foreground)');
    expect(drawing.querySelector('line')?.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(drawing.querySelector('text')?.textContent).toBe('a & b');
    expect(drawing.querySelector('text')?.getAttribute('style')).toBe('fill: var(--foreground)');
    expect(drawing.querySelector('use')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#arrow');
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
    await waitFor(() => container.textContent?.includes('Use Redis') ?? false);
    expect(container.textContent).not.toContain('staged · in your message');
    await click('Use Redis');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ kind: 'decision', key: 'decision', label: 'Redis (over in-memory)', payload: { choice: 'Redis' } });
    await waitFor(() => container.textContent?.includes('staged · in your message') ?? false);
    await act(async () => { staged?.setSent('decision', 'Redis'); });
    expect(container.textContent).toContain('sent · Redis');
    expect(container.textContent).not.toContain('staged · in your message');
  });

  it('resolves $computed params from state before the handler runs', async () => {
    const calls: unknown[] = [];
    await render(<BlockActionsProvider actions={{ stage: (params) => { calls.push(params); } }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('question').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Hide them until restocked') ?? false);
    await click('Hide them until restocked');
    await waitFor(() => container.textContent?.includes('A shorter menu, but regulars lose sight of their favourites.') ?? false);
    await click('Add to message');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ kind: 'answer', key: 'soldout', label: 'Hide them until restocked', payload: { answer: 'hide', note: '' } });
  });

  it('says an action is not available here when no surface handles it', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('Use Redis') ?? false);
    await click('Use Redis');
    await waitFor(() => container.textContent?.includes('Adding to your message is not available here.') ?? false);

    await render(<BlockActionsProvider actions={{ stage: () => undefined }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('steps').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Open this step in the Change Guide') ?? false);
    await click('Open this step in the Change Guide');
    await waitFor(() => container.textContent?.includes('Opening the Change Guide is not available here.') ?? false);
  });

  it('shows a handler\'s failure under the block', async () => {
    await render(<BlockActionsProvider actions={{ stage: () => { throw new Error('the composer is closed'); } }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Use Redis') ?? false);
    await click('Use Redis');
    await waitFor(() => container.textContent?.includes('Adding to your message failed: the composer is closed') ?? false);
  });
});

describe('blocks in the lightbox', () => {
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it('opens a block full-screen, drawn again from the same state, and closes with Escape', async () => {
    await render(<GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('benchmark').spec))}</GitSpaceMarkdown>);
    await waitFor(() => container.textContent?.includes('1.1 s') ?? false);
    await act(async () => container.querySelector<HTMLElement>('button[aria-label="Expand Menu ready, per page"]')?.click());
    await waitFor(() => dialog()?.textContent?.includes('1.1 s') ?? false);
    const title = document.getElementById(dialog()?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Menu ready, per page');
    for (const expected of EXPECTED.benchmark ?? []) expect(dialog()?.textContent).toContain(expected);
    // A control in the dialog changes the block in place too: both draw from one state.
    const toggle = [...dialog()!.querySelectorAll<HTMLElement>('button, span, div, p')].filter((element) => element.textContent?.trim() === 'Menu cache (abc1234)').at(-1);
    await act(async () => toggle?.click());
    await waitFor(() => (dialog()?.textContent?.includes('0.4 s') ?? false) && (container.textContent?.includes('0.4 s') ?? false));
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await waitFor(() => dialog() === null);
    expect(container.textContent).toContain('0.4 s');
  });

  it('opens when the block is pressed, but not when one of its own controls is', async () => {
    await render(<BlockActionsProvider actions={{ stage: () => undefined }}><GitSpaceMarkdown>{fence('gitspace-ui', JSON.stringify(fixture('options').spec))}</GitSpaceMarkdown></BlockActionsProvider>);
    await waitFor(() => container.textContent?.includes('Use Redis') ?? false);
    await click('Use Redis');
    expect(dialog()).toBeNull();
    await click('Pick one; it waits in your message so you can say why.');
    await waitFor(() => dialog()?.textContent?.includes('Survives a deploy') ?? false);
  });
});
