import { z } from 'zod';
import { actOnNode } from '@gitspace/runtime-machine/browser-semantic';
import { AxTree, browserViewPage, renderBrowserView } from '@gitspace/runtime-machine/browser-view';

/** The parts of Playwright a script's tools use: its pages and a CDP session of their own on each. */
export interface ScriptCdpSession { send(method: string, params?: Record<string, unknown>): Promise<unknown> }
export interface ScriptContext<Page> { pages(): Page[]; newCDPSession(page: Page): Promise<ScriptCdpSession> }

const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ loaderId: z.string().min(8) }) }) });
const Resolved = z.object({ object: z.object({ objectId: z.string() }) });
const Element = z.object({ result: z.object({ value: z.object({ connected: z.boolean(), visible: z.boolean(), enabled: z.boolean() }) }) });
const Platform = z.object({ result: z.object({ value: z.string() }) });
/** How long `act` waits for its element to show and be enabled. */
const ACT_WAIT_MS = 5_000;
/** Whether the element is still in its page, has a box, and takes input. */
const ELEMENT_STATE = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element) return { connected: false, visible: false, enabled: false };
  const box = element.getBoundingClientRect(), style = getComputedStyle(element);
  return {
    connected: this.isConnected && this.ownerDocument === document,
    visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden',
    enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
  };
}`;

/**
 * `view()` and `act()` for one script run (docs/APERTURE-DESIGN.md §6.1). A view is the page as `observe` shows it,
 * with refs `<document>:<node>`: the document is the page's load (its main frame's loader), which a navigation to
 * another document changes and an in-page route change or a back-forward cache restore keeps, so a ref names one node
 * of one document. `act` finds the page whose current load the ref names, in this run or a later one: a ref from a
 * document that is gone fails as stale, never reaching another element.
 */
export function scriptTools<Page>(context: ScriptContext<Page>) {
  const sessions = new Map<Page, Promise<ScriptCdpSession>>();
  const modifiers = new Map<ScriptCdpSession, Promise<number>>();
  const session = (page: Page): Promise<ScriptCdpSession> => {
    let opened = sessions.get(page);
    if (!opened) { opened = context.newCDPSession(page); sessions.set(page, opened); }
    return opened;
  };
  const documentOf = async (cdp: ScriptCdpSession): Promise<string> => FrameTree.parse(await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId.slice(0, 8).toLowerCase();

  /** The page as `observe` shows it (the latest page unless given), from line `offset`. */
  async function view(page?: Page, offset = 0): Promise<string> {
    const target = page ?? context.pages().at(-1);
    if (target === undefined) throw new Error('No page is open');
    const cdp = await session(target);
    const document = await documentOf(cdp);
    const tree = AxTree.parse(await cdp.send('Accessibility.getFullAXTree', { depth: 32 }));
    if (await documentOf(cdp) !== document) throw new Error('The page navigated while it was read; view it again');
    const lines = renderBrowserView(tree.nodes, document);
    const shown = browserViewPage(lines, offset, lines.length);
    const text = shown.lines.map(line => line.text).join('\n');
    return shown.nextOffset === null ? text : `${text}\n… lines ${offset + 1}–${shown.nextOffset} of ${lines.length}; view(page, ${shown.nextOffset}) continues`;
  }

  /** Clicks, fills or presses a key on the element a view's ref names, once it is visible and enabled. */
  async function act(ref: string, operation: 'click' | 'fill' | 'press', value?: string): Promise<void> {
    const match = /^([0-9a-f]{8}):(\d+)$/u.exec(String(ref));
    if (!match) throw new Error(`${ref} is not a ref from view(); refs from the browser tool's observe work only with its act action`);
    const document = match[1]!, backendNodeId = Number(match[2]);
    let cdp: ScriptCdpSession | undefined;
    for (const page of context.pages()) {
      const candidate = await session(page);
      if (await documentOf(candidate) === document) { cdp = candidate; break; }
    }
    if (!cdp) throw new Error(`${ref} is stale: its page navigated or closed since that view; take a new view()`);
    const found = cdp;
    const deadline = Date.now() + ACT_WAIT_MS;
    for (;;) {
      let objectId: string;
      try { objectId = Resolved.parse(await found.send('DOM.resolveNode', { backendNodeId })).object.objectId; }
      catch { throw new Error(`${ref} is stale: that element left the page; take a new view()`); }
      let state: z.infer<typeof Element>['result']['value'];
      try { state = Element.parse(await found.send('Runtime.callFunctionOn', { objectId, functionDeclaration: ELEMENT_STATE, returnByValue: true })).result.value; }
      finally { await found.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
      if (!state.connected) throw new Error(`${ref} is stale: that element left the page; take a new view()`);
      if (state.visible && state.enabled) break;
      if (Date.now() >= deadline) throw new Error(`${ref} is still ${state.visible ? 'disabled' : 'not visible'} after ${ACT_WAIT_MS / 1000} s`);
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 100);
      await pause.promise;
    }
    let modifier = modifiers.get(found);
    if (!modifier) {
      // Select-all is Meta+A on a Mac and Ctrl+A elsewhere.
      modifier = found.send('Runtime.evaluate', { expression: 'navigator.platform', returnByValue: true }).then(result => Platform.parse(result).result.value.startsWith('Mac') ? 4 : 2);
      modifiers.set(found, modifier);
    }
    await actOnNode((method, params) => found.send(method, params), backendNodeId, operation, value, await modifier, async () => await documentOf(found) === document);
  }

  return { view, act };
}
