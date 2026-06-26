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

  it('ignores unrelated events', () => {
    const turn = new LiveTurn();
    expect(turn.apply(evt({ type: 'turn_start' }))).toBeNull();
  });
});
