import { describe, expect, it } from 'bun:test';
import type { Message, ToolResultMessage } from '@oh-my-pi/pi-ai';

import { validateBlock, type Block } from '../../index.js';
import { subagentData, toolCallData, imageData, ruleActivationData } from '../../types/transcript.js';
import { codeData } from '../../types/content.js';
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

interface TaskResult {
  id: string;
  agent: string;
  description?: string;
  modelOverride?: string[];
  resolvedModel?: string;
  exitCode: number;
  output: string;
}

interface TaskDetails {
  results: TaskResult[];
}

function taskToolResult(toolCallId: string, details: TaskDetails): ToolResultMessage<TaskDetails> {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'task',
    content: [{ type: 'text', text: 'Task complete' }],
    details,
    isError: false,
    timestamp: 0,
  };
}

function nestedTaskResultBlocks(blocks: readonly Block[]): Block[] {
  const task = blocks.find((block) => block.type === 'tool-call');
  if (!task) throw new Error('Expected a task tool-call block');
  const data = toolCallData.parse(task.data);
  if (data.tool !== 'task') throw new Error(`Expected task tool, received ${data.tool}`);
  return data.result ?? [];
}

function toolData(blocks: readonly Block[], tool: string) {
  const block = blocks.find((candidate) => candidate.type === 'tool-call' && toolCallData.parse(candidate.data).tool === tool);
  if (!block) throw new Error(`Expected ${tool} tool-call block`);
  return toolCallData.parse(block.data);
}

