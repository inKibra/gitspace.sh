import { composioToolGroup, type ComposioToolGroup, type ComposioToolPolicy } from '@gitspace/protocol/mcp-contract';

type Tool = { slug: string; readOnly: boolean; destructive: boolean };

export const COMPOSIO_TOOL_GROUPS: readonly { group: ComposioToolGroup; label: string }[] = [
  { group: 'readOnly', label: 'Read-only' },
  { group: 'write', label: 'Write' },
  { group: 'destructive', label: 'Destructive' },
];

/** Setting a group decides every tool in it, so the group's exceptions are cleared. */
export function setComposioToolGroup(policy: ComposioToolPolicy, tools: readonly Tool[], group: ComposioToolGroup, allowed: boolean): ComposioToolPolicy {
  const members = tools.filter((tool) => composioToolGroup(tool) === group).map((tool) => tool.slug);
  return {
    groups: { ...policy.groups, [group]: allowed },
    allow: policy.allow.filter((slug) => !members.includes(slug)),
    deny: policy.deny.filter((slug) => !members.includes(slug)),
  };
}

/** A tool records an exception only while it differs from its group's setting. */
export function setComposioTool(policy: ComposioToolPolicy, tool: Tool, allowed: boolean): ComposioToolPolicy {
  const allow = policy.allow.filter((slug) => slug !== tool.slug);
  const deny = policy.deny.filter((slug) => slug !== tool.slug);
  if (allowed !== policy.groups[composioToolGroup(tool)]) (allowed ? allow : deny).push(tool.slug);
  return { groups: { ...policy.groups }, allow, deny };
}

/** Exceptions for tools Composio no longer offers would fail validation, so they are dropped before saving. */
export function pruneComposioToolPolicy(policy: ComposioToolPolicy, tools: readonly Tool[]): ComposioToolPolicy {
  const offered = tools.map((tool) => tool.slug);
  return { groups: { ...policy.groups }, allow: policy.allow.filter((slug) => offered.includes(slug)), deny: policy.deny.filter((slug) => offered.includes(slug)) };
}

/** Connection views arrive as read-only wire data, so the summary accepts either form. */
export function composioToolPolicySummary(policy: { readonly groups: Readonly<Record<ComposioToolGroup, boolean>>; readonly allow: readonly string[]; readonly deny: readonly string[] }): string {
  const on = COMPOSIO_TOOL_GROUPS.filter(({ group }) => policy.groups[group]).map(({ label }, index) => index === 0 ? label : label.toLowerCase());
  const base = on.length === COMPOSIO_TOOL_GROUPS.length ? 'All tools allowed' : on.length === 0 ? 'All tools denied' : `${on.join(' and ')} allowed`;
  const exceptions = policy.allow.length + policy.deny.length;
  return exceptions === 0 ? base : `${base} · ${exceptions} ${exceptions === 1 ? 'exception' : 'exceptions'}`;
}
