// The Inbox as the board and the rail use it: the rows (rows.tsx), the sources under one provider (data.ts), and the
// count the rail's badge and Needs you show (model.ts, decision 2a).
import { useMemo } from 'react';
import type { WaitingItem } from '@gitspace/protocol-workspace';
import { useInboxSources } from './data.js';
import { useHeldActions } from './held.js';
import { inboxCount, needsYou, workspaceItems, type Scope } from './model.js';

export { InboxProvider, InboxSourcesContext } from './data.js';
export { AccountRows, InboxRows, type OpenWorkspace } from './rows.js';
export type { Scope } from './model.js';

/** The badge's count in `scope` (null: every project): fresh rows that block work, issues and stale rows left out. */
export function useInboxCount(scope: Scope): number {
  const sources = useInboxSources();
  const held = useHeldActions();
  return inboxCount(sources, scope, key => held.cleared(key), Date.now());
}

/** The workspaces with a counted row: the Needs you filter. */
export function useNeedsYou(): ReadonlySet<string> {
  const sources = useInboxSources();
  const held = useHeldActions();
  const revision = held.revision();
  return useMemo(() => needsYou(sources, key => held.cleared(key), Date.now()), [sources, held, revision]);
}

const SUMMARY_KIND: Record<WaitingItem['kind'], 'question' | 'plan' | 'problem' | 'approval'> = {
  ask: 'question', plan: 'plan', approval: 'approval', 'lifecycle-approval': 'approval', takeover: 'question', 'secure-input': 'question', 'mcp-elicitation': 'question',
  failed: 'problem', 'setup-failed': 'problem', conflict: 'problem',
};

/** A compact card's line: the workspace's oldest open item and how many are open. */
export function useWaitingSummary(workspaceId: string): { text: string; kind: 'question' | 'plan' | 'problem' | 'approval'; count: number } | null {
  const sources = useInboxSources();
  const held = useHeldActions();
  const open = workspaceItems(sources, null).filter(entry => entry.workspaceId === workspaceId && !held.cleared(entry.key));
  const first = open[0];
  if (!first) return null;
  const title = first.item.title.replace(/\s+/gu, ' ').trim();
  return { text: open.length > 1 ? `${title} · +${open.length - 1}` : title, kind: SUMMARY_KIND[first.item.kind], count: open.length };
}
