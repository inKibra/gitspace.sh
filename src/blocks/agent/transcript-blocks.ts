/**
 * Maps GitSpace's structured agent-session state into blocks. This is the
 * stable half of the chat cutover: permissions, questions, todos, and errors
 * already exist as typed runtime state, so they map cleanly to interactive
 * blocks today. The streaming message/tool-call half (Pi `message_update`
 * payloads → blocks) is built separately against live SDK events.
 *
 * React-free: the server/coordinator can produce these blocks; the web layer
 * renders them through the registry.
 */
import type { Block } from '../index.js';
import type { Permission, PendingQuestion, TodoPhase } from '../../agents/agent-runtime-types.js';

/** A permission request → an interactive approval-gate block. */
export function permissionToBlock(permission: Permission): Block {
  const pattern = Array.isArray(permission.pattern) ? permission.pattern.join(', ') : permission.pattern;
  return {
    id: `perm:${permission.id}`,
    type: 'approval-gate',
    data: {
      tool: permission.type,
      detail: pattern ? `${permission.title} — ${pattern}` : permission.title,
    },
  };
}

/** A pending question (may bundle several) → host-ui dialog blocks. */
export function questionToBlocks(pending: PendingQuestion): Block[] {
  return pending.questions.map((q, i) => ({
    id: `q:${pending.id}:${i}`,
    type: 'hostui-dialog',
    data: {
      dialog: q.custom ? 'input' : 'select',
      prompt: q.header ? `${q.header} — ${q.question}` : q.question,
      options: q.options.map((o) => o.label),
    },
  }));
}

/** The agent's todo phases → a single checklist block (null when empty). */
export function todosToBlock(phases: TodoPhase[], id = 'todos'): Block | null {
  const items = phases.flatMap((phase) =>
    phase.tasks.map((task) => ({
      text: phase.name ? `${phase.name}: ${task.content}` : task.content,
      done: task.status === 'completed',
    })),
  );
  if (items.length === 0) return null;
  return { id, type: 'checklist', data: { title: 'plan', items } };
}

/** A session error → an error block. */
export function errorToBlock(text: string, id = 'err'): Block {
  return { id, type: 'error', data: { text } };
}

export interface PendingInteractionInput {
  permissions?: Permission[];
  questions?: PendingQuestion[];
  todoPhases?: TodoPhase[];
  error?: string | null;
}

/**
 * The interactive blocks that hang off the current session state, in the order
 * they should appear at the foot of the transcript: plan → questions →
 * permissions → error.
 */
export function pendingInteractionBlocks(input: PendingInteractionInput): Block[] {
  const blocks: Block[] = [];
  if (input.todoPhases && input.todoPhases.length > 0) {
    const todo = todosToBlock(input.todoPhases);
    if (todo) blocks.push(todo);
  }
  for (const q of input.questions ?? []) blocks.push(...questionToBlocks(q));
  for (const p of input.permissions ?? []) blocks.push(permissionToBlock(p));
  if (input.error) blocks.push(errorToBlock(input.error));
  return blocks;
}
