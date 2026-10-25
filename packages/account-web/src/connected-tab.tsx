import type { RuntimeBrowserConnectedTab } from '@gitspace/protocol-runtime';
import { Monitor01 } from '@untitledui/icons';

/** A tab connected from a pasted share link, as a sent message names it. */
export type ConnectedTabMention = Pick<RuntimeBrowserConnectedTab, 'title' | 'url' | 'browser'>;

/** What the agent reads in place of a pasted share link once its tab joined the workspace. */
export function connectedTabText(tab: RuntimeBrowserConnectedTab): string {
  return `[Connected tab "${tab.title}" (${tab.url}) on ${tab.browser}, pairingId ${tab.pairingId}, targetId ${tab.targetId}; use web_browser with source "relay" and this pairingId]`;
}

/** The connected tabs a sent message names (`connectedTabText`), and its text without them. */
export function connectedTabsIn(text: string): { tabs: ConnectedTabMention[]; text: string } {
  const tabs: ConnectedTabMention[] = [];
  const rest = text.replace(/\[Connected tab "(.*?)" \((\S*?)\) on (.+?), pairingId [0-9a-f-]{36}, targetId \S+?; use web_browser with source "relay" and this pairingId\]\s*/gu, (_match, title: string, url: string, browser: string) => {
    tabs.push({ title, url, browser });
    return '';
  });
  return { tabs, text: rest };
}

/** A tab as a chip: the Chrome icon, its site and, muted, what else identifies it. */
export function TabChip({ host, detail }: { host: string; detail: string | null }) {
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1 text-caption">
    <Monitor01 className="shrink-0" width={13} height={13} />
    <strong className="shrink-0 font-medium">{host}</strong>
    {detail ? <span className="min-w-0 truncate text-muted-foreground">· {detail}</span> : null}
  </span>;
}
