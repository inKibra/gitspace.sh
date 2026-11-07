// @vitest-environment happy-dom
import type { TranscriptItem, TranscriptRow, TurnBlock } from '@gitspace/blocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptHistory } from '../useTranscriptHistory.js';
import { VirtualTranscript } from '../VirtualTranscript.js';
import { TranscriptItemView } from './TranscriptItemView.js';
import { TurnTranscript } from './TurnTranscript.js';

/** Local wall-clock times in November 2026; "now" is Friday, November 6 at noon. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

function page(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Each turn's first text and, above it, the divider label (if any), in reading order. */
function sequence(document: Document): string[] {
  return [...document.querySelectorAll('[data-day-divider], [data-message-text]')].map((node) => node.hasAttribute('data-day-divider') ? `— ${node.textContent} —` : node.textContent ?? '');
}

const days: { text: string; at?: string }[] = [
  { text: 'First, recorded before times' },
  { text: 'Tuesday work', at: local(3, 22) },
  { text: 'Wednesday morning', at: local(4, 9) },
  { text: 'Wednesday evening', at: local(4, 18, 48) },
  { text: 'Recorded before times' },
  { text: 'Thursday', at: local(5, 8) },
  { text: 'Friday', at: local(6, 10) },
];

function user(index: number): Extract<TranscriptItem, { type: 'message' }> {
  const day = days[index]!;
  return { id: `turn-${index}:user`, type: 'message', role: 'user', text: day.text, ...(day.at ? { at: day.at } : {}) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('day dividers', () => {
  const expected = ['First, recorded before times', '— Tuesday, November 3 —', 'Tuesday work', '— Wednesday, November 4 —', 'Wednesday morning', 'Wednesday evening', 'Recorded before times', '— Yesterday —', 'Thursday', '— Today —', 'Friday'];

  it('name the day the conversation starts on and each change of local day between turns, in the turn list', () => {
    const turns: TurnBlock[] = days.map((_, index) => ({ id: `turn-${index}`, type: 'turn', status: 'done', user: user(index), items: [], sideAgents: [] }));
    const document = page(renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />).replaceAll('<p>', '<p data-message-text>'));
    expect(sequence(document)).toEqual(expected);
  });

  it('name the day the conversation starts on and each change of local day between turns, in the scrolling transcript', () => {
    // The window draws the latest ~600px; replies on the first dated turns alone keep every row inside it while still
    // checking that a turn's later rows get no divider.
    const reply = (index: number): TranscriptRow => ({ id: `turn-${index}:reply`, ordinal: index * 2 + 1, turnId: `turn-${index}`, turnStatus: 'done', truncated: false, contentBytes: 100, item: { id: `turn-${index}:reply`, type: 'message', role: 'assistant', text: 'Done.', at: days[index]!.at } });
    const rows: TranscriptRow[] = days.flatMap((_, index): TranscriptRow[] => [
      { id: `turn-${index}:user`, ordinal: index * 2, turnId: `turn-${index}`, turnStatus: 'done', truncated: false, contentBytes: 100, item: user(index) },
      ...index >= 1 && index <= 3 ? [reply(index)] : [],
    ]);
    const history: TranscriptHistory = {
      rows, generation: 'g', loading: false, initialLoading: false, error: null, navigation: null, hasBefore: false, hasAfter: false, total: rows.length,
      refresh: vi.fn(), loadOlder: vi.fn(), loadNewer: vi.fn(), jumpToLatest: vi.fn(), jumpToRow: vi.fn(), setViewport: vi.fn(),
      content: vi.fn(async () => ({ text: '{}', offset: 0, nextOffset: null, totalCharacters: 2 })),
      executionPage: vi.fn(async () => ({ generation: 'g', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 })),
    };
    const html = renderToStaticMarkup(<VirtualTranscript history={history} transport={[]} />);
    const document = page(html.replaceAll('<p>', '<p data-message-text>'));
    expect(sequence(document).filter((text) => text !== 'Done.')).toEqual(expected);
  });

  it('do not appear when no turn has a time', () => {
    const turns: TurnBlock[] = [0, 1].map((index) => ({ id: `t${index}`, type: 'turn', status: 'done', user: { id: `t${index}:user`, type: 'message', role: 'user', text: `Old ${index}` }, items: [], sideAgents: [] }));
    expect(page(renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />)).querySelectorAll('[data-day-divider]')).toHaveLength(0);
  });
});

describe('item times', () => {
  function times(item: TranscriptItem): { text: string; title: string | null }[] {
    return [...page(renderToStaticMarkup(<TranscriptItemView item={item} active={false} />)).querySelectorAll('time')].map((node) => ({ text: node.textContent ?? '', title: node.getAttribute('title') }));
  }

  it('show a small time on the person\'s messages and on cards, with the date when not today and the full date on hover', () => {
    expect(times({ id: 'u1', type: 'message', role: 'user', text: 'Ship it', at: local(6, 9, 5) })).toEqual([{ text: '09:05', title: 'Friday, November 6, 2026 at 09:05' }]);
    expect(times({ id: 'u2', type: 'message', role: 'user', text: 'Ship it', at: local(4, 18, 48) })).toEqual([{ text: 'Nov 4 · 18:48', title: 'Wednesday, November 4, 2026 at 18:48' }]);
    expect(times({ id: 'e1', type: 'interruption', reason: 'event', kind: 'agent-message', title: 'Reviewer', detail: 'No findings.', at: local(4, 18, 48) })).toEqual([{ text: 'Nov 4 · 18:48', title: 'Wednesday, November 4, 2026 at 18:48' }]);
    expect(times({ id: 'n1', type: 'interruption', reason: 'machine', title: 'Machine', detail: 'Darktop is online.', at: local(6, 11, 30) })).toEqual([{ text: '11:30', title: 'Friday, November 6, 2026 at 11:30' }]);
    expect(times({ id: 'w1', type: 'workspace-report', projectId: 'p', workspaceId: 'w', name: 'FEAT-1', requestId: 'r', outcome: 'finished', excerpt: null, at: local(5, 7) })).toEqual([{ text: 'Nov 5 · 07:00', title: 'Thursday, November 5, 2026 at 07:00' }]);
  });

  it('show the agent\'s reply time on hover only', () => {
    const html = renderToStaticMarkup(<TranscriptItemView item={{ id: 'a1', type: 'message', role: 'assistant', text: 'Done.', at: local(6, 9, 5) }} active={false} />);
    expect(page(html).querySelectorAll('time')).toHaveLength(0);
    expect(html).toContain('title="Friday, November 6, 2026 at 09:05"');
  });

  it('render nothing for items recorded without a time', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', type: 'message', role: 'user', text: 'Ship it' },
      { id: 'a1', type: 'message', role: 'assistant', text: 'Done.' },
      { id: 'e1', type: 'interruption', reason: 'event', kind: 'agent-message', title: 'Reviewer', detail: 'No findings.' },
      { id: 'n1', type: 'interruption', reason: 'machine', title: 'Machine', detail: 'Darktop is online.' },
      { id: 'c1', type: 'interruption', reason: 'compacted', title: 'Context compacted', recovered: true },
    ];
    for (const item of items) {
      const html = renderToStaticMarkup(<TranscriptItemView item={item} active={false} />);
      expect(html).not.toContain('<time');
      expect(html).not.toContain('title="');
    }
  });
});
