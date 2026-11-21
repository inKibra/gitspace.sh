import { afterEach, describe, expect, it } from 'bun:test';
import { Window, type Element, type HTMLElement, type ShadowRoot } from 'happy-dom';
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from '@gitspace/runtime-machine/browser-screenshot';
import { browserCaptureBarFunction } from '../src/capture-tracks.js';
import { browserOverlayFunction } from '../src/overlay.js';

const show = { show: { mode: 'run', workspace: 'Checkout', agent: 'main', doing: 'Clicking “Medium”', capture: 'ready', recording: null } };
const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

/** A page with the overlay function and the screenshot mask callable as the extension calls them, in its world of
 * the page, whose extension is there (`chrome.runtime.id`) and which keeps what the overlay sends (`__gitspaceSend`);
 * the overlay's closed shadow root is kept for the test, which a page never gets. happy-dom has no Web Animations,
 * which the overlay's pulses and presses use, so they run as Chrome's would with no effect here. */
function page() {
  const window = new Window();
  windows.push(window);
  const roots: ShadowRoot[] = [];
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (init) { const root = attach.call(this, init); roots.push(root); return root; };
  Object.assign(window.Element.prototype, { animate: () => ({ finished: Promise.resolve() }) });
  const sent: string[] = [];
  const runtime: { id?: string } = { id: 'extension' };
  Object.assign(window, { chrome: { runtime }, __gitspaceSend: async (payload: string) => { sent.push(payload); return {}; } });
  const call = (declaration: string, argument?: unknown): unknown => window.eval(`(${declaration})`)(argument);
  return { window, roots, sent, runtime, call, host: () => window.document.querySelector('[data-gitspace-overlay]') };
}
/** Whether an element of the overlay shows: neither it nor anything holding it is `display: none`. */
function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) if (/(^|;)\s*display:\s*none/.test(node.getAttribute('style') ?? '')) return false;
  return true;
}

describe('the agent screenshot mask', () => {
  it('covers secrets only: password, one-time-code, secure-input and shadow-root password fields; the page shows the rest', () => {
    const { window, roots, call } = page();
    const document = window.document;
    document.body.innerHTML = `<input id="password" type="password" value="hunter2">
      <input id="otp" autocomplete="one-time-code"><input id="secure" type="text" data-gitspace-secure-input>
      <input id="plain" type="text" value="hello"><x-card id="custom">Pull requests</x-card>
      <iframe id="frame"></iframe><canvas id="canvas"></canvas><div id="shadowed"></div>`;
    const shadowed = document.getElementById('shadowed');
    if (!shadowed) throw new Error('No shadow host');
    const shadow = shadowed.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="inner" type="password">';
    call(browserScreenshotPrepareFunction, [{ x: 0, y: 0, ref: 'e1' }]);
    const hidden = (element: Element | null) => {
      if (!element) throw new Error('Missing element');
      return window.getComputedStyle(element).visibility === 'hidden';
    };
    expect(['password', 'otp', 'secure'].map(id => hidden(document.getElementById(id)))).toEqual([true, true, true]);
    expect(hidden(shadow.getElementById('inner'))).toBe(true);
    expect(['plain', 'custom', 'frame', 'canvas'].map(id => hidden(document.getElementById(id)))).toEqual([false, false, false, false]);
    const covers = [...roots.at(-1)?.children ?? []].map(cover => cover.textContent);
    expect(covers).toEqual(['[masked]', '[masked]', '[masked]', '[masked]', 'e1']);
    call(browserScreenshotRestoreFunction);
    expect(hidden(document.getElementById('password'))).toBe(false);
  });
});

