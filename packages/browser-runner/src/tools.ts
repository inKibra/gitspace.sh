import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { actOnNode } from '@gitspace/runtime-machine/browser-semantic';
import { AxTree, browserViewPage, renderBrowserView } from '@gitspace/runtime-machine/browser-view';

/** The parts of Playwright a script's tools use: its pages and a CDP session of their own on each. */
export interface ScriptCdpSession { send(method: string, params?: Record<string, unknown>): Promise<unknown> }
export interface ScriptContext<Page> { pages(): Page[]; newCDPSession(page: Page): Promise<ScriptCdpSession> }
/** A Playwright locator as `upload` uses it: its file call, which takes drive addresses as `setInputFiles` does. */
export interface ScriptLocator { setInputFiles(files: unknown): Promise<void> }
/** A page as the tools use it: a locator for an element they marked, and its events (`download`). */
export interface ScriptPage { locator(selector: string): ScriptLocator; emit(event: string, value: unknown): boolean }
/** A file a Playwright file call sets from memory, as Playwright takes it. */
export type ScriptFilePayload = { name: string; mimeType: string; buffer: Buffer };
/** Where one Playwright file call sets files (`setInputFiles` of a locator, page, frame or element handle, and a file
 * chooser's `setFiles`): the input as Playwright finds it, which never needs the page's own JavaScript world. */
export interface ScriptInputTarget<Page> {
  /** How a refusal names it: the selector, or "the element". */
  description: string;
  /** The page the input is on; null once the element left it. */
  page(): Promise<Page | null>;
  /** The input's attribute `name`, read by Playwright in its isolated world (waiting for the element as it would). */
  attribute(name: string): Promise<string | null>;
  /** Playwright's own call with files from memory (an empty list clears the input). */
  set(files: ScriptFilePayload[]): Promise<void>;
}
/** One screenshot for `capture`: base64 JPEGs of the visible page and a small one, and the tab they show. */
export type ScriptShot = { name: string | null; targetId: string; page: { url: string; title: string }; image: string; thumbnail: string };
/** The drive files an upload sets: their bytes on the cloud browser; on your Chrome sealed `/files/` links, which the
 * extension fetches itself, so the bytes never cross the relay. */
export type ScriptUploadFiles =
  | { kind: 'bytes'; files: { name: string; mediaType: string; bytes: Uint8Array }[] }
  | { kind: 'links'; files: { url: string; name: string; mediaType: string; size: number }[] };
/** How a download ended: saved at its drive address (`drive://workspace/<path>`) with its size and type, or not saved
 * and why. */
export type ScriptDownloadOutcome = { file: string; size: number; mediaType: string } | { error: string };
/** A download one of the run's pages started, as the session follows it: `outcome` is null while it is being saved. */
export type ScriptDownload = {
  id: string;
  /** The tab that started it; null when the browser did not say. */
  targetId: string | null;
  /** Where it came from; '' when the browser did not say. */
  url: string;
  name: string;
  outcome: ScriptDownloadOutcome | null;
};
/** The session's answer to one files call: a value, or why it refused, which the tool throws to the script. */
export type ScriptFilesReply<Value> = { ok: true; value: Value } | { ok: false; error: string };
/** What a script's files go through: the workspace's browser session, the sandbox's only way to the drive. */
export interface ScriptFiles {
  /** Saves a screenshot as a capture in the workspace drive, which the run's result shows; returns the image's address. */
  capture(shot: ScriptShot): Promise<ScriptFilesReply<{ captureId: string; url: string }>>;
  /** The files `drive://workspace/<path>` addresses name, for one upload. */
  uploadFiles(urls: string[]): Promise<ScriptFilesReply<ScriptUploadFiles>>;
  /** The run's downloads once their list differs from `version` (a count of starts and settles): at once when it
   * does, else when a download starts or settles, or the run ends (`ended`). */
  downloads(version: number): Promise<ScriptFilesReply<{ version: number; ended: boolean; downloads: ScriptDownload[] }>>;
  /** Copies the run's saved download `id` to `drive://workspace/<path>`, waiting for it to be saved; answers the copy's address. */
  saveDownload(id: string, url: string): Promise<ScriptFilesReply<{ file: string }>>;
}