function richToolResult(toolCallId: string, toolName: string, content: unknown[], details: unknown): ToolResultMessage {
  return { role: 'toolResult', toolCallId, toolName, content, details, isError: false, timestamp: 0 } as ToolResultMessage;
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

  it('projects every completed batch-task result into a labeled subagent card with user-facing model roles', () => {
    const blocks = messagesToBlocks([
      assistant([
        {
          type: 'toolCall',
          id: 'batch-roles',
          name: 'task',
          arguments: {
            agent: 'task',
            context: 'Audit the release candidate.',
            tasks: [
              { assignment: 'Check fast paths' },
              { assignment: 'Review error handling' },
              { assignment: 'Design the rollout' },
              { assignment: 'Verify the current configuration' },
            ],
          },
        },
      ]),
      taskToolResult('batch-roles', {
        results: [
          { id: 'fast-audit', agent: 'task', description: 'Fast-path audit', modelOverride: ['pi/smol'], exitCode: 0, output: 'Fast paths verified.' },
          { id: 'failure-review', agent: 'task', description: 'Failure review', modelOverride: ['pi/slow'], exitCode: 0, output: 'Failure paths reviewed.' },
          { id: 'rollout-design', agent: 'task', description: 'Rollout design', modelOverride: ['pi/plan'], exitCode: 0, output: 'Rollout designed.' },
          { id: 'session-check', agent: 'task', description: 'Session check', modelOverride: ['pi/task'], exitCode: 0, output: 'Session configuration checked.' },
        ],
      }),
    ]);

    const nested = nestedTaskResultBlocks(blocks);
    const cards = nested.filter((block) => block.type === 'subagent');
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(validateBlock(card).ok).toBe(true);
    expect(cards.map((card) => {
      const data = subagentData.parse(card.data);
      return { label: data.label, model: data.model, status: data.status };
    })).toEqual([
      { label: 'Fast-path audit', model: 'Fast', status: 'done' },
      { label: 'Failure review', model: 'Thinking', status: 'done' },
      { label: 'Rollout design', model: 'Architect', status: 'done' },
      { label: 'Session check', model: 'Current model', status: 'done' },
    ]);
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

  it('retains every retain item and recall query argument while keeping concise targets', () => {
    const retainArgs = {
      items: [
        { content: 'Preserve the original parser boundary.', context: 'Transcript projection' },
        { content: 'Keep image content available to callers.', context: 'Tool result rendering' },
      ],
    };
    const recallArgs = {
      query: 'Search transcript records for the migration note about preserving tool-call arguments and image blocks',
      limit: 12,
      context: 'agent session history',
    };
    const blocks = messagesToBlocks([assistant([
      { type: 'toolCall', id: 'retain-args', name: 'retain', arguments: retainArgs },
      { type: 'toolCall', id: 'recall-args', name: 'recall', arguments: recallArgs },
    ])]);

    const retain = toolData(blocks, 'retain');
    expect(retain.args).toEqual(retainArgs);
    expect(retain.target).toBe('2 items');

    const recall = toolData(blocks, 'recall');
    expect(recall.args).toEqual(recallArgs);
    expect(recall.target).toBe('Search transcript records for the migration note about preserving tool-call argu…');
  });

  it('preserves unknown tool args/details and projects assistant and tool-result images', () => {
    const args = {
      command: 'status',
      payload: { files: ['src/blocks/agent/message-blocks.ts'], includeImages: true },
      notes: 'first line\nsecond line',
    };
    const details = { requestId: 'req-42', metrics: { files: 1, images: 1 } };
    const blocks = messagesToBlocks([
      assistant([
        { type: 'image', mimeType: 'image/jpeg', data: 'ASSISTANT_IMAGE' },
        { type: 'toolCall', id: 'unknown-args', name: 'mystery_tool', arguments: args },
      ]),
      richToolResult('unknown-args', 'mystery_tool', [{ type: 'image', mimeType: 'image/png', data: 'TOOL_IMAGE' }], details),
    ]);

    const assistantImage = blocks.find((block) => block.type === 'image');
    if (!assistantImage) throw new Error('Expected assistant image block');
    expect(imageData.parse(assistantImage.data).src).toBe('data:image/jpeg;base64,ASSISTANT_IMAGE');

    const mystery = toolData(blocks, 'mystery_tool');
    expect(mystery.target).toBe('status');
    expect(mystery.args).toEqual(args);
    expect(mystery.details).toEqual(details);
    const toolImage = mystery.result?.find((block) => block.type === 'image');
    if (!toolImage) throw new Error('Expected tool-result image block');
    expect(imageData.parse(toolImage.data).src).toBe('data:image/png;base64,TOOL_IMAGE');
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

  it('surfaces a rule activation as its own block instead of burying it in the output', () => {
    // Real shape: the harness prepends the reminder as an extra text part on the
    // toolResult. Joined into the output it renders as escaped XML inside the
    // collapsed result body, attributed to nobody.
    const result = {
      role: 'toolResult',
      toolCallId: 'tc-rule',
      toolName: 'edit',
      isError: false,
      timestamp: 0,
      content: [
        { type: 'text', text: '<system-reminder reason="rule_violation" rule="ts-set-map" path="builtin-defaults:ts-set-map.md">\nUse Record for small, static lookup tables.\n</system-reminder>' },
        { type: 'text', text: '[a.ts#1234]\n1:const x = 1;' },
      ],
    } as unknown as Message;
    const blocks = messagesToBlocks([
      assistant([{ type: 'toolCall', id: 'tc-rule', name: 'edit', arguments: { path: 'a.ts' } }]),
      result,
    ]);

    const nested = toolCallData.parse(blocks.find((b) => b.type === 'tool-call')!.data).result ?? [];
    const rule = nested.find((b) => b.type === 'rule-activation');
    expect(rule).toBeDefined();
    expect(validateBlock(rule!).ok).toBe(true);
    expect(ruleActivationData.parse(rule!.data).rule).toBe('ts-set-map');

    // …and the tool's own output is still there, without the XML debris.
    const out = nested.find((b) => b.type === 'code');
    expect(out).toBeDefined();
    const text = codeData.parse(out!.data).text;
    expect(text).toContain('const x = 1;');
    expect(text).not.toContain('system-reminder');
  });
});
