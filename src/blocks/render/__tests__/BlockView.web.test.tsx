import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';

import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { BlockView } from '../registry.web.js';
import { BlockHostProvider, type BlockHost } from '../host.web.js';
import '../content.web.js'; // registers markdown/callout/code/code-ref/data-structure
import '../transcript.web.js'; // registers message/thinking/tool-call
// note: diff.web is intentionally NOT imported — it pulls @pierre/diffs, which
// resolves only in the web build. Diff rendering is verified there.

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe('web BlockView', () => {
  it('renders a valid markdown block', () => {
    const { container } = render(<BlockView block={{ id: 'b1', type: 'markdown', data: { text: '# Hi\n\nhello' } }} />);
    expect(container.innerHTML).toContain('gs-block-md');
    expect(container.innerHTML).toContain('<h1'); // renderMarkdownHtml produced a heading
    expect(container.textContent).toContain('Hi');
  });

  it('renders an assistant message through markdown', () => {
    const { container } = render(<BlockView block={{ id: 'm1', type: 'message', data: { role: 'assistant', text: 'all done' } }} />);
    expect(container.textContent).toContain('agent');
    expect(container.textContent).toContain('all done');
  });

  it('composes: a running tool-call renders its nested content blocks (expanded)', () => {
    // running → auto-expanded (completed calls collapse by default).
    const block = {
      id: 't1',
      type: 'tool-call',
      data: { tool: 'bash', status: 'running', result: [{ id: 'c1', type: 'markdown', data: { text: 'composed body' } }] },
    };
    const { container } = render(<BlockView block={block} />);
    expect(container.textContent).toContain('bash');
    expect(container.textContent).toContain('composed body');
  });

  it('collapses a completed tool-call by default (output hidden until expanded)', () => {
    const block = {
      id: 't2',
      type: 'tool-call',
      data: { tool: 'bash', status: 'done', target: 'ls', result: [{ id: 'c2', type: 'markdown', data: { text: 'hidden body' } }] },
    };
    const { container } = render(<BlockView block={block} />);
    expect(container.textContent).toContain('bash');
    expect(container.textContent).toContain('ls'); // header target still visible
    expect(container.textContent).not.toContain('hidden body'); // output collapsed
  });

  it('keeps input visible on a completed tool-call while output stays collapsed', () => {
    const block = {
      id: 't3',
      type: 'tool-call',
      data: {
        tool: 'eval',
        status: 'done',
        target: 'print(6*7)',
        input: [{ id: 'i3', type: 'markdown', data: { text: 'FULL INPUT CODE' } }],
        result: [{ id: 'r3', type: 'markdown', data: { text: 'collapsed output' } }],
      },
    };
    const { container } = render(<BlockView block={block} />);
    expect(container.textContent).toContain('FULL INPUT CODE'); // input always visible
    expect(container.textContent).not.toContain('collapsed output'); // output collapsed
  });

  it('degrades an unknown block type to a loud fallback (markdown when text is present)', () => {
    const { container } = render(<BlockView block={{ id: 'x1', type: 'mystery', data: { text: 'fallback body' } }} />);
    expect(container.textContent).toContain('unsupported block');
    expect(container.textContent).toContain('fallback body');
  });

  it('surfaces invalid data loudly with the offending field', () => {
    const { container } = render(<BlockView block={{ id: 'm2', type: 'message', data: { role: 'robot', text: 'x' } }} />);
    expect(container.textContent).toContain('invalid block');
    expect(container.textContent).toContain('role');
  });

  it('renders a pending (optimistic) user message dimmed with a sending marker', () => {
    const { container } = render(<BlockView block={{ id: 'u1', type: 'message', data: { role: 'user', text: 'hello there', pending: true } }} />);
    expect(container.textContent).toContain('hello there');
    expect(container.textContent).toContain('sending…');
    expect(container.innerHTML).toContain('opacity-60');
  });

  it('error block Retry dispatches a retry-prompt action through the host', () => {
    const dispatch = mock(() => {});
    const host: BlockHost = { resolve: () => {}, dispatch, readOnly: false };
    const { container } = render(
      <BlockHostProvider host={host}>
        <BlockView block={{ id: 'e1', type: 'error', data: { text: 'send failed' } }} />
      </BlockHostProvider>,
    );
    const retry = Array.from(container.getElementsByTagName('button')).find((b) => b.textContent?.includes('Retry')) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'run', actionId: 'retry-prompt', payload: { blockId: 'e1' } });
  });

  it('error block Retry is disabled on a read-only host', () => {
    const dispatch = mock(() => {});
    const host: BlockHost = { resolve: () => {}, dispatch, readOnly: true };
    const { container } = render(
      <BlockHostProvider host={host}>
        <BlockView block={{ id: 'e2', type: 'error', data: { text: 'send failed' } }} />
      </BlockHostProvider>,
    );
    const retry = Array.from(container.getElementsByTagName('button')).find((b) => b.textContent?.includes('Retry')) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('aborted error blocks offer no retry', () => {
    const { container } = render(<BlockView block={{ id: 'e3', type: 'error', data: { text: 'stopped', aborted: true } }} />);
    expect(container.textContent).toContain('stopped');
    expect(container.textContent).not.toContain('Retry');
  });
});
