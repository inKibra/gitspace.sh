import { afterEach, describe, expect, it } from 'bun:test';
import { Window, type Element, type ShadowRoot } from 'happy-dom';
import { browserScreenshotPrepareFunction } from '@gitspace/runtime-machine/browser-screenshot';
import type { CommentPin, CommentView } from '../src/comments.js';
import { browserOverlayFunction, browserOverlayPickedFunction } from '../src/overlay.js';

const idle = { show: { mode: 'idle', workspace: 'Checkout', agent: null, doing: null, binding: '__gitspaceStop', capture: 'ready', recording: null, comments: true } };
const at = new Date(Date.now() - 180_000).toISOString();
const phone: CommentPin = {
  id: 'thread-1', n: 1, label: 'textbox “Telephone:”', area: false, box: { x: 0.5, y: 0.25, w: 0.25, h: 0.05 }, selector: '#phone',
  scroll: { x: 0, y: 100 }, viewport: { w: 1024, h: 768 }, resolved: null,
  comments: [{ who: 'Bradley', agent: false, guest: false, at, text: 'This should accept +44 numbers.' }, { who: 'main', agent: true, guest: false, at, text: 'Fixed in a3f9c21; reload to check.' }],
};
const sizes: CommentPin = {
  id: 'thread-2', n: 2, label: 'area around group “Pizza Size”', area: true, box: { x: 0.125, y: 0.5, w: 0.25, h: 0.125 }, selector: '',
  scroll: { x: 0, y: 0 }, viewport: { w: 1024, h: 768 }, resolved: 'Bradley', comments: [{ who: 'Ana', agent: false, guest: true, at, text: 'Make Medium the default.' }],
};
const view = (change: Partial<CommentView> = {}): CommentView => ({ bar: true, name: 'Bradley', workspace: 'Checkout', threads: [phone, sizes], hover: null, draft: null, busy: null, done: null, focus: null, error: null, ...change });

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

/** A 1024×768 page with the overlay as the extension calls it in its own world; the binding's calls are kept, the
 * overlay's closed shadow root is kept for the test (a page never gets it), and `under` says which element is at each
 * point, as Chrome's hit testing would. */
function page() {
  const window = new Window({ width: 1024, height: 768 });
  windows.push(window);
  const roots: ShadowRoot[] = [];
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (init) { const root = attach.call(this, init); roots.push(root); return root; };
  Object.assign(window.Element.prototype, { animate: () => ({ finished: Promise.resolve() }) });
  const calls: string[] = [];
  const pageEvents: string[] = [];
  Object.assign(window, { __gitspaceStop: (payload: string) => { calls.push(payload); } });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown']) window.document.addEventListener(type, () => { pageEvents.push(type); });
  let under: (x: number, y: number) => Element[] = () => [];
  Object.assign(window.document, { elementsFromPoint: (x: number, y: number) => under(x, y) });
  const call = (declaration: string, argument?: unknown): unknown => window.eval(`(${declaration})`)(argument);
  const root = () => { const found = roots[0]; if (!found) throw new Error('No overlay'); return found; };
  const buttons = () => [...root().querySelectorAll('button')].filter(visible);
  const button = (label: string) => { const found = buttons().find(element => element.textContent === label); if (!found) throw new Error(`No ${label}`); return found; };
  const layer = () => { const found = [...root().querySelectorAll('div')].find(element => element.style.cursor === 'crosshair'); if (!found) throw new Error('No comment layer'); return found; };
  /** Your pointer on the comment layer, as Chrome reports it (trusted). */
  const pointer = (type: string, x: number, y: number) => {
    const event = new window.PointerEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'isTrusted', { value: true });
    layer().dispatchEvent(event);
  };
  const key = (name: string, target: Element = window.document.body) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, composed: true, key: name });
    Object.defineProperty(event, 'isTrusted', { value: true });
    target.dispatchEvent(event);
  };
  /** An element of the page with its box. */
  const element = (id: string, box: { left: number; top: number; right: number; bottom: number }) => {
    const made = window.document.createElement('div');
    made.id = id;
    window.document.body.appendChild(made);
    Object.assign(made, { getBoundingClientRect: () => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) });
    return made;
  };
  /** Where each pin sits: its number and its top-left corner. */
  const pins = () => buttons().filter(element => /^\d+$/.test(element.textContent)).map(element => `${element.textContent}@${element.style.transform}`);
  return { window, root, call, calls, pageEvents, buttons, button, layer, pointer, key, element, pins, under: (find: typeof under) => { under = find; } };
}
/** Whether an element of the overlay shows: neither it nor anything holding it is `display: none`. */
function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) if (/(^|;)\s*display:\s*none/.test(node.getAttribute('style') ?? '')) return false;
  return true;
}

