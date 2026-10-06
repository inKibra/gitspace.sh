import { expect, test } from 'vitest';
import { RuntimeAgentsArgumentsSchema, isSubagentToolCallAllowed } from '@gitspace/protocol-runtime';
import { parseCloudAgentDefinition } from './session-controls.js';

test('spawn requires an explicit definition or role rather than an address or parent inheritance', () => {
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', task: 'Inspect source' }).success).toBe(false);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', name: 'Reviewer', task: 'Inspect source' }).success).toBe(false);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', agent: 'review', role: 'review', task: 'Inspect source' }).success).toBe(false);
});
test('agent files reject effectful tools visibly when loaded', () => {
  expect(() => parseCloudAgentDefinition('.agents/agents/review.md', '---\nmodel: pi/review\ntools: read, bash\n---\nInspect source.')).toThrow(/read.only|disallowed/i);
});
test('messages use an address and reject the obsolete id argument', () => {
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', to: 'Reviewer', message: 'Check the boundary' }).success).toBe(true);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', id: 'Reviewer', message: 'Check the boundary' }).success).toBe(false);
});

test('child capabilities include local planning and headless browsing but reject relay access', () => {
  expect(isSubagentToolCallAllowed('todo', { items: [] })).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'tabs' })).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'tabs', source: 'relay' })).toBe(false);
  expect(isSubagentToolCallAllowed('agents', { op: 'send', to: 'parent', message: 'Result' })).toBe(true);
  expect(isSubagentToolCallAllowed('agents', { op: 'spawn', role: 'review', task: 'Nested' })).toBe(false);
});
