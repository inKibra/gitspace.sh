import { describe, expect, it } from 'bun:test';

import { validateBlock } from '../../index.js';
import { pendingInteractionBlocks, permissionToBlock, questionToBlocks, todosToBlock } from '../transcript-blocks.js';
import type { Permission, PendingQuestion, TodoPhase } from '../../../agents/agent-runtime-types.js';

const permission: Permission = {
  id: 'p1',
  type: 'bash',
  pattern: 'rm *',
  sessionID: 's1',
  messageID: 'm1',
  title: 'Delete files',
  metadata: {},
  time: { created: 0 },
};

const question: PendingQuestion = {
  id: 'q1',
  sessionID: 's1',
  questions: [
    { question: 'Which consumer first?', header: 'Migration', options: [{ label: 'Editor' }, { label: 'Preview' }] },
    { question: 'Notes?', header: 'Detail', options: [], custom: true },
  ],
};

const phases: TodoPhase[] = [
  { name: 'plan', tasks: [{ content: 'write goal', status: 'completed' }, { content: 'write rubric', status: 'pending' }] },
];

describe('agent state → blocks', () => {
  it('maps a permission to a schema-valid approval-gate block', () => {
    const block = permissionToBlock(permission);
    const r = validateBlock(block);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.type).toBe('approval-gate');
  });

  it('maps questions to schema-valid host-ui dialog blocks (select + input)', () => {
    const blocks = questionToBlocks(question);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(validateBlock(b).ok).toBe(true);
    expect((blocks[0].data as { dialog: string }).dialog).toBe('select');
    expect((blocks[1].data as { dialog: string }).dialog).toBe('input');
  });

  it('maps todo phases to a schema-valid checklist block', () => {
    const block = todosToBlock(phases);
    expect(block).not.toBeNull();
    const r = validateBlock(block!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.block.data as { items: { done: boolean }[] };
      expect(data.items).toHaveLength(2);
      expect(data.items[0].done).toBe(true);
    }
  });

  it('returns null for empty todos', () => {
    expect(todosToBlock([])).toBeNull();
  });

  it('orders pending interaction blocks plan → questions → permissions → error, all valid', () => {
    const blocks = pendingInteractionBlocks({ permissions: [permission], questions: [question], todoPhases: phases, error: 'boom' });
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe('checklist');
    expect(types).toContain('hostui-dialog');
    expect(types).toContain('approval-gate');
    expect(types[types.length - 1]).toBe('error');
    for (const b of blocks) expect(validateBlock(b).ok).toBe(true);
  });
});