describe('the in-page comment tool', () => {
  it('Comment on a tab’s toolbar turns comment mode on; Esc closes what is open, then leaves it', () => {
    const tab = page();
    tab.call(browserOverlayFunction, idle);
    expect(tab.root().textContent).toContain('GitSpace · Checkout · idle');
    expect(tab.buttons().map(button => button.textContent)).toEqual(['Comment', 'Capture']);
    tab.button('Comment').click();
    expect(tab.calls).toEqual(['comment on']);
    // Esc means nothing to the tool before it is on: the page has it.
    tab.key('Escape');
    expect(tab.calls).toEqual(['comment on']);
    tab.call(browserOverlayFunction, { comment: view() });
    expect(visible(tab.layer())).toBe(true);
    expect(tab.root().textContent).toContain('Comment tool · click an element or drag an area · 2 comments');
    tab.button('1').click();
    tab.key('Escape');
    // The first Esc closed the thread; the second leaves comment mode, and the page heard neither.
    expect(tab.calls).toEqual(['comment on']);
    tab.key('Escape');
    expect(tab.calls).toEqual(['comment on', 'comment off']);
    expect(tab.pageEvents).toEqual(['keydown']);
    tab.call(browserOverlayFunction, { comment: null });
    expect(visible(tab.layer())).toBe(false);
    expect(tab.pins()).toEqual([]);
    // Without an account that takes comments, there is no Comment.
    tab.call(browserOverlayFunction, { show: { ...idle.show, comments: false } });
    expect(tab.buttons().map(button => button.textContent)).toEqual(['Capture']);
  });

  it('a click anchors to the element under it and a drag to an area, with the element holding it; the page sees neither', () => {
    const tab = page();
    const form = tab.element('form', { left: 50, top: 100, right: 600, bottom: 500 });
    const pay = tab.element('pay', { left: 100, top: 200, right: 300, bottom: 240 });
    form.appendChild(pay);
    tab.under((x, y) => x >= 100 && x <= 300 && y >= 200 && y <= 240 ? [pay, form] : x >= 50 && x <= 600 && y >= 100 && y <= 500 ? [form] : []);
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view({ threads: [] }) });
    tab.pointer('pointermove', 150, 220);
    tab.pointer('pointerdown', 150, 220);
    tab.pointer('pointerup', 150, 220);
    tab.pointer('pointerdown', 128, 384);
    tab.pointer('pointermove', 200, 420);
    tab.pointer('pointerup', 384, 480);
    expect(tab.calls.map(call => JSON.parse(call.replace(/^comment \w+ /, '')))).toEqual([
      { seq: 1 },
      { seq: 2, at: { x: 150 / 1024, y: 220 / 768, width: 0, height: 0 } },
      // A new pick drops the draft of the one before.
      { seq: 2 },
      { seq: 3, area: { x: 0.125, y: 0.5, width: 0.25, height: 0.125 } },
    ]);
    expect(tab.calls.map(call => call.split(' ')[1])).toEqual(['hover', 'pick', 'cancel', 'pick']);
    // The extension reads each picked element in the overlay's world: the button clicked, the form around the area.
    expect(tab.call(browserOverlayPickedFunction, 2)).toBe(pay);
    expect(tab.call(browserOverlayPickedFunction, 3)).toBe(form);
    expect(tab.pageEvents).toEqual([]);
  });

  it('the draft asks for the comment on what was picked, as you; Comment posts it and Cancel drops it', () => {
    const tab = page();
    const pay = tab.element('pay', { left: 100, top: 200, right: 300, bottom: 240 });
    tab.under(() => [pay]);
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view({ threads: [] }) });
    tab.pointer('pointerdown', 150, 220);
    tab.pointer('pointerup', 150, 220);
    tab.call(browserOverlayFunction, { comment: view({ threads: [], draft: { seq: 1, label: 'button “Pay now”', area: false } }) });
    expect(tab.root().textContent).toContain('On button “Pay now” · as Bradley');
    // The draft's pin sits at the element's top-right corner.
    expect(tab.pins()).toEqual(['1@translate(290px,190px)']);
    const field = tab.root().querySelector('textarea');
    if (!field) throw new Error('No field');
    expect(field.placeholder).toBe('Write a comment…');
    field.value = 'Pay now is hidden on phones';
    tab.button('Comment').click();
    expect(tab.calls.at(-1)).toBe('comment post {"seq":2,"text":"Pay now is hidden on phones"}');
    expect(tab.buttons().map(button => button.textContent)).toContain('Sending…');
    tab.call(browserOverlayFunction, { comment: view({ threads: [], draft: null, done: { seq: 2, error: null } }) });
    expect(tab.root().querySelector('textarea')).toBeNull();
    tab.pointer('pointerdown', 150, 220);
    tab.pointer('pointerup', 150, 220);
    tab.button('Cancel').click();
    expect(tab.calls.at(-1)).toBe('comment cancel {"seq":3}');
    expect(tab.root().querySelector('textarea')).toBeNull();
  });

  it('puts each thread’s numbered pin at its anchor: its element where the page has it, else its box where the page was scrolled then', () => {
    const tab = page();
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view() });
    // The phone field was 100 px further down the page when commented on, which is now at the top.
    expect(tab.pins()).toEqual(['1@translate(758px,282px)', '2@translate(374px,372px)']);
    tab.element('phone', { left: 100, top: 200, right: 300, bottom: 230 });
    tab.call(browserOverlayFunction, { comment: view() });
    expect(tab.pins()).toEqual(['1@translate(290px,190px)', '2@translate(374px,372px)']);
  });

  it('a pin opens its thread with the agent’s reply as the agent; Reply and Resolve or Reopen go to the extension', () => {
    const tab = page();
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view() });
    tab.button('1').click();
    const text = tab.root().textContent;
    expect(text).toContain('On textbox “Telephone:” · files into Checkout');
    expect(text).toContain('Bradley · 3 min ago');
    expect(text).toContain('This should accept +44 numbers.');
    expect(text).toContain('AImain · 3 min ago');
    expect(text).toContain('Fixed in a3f9c21; reload to check.');
    const field = tab.root().querySelector('textarea');
    if (!field) throw new Error('No field');
    expect(field.placeholder).toBe('Reply…');
    field.value = '  Works now, thanks  ';
    tab.button('Reply').click();
    expect(tab.calls.at(-1)).toBe('comment reply {"seq":1,"threadId":"thread-1","text":"Works now, thanks"}');
    tab.call(browserOverlayFunction, { comment: view({ done: { seq: 1, error: null } }) });
    tab.button('Resolve').click();
    expect(tab.calls.at(-1)).toBe('comment resolve {"seq":2,"threadId":"thread-1","reopen":false}');
    tab.call(browserOverlayFunction, { comment: view({ done: { seq: 2, error: 'Only the main agent and the account’s owner resolve' } }) });
    expect(tab.root().textContent).toContain('Only the main agent and the account’s owner resolve');
    // A resolved thread is reopened.
    tab.button('2').click();
    expect(tab.root().textContent).toContain('Ana (guest)');
    expect(tab.root().textContent).toContain('Resolved by Bradley');
    tab.button('Reopen').click();
    expect(tab.calls.at(-1)).toBe('comment resolve {"seq":3,"threadId":"thread-2","reopen":true}');
  });

  it('Show on page opens the thread it names', () => {
    const tab = page();
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view({ focus: { thread: 'thread-2', seq: 1 } }) });
    expect(tab.root().textContent).toContain('On area around group “Pizza Size” · files into Checkout');
  });

  it('while comment mode is on, your presses on a tab the agent acts on are comments, not take over', () => {
    const tab = page();
    const pay = tab.element('pay', { left: 100, top: 200, right: 300, bottom: 240 });
    tab.under(() => [pay]);
    tab.call(browserOverlayFunction, { show: { ...idle.show, mode: 'run', agent: 'main', doing: 'Running a script' } });
    tab.call(browserOverlayFunction, { comment: view({ threads: [] }) });
    // The layer stands aside for the agent; your own trusted press on the page is caught before the page sees it.
    expect(visible(tab.layer())).toBe(false);
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new tab.window.PointerEvent(type, { bubbles: true, composed: true, clientX: 150, clientY: 220, button: 0 });
      Object.defineProperty(event, 'isTrusted', { value: true });
      pay.dispatchEvent(event);
    }
    expect(tab.calls).toEqual([`comment pick {"seq":1,"at":{"x":${150 / 1024},"y":${220 / 768},"width":0,"height":0}}`]);
    expect(tab.pageEvents).toEqual([]);
  });

  it('pins and threads stay out of the page and the agent’s screenshots', () => {
    const tab = page();
    tab.call(browserOverlayFunction, idle);
    tab.call(browserOverlayFunction, { comment: view() });
    tab.button('1').click();
    expect(tab.pins()).toHaveLength(2);
    // Nothing of the tool is in the page's own document; all of it is under the overlay's host, which the agent's
    // screenshot mask hides.
    expect(tab.window.document.querySelectorAll('button, textarea')).toHaveLength(0);
    tab.call(browserScreenshotPrepareFunction, []);
    const host = tab.window.document.querySelector('[data-gitspace-overlay]');
    if (!host) throw new Error('No overlay');
    expect(tab.window.getComputedStyle(host).visibility).toBe('hidden');
  });
});
