import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPOSIO_TOOL_POLICY, composioToolAllowed } from '@gitspace/protocol/mcp-contract';
import { composioToolPolicySummary, pruneComposioToolPolicy, setComposioTool, setComposioToolGroup } from './composio-tool-policy.js';

const search = { slug: 'NOTION_SEARCH', readOnly: true, destructive: false };
const create = { slug: 'NOTION_CREATE_PAGE', readOnly: false, destructive: false };
const archive = { slug: 'NOTION_ARCHIVE_PAGE', readOnly: true, destructive: true };
const tools = [search, create, archive];

describe('Composio tool policy editing', () => {
  it('lets tools added later follow their group while exceptions pin individual tools', () => {
    const policy = setComposioTool(setComposioToolGroup(DEFAULT_COMPOSIO_TOOL_POLICY, tools, 'destructive', false), create, false);
    expect(policy).toEqual({ groups: { readOnly: true, write: true, destructive: false }, allow: [], deny: ['NOTION_CREATE_PAGE'] });
    expect(composioToolAllowed(policy, archive)).toBe(false);
    expect(composioToolAllowed(policy, { slug: 'NOTION_DELETE_BLOCK', readOnly: false, destructive: true })).toBe(false);
    expect(composioToolAllowed(policy, { slug: 'NOTION_UPDATE_PAGE', readOnly: false, destructive: false })).toBe(true);
    expect(composioToolPolicySummary(policy)).toBe('Read-only and write allowed · 1 exception');
  });

  it('drops an exception when a tool is switched back to its group setting, and a group switch clears its exceptions', () => {
    const excepted = setComposioTool(setComposioToolGroup(DEFAULT_COMPOSIO_TOOL_POLICY, tools, 'write', false), create, true);
    expect(excepted.allow).toEqual(['NOTION_CREATE_PAGE']);
    expect(setComposioTool(excepted, create, false).allow).toEqual([]);
    expect(setComposioToolGroup(excepted, tools, 'write', false)).toEqual({ ...excepted, allow: [] });
  });

  it('prunes exceptions for tools the toolkit no longer offers before saving', () => {
    const stale = { ...DEFAULT_COMPOSIO_TOOL_POLICY, deny: ['NOTION_SEARCH', 'NOTION_REMOVED_TOOL'] };
    expect(pruneComposioToolPolicy(stale, tools).deny).toEqual(['NOTION_SEARCH']);
  });
});
