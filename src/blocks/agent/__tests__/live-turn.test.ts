import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@oh-my-pi/pi-agent-core';

import { validateBlock } from '../../index.js';
import { LiveTurn } from '../live-turn.js';

function evt(e: unknown): AgentEvent {
  return e as AgentEvent;
}

describe('LiveTurn accumulator', () => {
  it('renders the streaming assistant message on message_update', () => {
    const turn = new LiveTurn();
    const u = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud…' }] }, assistantMessageEvent: {} }));
    expect(u).not.toBeNull();
    expect(u!.committed).toBe(false);
    expect(u!.blocks.some((b) => b.type === 'message')).toBe(true);
    for (const b of u!.blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('shows a tool call running, then done once its result arrives', () => {
    const turn = new LiveTurn();
    turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'running it' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] }, assistantMessageEvent: {} }));
    const before = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] }, assistantMessageEvent: {} }));
    const toolBefore = before!.blocks.find((b) => b.type === 'tool-call')!;
    expect((toolBefore.data as { status: string }).status).toBe('running');

    const after = turn.apply(evt({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.ts b.ts' }] }, isError: false }));
    const toolAfter = after!.blocks.find((b) => b.type === 'tool-call')!;
    expect((toolAfter.data as { status: string }).status).toBe('done');
    expect((toolAfter.data as { result?: unknown[] }).result?.length).toBe(1);
  });

  it('commits and clears on turn_end', () => {
    const turn = new LiveTurn();
    turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, assistantMessageEvent: {} }));
    const end = turn.apply(evt({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] }));
    expect(end).toEqual({ blocks: [], committed: true });
    // after reset, a stray tool result alone produces nothing
    expect(turn.apply(evt({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'bash', result: '', isError: false }))).toBeNull();
  });

  it('keeps the user message when the assistant reply streams in (regression: no replace)', () => {
    const turn = new LiveTurn();
    turn.apply(evt({ type: 'message_update', message: { role: 'user', content: 'run the tests' }, assistantMessageEvent: {} }));
    const u = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }], responseId: 'r1' }, assistantMessageEvent: {} }));
    const msgs = u!.blocks.filter((b) => b.type === 'message').map((b) => b.data as { role: string; text: string });
    expect(msgs.some((m) => m.role === 'user' && m.text.includes('run the tests'))).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant' && m.text.includes('on it'))).toBe(true);
  });

  it('does not duplicate a message across message_start + message_update (regression)', () => {
    const turn = new LiveTurn();
    turn.apply(evt({ type: 'message_start', message: { role: 'user', content: 'ZQX9 do it' } }));
    const u = turn.apply(evt({ type: 'message_update', message: { role: 'user', content: 'ZQX9 do it' }, assistantMessageEvent: {} }));
    const userMsgs = u!.blocks.filter((b) => b.type === 'message' && (b.data as { role: string }).role === 'user');
    expect(userMsgs).toHaveLength(1);
  });

  it('streaming the same assistant message updates in place (single block)', () => {
    const turn = new LiveTurn();
    turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }], responseId: 'r1' }, assistantMessageEvent: {} }));
    const u = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }], responseId: 'r1' }, assistantMessageEvent: {} }));
    const msgs = u!.blocks.filter((b) => b.type === 'message');
    expect(msgs).toHaveLength(1);
    expect((msgs[0].data as { text: string }).text).toBe('hello there');
  });

  it('uses distinct block ids across turns (no key collision)', () => {
    const turn = new LiveTurn();
    const a = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], responseId: 'r1' }, assistantMessageEvent: {} }));
    turn.apply(evt({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] }));
    const b = turn.apply(evt({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], responseId: 'r2' }, assistantMessageEvent: {} }));
    expect(a!.blocks[0].id).not.toBe(b!.blocks[0].id);
  });

  it('ignores unrelated events', () => {
    const turn = new LiveTurn();
    expect(turn.apply(evt({ type: 'turn_start' }))).toBeNull();
  });
});
