import { describe, expect, it } from 'bun:test';
import type { Message } from '@oh-my-pi/pi-ai';

import { validateBlock } from '../../index.js';
import { liveMessageToBlocks, messagesToBlocks } from '../message-blocks.js';

// Minimal well-typed fixtures (only the fields the mapper reads).
function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 } as Message;
}
function assistant(content: unknown[], extra: Record<string, unknown> = {}): Message {
  return { role: 'assistant', content, timestamp: 0, ...extra } as unknown as Message;
}
function toolResult(toolCallId: string, text: string, isError = false): Message {
  return { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text }], isError } as Message;
}

describe('messagesToBlocks', () => {
  it('maps a user turn to a message block', () => {
    const blocks = messagesToBlocks([user('migrate the effects')]);
    expect(blocks).toHaveLength(1);
    expect(validateBlock(blocks[0]).ok).toBe(true);
    expect((blocks[0].data as { role: string }).role).toBe('user');
  });

  it('maps assistant text + thinking into message + thinking blocks', () => {
    const blocks = messagesToBlocks([
      assistant([
        { type: 'thinking', thinking: 'let me plan' },
        { type: 'text', text: 'Here is the plan.' },
      ]),
    ]);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'message']);
    for (const b of blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('correlates a tool call with its result and nests it', () => {
    const blocks = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'bun test' } }]),
      toolResult('tc1', 'ok: 13 pass'),
    ]);
    const tool = blocks.find((b) => b.type === 'tool-call');
    expect(tool).toBeDefined();
    const r = validateBlock(tool!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.block.data as { status: string; target?: string; result?: unknown[] };
      expect(data.status).toBe('done');
      expect(data.target).toBe('bun test');
      expect(data.result?.length).toBe(1);
      // the nested result block is itself valid
      expect(validateBlock((data.result as unknown[])[0]).ok).toBe(true);
    }
  });

  it('leaves a tool call running when its result is out of the window', () => {
    const blocks = messagesToBlocks([assistant([{ type: 'toolCall', id: 'tc9', name: 'edit', arguments: { file_path: 'a.ts' } }])]);
    const tool = blocks.find((b) => b.type === 'tool-call')!;
    expect((tool.data as { status: string }).status).toBe('running');
    expect((tool.data as { target: string }).target).toBe('a.ts');
  });

  it('shows the eval code: first line as target, full code as a formatted input block', () => {
    const code = 'const x = 2 + 2;\nreturn x;';
    const blocks = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'e1', name: 'eval', arguments: { code } }]),
    ]);
    const tool = blocks.find((b) => b.type === 'tool-call')!;
    const data = tool.data as { tool: string; target?: string; input?: Array<{ type: string; data: { text: string } }> };
    expect(data.tool).toBe('eval');
    expect(data.target).toBe('const x = 2 + 2;'); // one-line collapsed summary
    expect(data.input?.[0]?.type).toBe('code');
    expect(data.input?.[0]?.data.text).toBe(code); // full input preserved
  });

  it('shows the write content as input (lang from the path)', () => {
    const content = 'export const x = 1;\nexport const y = 2;';
    const tool = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts', content } }]),
    ]).find((b) => b.type === 'tool-call')!;
    const data = tool.data as { target?: string; input?: Array<{ type: string; data: { text: string; lang?: string } }> };
    expect(data.target).toBe('a.ts');
    expect(data.input?.[0]?.data.text).toBe(content);
    expect(data.input?.[0]?.data.lang).toBe('typescript');
  });

  it('shows an edit as a synthesized old→new diff', () => {
    const tool = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'a.ts', old_string: 'let a', new_string: 'const a' } }]),
    ]).find((b) => b.type === 'tool-call')!;
    const data = tool.data as { input?: Array<{ data: { text: string; lang?: string } }> };
    expect(data.input?.[0]?.data.lang).toBe('diff');
    expect(data.input?.[0]?.data.text).toBe('- let a\n+ const a');
  });

  it('shows a patch-mode edit as a diff', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new';
    const tool = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'e2', name: 'edit', arguments: { path: 'a.ts', patch } }]),
    ]).find((b) => b.type === 'tool-call')!;
    const data = tool.data as { input?: Array<{ data: { text: string; lang?: string } }> };
    expect(data.input?.[0]?.data.text).toBe(patch);
    expect(data.input?.[0]?.data.lang).toBe('diff');
  });

  it('generic fallback: surfaces a multi-line content arg for an unlisted tool', () => {
    const memory = 'line one\nline two\nline three';
    const tool = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'g1', name: 'learn', arguments: { memory } }]),
    ]).find((b) => b.type === 'tool-call')!;
    const data = tool.data as { input?: Array<{ data: { text: string } }> };
    expect(data.input?.[0]?.data.text).toBe(memory);
  });

  it('shows the task assignment (single) and subtask count (batch) as input', () => {
    const single = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 't1', name: 'task', arguments: { agent: 'general', context: 'ctx', assignment: 'Audit the auth flow' } }]),
    ]).find((b) => b.type === 'tool-call')!;
    expect((single.data as { target?: string }).target).toBe('Audit the auth flow');

    const batch = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 't2', name: 'task', arguments: { agent: 'general', context: 'ctx', tasks: [{ assignment: 'a' }, { assignment: 'b' }] } }]),
    ]).find((b) => b.type === 'tool-call')!;
    expect((batch.data as { target?: string }).target).toBe('2 subtasks');
  });

  it('surfaces input for the newer builtin tools (ask/github/checkpoint/learn/manage_skill)', () => {
    const target = (name: string, args: Record<string, unknown>): string | undefined =>
      (messagesToBlocks([assistant([{ type: 'toolCall', id: `x-${name}`, name, arguments: args }])])
        .find((b) => b.type === 'tool-call')!.data as { target?: string }).target;
    expect(target('ask', { questions: [{ q: 'a' }] })).toBe('1 question');
    expect(target('github', { op: 'pr_create' })).toBe('pr_create');
    expect(target('checkpoint', { goal: 'trace the auth bug' })).toBe('trace the auth bug');
    expect(target('learn', { memory: 'prefer clean cutover' })).toBe('prefer clean cutover');
    expect(target('manage_skill', { action: 'create', name: 'deploy' })).toBe('deploy');
    expect(target('write', { path: 'a.ts', content: 'x' })).toBe('a.ts'); // path wins over content
  });

  it('surfaces an assistant error as an error block', () => {
    const blocks = messagesToBlocks([assistant([{ type: 'text', text: 'partial' }], { errorMessage: 'stream aborted' })]);
    expect(blocks.some((b) => b.type === 'error')).toBe(true);
    for (const b of blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('skips developer messages and bare tool-result messages in the main walk', () => {
    const blocks = messagesToBlocks([
      { role: 'developer', content: 'system note', timestamp: 0 } as Message,
      toolResult('orphan', 'output'),
    ]);
    expect(blocks).toHaveLength(0);
  });

  it('liveMessageToBlocks maps a single in-progress assistant message', () => {
    const blocks = liveMessageToBlocks(assistant([{ type: 'text', text: 'streaming…' }], { responseId: 'r1' }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toContain('r1');
    expect(validateBlock(blocks[0]).ok).toBe(true);
  });
});
