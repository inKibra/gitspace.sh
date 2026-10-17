import { expect, test } from 'vitest';
import { discoveredMcpTools } from '@gitspace/protocol-runtime';
import { invokeMcpNamespace } from '../src/runtime-mcp.js';

// A toolkit the size of Composio's Notion: dozens of tools, each with a large input schema and description.
const toolkit = Array.from({ length: 60 }, (_, index) => ({
  name: `NOTION_TOOL_${index}`,
  description: `Notion operation ${index}. ${'Detailed guidance. '.repeat(60)}`,
  inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, field) => [`field_${field}`, { type: 'string', description: 'x'.repeat(80) }])) },
}));

test('a large toolkit lists within the tool result limit and describes one tool in full', async () => {
  expect(JSON.stringify(toolkit).length).toBeGreaterThan(50 * 1024);
  const listed = discoveredMcpTools(toolkit, undefined);
  expect(JSON.stringify(listed).length).toBeLessThan(25 * 1024);
  expect(discoveredMcpTools(toolkit, 'NOTION_TOOL_7')).toEqual(toolkit[7]);
  expect(() => discoveredMcpTools(toolkit, 'NOTION_MISSING')).toThrow('NOTION_MISSING is not exposed');

  // Codemode's namespace reads the compact listing, then discovers the one described tool by name.
  const calls: unknown[] = [];
  const execute = async (tool: 'mcp_discover' | 'mcp_invoke', args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === 'mcp_invoke') return { ok: true };
    if (!('connectionId' in args)) return [{ connectionId: 'composio-notion' }];
    return JSON.parse(JSON.stringify(discoveredMcpTools(toolkit, typeof args.name === 'string' ? args.name : undefined)));
  };
  expect(await invokeMcpNamespace('search', { query: 'operation 7.' }, execute)).toEqual([expect.objectContaining({ name: 'NOTION_TOOL_7', connectionId: 'composio-notion' })]);
  const described = await invokeMcpNamespace('describe', { name: 'NOTION_TOOL_7' }, execute);
  expect(described).toMatchObject({ name: 'NOTION_TOOL_7', inputSchema: toolkit[7]!.inputSchema, connectionId: 'composio-notion', qualifiedName: 'composio-notion.NOTION_TOOL_7' });
  expect(calls).toContainEqual({ tool: 'mcp_discover', args: { connectionId: 'composio-notion', name: 'NOTION_TOOL_7' } });
});
