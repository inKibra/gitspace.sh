import { afterEach, describe, expect, it } from 'bun:test';
import { Window, type ShadowRoot } from 'happy-dom';
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from '@gitspace/runtime-machine/browser-screenshot';
import { browserOverlayFunction } from '../src/overlay.js';

const show = { show: { mode: 'run', name: 'Checkout', color: '#1a73e8', binding: '__gitspaceStop', capture: 'ready' } };
const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

/** A page with the overlay function and the screenshot mask callable as the extension calls them; the overlay's
 * closed shadow root is kept for the test, which a page never gets. */
function page() {
  const window = new Window();
  windows.push(window);
  const roots: ShadowRoot[] = [];
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (init) { const root = attach.call(this, init); roots.push(root); return root; };
  const call = (declaration: string, argument?: unknown): unknown => window.eval(`(${declaration})`)(argument);
  return { window, roots, call, host: () => window.document.querySelector('[data-gitspace-overlay]') };
}

describe('the in-page overlay', () => {
  it('stays out of the accessibility tree and the focus order, and the screenshot mask hides it', () => {
    const { window, roots, call, host } = page();
    call(browserOverlayFunction, show);
    const element = host();
    if (!element) throw new Error('No overlay');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect([...roots[0]?.querySelectorAll('button, a, input, [tabindex]') ?? []].map(node => node.getAttribute('tabindex'))).toEqual(['-1', '-1']);
    call(browserScreenshotPrepareFunction, []);
    expect(window.getComputedStyle(element).visibility).toBe('hidden');
    call(browserScreenshotRestoreFunction);
    expect(window.getComputedStyle(element).visibility).not.toBe('hidden');
  });

  it('Stop calls the binding of its own world, and the page never sees the click', () => {
    const { window, roots, call } = page();
    const stops: string[] = [];
    const clicks: string[] = [];
    Object.assign(window, { __gitspaceStop: (payload: string) => { stops.push(payload); } });
    window.document.addEventListener('click', event => { clicks.push(event.type); });
    call(browserOverlayFunction, show);
    const stop = [...roots[0]?.querySelectorAll('button') ?? []].find(button => button.textContent === 'Stop');
    if (!stop) throw new Error('No Stop');
    stop.click();
    expect(stops).toEqual(['stop']);
    expect(clicks).toEqual([]);
  });

  it('Capture starts a capture where the account saves them; while it records, REC shows and Stop capture ends it', () => {
    const { window, roots, call } = page();
    const presses: string[] = [];
    Object.assign(window, { __gitspaceStop: (payload: string) => { presses.push(payload); } });
    const buttons = () => [...roots[0]?.querySelectorAll('button') ?? []];
    const shown = () => buttons().filter(button => button.style.display !== 'none').map(button => button.textContent);
    call(browserOverlayFunction, { show: { ...show.show, capture: 'none' } });
    expect(shown()).toEqual(['Stop']);
    call(browserOverlayFunction, show);
    expect(shown()).toEqual(['Capture', 'Stop']);
    buttons().find(button => button.textContent === 'Capture')?.click();
    call(browserOverlayFunction, { show: { ...show.show, mode: 'capture', capture: 'recording' } });
    expect(roots[0]?.textContent).toContain('REC');
    // Recording alone, the agent's Stop is not offered.
    expect(shown()).toEqual(['Stop capture']);
    buttons().find(button => button.textContent === 'Stop capture')?.click();
    expect(presses).toEqual(['capture', 'captureStop']);
  });

  it('replaces one a previous debugger session left and leaves when removed', () => {
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
});
