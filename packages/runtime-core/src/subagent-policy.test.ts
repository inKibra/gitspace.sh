import { expect, test } from 'vitest';
import { RuntimeAgentsArgumentsSchema, SUBAGENT_READONLY_TOOLS, isSubagentToolCallAllowed } from '@gitspace/protocol-runtime';
import { parseCloudAgentDefinition } from './session-controls.js';

test('agent files reject tools no subagent may use visibly when loaded', () => {
  expect(parseCloudAgentDefinition('.agents/agents/tester.md', '---\ntools: read, bash, mcp_invoke\n---\nUse the product.').tools).toEqual(['read', 'bash', 'mcp_invoke']);
  expect(() => parseCloudAgentDefinition('.agents/agents/review.md', '---\nmodel: pi/review\ntools: read, write\n---\nInspect source.')).toThrow(/cannot use: write/);
});
test('messages use an address and reject the obsolete id argument', () => {
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', to: 'Reviewer', message: 'Check the boundary' }).success).toBe(true);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', id: 'Reviewer', message: 'Check the boundary' }).success).toBe(false);
});

test('a child uses only its own tools, the headless browser and the list of Chromes, and never spawns', () => {
  const readOnly = [...SUBAGENT_READONLY_TOOLS];
  expect(isSubagentToolCallAllowed('todo', { items: [] }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('bash', { command: 'ls' }, readOnly)).toBe(false);
  expect(isSubagentToolCallAllowed('bash', { command: 'ls' }, [...readOnly, 'bash'])).toBe(true);
  expect(isSubagentToolCallAllowed('write', { path: 'a', content: 'b' }, [...readOnly, 'write'])).toBe(false);
  expect(isSubagentToolCallAllowed('browser', { action: 'tabs' }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'tabs', source: 'relay' }, readOnly)).toBe(false);
  expect(isSubagentToolCallAllowed('browser', { action: 'chromes' }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('agents', { op: 'send', to: 'parent', message: 'Result' }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('agents', { op: 'spawn', role: 'review', task: 'Nested' }, readOnly)).toBe(false);
});
test('a child reads captures and replays one on the headless browser, but never on the user’s Chrome and never saves one as a skill', () => {
  const readOnly = [...SUBAGENT_READONLY_TOOLS], capture = '6f0c2a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
  expect(isSubagentToolCallAllowed('browser', { action: 'captures' }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'capture', capture }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'replay', capture }, readOnly)).toBe(true);
  expect(isSubagentToolCallAllowed('browser', { action: 'replay', capture, source: 'relay' }, readOnly)).toBe(false);
  expect(isSubagentToolCallAllowed('browser', { action: 'captureSaved', capture, path: '.gitspace/skills/sign-in' }, readOnly)).toBe(false);
});
