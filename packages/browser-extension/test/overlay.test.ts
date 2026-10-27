import { afterEach, describe, expect, it } from 'bun:test';
import { Window, type Element, type ShadowRoot } from 'happy-dom';
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
    const shown = () => buttons().filter(visible).map(button => button.textContent);
    call(browserOverlayFunction, { show: { ...show.show, capture: 'none' } });
    expect(shown()).toEqual(['Take over', 'Stop']);
    call(browserOverlayFunction, show);
    expect(shown()).toEqual(['Capture', 'Take over', 'Stop']);
    buttons().find(button => button.textContent === 'Capture')?.click();
    call(browserOverlayFunction, { show: { ...show.show, mode: 'capture', agent: null, doing: null, capture: 'recording', recording: { startedAt: Date.now(), sound: true } } });
    expect(roots[0]?.textContent).toContain('REC');
    // Recording alone, the agent's Stop is not offered.
    expect(shown()).toEqual(['Stop capture']);
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
    expect(shown.map(button => button.textContent)).toEqual(['Capture', 'Resume agent']);
    expect(shown.at(-1)?.style.background).toBe('#1a73e8');
    expect([...roots[0]?.children ?? []].some(element => element instanceof window.HTMLElement && element.style.boxShadow === 'inset 0 0 0 2px #a3a3a3' && element.style.opacity === '1')).toBe(true);
    shown.at(-1)?.click();
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
