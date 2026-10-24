import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { actOnNode } from '@gitspace/runtime-machine/browser-semantic';
import { AxTree, browserViewPage, renderBrowserView } from '@gitspace/runtime-machine/browser-view';

/** The parts of Playwright a script's tools use: its pages and a CDP session of their own on each. */
export interface ScriptCdpSession { send(method: string, params?: Record<string, unknown>): Promise<unknown> }
export interface ScriptContext<Page> { pages(): Page[]; newCDPSession(page: Page): Promise<ScriptCdpSession> }
/** A Playwright locator as `upload` uses it. */
export interface ScriptLocator<Page> {
  page(): Page;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
  evaluate<Result, Argument>(action: (element: unknown, argument: Argument) => Result, argument: Argument): Promise<Result>;
}
/** A page as `upload` uses it: a locator for an element it marked. */
export interface ScriptPage<Page> { locator(selector: string): ScriptLocator<Page> }
/** One screenshot for `capture`: base64 JPEGs of the visible page and a small one, and the tab they show. */
export type ScriptShot = { name: string | null; targetId: string; page: { url: string; title: string }; image: string; thumbnail: string };
/** The drive files an upload sets: their bytes on the cloud browser; on your Chrome sealed `/files/` links, which the
 * extension fetches itself, so the bytes never cross the relay. */
export type ScriptUploadFiles =
  | { kind: 'bytes'; files: { name: string; mediaType: string; bytes: Uint8Array }[] }
  | { kind: 'links'; files: { url: string; name: string; mediaType: string; size: number }[] };
/** The session's answer to one files call: a value, or why it refused, which the tool throws to the script. */
export type ScriptFilesReply<Value> = { ok: true; value: Value } | { ok: false; error: string };
/** What a script's files go through: the workspace's browser session, the sandbox's only way to the drive. */
export interface ScriptFiles {
  /** Saves a screenshot as a capture in the workspace drive, which the run's result shows; returns the image's address. */
  capture(shot: ScriptShot): Promise<ScriptFilesReply<{ captureId: string; url: string }>>;
  /** The files `drive://workspace/<path>` addresses name, for one upload. */
  uploadFiles(urls: string[]): Promise<ScriptFilesReply<ScriptUploadFiles>>;
}

async function answered<Value>(pending: Promise<ScriptFilesReply<Value>>): Promise<Value> {
  const reply = await pending;
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ loaderId: z.string().min(8) }) }) });
const Resolved = z.object({ object: z.object({ objectId: z.string() }) });
const Element = z.object({ result: z.object({ value: z.object({ connected: z.boolean(), visible: z.boolean(), enabled: z.boolean() }) }) });
const Platform = z.object({ result: z.object({ value: z.string() }) });
const TargetInfo = z.object({ targetInfo: z.object({ targetId: z.string(), url: z.string(), title: z.string() }) });
const LayoutMetrics = z.object({ cssVisualViewport: z.object({ pageX: z.number(), pageY: z.number(), clientWidth: z.number().positive(), clientHeight: z.number().positive() }), visualViewport: z.object({ clientWidth: z.number().positive() }).optional() });
const Screenshot = z.object({ data: z.string().min(1) });
const Marked = z.object({ result: z.object({ objectId: z.string().optional() }) });
const Described = z.object({ node: z.object({ backendNodeId: z.number().int() }) });
/** A capture's image is at most this many pixels on its longer side, within what models take; its thumbnail at most
 * this wide. */
const CAPTURE_PIXELS = 1600, THUMBNAIL_WIDTH = 480;
/** The attribute that names an element for a moment, so a locator or a CDP call can find it. */
const UPLOAD_MARK = 'data-gitspace-upload';
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
 * `view()`, `act()`, `capture()` and `upload()` for one script run (docs/APERTURE-DESIGN.md §6.1). A view is the page
 * as `observe` shows it, with refs `<document>:<node>`: the document is the page's load (its main frame's loader),
 * which a navigation to another document changes and an in-page route change or a back-forward cache restore keeps, so
 * a ref names one node of one document. `act` finds the page whose current load the ref names, in this run or a later
 * one: a ref from a document that is gone fails as stale, never reaching another element.
 */