describe('the in-page overlay', () => {
  it('stays out of the accessibility tree and the focus order, and the screenshot mask hides it', () => {
    const { window, roots, call, host } = page();
    call(browserOverlayFunction, show);
    const element = host();
    if (!element) throw new Error('No overlay');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect([...roots[0]?.querySelectorAll('button, a, input, textarea, [tabindex]') ?? []].filter(node => node.getAttribute('tabindex') !== '-1')).toEqual([]);
    call(browserScreenshotPrepareFunction, []);
    expect(window.getComputedStyle(element).visibility).toBe('hidden');
    call(browserScreenshotRestoreFunction);
    expect(window.getComputedStyle(element).visibility).not.toBe('hidden');
  });

  it('says who acts on which workspace and what it is doing; Stop tells the extension, and the page never sees the click', () => {
    const { window, roots, sent: stops, call } = page();
    const clicks: string[] = [];
    window.document.addEventListener('click', event => { clicks.push(event.type); });
    call(browserOverlayFunction, show);
    expect(roots[0]?.textContent).toContain('main · Checkout');
    expect(roots[0]?.textContent).toContain('Clicking “Medium”…');
    const stop = [...roots[0]?.querySelectorAll('button') ?? []].find(button => button.textContent === 'Stop');
    if (!stop) throw new Error('No Stop');
    stop.click();
    expect(stops).toEqual(['stop']);
    expect(clicks).toEqual([]);
  });

  it('Capture starts a capture where the account saves them; while it records, REC shows and Stop capture ends it', () => {
    const { roots, sent: presses, call } = page();
    const buttons = () => [...roots[0]?.querySelectorAll('button') ?? []];
    const shown = () => buttons().filter(visible).map(button => button.textContent || button.title);
    call(browserOverlayFunction, { show: { ...show.show, capture: 'none' } });
    expect(shown()).toEqual(['Take over', 'Stop', 'Hide the GitSpace toolbar']);
    call(browserOverlayFunction, show);
    expect(shown()).toEqual(['Capture', 'Take over', 'Stop', 'Hide the GitSpace toolbar']);
    buttons().find(button => button.textContent === 'Capture')?.click();
    call(browserOverlayFunction, { show: { ...show.show, mode: 'capture', agent: null, doing: null, capture: 'recording', recording: { startedAt: Date.now(), sound: true } } });
    expect(roots[0]?.textContent).toContain('REC');
    // Recording alone, the agent's Stop is not offered.
    expect(shown()).toEqual(['Stop capture', 'Hide the GitSpace toolbar']);
    buttons().find(button => button.textContent === 'Stop capture')?.click();
    expect(presses).toEqual(['capture', 'captureStop']);
  });

  it('while the agent acts, Take over and your own pointer or key press on the page take the tab; the page’s own events and presses on the toolbar do not', () => {
    const { window, roots, sent: presses, call, host } = page();
    // Chrome marks your input (and the agent's, which the extension tells apart) trusted; a page's own events are not.
    const input = (target: Element, type: string, trusted: boolean) => {
      const event = type === 'keydown' ? new window.KeyboardEvent(type, { bubbles: true, composed: true, key: 'a' }) : new window.PointerEvent(type, { bubbles: true, composed: true });
      if (trusted) Object.defineProperty(event, 'isTrusted', { value: true });
      target.dispatchEvent(event);
    };
    call(browserOverlayFunction, show);
    input(window.document.body, 'pointerdown', false);
    input(window.document.body, 'keydown', false);
    expect(presses).toEqual([]);
    const toolbar = host();
    if (!toolbar) throw new Error('No overlay');
    input(toolbar, 'pointerdown', true);
    expect(presses).toEqual([]);
    input(window.document.body, 'pointerdown', true);
    input(window.document.body, 'keydown', true);
    expect(presses).toEqual(['take', 'take']);
    [...roots[0]?.querySelectorAll('button') ?? []].find(button => button.textContent === 'Take over')?.click();
    expect(presses).toEqual(['take', 'take', 'takeover']);
    // Once you hold the tab, or only a capture uses it, your input there takes nothing.
    call(browserOverlayFunction, { show: { ...show.show, mode: 'you', doing: null } });
    input(window.document.body, 'pointerdown', true);
    call(browserOverlayFunction, { show: { ...show.show, mode: 'capture', agent: null, doing: null } });
    input(window.document.body, 'keydown', true);
    expect(presses).toEqual(['take', 'take', 'takeover']);
  });

  it('while you hold the tab, says you are in control and the agent is paused, in a grey frame; Resume agent hands it back', () => {
    const { window, roots, sent: presses, call } = page();
    call(browserOverlayFunction, { show: { ...show.show, mode: 'you', doing: null } });
    expect(roots[0]?.textContent).toContain("You're in control");
    expect(roots[0]?.textContent).toContain('main is paused · it sees your changes when it resumes');
    expect(roots[0]?.textContent).not.toContain('Clicking');
    const shown = [...roots[0]?.querySelectorAll('button') ?? []].filter(visible);
    expect(shown.map(button => button.textContent || button.title)).toEqual(['Capture', 'Resume agent', 'Hide the GitSpace toolbar']);
    const resume = shown.find(button => button.textContent === 'Resume agent');
    expect(resume?.style.background).toBe('#1a73e8');
    expect([...roots[0]?.children ?? []].some(element => element instanceof window.HTMLElement && element.style.boxShadow === 'inset 0 0 0 2px #a3a3a3' && element.style.opacity === '1')).toBe(true);
    resume?.click();
    expect(presses).toEqual(['resume']);
  });

  it('while you hold the tab, the agent’s ghost cursor leaves the page; while the agent acts, it stays', () => {
    const { window, call } = page();
    window.document.documentElement.appendChild(window.document.createElement('gitspace-cursor'));
    call(browserOverlayFunction, show);
    expect(window.document.querySelectorAll('gitspace-cursor')).toHaveLength(1);
    call(browserOverlayFunction, { show: { ...show.show, mode: 'you', doing: null } });
    expect(window.document.querySelectorAll('gitspace-cursor')).toHaveLength(0);
  });

  it('removed from a world that has none of its own, still clears the toolbar an earlier session’s world left', () => {
    const { window, call, host } = page();
    // The toolbar an earlier session's world made, which this world never did.
    const stale = window.document.createElement('div');
    stale.setAttribute('data-gitspace-overlay', '');
    window.document.documentElement.appendChild(stale);
    call(browserOverlayFunction, { remove: true });
    expect(host()).toBeNull();
  });

  it('replaces one an earlier version drew in a world of its own, and leaves when removed', () => {
    const { window, call } = page();
    const stale = window.document.createElement('div');
    stale.setAttribute('data-gitspace-overlay', '');
    window.document.documentElement.appendChild(stale);
    call(browserOverlayFunction, show);
    expect(window.document.querySelectorAll('[data-gitspace-overlay]').length).toBe(1);
    expect(window.document.querySelector('[data-gitspace-overlay]')).not.toBe(stale);
    call(browserOverlayFunction, { remove: true });
    expect(window.document.querySelectorAll('[data-gitspace-overlay]').length).toBe(0);
    // The cursor alone never draws an overlay that is gone.
    expect(call(browserOverlayFunction, { cursor: { x: 1, y: 1, type: 'mouseMoved' } })).toBe(false);
  });

  it('stays the only toolbar on the page: one an earlier version draws later goes at once, the capture bar stays, and its own comes back when taken away', async () => {
    const { window, call, host } = page();
    call(browserOverlayFunction, show);
    const ours = host();
    call(browserCaptureBarFunction, { binding: '__gitspaceSend', show: { mode: 'capture', name: 'Order', startedAt: Date.now(), steps: 0, comments: 0, sound: null, saving: false } });
    // An earlier version's toolbar, drawn after this one from a world of its own.
    const stale = window.document.createElement('div');
    stale.setAttribute('data-gitspace-overlay', '');
    window.document.documentElement.appendChild(stale);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stale.isConnected).toBe(false);
    expect(window.document.querySelectorAll('[data-gitspace-overlay]')).toHaveLength(2);
    // That earlier toolbar took this one away as it installed.
    ours?.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ours?.isConnected).toBe(true);
  });

  it('asks the extension to draw it again once nothing refreshed it for 75 s, and leaves when the extension cannot be asked', async () => {
    const { window, sent, call, host } = page();
    const timers = new Map<number, { run: () => void; ms: number }>();
    let timer = 0;
    Object.assign(window, { setTimeout: (run: () => void, ms = 0) => { timers.set(++timer, { run, ms }); return timer; }, clearTimeout: (id: number) => { timers.delete(id); } });
    const deadline = () => { for (const [id, { run, ms }] of [...timers]) if (ms === 75_000) { timers.delete(id); run(); } };
    call(browserOverlayFunction, show);
    deadline();
    expect(sent).toEqual(['refresh']);
    expect(host()).not.toBeNull();
    // The extension is gone: asking fails, and the overlay leaves the page.
    Object.assign(window, { __gitspaceSend: async () => { throw new Error('Extension context invalidated.'); } });
    deadline();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host()).toBeNull();
  });

  it('with report, says where your own pointer is, at most ten times a second and the latest each time, and when it leaves the tab; never the agent’s pointer, and nothing once reporting stops', () => {
    const { window, sent: reports, call, host } = page();
    // The page's timers, which the test runs: those of the next second.
    const timers = new Map<number, { run: () => void; ms: number }>();
    let timer = 0;
    Object.assign(window, {
      setTimeout: (run: () => void, ms = 0) => { timers.set(++timer, { run, ms }); return timer; },
      clearTimeout: (id: number) => { timers.delete(id); },
    });
    const elapse = () => { for (const [id, { run, ms }] of [...timers]) if (ms < 1000) { timers.delete(id); run(); } };
    // Without a related target: the pointer left the page, not moved within it.
    const mouse = (type: string, x = 0, y = 0) => window.document.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y }));
    call(browserOverlayFunction, { show: null, report: true });
    expect(host()).not.toBeNull();
    mouse('mousemove', 512, 384); mouse('mousemove', 256, 192); mouse('mousemove', 768, 576);
    expect(reports).toEqual(['pointer {"x":0.5,"y":0.5}']);
    elapse();
    expect(reports).toEqual(['pointer {"x":0.5,"y":0.5}', 'pointer {"x":0.75,"y":0.75}']);
    // The agent's events land where its cursor is; they are not yours.
    call(browserOverlayFunction, { cursor: { x: 100, y: 100, type: 'mouseMoved' } });
    mouse('mousemove', 100, 100);
    elapse();
    expect(reports).toHaveLength(2);
    mouse('mouseout');
    elapse();
    expect(reports.at(-1)).toBe('pointer null');
    call(browserOverlayFunction, { show: null, report: false });
    mouse('mousemove', 512, 384);
    elapse();
    expect(reports).toHaveLength(3);
  });
});

