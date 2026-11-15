import type { TranscriptItem, TranscriptRow } from '@gitspace/blocks';
import { describe, expect, it } from 'vitest';
import { openRows } from './CommentLayer.js';

function row(turnId: string, item: TranscriptItem, ordinal: number): TranscriptRow {
  return { id: item.id, ordinal, turnId, turnStatus: 'done', item, truncated: false, contentBytes: 0 };
}

const older = [
  row('t1', { id: 't1:user', type: 'message', role: 'user', text: 'Which cache?' }, 1),
  row('t1', { id: 't1:a', type: 'message', role: 'assistant', text: 'Use KV.' }, 2),
];
const latest = [
  row('t2', { id: 't2:user', type: 'message', role: 'user', text: 'Why?' }, 3),
  row('t2', { id: 't2:think', type: 'thinking', text: 'They want reasons.' }, 4),
  row('t2', { id: 't2:before', type: 'message', role: 'assistant', text: 'Let me check the reads.' }, 5),
  row('t2', { id: 't2:call', type: 'tool-call', toolCallId: 'call', tool: 'bash', status: 'done' }, 6),
  row('t2', { id: 't2:after', type: 'message', role: 'assistant', text: 'Reads stay at the edge.' }, 7),
];

describe('comments go on the latest turn', () => {
  it('takes the agent\'s messages before and after its tool calls and the calls, not its thinking or an older turn', () => {
    expect([...openRows([...older, ...latest], true)].sort()).toEqual(['t2:after', 't2:before', 't2:call']);
  });

  it('takes nothing while the newest rows are not loaded, nor a message still being written', () => {
    expect(openRows([...older, ...latest], false).size).toBe(0);
    const streaming = row('t2', { id: 't2:pending', type: 'message', role: 'assistant', text: 'Reads st', pending: true }, 8);
    expect(openRows([...older, ...latest, streaming], true).has('t2:pending')).toBe(false);
  });
});