/**
 * A download as Playwright's `download` event gives it, kept in the workspace drive: `path()` is its drive address
 * once saved, `saveAs('drive://workspace/<path>')` copies it there, and nothing of it is on a disk the script reads.
 */
class ScriptDownloadFile<Page> {
  constructor(private readonly owner: Page, private readonly entry: ScriptDownload, private readonly settled: Promise<ScriptDownloadOutcome>, private readonly files: ScriptFiles) {}
  page(): Page { return this.owner; }
  url(): string { return this.entry.url; }
  suggestedFilename(): string { return this.entry.name; }
  /** Its drive address, once saved. */
  async path(): Promise<string> {
    const outcome = await this.settled;
    if ('error' in outcome) throw new Error(`The download was not saved: ${outcome.error}`);
    return outcome.file;
  }
  /** Why it was not saved, or null once it was. */
  async failure(): Promise<string | null> {
    const outcome = await this.settled;
    return 'error' in outcome ? outcome.error : null;
  }
  /** Copies it, once saved, to another drive file. */
  async saveAs(url: string): Promise<void> {
    if (!url.startsWith('drive://')) throw new Error(`${url}: saveAs() takes drive://workspace/<path>; this browser can't write to your machine's disk (copy a drive file there with space_artifacts toMachine)`);
    await answered(this.files.saveDownload(this.entry.id, url));
  }
  async createReadStream(): Promise<never> { throw new Error('A download is a drive file: read it at download.path() with the file tools, not as a stream'); }
  async cancel(): Promise<never> { throw new Error('A download goes to the drive as it arrives and cannot be cancelled'); }
  async delete(): Promise<never> { throw new Error('A download is a drive file and stays in the drive'); }
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
const Search = z.object({ searchId: z.string(), resultCount: z.number().int().nonnegative() });
const SearchResults = z.object({ nodeIds: z.array(z.number().int()) });
const DescribedNode = z.object({ node: z.object({ nodeName: z.string(), backendNodeId: z.number().int(), attributes: z.array(z.string()).optional() }) });
/** A file from memory as a script hands it to a Playwright file call. */
const Payload = z.object({ name: z.string().min(1).max(255), mimeType: z.string().max(255).optional(), buffer: z.instanceof(Uint8Array) });
/** A capture's image is at most this many pixels on its longer side, within what models take; its thumbnail at most
 * this wide. */
const CAPTURE_PIXELS = 1600, THUMBNAIL_WIDTH = 480;
/** The attribute that names an element for a moment, so a locator or a CDP call can find it. */
const UPLOAD_MARK = 'data-gitspace-upload';
/** One file call sets at most this many files from memory, this many bytes in all: on your Chrome Playwright sends
 * them as base64 in one command, which the extension's connection takes up to 4,000,000 characters (`relay-browser.ts`). */
const INPUT_FILES = 8, INPUT_BYTES = 2 * 1024 * 1024;
/** Why a file call refuses a path: no browser of a script reads a machine's disk. */
const LOCAL_FILE = "this browser can't read your machine's disk; copy the file to the drive with space_artifacts fromMachine, then pass drive://workspace/<path>";
/** At most this many elements of a page whose attribute value is "file" are looked at for its file inputs. */
const FILE_CANDIDATES = 200;
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
 * `view()`, `act()`, `capture()` and `upload()` for one script run (docs/APERTURE-DESIGN.md §6.1), what Playwright's
 * file calls do with drive files (`setInputFiles`), and Playwright's `download` events (`followDownloads`). A view is
 * the page as `observe` shows it, with refs `<document>:<node>`: the document is the page's load (its main frame's
 * loader), which a navigation to another document changes and an in-page route change or a back-forward cache restore
 * keeps, so a ref names one node of one document. `act` finds the page whose current load the ref names, in this run or
 * a later one: a ref from a document that is gone fails as stale, never reaching another element.
 */
