/**
 * Folds the Pi SDK's live agent-event stream into the transcript's "live suffix"
 * — the in-progress turn that hasn't been committed to the session file yet.
 *
 * The client renders a committed prefix (range reads) + this live suffix
 * (re-rendered on each update), then commits on turn end. This accumulator is
 * pure + stateful per session; the coordinator owns one per active session and
 * emits its output as a delta.
 */
import type { AgentEvent } from '@oh-my-pi/pi-agent-core';
import type { Message, TextContent, ToolResultMessage } from '@oh-my-pi/pi-ai';
import type { Block } from '../index.js';
import { liveMessageToBlocks } from './message-blocks.js';

export interface LiveUpdate {
  /** Blocks for the live suffix (empty when the turn has committed). */
  blocks: Block[];
  /** True when the turn finished: the client should drop the live suffix and
   *  refetch the tail (the turn is now in the committed session). */
  committed: boolean;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Convert a tool_execution_end result into a ToolResultMessage for rendering. */
function toolResultFromEvent(event: Extract<AgentEvent, { type: 'tool_execution_end' }>): ToolResultMessage {
  const raw = event.result as { content?: unknown } | undefined;
  let content: TextContent[];
  if (raw && Array.isArray(raw.content)) {
    const text = (raw.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    content = [{ type: 'text', text: text || safeJson(event.result) }];
  } else {
    content = [{ type: 'text', text: typeof event.result === 'string' ? event.result : safeJson(event.result) }];
  }
  return { role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, content, isError: !!event.isError } as ToolResultMessage;
}

export class LiveTurn {
  private message: Message | null = null;
  private readonly toolResults = new Map<string, ToolResultMessage>();

  /** Fold one agent event; returns a live update, or null when nothing changed. */
  apply(event: AgentEvent): LiveUpdate | null {
    switch (event.type) {
      case 'message_start':
      case 'message_update':
      case 'message_end':
        this.message = event.message as Message;
        return { blocks: this.render(), committed: false };
      case 'tool_execution_end': {
        this.toolResults.set(event.toolCallId, toolResultFromEvent(event));
        return this.message ? { blocks: this.render(), committed: false } : null;
      }
      case 'turn_end':
      case 'agent_end':
        this.reset();
        return { blocks: [], committed: true };
      default:
        return null;
    }
  }

  private render(): Block[] {
    return this.message ? liveMessageToBlocks(this.message, [...this.toolResults.values()]) : [];
  }

  reset(): void {
    this.message = null;
    this.toolResults.clear();
  }
}
