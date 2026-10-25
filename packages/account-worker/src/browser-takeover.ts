import { takeoverAsked } from '@gitspace/runtime-core';
import type { WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { RuntimeBrowserHolder } from '@gitspace/protocol-runtime';

/** Take over as the workspace sees it (docs/APERTURE-DESIGN.md §7.2): one holder per tab, the agent or you. While you
 * hold a tab none of the agent's commands reach it; a single step waits for you to hand it back, within its own
 * deadline, and then answers this. Your Chrome refuses a step that reaches a tab you hold with the same words. */
export const BROWSER_TAB_HELD = 'The user is using this tab; ask them with ask_takeover or wait';
/** A tab of one of the workspace's groups (your Chrome's, or the cloud browser's). */
export type BrowserTabTarget = { groupId: string; targetId: string };
/** What waits for each tab to come back, by workspace, group and tab: calls in this workspace object. */
const handbacks = new Map<string, Set<() => void>>();
const handbackKey = (workspaceId: string, target: BrowserTabTarget) => JSON.stringify([workspaceId, target.groupId, target.targetId]);
/** Where the workspace notes that the agent was told you took a tab (the hold's `since`), so it hears the handback too. */
const toldKey = (target: BrowserTabTarget) => `runtime.browser.told:${target.groupId}:${target.targetId}`;

/** Resolves when you hand the tab back, at once when `held` says you do not hold it, and rejects with the signal's
 * reason when it aborts. Nothing polls: `handedBack` wakes it. `held` is asked after the wait is in place, so a handback
 * between the two is not missed. */
export async function waitForHandback(workspaceId: string, target: BrowserTabTarget, held: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const key = handbackKey(workspaceId, target), done = Promise.withResolvers<void>();
  const waiters = handbacks.get(key) ?? new Set<() => void>();
  handbacks.set(key, waiters);
  const resolve = () => done.resolve();
  const abort = () => done.reject(signal.reason);
  waiters.add(resolve);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (await held()) await done.promise;
  } finally {
    signal.removeEventListener('abort', abort);
    waiters.delete(resolve);
    if (!waiters.size && handbacks.get(key) === waiters) handbacks.delete(key);
  }
}

/** The browser a group is on, as the agent's events name it. */
export type BrowserHolderSource = { source: 'chrome' | 'cloud'; pairingId: string | null; groupId: string; name: string };
/**
 * A group's tabs you hold changed from `before` to `after`. Whatever waits for a tab that came back continues. The
 * main conversation hears `browser-taken` when you took a tab the agent was acting on (`acting`) or one its open
 * ask_takeover card names, and `browser-handback` for a tab it heard was taken, or one such a card names; its refs on
 * that tab no longer apply. `note` says why a tab came back without your Resume agent.
 */
export async function holdersChanged(input: {
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> };
  workspaceId: string;
  runtime(): Promise<Pick<WorkspaceRuntime, 'harness' | 'browserEvent'>>;
  browser: BrowserHolderSource;
  before: readonly RuntimeBrowserHolder[];
  after: readonly RuntimeBrowserHolder[];
  acting(targetId: string): boolean;
  page(targetId: string): { url: string; title: string } | undefined;
  note?: string;
}): Promise<void> {
  const { browser } = input, groupId = browser.groupId;
  const taken = input.after.filter(holder => !input.before.some(prior => prior.targetId === holder.targetId));
  const returned = input.before.filter(holder => !input.after.some(current => current.targetId === holder.targetId));
  for (const holder of returned) for (const resolve of handbacks.get(handbackKey(input.workspaceId, { groupId, targetId: holder.targetId })) ?? []) resolve();
  if (!taken.length && !returned.length) return;
  const runtime = await input.runtime();
  const sender = { id: groupId, name: browser.name };
  const named = (targetId: string) => {
    const page = input.page(targetId);
    return `tab ${targetId}${page ? ` (${page.title || page.url})` : ''} in ${browser.name}`;
  };
  const payload = (holder: RuntimeBrowserHolder, at: string) => ({ groupId, targetId: holder.targetId, source: browser.source, pairingId: browser.pairingId, at, by: holder.by });
  for (const holder of taken) {
    const target = { groupId, targetId: holder.targetId };
    if (!input.acting(holder.targetId) && !await takeoverAsked(runtime.harness, target)) continue;
    await input.storage.put(toldKey(target), holder.since);
    await runtime.browserEvent({ kind: 'browser-taken', requestId: `browser-taken:${groupId}:${holder.targetId}:${holder.since}`, sender, payload: payload(holder, holder.since),
      text: `The user took over ${named(holder.targetId)}. None of your browser commands reach that tab until they hand it back: a single step on it waits, and a script stops at its next command there. Other tabs are unaffected. You are told when they hand it back.` });
  }
  const at = new Date().toISOString();
  for (const holder of returned) {
    const target = { groupId, targetId: holder.targetId };
    const told = await input.storage.get(toldKey(target)) === holder.since;
    if (told) await input.storage.delete(toldKey(target));
    if (!told && !await takeoverAsked(runtime.harness, target)) continue;
    await runtime.browserEvent({ kind: 'browser-handback', requestId: `browser-handback:${groupId}:${holder.targetId}:${at}`, sender, payload: payload(holder, at),
      text: input.note ? `The user's hold on ${named(holder.targetId)} ended: ${input.note}` : `The user handed ${named(holder.targetId)} back to you. They may have changed the page, and your earlier refs and observations of it no longer apply: observe it again before acting.` });
  }
}