export function scriptTools<Page extends ScriptPage<Page>>(context: ScriptContext<Page>, files: ScriptFiles) {
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

  /** The open page whose current document a view's ref names, its CDP session and the ref's node. */
  async function refTarget(ref: string): Promise<{ page: Page; cdp: ScriptCdpSession; document: string; backendNodeId: number }> {
    const match = /^([0-9a-f]{8}):(\d+)$/u.exec(String(ref));
    if (!match) throw new Error(`${ref} is not a ref from view(); refs from the browser tool's observe work only with its act action`);
    const document = match[1]!, backendNodeId = Number(match[2]);
    for (const page of context.pages()) {
      const cdp = await session(page);
      if (await documentOf(cdp) === document) return { page, cdp, document, backendNodeId };
    }
    throw new Error(`${ref} is stale: its page navigated or closed since that view; take a new view()`);
  }

  /** Clicks, fills or presses a key on the element a view's ref names, once it is visible and enabled. */
  async function act(ref: string, operation: 'click' | 'fill' | 'press', value?: string): Promise<void> {
    const { cdp: found, document, backendNodeId } = await refTarget(ref);
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

  /** Saves the visible part of a page (the latest unless given) as a capture in the workspace drive and shows it in the
   * run's result. The image is at most 1600 pixels on its longer side; a thumbnail goes with it. */
  async function capture(page?: Page, options: { name?: string } = {}): Promise<{ captureId: string; url: string }> {
    const target = page ?? context.pages().at(-1);
    if (target === undefined) throw new Error('No page is open');
    const cdp = await session(target);
    const { targetInfo } = TargetInfo.parse(await cdp.send('Target.getTargetInfo'));
    const metrics = LayoutMetrics.parse(await cdp.send('Page.getLayoutMetrics'));
    const viewport = metrics.cssVisualViewport;
    // Screenshots come in device pixels; the deprecated visual viewport is the one metric given in them.
    const ratio = metrics.visualViewport ? metrics.visualViewport.clientWidth / viewport.clientWidth : 1;
    const shots: string[] = [];
    for (const [pixels, side, quality] of [[CAPTURE_PIXELS, Math.max(viewport.clientWidth, viewport.clientHeight), 80], [THUMBNAIL_WIDTH, viewport.clientWidth, 60]] as const) {
      const clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: Math.min(1, pixels / (side * ratio)) };
      shots.push(Screenshot.parse(await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false, clip })).data);
    }
    const [image = '', thumbnail = ''] = shots;
    return answered(files.capture({ name: options.name ?? null, targetId: targetInfo.targetId, page: { url: targetInfo.url, title: targetInfo.title }, image, thumbnail }));
  }

  /** Sets a file input's files from the workspace drive (`drive://workspace/<path>`, one or a list): the input as a
   * locator, or as a ref from a view. On the cloud browser Playwright sets the bytes; on your Chrome the extension
   * fetches sealed links to the files itself. */
  async function upload(target: string | ScriptLocator<Page>, urls: string | string[]): Promise<void> {
    const chosen = await answered(files.uploadFiles(Array.isArray(urls) ? urls : [urls]));
    if (typeof target !== 'string' && typeof target?.setInputFiles !== 'function') throw new Error('upload() takes a locator or a ref from view()');
    if (chosen.kind === 'bytes') {
      const buffers = chosen.files.map(file => ({ name: file.name, mimeType: file.mediaType, buffer: Buffer.from(file.bytes) }));
      if (typeof target !== 'string') { await target.setInputFiles(buffers); return; }
      // A ref names a node; Playwright sets files through a locator, so the node is marked for one moment.
      const { page, cdp, backendNodeId } = await refTarget(target);
      const mark = crypto.randomUUID();
      const { objectId } = Resolved.parse(await cdp.send('DOM.resolveNode', { backendNodeId })).object;
      try {
        await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function (mark) { this.setAttribute(${JSON.stringify(UPLOAD_MARK)}, mark); }`, arguments: [{ value: mark }] });
        await page.locator(`[${UPLOAD_MARK}="${mark}"]`).setInputFiles(buffers);
      } finally {
        await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function () { this.removeAttribute(${JSON.stringify(UPLOAD_MARK)}); }` }).catch(() => {});
        await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
      return;
    }
    if (typeof target === 'string') {
      const { cdp, backendNodeId } = await refTarget(target);
      await cdp.send('GitSpace.setInputFilesFromUrls', { backendNodeId, files: chosen.files });
      return;
    }
    // The extension takes a node; the locator's element is held on its window for one moment to find it.
    const key = `${UPLOAD_MARK}:${crypto.randomUUID()}`;
    const top = await target.evaluate((element, name) => {
      Reflect.set(globalThis, Symbol.for(name), element);
      return Reflect.get(globalThis, 'top') === globalThis;
    }, key);
    const cdp = await session(target.page());
    const held = `globalThis[Symbol.for(${JSON.stringify(key)})]`;
    try {
      if (!top) throw new Error('On your Chrome upload() reaches inputs in a page’s top document only');
      const { objectId } = Marked.parse(await cdp.send('Runtime.evaluate', { expression: held })).result;
      if (!objectId) throw new Error('The input left the page before its files were set');
      const { backendNodeId } = Described.parse(await cdp.send('DOM.describeNode', { objectId })).node;
      await cdp.send('Runtime.releaseObject', { objectId });
      await cdp.send('GitSpace.setInputFilesFromUrls', { backendNodeId, files: chosen.files });
    } finally { await cdp.send('Runtime.evaluate', { expression: `delete ${held}` }).catch(() => {}); }
  }

  return { view, act, capture, upload };
}
