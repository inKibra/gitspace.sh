/**
 * Folds the Pi SDK's live agent-event stream into the transcript's "live suffix"
 * — the in-progress turn that hasn't been committed to the session file yet.
 *
 * The client renders a committed prefix (range reads) + this live suffix
 * (re-rendered on each update), then commits on turn end. This accumulator is
 * pure + stateful per session; the coordinator owns one per active session and
 * emits its output as a delta.
 *
 * It keeps the WHOLE turn's messages (a turn is user → assistant → tool results,
 * possibly several), not just the latest — otherwise a later message would
 * visually replace an earlier one (e.g. the assistant reply overwriting the
 * user's own message) until a refresh.
 */
import type { AgentEvent } from '@oh-my-pi/pi-agent-core';
import type { AssistantMessage, Message, TextContent, ToolResultMessage } from '@oh-my-pi/pi-ai';
import type { Block } from '../index.js';
import { messageToBlocks } from './message-blocks.js';

export interface LiveUpdate {
  /** Blocks for the live suffix (empty when the turn has committed). */
  blocks: Block[];
  /** True when the turn finished: the client drops the live suffix (the turn is
   *  now folded into committed history). */
  committed: boolean;
}

type ToolResultWithDetails = ToolResultMessage & { details?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolResultFromEvent(event: Extract<AgentEvent, { type: 'tool_execution_end' }>): ToolResultMessage {
  const rawResult = event.result;
  const rawContent = isRecord(rawResult) ? rawResult.content : undefined;
  let content: TextContent[];
  if (Array.isArray(rawContent)) {
    const text = rawContent
      .filter((item): item is { type: 'text'; text: string } =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string',
      )
      .map((item) => item.text)
      .join('\n');
    content = [{ type: 'text', text: text || safeJson(rawResult) }];
  } else {
    content = [{ type: 'text', text: typeof rawResult === 'string' ? rawResult : safeJson(rawResult) }];
  }

  const toolResult: ToolResultWithDetails = {
    role: 'toolResult',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    content,
    isError: !!event.isError,
    timestamp: Date.now(),
  };
  if (isRecord(rawResult) && rawResult.details !== undefined) toolResult.details = rawResult.details;
  return toolResult;
}

export class LiveTurn {
  private messages: Message[] = [];
  private readonly toolResults = new Map<string, ToolResultMessage>();
  private turnSeq = 0; // bumps per turn so live block ids never collide across turns

  /** Fold one agent event; returns a live update, or null when nothing changed. */
  apply(event: AgentEvent): LiveUpdate | null {
    switch (event.type) {
      case 'message_start':
        // A new message begins — always a distinct entry (delimits messages,
        // even consecutive same-role ones).
        this.messages.push(event.message as Message);
        return { blocks: this.render(), committed: false };
      case 'message_update':
      case 'message_end':
        // Update the in-progress message (same logical message), else start one.
        this.upsert(event.message as Message);
        return { blocks: this.render(), committed: false };
      case 'tool_execution_end':
        this.toolResults.set(event.toolCallId, toolResultFromEvent(event));
        return this.messages.length > 0 ? { blocks: this.render(), committed: false } : null;
      case 'turn_end':
      case 'agent_end':
        this.reset();
        return { blocks: [], committed: true };
      default:
        return null;
    }
  }

  /** Update the in-progress message if it's the same one, else start a new one. */
  private upsert(message: Message): void {
    const last = this.messages[this.messages.length - 1];
    if (last && sameMessage(last, message)) {
      this.messages[this.messages.length - 1] = message;
    } else {
      this.messages.push(message);
    }
  }

  private render(): Block[] {
    // Correlate tool results from both tool_execution_end and any toolResult messages.
    const results = new Map(this.toolResults);
    for (const m of this.messages) {
      if (m.role === 'toolResult') results.set(m.toolCallId, m);
    }
    return this.messages.flatMap((m, i) => messageToBlocks(m, `live${this.turnSeq}.${i}`, results));
  }

  reset(): void {
    this.messages = [];
    this.toolResults.clear();
    this.turnSeq += 1;
  }
}

/** Whether two messages are the same logical message (a streaming update) vs new. */
function sameMessage(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  if (a.role === 'assistant' && b.role === 'assistant') {
    const ra = (a as AssistantMessage).responseId;
    const rb = (b as AssistantMessage).responseId;
    return ra && rb ? ra === rb : true; // streaming the same assistant message
  }
  // Same non-assistant role (user/developer/toolResult): treat consecutive
  // updates as the SAME in-progress message. New distinct messages are
  // delimited by message_start (which always pushes), so this only merges the
  // start+update(s) of one message — fixing the user message rendering twice.
  return true;
}
