import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { render } from '@testing-library/react';

import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { BlockView } from '../registry.web.js';
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

  it('composes: a tool-call renders its nested content blocks', () => {
    const block = {
      id: 't1',
      type: 'tool-call',
      data: { tool: 'bash', status: 'done', result: [{ id: 'c1', type: 'markdown', data: { text: 'composed body' } }] },
    };
    const { container } = render(<BlockView block={block} />);
    expect(container.textContent).toContain('bash');
    expect(container.textContent).toContain('composed body');
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
});
