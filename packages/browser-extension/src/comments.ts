/**
 * The in-page comment tool on your Chrome (docs/APERTURE-DESIGN.md §9, B2; the agreed look is account-web's
 * BrowsersMockExtension `CommentLayer`, which `overlay.ts` draws). Comment on the in-page toolbar of a tab in a
 * workspace group turns comment mode on for that tab, and its workspace receives the comments; a tab in no workspace
 * group has no toolbar, so no comment mode. Comment mode shows the page's threads as numbered pins where their anchors
 * are, outlines what is under your pointer, and anchors a new comment to the element you click or the area you drag.
 *
 * The overlay picks the element under your pointer past its own layer and keeps it under a number (`picked`); the
 * extension reads it as a share's hit test reads one (box, accessible role and name, selectors) and crops a JPEG of
 * the element or the dragged area. Threads are the workspace's: listed for the tab's page when comment mode turns on,
 * when the page changes and when the account says they changed (its `comments` notice), and written with requests
 * signed by this Chrome's pairing key (`POST /api/browser-relay/comments`, label `comment`). While a capture records the
 * tab with the comment tool on (`capture`), each new thread lands on the capture's clock and the capture hears of it.
 */
import type { BROWSER_COMMENT_PATH, RuntimeBrowserComment, RuntimeBrowserCommentAnchor, RuntimeBrowserCommentChromeRequest, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { accountValue, relaySignature, sha256Hex, SIGNATURE_HEADER, type SigningIdentity } from './upload.js';

/** Where this Chrome's signed comment requests go (`BROWSER_COMMENT_PATH`). */
const COMMENTS_PATH: typeof BROWSER_COMMENT_PATH = '/api/browser-relay/comments';
/** The longest comment, in characters (`BROWSER_COMMENT_TEXT_MAX`). */
const COMMENT_TEXT_MAX = 4000;

/** One signed comment request; resolves with the value of the account's `ok` reply, or fails with its message. */
export async function commentRequest(account: string, identity: SigningIdentity, request: RuntimeBrowserCommentChromeRequest): Promise<unknown> {
  const body = new TextEncoder().encode(JSON.stringify(request));
  const header = await relaySignature(identity, 'comment', 'POST', COMMENTS_PATH, await sha256Hex(body));
  return accountValue(await fetch(new URL(COMMENTS_PATH, account).href, { method: 'POST', body, headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store' }), '');
}

/** An area of the tab in fractions of its layout viewport, as a share's hit test gives boxes. */
export type CommentArea = { x: number; y: number; width: number; height: number };
/** The element the overlay picked, as the extension reads it: its box, accessible role and name, a little of its
 * visible text and selectors that find it alone, most specific first. */
export type CommentTarget = { box: CommentArea; role: string; name: string; text: string; selectors: string[] };
/** The tab's page now: its URL and title, its layout viewport and scroll offset in CSS pixels. */
export type CommentPage = { url: string; title: string; viewport: { w: number; h: number }; scroll: { x: number; y: number } };
/** The workspace group a tab is in: comments land in its workspace. */
export type CommentGroup = { groupId: string; workspace: string };
/** A capture recording the tab with the comment tool on: new threads land at their time since `startedAt`, and the
 * capture hears of each (`saved`) and of the comment tool turned off from the page (`ended`). */
export type CommentCapture = { captureId: string; startedAt: number; saved(): void; ended(): void };
/** What the comment tool needs of the extension. */
export type CommentHost = {
  /** One signed comment request to the account (`commentRequest`). */
  request(request: RuntimeBrowserCommentChromeRequest): Promise<unknown>;
  /** Draws the tab's overlay again, with `view`. */
  draw(targetId: string): void;
  /** The workspace group holding the tab; null for a tab in none. */
  group(targetId: string): Promise<CommentGroup | null>;
  /** The element the tab's overlay picked under `seq`; null when it has none or it cannot be read. */
  picked(targetId: string, seq: number): Promise<CommentTarget | null>;
  /** A base64 JPEG of an area of the tab without the overlay; null when Chrome draws none. */
  crop(targetId: string, area: CommentArea): Promise<string | null>;
  page(targetId: string): Promise<CommentPage>;
};

/** One comment of a thread as the overlay shows it: who (an agent as `main` or `agent`), when, what. */
export type CommentLine = { who: string; agent: boolean; guest: boolean; at: string; text: string };
/** One thread as the overlay draws its pin and popover: its number on the page, what it is on, its anchor, whether
 * and by whom it was resolved, and its comments, oldest first. */
export type CommentPin = {
  id: string; n: number; label: string; area: boolean; box: RuntimeBrowserCommentAnchor['box']; selector: string;
  scroll: { x: number; y: number } | null; viewport: { w: number; h: number } | null; resolved: string | null; comments: CommentLine[];
};
/**
 * What the overlay draws in comment mode: its own bar (none while a capture's bar shows), your name and the workspace,
 * the page's threads, the label of what is under your pointer (`hover`, for the overlay's pick `seq`), the comment
 * being written (`draft`, once its anchor is read), the write in flight (`busy`, by the overlay's `seq`) and the last
 * one finished (`done`, with its error), a thread to open once (`focus`), and why the threads could not be listed.
 */
export type CommentView = {
  bar: boolean; name: string; workspace: string; threads: CommentPin[];
  hover: { seq: number; label: string } | null; draft: { seq: number; label: string; area: boolean } | null;
  busy: number | null; done: { seq: number; error: string | null } | null; focus: { thread: string; seq: number } | null; error: string | null;
};

type CommentRequest = Extract<RuntimeBrowserCommentChromeRequest, { op: 'comment' }>;
type Tab = CommentGroup & {
  capture: CommentCapture | null; threads: RuntimeBrowserCommentThread[]; name: string; error: string | null;
  hover: CommentView['hover']; hovering: { running: boolean; next: number | null };
  draft: { seq: number; label: string; request: Omit<CommentRequest, 'text' | 'capture'> } | null;
  busy: number | null; done: CommentView['done']; focus: CommentView['focus']; listed: number;
};

/** `textbox “Telephone:”`, `area around group “Pizza Size”`, or `an area of the page` (account-web's
 * `commentAnchorLabel`, with the element around a dragged area). */
export function commentLabel(role: string, name: string, area: boolean): string {
  if (!role && !name) return area ? 'an area of the page' : 'an element';
  const quoted = name.length > 60 ? name.slice(0, 59) + '…' : name;
  const element = quoted ? `${role || 'element'} “${quoted}”` : role;
  return area ? `area around ${element}` : element;
}

/** The comment tool on this Chrome's tabs, by target id: a tab is in comment mode while it has an entry. */
export class ChromeComments {
  private readonly tabs = new Map<string, Tab>();
  private focusSeq = 0;
  constructor(private readonly host: CommentHost) {}

  /** Whether a tab is in comment mode. */
  on(targetId: string): boolean { return this.tabs.has(targetId); }

  /** Turns comment mode on for a tab of workspace group `group`, with `capture` onto that capture's clock; a tab
   * already in it only takes the capture. Resolves once the page's threads are listed, or failed to be. */
  async start(targetId: string, group: CommentGroup, capture: CommentCapture | null = null): Promise<void> {
    const current = this.tabs.get(targetId);
    if (current?.groupId === group.groupId) { current.capture = capture; this.host.draw(targetId); return; }
    const tab: Tab = { ...group, capture, threads: [], name: '', error: null, hover: null, hovering: { running: false, next: null }, draft: null, busy: null, done: null, focus: null, listed: 0 };
    this.tabs.set(targetId, tab);
    this.host.draw(targetId);
    await this.list(targetId, tab);
  }

  /** Turns comment mode off for a tab. From the page (Esc, Done), a capture's comment tool hears that it ended. */
  stop(targetId: string, fromPage: boolean): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.tabs.delete(targetId);
    if (fromPage) tab.capture?.ended();
    this.host.draw(targetId);
  }

  /** Opens a thread's popover on a tab in comment mode (Show on page in GitSpace). */
  focus(targetId: string, threadId: string): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    tab.focus = { thread: threadId, seq: ++this.focusSeq };
    this.host.draw(targetId);
  }

  /** The workspace's threads changed (the account's `comments` notice): each tab of its group in comment mode lists
   * its page's threads again. */
  changed(groupId: string): void {
    for (const [targetId, tab] of this.tabs) if (tab.groupId === groupId) void this.list(targetId, tab);
  }

  /** The tab's page changed: the comment being written goes, and the new page's threads are listed. */
  navigated(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    tab.draft = null; tab.hover = null; tab.threads = [];
    this.host.draw(targetId);
    void this.list(targetId, tab);
  }

  /** What the overlay draws of a tab's comment mode; null while it is off. */
  view(targetId: string): CommentView | null {
    const tab = this.tabs.get(targetId);
    if (!tab) return null;
    const threads = tab.threads.toSorted((a, b) => a.root.createdAt.localeCompare(b.root.createdAt) || a.root.id.localeCompare(b.root.id)).flatMap((thread, index) => {
      const anchor = thread.root.anchor;
      if (!anchor) return [];
      const area = anchor.area === true;
      // An agent shows as `main` or `agent` (a subagent), a person by name (account-web's `commentAuthorName`).
      const comments = [thread.root, ...thread.replies].map(({ by, createdAt, text }) => ({ who: by.kind === 'agent' ? by.conversation === 'main' ? 'main' : 'agent' : by.name, agent: by.kind === 'agent', guest: by.kind === 'person' && by.guest, at: createdAt, text }));
      return [{
        id: thread.root.id, n: index + 1, label: commentLabel(anchor.role, anchor.name, area), area, box: anchor.box, selector: anchor.selector,
        scroll: anchor.scroll ?? null, viewport: anchor.viewport ?? null, resolved: thread.root.resolved?.by ?? null, comments,
      }];
    });
    const draft = tab.draft && { seq: tab.draft.seq, label: tab.draft.label, area: tab.draft.request.anchor.area === true };
    return { bar: tab.capture === null, name: tab.name, workspace: tab.workspace, threads, hover: tab.hover, draft, busy: tab.busy, done: tab.done, focus: tab.focus, error: tab.error };
  }

  /**
   * A call of the overlay's binding about comments, `comment <what> <json>`: `on` and `off` (the toolbar's Comment,
   * Done, Esc), `hover` (what is under your pointer now), `pick` (a click, `at` as an empty area there, or a dragged
   * `area`), `cancel` (the draft), `post`, `reply` and `resolve` (each with the overlay's `seq`, which `busy` and `done`
   * name).
   */
  async binding(targetId: string, payload: string): Promise<void> {
    const [, what = '', json = ''] = /^comment (\w+) ?(.*)$/s.exec(payload) ?? [];
    let value: unknown;
    try { value = JSON.parse(json || '{}'); } catch { return; }
    const args = typeof value === 'object' && value !== null ? value : {};
    if (what === 'on') { const group = await this.host.group(targetId); if (group) await this.start(targetId, group); return; }
    if (what === 'off') { this.stop(targetId, true); return; }
    const tab = this.tabs.get(targetId);
    const seq = 'seq' in args && typeof args.seq === 'number' && Number.isSafeInteger(args.seq) ? args.seq : null;
    if (!tab || seq === null) return;
    if (what === 'hover') return this.hover(targetId, tab, seq);
    if (what === 'pick') return this.pick(targetId, tab, seq, 'at' in args && isArea(args.at) ? args.at : null, 'area' in args && isArea(args.area) ? args.area : null);
    if (what === 'cancel') { if (tab.draft?.seq === seq) { tab.draft = null; this.host.draw(targetId); } return; }
    const text = 'text' in args && typeof args.text === 'string' ? args.text.trim() : '';
    const threadId = 'threadId' in args && typeof args.threadId === 'string' ? args.threadId : null;
    if (what === 'post') return this.write(targetId, tab, seq, async () => {
      const draft = tab.draft;
      if (!draft) throw new Error('Click an element or drag an area first');
      const capture = tab.capture;
      const thread = threadOf(await this.host.request({ ...draft.request, text: checked(text), ...(capture ? { capture: { captureId: capture.captureId, atMs: Math.max(0, Math.round(Date.now() - capture.startedAt)) } } : {}) }));
      if (tab.draft === draft) tab.draft = null;
      upsert(tab, thread);
      capture?.saved();
    });
    if (what === 'reply' && threadId) return this.write(targetId, tab, seq, async () => upsert(tab, threadOf(await this.host.request({ op: 'reply', groupId: tab.groupId, threadId, text: checked(text) }))));
    const reopen = 'reopen' in args && args.reopen === true;
    if (what === 'resolve' && threadId) return this.write(targetId, tab, seq, async () => upsert(tab, threadOf(await this.host.request({ op: 'resolve', groupId: tab.groupId, threadId, ...(reopen ? { reopen } : {}) }))));
  }

  /** Reads what is under your pointer for its label; while one read runs, only the latest pick waits for the next. */
  private async hover(targetId: string, tab: Tab, seq: number): Promise<void> {
    tab.hovering.next = seq;
    if (tab.hovering.running) return;
    tab.hovering.running = true;
    try {
      for (let next: number | null = seq; next !== null; next = tab.hovering.next) {
        tab.hovering.next = null;
        const target = await this.host.picked(targetId, next).catch(() => null);
        if (this.tabs.get(targetId) !== tab) return;
        tab.hover = { seq: next, label: target ? commentLabel(target.role, target.name, false) : '' };
        this.host.draw(targetId);
      }
    } finally { tab.hovering.running = false; }
  }

  /** Anchors the comment being written: the element picked under `seq` (clicked `at`, an empty area where it was
   * clicked, used when nothing there can be read), or the dragged `area` with the element around it; its box, the
   * page's scroll and viewport, and a crop of the box. */
  private async pick(targetId: string, tab: Tab, seq: number, at: CommentArea | null, area: CommentArea | null): Promise<void> {
    const [target, page] = await Promise.all([this.host.picked(targetId, seq).catch(() => null), this.host.page(targetId)]);
    const box = area ?? target?.box ?? at;
    if (!box || this.tabs.get(targetId) !== tab) return;
    const crop = await this.host.crop(targetId, box).catch(() => null);
    if (this.tabs.get(targetId) !== tab) return;
    const role = target?.role ?? '', name = target?.name ?? '';
    const anchor: CommentRequest['anchor'] = {
      role, name, selector: target?.selectors[0] ?? '', box: { x: box.x, y: box.y, w: box.width, h: box.height },
      ...(area ? { area: true } : {}), scroll: page.scroll, viewport: page.viewport,
    };
    tab.draft = { seq, label: commentLabel(role, name, area !== null), request: { op: 'comment', groupId: tab.groupId, page: { url: page.url.slice(0, 8192), title: page.title.slice(0, 500) }, anchor, ...(crop ? { crop } : {}) } };
    tab.done = null;
    this.host.draw(targetId);
  }

  /** One write at a time per tab; `done` tells the overlay how the one it numbered `seq` ended. */
  private async write(targetId: string, tab: Tab, seq: number, operation: () => Promise<void>): Promise<void> {
    if (tab.busy !== null) return;
    tab.busy = seq;
    this.host.draw(targetId);
    let error: string | null = null;
    try { await operation(); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    if (this.tabs.get(targetId) !== tab) return;
    tab.busy = null; tab.done = { seq, error: error?.slice(0, 300) ?? null };
    this.host.draw(targetId);
  }

  /** Lists the threads of the tab's page; a later list wins over an earlier one still running. */
  private async list(targetId: string, tab: Tab): Promise<void> {
    const listed = ++tab.listed;
    try {
      const { url } = await this.host.page(targetId);
      const value = await this.host.request({ op: 'list', groupId: tab.groupId, url: url.slice(0, 8192) });
      if (typeof value !== 'object' || value === null || !('threads' in value) || !Array.isArray(value.threads) || !value.threads.every(isThread)) throw new Error('The account answered the comments with an unexpected reply');
      if (this.tabs.get(targetId) !== tab || tab.listed !== listed) return;
      tab.threads = value.threads; tab.name = 'name' in value && typeof value.name === 'string' ? value.name.slice(0, 60) : ''; tab.error = null;
    } catch (failure) {
      if (this.tabs.get(targetId) !== tab || tab.listed !== listed) return;
      tab.error = failure instanceof Error ? failure.message.slice(0, 300) : 'The comments could not be listed';
    }
    this.host.draw(targetId);
  }
}

/** A thread written now replaces the one with its id, or joins the page's threads. */
function upsert(tab: Tab, thread: RuntimeBrowserCommentThread): void {
  const index = tab.threads.findIndex(other => other.root.id === thread.root.id);
  if (index === -1) tab.threads.push(thread); else tab.threads[index] = thread;
}
function checked(text: string): string {
  if (!text) throw new Error('Write a comment first');
  if (text.length > COMMENT_TEXT_MAX) throw new Error(`A comment takes at most ${COMMENT_TEXT_MAX} characters`);
  return text;
}
function threadOf(value: unknown): RuntimeBrowserCommentThread {
  if (typeof value === 'object' && value !== null && 'thread' in value && isThread(value.thread)) return value.thread;
  throw new Error('The account answered the comment with an unexpected reply');
}
const fraction = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1;
/** An area of the tab from the overlay, in fractions of the viewport. */
function isArea(value: unknown): value is CommentArea {
  return typeof value === 'object' && value !== null && 'x' in value && 'y' in value && 'width' in value && 'height' in value && fraction(value.x) && fraction(value.y) && fraction(value.width) && fraction(value.height);
}
/** A comment as the account answers it (`RuntimeBrowserComment`), as far as this tool reads it. */
function isComment(value: unknown): value is RuntimeBrowserComment {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'text' in value && typeof value.text === 'string' && 'createdAt' in value && typeof value.createdAt === 'string'
    && 'by' in value && typeof value.by === 'object' && value.by !== null && 'anchor' in value && (value.anchor === null || (typeof value.anchor === 'object' && 'box' in value.anchor)) && 'resolved' in value;
}
function isThread(value: unknown): value is RuntimeBrowserCommentThread {
  return typeof value === 'object' && value !== null && 'root' in value && isComment(value.root) && 'replies' in value && Array.isArray(value.replies) && value.replies.every(isComment);
}
