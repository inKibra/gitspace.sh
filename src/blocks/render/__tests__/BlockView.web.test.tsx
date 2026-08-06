import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';

import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { BlockView } from '../registry.web.js';
import { BlockHostProvider, type BlockHost } from '../host.web.js';
import '../content.web.js'; // registers markdown/callout/code/code-ref/data-structure
import '../transcript.web.js'; // registers message/thinking/tool-call
// note: diff.web is intentionally NOT imported — it pulls @pierre/diffs, which
// resolves only in the web build. Diff rendering is verified there.
function payload(container: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(container.getElementsByTagName('section')).find((element) => element.getAttribute('data-payload') === label);
}

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
  it('uses the bash renderer for structured input and output payloads', () => {
    const { container } = render(
      <BlockView
        block={{
          id: 't-bash-structured',
          type: 'tool-call',
          data: {
            tool: 'bash',
            status: 'running',
            target: 'printf',
            args: { command: 'printf hi', cwd: '/tmp' },
            details: { stdout: 'hi', exitCode: 0 },
          },
        }}
      />,
    );

    const input = payload(container, 'command input');
    const output = payload(container, 'command output');
    expect(input).not.toBeNull();
    expect(output).not.toBeNull();
    expect(input?.textContent).toContain('structured');
    expect(output?.textContent).toContain('structured');
  });

  it('keeps expanded payloads scrollable at the bounded height', () => {
    const { container } = render(
      <BlockView
        block={{
          id: 't-bash-long',
          type: 'tool-call',
          data: { tool: 'bash', status: 'running', details: 'line\n'.repeat(400) },
        }}
      />,
    );

    const output = payload(container, 'command output');
    expect(output).not.toBeNull();
    expect(output?.classList.contains('max-h-72')).toBe(true);
    expect(output?.classList.contains('overflow-y-auto')).toBe(true);
  });

  it('uses the generic renderer for an unknown tool', () => {
    const { container } = render(
      <BlockView
        block={{
          id: 't-unknown',
          type: 'tool-call',
          data: { tool: 'mystery-tool', status: 'running', args: '--verbose', details: 'generic output' },
        }}
      />,
    );

    expect(container.textContent).toContain('mystery-tool');
    expect(payload(container, 'input')?.textContent).toContain('--verbose');
    expect(payload(container, 'output')?.textContent).toContain('generic output');
  });

  it('renders a tool with no args or details when nested blocks provide its output', () => {
    const { container } = render(
      <BlockView
        block={{
          id: 't-edit-no-payloads',
          type: 'tool-call',
          data: {
            tool: 'edit',
            target: 'src/example.ts',
            status: 'running',
            result: [{ id: 'edit-result', type: 'markdown', data: { text: 'patch applied' } }],
          },
        }}
      />,
    );

    expect(container.textContent).toContain('edit');
    expect(container.textContent).toContain('src/example.ts');
    expect(container.textContent).toContain('patch applied');
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

  it('names the rule and reveals the instruction on expand', () => {
    // The point of the block: before this, the rule id lived inside an escaped
    // XML attribute in the tool output, so it was neither visible nor scannable.
    const block = {
      id: 'r1',
      type: 'rule-activation',
      data: {
        rule: 'ts-set-map',
        reason: 'rule_violation',
        path: 'builtin-defaults:ts-set-map.md',
        body: 'Use Record for small, static lookup tables.\n\nRuntime collection? Set / Map.',
      },
    };
    const { container, getByRole } = render(<BlockView block={block} />);

    expect(container.textContent).toContain('ts-set-map');
    expect(container.textContent).toContain('Use Record for small, static lookup tables.');
    // Collapsed: the trailing detail is withheld until asked for.
    expect(container.textContent).not.toContain('Runtime collection?');

    fireEvent.click(getByRole('button'));
    expect(container.textContent).toContain('Runtime collection?');
    expect(container.textContent).toContain('builtin-defaults:ts-set-map.md');
  });
});