/** The toolbar's parts in the overlay's shadow root, each with the box Chrome would lay out (happy-dom lays out
 * nothing): the toolbar 600×40 and the pill 100×32 where their styles put them in the tab, the handle 14 px wide 6 px
 * into the toolbar. At its own spot (bottom centre of a 1024×768 tab) the toolbar spans x 212–812 and y 712–752. */
function toolbar(window: Window, root: ShadowRoot | undefined) {
  const element = (found: Element | null | undefined) => { if (!(found instanceof window.HTMLElement)) throw new Error('No such part of the toolbar'); return found; };
  const hide = element(root?.querySelector('[title="Hide the GitSpace toolbar"]'));
  const bar = element(hide.parentElement);
  const grip = element(bar.firstElementChild);
  const pill = element(root?.querySelector('[title="Show the GitSpace toolbar"]'));
  const pillStop = element(pill.querySelector('button'));
  const box = (part: HTMLElement, width: number, height: number) => {
    const centred = part.style.transform.startsWith('translateX');
    const left = centred ? window.innerWidth / 2 - width / 2 : Number.parseFloat(part.style.left);
    const top = centred ? window.innerHeight - Number.parseFloat(part.style.bottom) - height : Number.parseFloat(part.style.top);
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
  };
  Object.assign(bar, { getBoundingClientRect: () => box(bar, 600, 40) });
  Object.assign(pill, { getBoundingClientRect: () => box(pill, 100, 32) });
  Object.assign(grip, { getBoundingClientRect: () => { const at = box(bar, 600, 40); return { ...at, left: at.left + 6, right: at.left + 20, width: 14, x: at.left + 6 }; } });
  return { bar, grip, hide, pill, pillStop };
}
/** Your pointer as Chrome reports it (trusted): a mouse, or a finger. */
function pointer(window: Window, target: Element, type: string, x: number, y: number, pointerType = 'mouse') {
  const event = new window.PointerEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: pointerType === 'touch' ? 2 : 1, pointerType });
  Object.defineProperty(event, 'isTrusted', { value: true });
  target.dispatchEvent(event);
}
/** A finger's touch event, as Chrome sends it after the pointer event; answers whether its default (scrolling the page)
 * was prevented. */
