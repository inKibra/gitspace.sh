// @vitest-environment happy-dom
import type { TranscriptItem, TranscriptRow } from '@gitspace/blocks';
import type { RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentLayerProvider, CommentMessage, gutterSlot, openRows } from './CommentLayer.js';

function row(turnId: string, item: TranscriptItem, ordinal: number): TranscriptRow {
  return { id: item.id, ordinal, turnId, turnStatus: 'done', item, truncated: false, contentBytes: 0 };
}

// Turns are named after the ordinal of the input that opened them: an earlier message, the person's last message, and
// a background job's notice after it.
const earlier = 'pi:c:turn:1024';
const last = 'pi:c:turn:3072';
const notice = 'pi:c:turn:6144';
const older = [
  row(earlier, { id: 'a:user', type: 'message', role: 'user', text: 'Which cache?' }, 1024),
  row(earlier, { id: 'a:answer', type: 'message', role: 'assistant', text: 'Use KV.' }, 2048),
];
const since = [
  row(last, { id: 'b:user', type: 'message', role: 'user', text: 'Why?' }, 3072),
  row(last, { id: 'b:think', type: 'thinking', text: 'They want reasons.' }, 3073),
  row(last, { id: 'b:before', type: 'message', role: 'assistant', text: 'Let me check the reads.' }, 4096),
  row(last, { id: 'b:call', type: 'tool-call', toolCallId: 'call', tool: 'bash', status: 'done' }, 4097),
  row(last, { id: 'b:answer', type: 'message', role: 'assistant', text: 'Reads stay at the edge.' }, 5120),
  row(notice, { id: 'c:event', type: 'interruption', reason: 'event', kind: 'command-completed', title: 'Background command build', detail: 'exit 0' }, 6144),
  row(notice, { id: 'c:reply', type: 'message', role: 'assistant', text: 'The build is green.' }, 7168),
];

describe('comments go on what the agent wrote since the last message', () => {
  it('takes the agent\'s messages and tool calls from the last message on, through a notice and the reply to it, not its thinking or an earlier turn', () => {
    expect([...openRows([...older, ...since], last)].sort()).toEqual(['b:answer', 'b:before', 'b:call', 'c:reply']);
  });

  it('takes nothing before the first message, nor a message still being written', () => {
    expect(openRows([...older, ...since], null).size).toBe(0);
    const streaming = row(notice, { id: 'c:pending', type: 'message', role: 'assistant', text: 'Reads st', pending: true }, 7169);
    expect(openRows([...older, ...since, streaming], last).has('c:pending')).toBe(false);
  });
});

describe('the chat after a notice', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  /** Selects the whole text of a message and lets the layer see it. */
  async function select(rowId: string) {
    const text = container.querySelector(`[data-comment-target="${rowId}"] p`)!;
    const range = document.createRange();
    range.selectNodeContents(text);
    await act(async () => {
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  }

  it('keeps the answer to the last message commentable after a notice row, and locks an earlier answer with a note', async () => {
    const request = async (): Promise<RuntimeSessionResult> => { throw new Error('Unexpected request'); };
    await act(async () => root.render(<CommentLayerProvider conversationId="c" document={{ staged: [], lookupRevision: 0, window: last }} rows={[...older, ...since]} request={request}>
      {['a:answer', 'b:answer', 'c:reply'].map((id) => <CommentMessage key={id} row={id}><p>{id === 'a:answer' ? 'Use KV.' : 'Reads stay at the edge.'}</p></CommentMessage>)}
    </CommentLayerProvider>));
    await select('b:answer');
    expect(container.querySelector('[aria-label="Comment on the selection"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Comments go on what the agent wrote since the last message');
    await select('a:answer');
    expect(container.querySelector('[aria-label="Comment on the selection"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Comments go on what the agent wrote since the last message');
  });
});

describe('comment icons sit in the gutter right of the column', () => {
  // A column whose right edge is at 800, a gutter 28 px wide past it, and a first line of text running to the edge.
  const gutter = { top: 100, left: 800, width: 28, height: 600 };
  const line = { top: 340, left: 24, right: 800, width: 776, height: 24 };

  it('keeps the icon clear of a full-width line, inside the gutter, level with the line', () => {
    const slot = gutterSlot(gutter, line);
    const icon = { left: gutter.left + slot.left, top: gutter.top + slot.top, size: 16 };
    expect(icon.left).toBeGreaterThanOrEqual(line.right);
    expect(icon.left + icon.size).toBeLessThanOrEqual(gutter.left + gutter.width);
    expect(icon.top + icon.size / 2).toBe(line.top + line.height / 2);
  });
});
