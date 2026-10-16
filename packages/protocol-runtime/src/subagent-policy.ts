import { RuntimeChildAgentsArgumentsSchema } from './tool-arguments.js';
import { RuntimeBrowserArgumentsSchema } from './browser.js';

/** A subagent's tools when its definition lists none. */
export const SUBAGENT_READONLY_TOOLS = ['read', 'grep', 'code_search', 'find', 'web_search', 'ast_grep', 'history_search', 'history_read', 'todo', 'browser', 'agents', 'workspace_status'] as const;
/** Every tool a definition may list: the read-only set plus commands and MCP tools, for agents that use the product. */
export const SUBAGENT_TOOLS = [...SUBAGENT_READONLY_TOOLS, 'bash', 'proc', 'mcp_discover', 'mcp_invoke'] as const;
export function isSubagentTool(name: string): boolean { return SUBAGENT_TOOLS.some(tool => tool === name); }
/** `tools` is the child's own list. Children never spawn or stop agents and only use the headless browser. */
export function isSubagentToolCallAllowed(name: string, args: unknown, tools: readonly string[]): boolean {
  if (!tools.includes(name) || !isSubagentTool(name)) return false;
  if (name === 'browser') {
    const parsed = RuntimeBrowserArgumentsSchema.safeParse(args);
    return parsed.success && parsed.data.source === 'headless';
  }
  return name !== 'agents' || RuntimeChildAgentsArgumentsSchema.safeParse(args).success;
}
