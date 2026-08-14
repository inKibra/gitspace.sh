/**
 * The transcript's `tail` slot (the idle recap).
 *
 * The recap first shipped inside `live`, which had two consequences:
 *   1. `live` renders BEFORE `pending`, so a recap sat above the message you had
 *      just sent — it appeared to annotate your own prompt.
 *   2. `useTranscript` folds a finished turn into history when `live` EMPTIES.
 *      A long-lived block parked in `live` would keep it non-empty forever.
 *
 * So the tail is its own region, rendered last, and never part of `live`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { render } from '@testing-library/react';

import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { AgentTranscript } from '../AgentTranscript.web.js';
import type { BlockHost } from '../host.web.js';
import type { Block } from '../../index.js';
import type { TranscriptPage } from '../../agent/transcript-source.js';
import '../content.web.js';
import '../transcript.web.js';

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeAll(() => {
  setupTestDom();
  // happy-dom has no rAF; the transcript schedules its scroll-to-bottom on it.
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  teardownTestDom();
});

const host: BlockHost = { readOnly: true, resolve: () => {}, dispatch: () => {} };
const emptyPage = (): Promise<TranscriptPage> =>
  Promise.resolve({ blocks: [], oldestCursor: null, hasMore: false });

const msg = (id: string, text: string): Block => ({ id, type: 'message', data: { role: 'user', text } });
const recap = (text: string): Block => ({ id: 'recap:idle', type: 'recap', data: { text } });

describe('transcript tail', () => {
  it('renders the tail AFTER the pending message, never before it', async () => {
    const { container } = render(
      <AgentTranscript
        fetchRange={emptyPage}
        live={[msg('m1', 'streaming turn')]}
        pending={[msg('p1', 'just sent this')]}
        tail={[recap('where things stand')]}
        host={host}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('just sent this');
    expect(text).toContain('where things stand');
    // The symptom, pinned: the recap must not precede the sent message.
    expect(text.indexOf('where things stand')).toBeGreaterThan(text.indexOf('just sent this'));
  });

  it('renders after the live turn too', () => {
    const { container } = render(
      <AgentTranscript fetchRange={emptyPage} live={[msg('m1', 'live turn')]} tail={[recap('recap line')]} host={host} />,
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('recap line')).toBeGreaterThan(text.indexOf('live turn'));
  });

  it('a tail alone still counts as content — not the empty state', () => {
    const { container } = render(
      <AgentTranscript fetchRange={emptyPage} live={[]} tail={[recap('only a recap')]} host={host} />,
    );
    expect(container.textContent).toContain('only a recap');
    expect(container.textContent).not.toContain('No messages yet');
  });

  it('is absent when there is no recap', () => {
    const { container } = render(<AgentTranscript fetchRange={emptyPage} live={[]} host={host} />);
    expect(container.textContent).toContain('No messages yet');
  });
});