export function scriptTools<Page extends ScriptPage>(context: ScriptContext<Page>, files: ScriptFiles) {
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

  /** File calls on one page take turns: each marks the page's file inputs for a moment. */
  const marking = new Map<Page, Promise<number>>();
  /** The backend node of the file input a file call names, on your Chrome. Each file input of the page's documents
   * (Chrome's DOM search, which reaches its frames and shadow roots) is marked for a moment, and Playwright reads the
   * mark of the one the call means in its isolated world: the page's own JavaScript world is never needed. */
  async function relayInput(cdp: ScriptCdpSession, target: ScriptInputTarget<Page>): Promise<number> {
    await cdp.send('DOM.getDocument', { depth: 0 });
    // A quoted query matches an attribute whose whole value is "file", in every document of the page.
    const { searchId, resultCount } = Search.parse(await cdp.send('DOM.performSearch', { query: '"file"' }));
    let inputs: { nodeId: number; backendNodeId: number }[];
    try {
      const { nodeIds } = resultCount ? SearchResults.parse(await cdp.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: Math.min(resultCount, FILE_CANDIDATES) })) : { nodeIds: [] };
      const described = await Promise.all(nodeIds.map(async nodeId => ({ nodeId, node: DescribedNode.parse(await cdp.send('DOM.describeNode', { nodeId })).node })));
      inputs = described.filter(({ node }) => {
        const attributes = node.attributes ?? [];
        const type = attributes.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'type');
        return node.nodeName === 'INPUT' && type >= 0 && attributes[type + 1]?.toLowerCase() === 'file';
      }).map(({ nodeId, node }) => ({ nodeId, backendNodeId: node.backendNodeId }));
    } finally { await cdp.send('DOM.discardSearchResults', { searchId }).catch(() => {}); }
    const token = crypto.randomUUID();
    try {
      await Promise.all(inputs.map((input, index) => cdp.send('DOM.setAttributeValue', { nodeId: input.nodeId, name: UPLOAD_MARK, value: `${token}:${index}` })));
      const mark = await target.attribute(UPLOAD_MARK);
      const found = mark?.startsWith(`${token}:`) ? inputs[Number(mark.slice(token.length + 1))] : undefined;
      if (!found) throw new Error(`${target.description} is not a file input (<input type="file">): on your Chrome a file call takes the input itself, not its label or a button; for a button that opens a file picker, take page.waitForEvent('filechooser') and call chooser.setFiles()`);
      return found.backendNodeId;
    } finally { await Promise.all(inputs.map(input => cdp.send('DOM.removeAttribute', { nodeId: input.nodeId, name: UPLOAD_MARK }).catch(() => {}))); }
  }

  /**
   * What Playwright's file calls (`setInputFiles`, a file chooser's `setFiles`) set on a file input: drive files
   * (`drive://workspace/<path>`, one or a list) or files from memory (`{ name, mimeType, buffer }` with a `Uint8Array`,
   * one or a list), at most 8 files at once, 20 MiB of drive files or 2 MiB from memory; an empty list clears it. Any
   * other path is refused: no browser of a script reads a machine's disk. On the cloud browser Playwright sets the
   * bytes; on your Chrome the extension fetches sealed links to drive files itself, so their bytes never cross the relay.
   */
  async function setInputFiles(target: ScriptInputTarget<Page>, input: unknown): Promise<void> {
    const items: unknown[] = Array.isArray(input) ? input : [input];
    if (items.every((item): item is string => typeof item === 'string')) {
      const local = items.find(item => !item.startsWith('drive://'));
      if (local !== undefined) throw new Error(`${local}: ${LOCAL_FILE}`);
      if (!items.length) { await target.set([]); return; }
      const chosen = await answered(files.uploadFiles(items));
      if (chosen.kind === 'bytes') { await target.set(chosen.files.map(file => ({ name: file.name, mimeType: file.mediaType, buffer: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength) }))); return; }
      const page = await target.page();
      if (!page) throw new Error(`${target.description} left the page before its files were set`);
      const cdp = await session(page);
      const turn = (marking.get(page) ?? Promise.resolve(0)).catch(() => 0).then(() => relayInput(cdp, target));
      marking.set(page, turn);
      let backendNodeId: number;
      try { backendNodeId = await turn; } finally { if (marking.get(page) === turn) marking.delete(page); }
      await cdp.send('GitSpace.setInputFilesFromUrls', { backendNodeId, files: chosen.files });
      return;
    }
    if (items.some(item => typeof item === 'string')) throw new Error('A file call takes drive://workspace/<path> addresses or files from memory, not both');
    const payloads = z.array(Payload).safeParse(items);
    if (!payloads.success) throw new Error('A file from memory is { name, mimeType, buffer } with buffer a Uint8Array (new TextEncoder().encode(text) for text)');
    if (payloads.data.length > INPUT_FILES || payloads.data.reduce((total, file) => total + file.buffer.byteLength, 0) > INPUT_BYTES) throw new Error(`A file call sets at most ${INPUT_FILES} files and ${INPUT_BYTES / 1024 / 1024} MiB from memory at once; put larger files in the drive (space_artifacts fromMachine) and pass drive://workspace/<path>`);
    await target.set(payloads.data.map(file => ({ name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', buffer: Buffer.from(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength) })));
  }

  /** Sets a file input's files from the workspace drive (`drive://workspace/<path>`, one or a list): the input as a
   * locator (as its `setInputFiles` does), or as a ref from a view. */
  async function upload(target: string | ScriptLocator, urls: string | string[]): Promise<void> {
    if (typeof target !== 'string') {
      if (typeof target?.setInputFiles !== 'function') throw new Error('upload() takes a locator or a ref from view()');
      await target.setInputFiles(urls);
      return;
    }
    const chosen = await answered(files.uploadFiles(Array.isArray(urls) ? urls : [urls]));
    const { page, cdp, backendNodeId } = await refTarget(target);
    if (chosen.kind === 'links') { await cdp.send('GitSpace.setInputFilesFromUrls', { backendNodeId, files: chosen.files }); return; }
    // A ref names a node; Playwright sets files through a locator, so the node is marked for one moment.
    const buffers = chosen.files.map(file => ({ name: file.name, mimeType: file.mediaType, buffer: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength) }));
    const mark = crypto.randomUUID();
    const { objectId } = Resolved.parse(await cdp.send('DOM.resolveNode', { backendNodeId })).object;
    try {
      await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function (mark) { this.setAttribute(${JSON.stringify(UPLOAD_MARK)}, mark); }`, arguments: [{ value: mark }] });
      await page.locator(`[${UPLOAD_MARK}="${mark}"]`).setInputFiles(buffers);
    } finally {
      await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function () { this.removeAttribute(${JSON.stringify(UPLOAD_MARK)}); }` }).catch(() => {});
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  /** Each page's tab, by its target id. */
  const targets = new Map<Page, Promise<string>>();
  /** The open page of the tab `targetId` (the latest page when the browser did not say); none for a tab not open here. */
  async function pageOfTab(targetId: string | null): Promise<Page | undefined> {
    const pages = context.pages();
    if (targetId === null) return pages.at(-1);
    for (const page of pages) {
      let target = targets.get(page);
      if (!target) { target = session(page).then(async cdp => TargetInfo.parse(await cdp.send('Target.getTargetInfo')).targetInfo.targetId); targets.set(page, target); }
      if (await target === targetId) return page;
    }
    return undefined;
  }

  /** Gives the page that starts each download Playwright's `download` event once the browser saves it to the drive
   * (`ScriptDownloadFile`), following the run's downloads through the session until the run ends. */
  function followDownloads(): void {
    const settles = new Map<string, (outcome: ScriptDownloadOutcome) => void>();
    void (async () => {
      for (let version = 0, ended = false; !ended;) {
        const answer = await answered(files.downloads(version));
        ({ version, ended } = answer);
        for (const entry of answer.downloads) {
          if (!settles.has(entry.id)) {
            const settled = Promise.withResolvers<ScriptDownloadOutcome>();
            settles.set(entry.id, settled.resolve);
            const page = await pageOfTab(entry.targetId);
            page?.emit('download', new ScriptDownloadFile(page, entry, settled.promise, files));
          }
          if (entry.outcome) settles.get(entry.id)?.(entry.outcome);
        }
      }
      for (const settle of settles.values()) settle({ error: 'The script ended before the download was saved' });
    })().catch(() => {});
  }

  return { view, act, capture, upload, setInputFiles, followDownloads };
}