function touch(window: Window, target: Element, type: string) {
  const event = new window.TouchEvent(type, { bubbles: true, composed: true, cancelable: true, touches: [] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('moving and hiding the toolbar', () => {
  it('drags by its handle anywhere in the tab, never past its edges, keeps to its side as the tab changes size, and tells the extension where; the page hears none of it', () => {
    const { window, roots, sent, call } = page();
    const heard: string[] = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.document.addEventListener(type, () => { heard.push(type); });
    call(browserOverlayFunction, { ...show, place: null });
    const { bar, grip } = toolbar(window, roots[0]);
    const body = window.document.body;
    // Taken 8 px into the toolbar and 18 px down.
    pointer(window, grip, 'pointerdown', 220, 730);
    pointer(window, body, 'pointermove', -400, -400);
    expect([bar.style.left, bar.style.top]).toEqual(['8px', '8px']);
    pointer(window, body, 'pointermove', 5000, 5000);
    expect([bar.style.left, bar.style.top]).toEqual(['416px', '720px']);
    pointer(window, body, 'pointermove', 400, 300);
    expect([bar.style.left, bar.style.top]).toEqual(['392px', '282px']);
    expect(sent).toEqual([]);
    pointer(window, body, 'pointerup', 1000, 760);
    expect(sent).toEqual(['place {"at":{"x":1,"y":1},"hidden":false}']);
    expect(heard).toEqual([]);
    // In the bottom-right corner of a smaller tab, and at its left edge in a tab narrower than itself.
    window.happyDOM.setViewport({ width: 800, height: 600 });
    expect([bar.style.left, bar.style.top]).toEqual(['192px', '552px']);
    window.happyDOM.setViewport({ width: 500, height: 600 });
    expect([bar.style.left, bar.style.top]).toEqual(['8px', '552px']);
  });

  it('Hide folds it into a pill at the tab’s edge nearest it, which one click opens again; while the agent acts, its cursor and frame still show and the pill has Stop', () => {
    const { window, roots, sent, call } = page();
    call(browserOverlayFunction, { ...show, place: null });
    const { bar, hide, pill, pillStop } = toolbar(window, roots[0]);
    hide.click();
    expect([visible(bar), visible(pill), visible(pillStop)]).toEqual([false, true, true]);
    expect(sent).toEqual(['place {"at":null,"hidden":true}']);
    // At the toolbar's own spot, bottom centre.
    expect([pill.style.transform, pill.style.bottom]).toEqual(['translateX(-50%)', '16px']);
    call(browserOverlayFunction, { cursor: { x: 300, y: 200, type: 'mouseMoved' } });
    const shown = [...roots[0]?.children ?? []].filter(element => element instanceof window.HTMLElement && element.style.opacity === '1');
    expect(shown.map(element => element.textContent)).toEqual(['', 'main']);
    pillStop.click();
    expect(sent.at(-1)).toBe('stop');
    expect(pillStop.textContent).toBe('Stopping…');
    expect(visible(bar)).toBe(false);
    // Nothing acting, no Stop; a click on the pill opens the toolbar.
    call(browserOverlayFunction, { show: { ...show.show, mode: 'idle', agent: null, doing: null } });
    expect([visible(pill), visible(pillStop)]).toEqual([true, false]);
    pill.click();
    expect([visible(bar), visible(pill)]).toEqual([true, false]);
    expect(sent.at(-1)).toBe('place {"at":null,"hidden":false}');
    // Dragged an eighth of the way across and three quarters down, it hides to the left edge, three quarters down.
    call(browserOverlayFunction, show);
    pointer(window, toolbar(window, roots[0]).grip, 'pointerdown', 220, 730);
    pointer(window, window.document.body, 'pointerup', 67, 560);
    expect(sent.at(-1)).toBe('place {"at":{"x":0.125,"y":0.75},"hidden":false}');
    hide.click();
    expect([pill.style.left, pill.style.top]).toEqual(['8px', '548px']);
  });

  it('takes a finger too: a touch on it is never the page’s and never takes the tab, and its handle drags it without scrolling the page', () => {
    const { window, roots, sent, call } = page();
    const heard: string[] = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend']) window.document.addEventListener(type, () => { heard.push(type); });
    call(browserOverlayFunction, { ...show, place: null });
    const { bar } = toolbar(window, roots[0]);
    const body = window.document.body;
    // A tap on the toolbar lands on the page beneath it (the toolbar lets pointers through until one is over it); the
    // toolbar takes it, so the tap's click reaches its button.
    pointer(window, body, 'pointerdown', 700, 730, 'touch');
    expect(bar.style.pointerEvents).toBe('auto');
    expect(touch(window, body, 'touchstart')).toBe(false);
    pointer(window, body, 'pointerup', 700, 730, 'touch');
    touch(window, body, 'touchend');
    expect(sent).toEqual([]);
    expect(heard).toEqual([]);
    // Elsewhere on the page, a finger is yours and takes the tab while the agent acts.
    pointer(window, body, 'pointerdown', 100, 100, 'touch');
    pointer(window, body, 'pointerup', 100, 100, 'touch');
    expect(sent).toEqual(['take']);
    expect(heard).toEqual(['pointerdown', 'pointerup']);
    // On the handle, the finger drags the toolbar, 10 px into it and 18 px down; the page never scrolls under it.
    pointer(window, body, 'pointerdown', 222, 730, 'touch');
    expect(touch(window, body, 'touchstart')).toBe(true);
    pointer(window, body, 'pointermove', 322, 130, 'touch');
    expect(touch(window, body, 'touchmove')).toBe(true);
    pointer(window, body, 'pointerup', 322, 130, 'touch');
    touch(window, body, 'touchend');
    expect([bar.style.left, bar.style.top]).toEqual(['312px', '112px']);
    expect(JSON.parse(sent.at(-1)?.replace(/^place /, '') ?? '')).toEqual({ at: { x: 304 / 408, y: 104 / 712 }, hidden: false });
    expect(heard).toEqual(['pointerdown', 'pointerup']);
  });

  it('takes the place the extension kept for the tab once, as a new document of the tab does, and its own after that', () => {
    const { window, roots, call } = page();
    call(browserOverlayFunction, { ...show, place: { at: { x: 0, y: 0 }, hidden: false } });
    const { bar } = toolbar(window, roots[0]);
    call(browserOverlayFunction, { ...show, place: { at: { x: 1, y: 1 }, hidden: true } });
    expect(visible(bar)).toBe(true);
    expect([bar.style.left, bar.style.top]).toEqual(['8px', '8px']);
    // A new document of the tab (after a navigation), drawn where you left the toolbar: hidden at the bottom-right
    // corner, with Stop while the agent acts.
    const next = page();
    next.call(browserOverlayFunction, { ...show, place: { at: { x: 1, y: 1 }, hidden: true } });
    const drawn = toolbar(next.window, next.roots[0]);
    next.call(browserOverlayFunction, show);
    expect([visible(drawn.bar), visible(drawn.pill), visible(drawn.pillStop)]).toEqual([false, true, true]);
    expect([drawn.pill.style.left, drawn.pill.style.top]).toEqual(['916px', '728px']);
  });
});
