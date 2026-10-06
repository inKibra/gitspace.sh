import { RuntimeChildAgentsArgumentsSchema } from './tool-arguments.js';
import { RuntimeBrowserArgumentsSchema } from './browser.js';

/** Fixed capability ceiling; a saved definition may only narrow these tools. */
export const SUBAGENT_READONLY_TOOLS = ['read', 'grep', 'find', 'web_search', 'ast_grep', 'history_search', 'history_read', 'todo', 'browser', 'agents'] as const;
export function isSubagentReadonlyTool(name: string): boolean { return SUBAGENT_READONLY_TOOLS.some(tool => tool === name); }
export function isSubagentToolCallAllowed(name: string, args: unknown): boolean {
  if (name === 'browser') {
    const parsed = RuntimeBrowserArgumentsSchema.safeParse(args);
    return parsed.success && parsed.data.source === 'headless';
  }
  return name === 'rule_match_ast' || (isSubagentReadonlyTool(name) && (name !== 'agents' || RuntimeChildAgentsArgumentsSchema.safeParse(args).success));
}
