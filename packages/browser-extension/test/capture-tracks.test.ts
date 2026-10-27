import { afterEach, describe, expect, it, jest } from 'bun:test';
import { Window, type Element, type ShadowRoot } from 'happy-dom';
import { RuntimeBrowserCaptureStepsSchema, RuntimeBrowserLayoutSampleSchema } from '@gitspace/protocol-runtime';
import { browserCaptureBarFunction, browserCaptureRecorderFunction, CaptureTrackRecorder, CaptureTracksInChrome, type CaptureCommentMode, type CaptureTracksHost, type ChromeCapture } from '../src/capture-tracks.js';
import { browserOverlayFunction } from '../src/overlay.js';

const windows: Window[] = [];
afterEach(async () => { jest.useRealTimers(); for (const window of windows.splice(0)) await window.happyDOM.close(); });

/** A page calling the extension's functions as its isolated world would, with the binding they report to; closed
 * shadow roots are kept for the test. Page timers never run: nothing here waits on them. */
function page(html = '') {
  const window = new Window({ url: 'https://shop.example/order?session=1' });
  windows.push(window);
  const roots: ShadowRoot[] = [];
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (init) { const root = attach.call(this, init); roots.push(root); return root; };
  Object.assign(window.Element.prototype, { animate: () => ({ finished: Promise.resolve() }) });
  const calls: string[] = [];
  Object.assign(window, { __gitspaceSend: (payload: string) => { calls.push(payload); }, setTimeout: () => 0, setInterval: () => 0 });
  window.document.body.innerHTML = html;
  const call = (declaration: string, argument?: unknown): unknown => window.eval(`(${declaration})`)(argument);
  /** Dispatches an event as your own input: trusted. */
  const you = (target: Element | ShadowRoot | typeof window.document, event: InstanceType<typeof window.Event>) => { Object.defineProperty(event, 'isTrusted', { value: true }); target.dispatchEvent(event); };
  const element = (selector: string) => { const found = window.document.querySelector(selector); if (!found) throw new Error(`No ${selector}`); return found; };
  return { window, roots, calls, call, you, element };
}

const FORM = `<form>
  <label for="name">Customer name</label><input id="name" name="custname">
  <label>Password <input type="password" name="pw"></label>
  <input name="cardnumber" autocomplete="cc-number" aria-label="Card">
  <input name="access_token" aria-label="Access">
  <label><input type="checkbox" name="topping" value="bacon"> Bacon</label>
  <select name="size" aria-label="Size"><option>Small</option><option>Medium</option></select>
  <button type="button">Cancel</button><button type="button">Cancel</button>
  <button type="button" data-testid="submit">Submit order</button>
</form>`;

describe('the steps you take while capturing', () => {
  it('become Playwright locators computed in the page, with secrets masked, typing as one fill, and only your own input', () => {
    const { window, calls, call, you, element } = page(FORM);
    call(browserCaptureRecorderFunction, { binding: '__gitspaceSend' });
    const type = (selector: string, value: string) => { const input = element(selector); Reflect.set(input, 'value', value); you(input, new window.Event('input', { bubbles: true })); };
    const click = (selector: string) => you(element(selector), new window.MouseEvent('click', { bubbles: true, button: 0 }));
    // Clicking into a field is no step; typing is one fill once the field changes.
    click('#name');
    type('#name', 'A'); type('#name', 'Ada');
    you(element('#name'), new window.Event('change', { bubbles: true }));
    // A password typed, then a click elsewhere: the fill comes first, masked.
    type('[name=pw]', 'hunter2');
    click('button:nth-of-type(1)');
    type('[name=cardnumber]', '4242 4242 4242 4242');
    you(element('[name=cardnumber]'), new window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    type('[name=access_token]', 'tok-123');
    you(element('[name=access_token]'), new window.Event('change', { bubbles: true }));
    const box = element('[name=topping]');
    Reflect.set(box, 'checked', true);
    you(box, new window.Event('change', { bubbles: true }));
    Reflect.set(element('select'), 'selectedIndex', 1);
    you(element('select'), new window.Event('change', { bubbles: true }));
    // The page's own events are not yours.
    element('[data-testid=submit]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    click('[data-testid=submit]');
    const steps = calls.filter(text => text.startsWith('step ')).map(text => JSON.parse(text.slice(5)));
    expect(steps.map(({ kind, locator, value }) => ({ kind, locator, value }))).toEqual([
      { kind: 'fill', locator: "getByRole('textbox', { name: 'Customer name' })", value: 'Ada' },
      { kind: 'fill', locator: "getByLabel('Password')", value: '«secret»' },
      { kind: 'click', locator: "getByRole('button', { name: 'Cancel', exact: true }).nth(0)", value: undefined },
      { kind: 'fill', locator: "getByRole('textbox', { name: 'Card' })", value: '«secret»' },
      { kind: 'press', locator: "getByRole('textbox', { name: 'Card' })", value: 'Enter' },
      { kind: 'fill', locator: "getByRole('textbox', { name: 'Access' })", value: '«secret»' },
      { kind: 'check', locator: "getByRole('checkbox', { name: 'Bacon' })", value: 'true' },
      { kind: 'select', locator: "getByRole('combobox', { name: 'Size' })", value: 'Medium' },
      { kind: 'click', locator: "getByTestId('submit')", value: undefined },
    ]);
    expect(calls.join('\n')).not.toMatch(/hunter2|4242|tok-123/u);
    expect(steps.every(step => step.url === 'https://shop.example/order?session=1')).toBe(true);
  });

  it('a field still being typed in when the capture ends is its last step', () => {
    const { window, call, you, element } = page(FORM);
    call(browserCaptureRecorderFunction, { binding: '__gitspaceSend' });
    Reflect.set(element('#name'), 'value', 'Grace');
    you(element('#name'), new window.Event('input', { bubbles: true }));
    expect(call(browserCaptureRecorderFunction, { flush: true })).toEqual({ kind: 'fill', url: 'https://shop.example/order?session=1', locator: "getByRole('textbox', { name: 'Customer name' })", value: 'Grace' });
    expect(call(browserCaptureRecorderFunction, { flush: true })).toBeNull();
  });
});

describe('a capture’s tracks on its clock', () => {
  it('start at the page, keep the page’s fetches and every request that changes data, marked, with secrets in addresses masked', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    const recorder = new CaptureTrackRecorder({ startedAt, url: 'https://shop.example/order?token=abc&page=2', layout: async () => {} });
    jest.advanceTimersByTime(1200);
    recorder.request({ type: 'XHR', request: { method: 'POST', url: 'https://shop.example/api/orders' } });
    recorder.request({ type: 'Fetch', request: { method: 'GET', url: 'https://shop.example/api/menu' } });
    recorder.request({ type: 'Image', request: { method: 'GET', url: 'https://shop.example/logo.png' } });
    recorder.request({ type: 'Preflight', request: { method: 'OPTIONS', url: 'https://shop.example/api/orders' } });
    recorder.request({ type: 'Document', request: { method: 'post', url: 'https://user:pw@shop.example/checkout?otp=991' } });
    recorder.page(`step ${JSON.stringify({ kind: 'click', locator: "getByRole('button', { name: 'Pay' })", url: 'https://shop.example/pay?card=4242' })}`);
    recorder.navigated('https://shop.example/done');
    recorder.navigated('https://shop.example/done');
    const { steps, tracks } = await recorder.finish();
    expect(RuntimeBrowserCaptureStepsSchema.parse(JSON.parse(new TextDecoder().decode(steps)))).toEqual([
      { atMs: 0, kind: 'goto', url: 'https://shop.example/order?token=%C2%ABsecret%C2%BB&page=2' },
      { atMs: 1200, kind: 'request', url: 'https://shop.example/api/orders', method: 'POST', mutating: true },
      { atMs: 1200, kind: 'request', url: 'https://shop.example/api/menu', method: 'GET' },
      { atMs: 1200, kind: 'request', url: 'https://shop.example/checkout?otp=%C2%ABsecret%C2%BB', method: 'POST', mutating: true },
      { atMs: 1200, kind: 'click', locator: "getByRole('button', { name: 'Pay' })", url: 'https://shop.example/pay?card=%C2%ABsecret%C2%BB' },
      { atMs: 1200, kind: 'goto', url: 'https://shop.example/done' },
    ]);
    expect(tracks).toEqual({ steps: { path: 'steps.json', count: 6 } });
  });

  it('keep layout samples as they change, at most two a second, the latest of those that came sooner', async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    const recorder = new CaptureTrackRecorder({ startedAt: Date.now(), url: 'https://shop.example/', layout: async line => { lines.push(new TextDecoder().decode(line)); } });
    /** Lets the layout writes queued so far finish. */
    const written = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
    const sample = (name: string) => `layout ${JSON.stringify({ viewport: { w: 1280, h: 720 }, scroll: { x: 0, y: 40 }, elements: [{ role: 'button', name, selector: 'button', box: { x: 0.1, y: 0.2, w: 0.3, h: 2 } }] })}`;
    recorder.page(sample('first'));
    jest.advanceTimersByTime(100); recorder.page(sample('second'));
    jest.advanceTimersByTime(200); recorder.page(sample('third'));
    jest.advanceTimersByTime(199);
    await written();
    expect(lines).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await written();
    expect(lines).toHaveLength(2);
    jest.advanceTimersByTime(100); recorder.page(sample('fourth'));
    jest.advanceTimersByTime(100);
    const { tracks } = await recorder.finish();
    const samples = lines.map(line => RuntimeBrowserLayoutSampleSchema.parse(JSON.parse(line)));
    expect(samples.map(entry => [entry.atMs, entry.elements[0]?.name])).toEqual([[0, 'first'], [500, 'third'], [700, 'fourth']]);
    expect(samples[0]?.elements[0]?.box).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 1 });
    expect(tracks.layout).toEqual({ path: 'layout.jsonl', count: 3 });
  });
});

describe('the capturing bar', () => {
  const capturing = { mode: 'capture', name: 'Order a pizza', startedAt: Date.now() - 14_000, steps: 5, comments: 1, sound: true, saving: false };
  /** The bar's buttons that show: neither they nor what holds them is `display: none`. */
  const shown = (roots: ShadowRoot[]) => [...roots.at(-1)?.querySelectorAll('button') ?? []].filter(button => { for (let node: Element | null = button; node; node = node.parentElement) if (node.getAttribute('style')?.includes('display: none')) return false; return true; }).map(button => button.textContent?.trim());

  it('while capturing names the capture, its time, steps and comments, with Comment, the sound and Done; C comments outside a field', () => {
    const { window, roots, calls, call, you, element } = page('<input id="field">');
    call(browserCaptureBarFunction, { binding: '__gitspaceSend', show: capturing });
    const text = roots.at(-1)?.textContent ?? '';
    expect(text).toContain('Capturing · Order a pizza✎ · 0:14 · 5 steps · 1 comment');
    expect(text).toContain('REC 0:14 · tabCapture · with sound');
    expect(text).toContain('press C to point something out. Secrets are masked.');
    expect(shown(roots)).toEqual(['Comment', '🔊 Sound', 'Done']);
    for (const label of ['Comment', '🔊 Sound', 'Done']) [...roots.at(-1)?.querySelectorAll('button') ?? []].find(button => button.textContent?.trim() === label)?.click();
    you(window.document, new window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    you(element('#field'), new window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(calls).toEqual(['captureComment', 'captureSound', 'captureDone', 'captureComment']);
  });

  it('in comment mode says how to comment and offers Back to doing and Done; frames have no sound to toggle', () => {
    const { roots, calls, call } = page();
    call(browserCaptureBarFunction, { binding: '__gitspaceSend', show: { ...capturing, mode: 'comment', comments: 2, sound: null } });
    expect(roots.at(-1)?.textContent).toContain('Comment tool · click an element or drag an area · 2 comments');
    expect(roots.at(-1)?.textContent).toContain('REC 0:14 · frames · no sound');
    expect(shown(roots)).toEqual(['Back to doing (Esc)', 'Done']);
    [...roots.at(-1)?.querySelectorAll('button') ?? []].find(button => button.textContent === 'Back to doing (Esc)')?.click();
    expect(calls).toEqual(['captureBack']);
  });

  it('saved, shows the card with the capture’s tracks and its actions; renaming says the new name', () => {
    const { window, roots, calls, call } = page();
    call(browserCaptureBarFunction, { binding: '__gitspaceSend', show: { mode: 'saved', name: 'Order a pizza', workspace: 'Cross-machine browser relay', pills: ['5 steps', '1 comment', 'video 0:14 · sound', 'page layout'], mention: 'Copy mention', share: 'Share', replay: 'Replay steps', notice: null } });
    const text = roots.at(-1)?.textContent ?? '';
    expect(text).toContain('Capture saved: Order a pizza✎');
    expect(text).toContain('In the Browser tab of Cross-machine browser relay · not in the repository');
    expect(text).toContain('5 steps1 commentvideo 0:14 · soundpage layout');
    expect(text).toContain('Mention @Order a pizza in the chat');
    expect(shown(roots)).toEqual(['✕', 'Copy mention', 'Share', 'Replay steps', 'Open in GitSpace']);
    for (const label of ['Copy mention', 'Share', 'Replay steps', 'Open in GitSpace', '✕']) [...roots.at(-1)?.querySelectorAll('button') ?? []].find(button => button.textContent === label)?.click();
    const pencil = [...roots.at(-1)?.querySelectorAll('span') ?? []].filter(span => span.textContent === '✎').at(-1);
    pencil?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const name = pencil?.previousElementSibling;
    if (!name) throw new Error('No name');
    name.textContent = 'Pizza order, large';
    name.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls).toEqual(['captureMention', 'captureShare', 'captureReplay', 'captureOpen', 'captureClose', 'captureName "Pizza order, large"']);
  });

  it('the agent’s toolbar gives way to it while a capture records its steps, and rises above it while the agent acts', () => {
    const { roots, call } = page();
    const recording = { startedAt: Date.now(), sound: true, tracks: true };
    call(browserOverlayFunction, { show: { mode: 'capture', workspace: 'Checkout', agent: null, doing: null, capture: 'recording', recording } });
    const bar = roots[0]?.querySelector('div[style*="bottom"]');
    expect(bar?.getAttribute('style')).toContain('display: none');
    call(browserOverlayFunction, { show: { mode: 'run', workspace: 'Checkout', agent: 'main', doing: 'Clicking', capture: 'recording', recording } });
    expect(bar?.getAttribute('style')).toContain('bottom: 76px');
    expect([...roots[0]?.querySelectorAll('button') ?? []].filter(button => button.style.display !== 'none').map(button => button.textContent?.trim())).not.toContain('Stop capture');
  });
});

describe('a capture on your Chrome', () => {
  /** The service worker as the tracks see it: what they upload, draw, send and open. */
  async function chrome() {
    const key = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    const uploads = new Map<string, Uint8Array[]>(), completed: string[] = [], sent: object[] = [], opened: string[] = [], copied: string[] = [], released: string[] = [], stopped: string[] = [];
    const modes: (CaptureCommentMode | null)[] = [];
    const host: CaptureTracksHost = {
      account: 'https://account.gitspace.test',
      upload: (_capture, file) => ({ write: async bytes => { uploads.set(file, [...uploads.get(file) ?? [], bytes]); }, complete: async () => { completed.push(file); }, abort: async () => {} }),
      redraw: () => {},
      call: async (_targetId, name, argument) => {
        if (name === 'bar' && argument && typeof argument === 'object' && 'copy' in argument && typeof argument.copy === 'string') { copied.push(argument.copy); return true; }
        return null;
      },
      send: message => { sent.push(message); },
      identity: async () => ({ privateKey: key.privateKey, pairingId: crypto.randomUUID(), generation: 1 }),
      commentMode: async (_targetId, mode) => { modes.push(mode); },
      group: async () => ({ name: 'Cross-machine browser relay', projectId: 'project', workspaceId: 'workspace' }),
      open: async url => { opened.push(url); },
      stop: async capture => { stopped.push(capture.captureId); },
      sound: async () => {},
      release: async targetId => { released.push(targetId); },
    };
    return { tracks: new CaptureTracksInChrome(host), uploads, completed, sent, opened, copied, released, stopped, modes };
  }
  const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

  it('counts your steps and comments, ends with Done, uploads steps and layout, and the saved card copies the mention, shares, asks for a replay and opens GitSpace', async () => {
    jest.useFakeTimers();
    const { tracks, uploads, completed, sent, opened, copied, stopped, modes } = await chrome();
    const capture: ChromeCapture = { captureId: crypto.randomUUID(), track: 'video', groupId: crypto.randomUUID(), tabId: 4, targetId: 'tab', url: 'https://shop.example/order', title: 'Order a pizza', startedAt: Date.now(), ending: null };
    tracks.start(capture, true);
    expect(tracks.shows('tab')).toBe(true);
    jest.advanceTimersByTime(3000);
    tracks.message('tab', `step ${JSON.stringify({ kind: 'fill', locator: "getByLabel('Name')", value: 'Ada', url: capture.url })}`);
    tracks.message('tab', `layout ${JSON.stringify({ viewport: { w: 800, h: 600 }, scroll: { x: 0, y: 0 }, elements: [] })}`);
    tracks.event('tab', 'Network.requestWillBeSent', { type: 'Fetch', request: { method: 'POST', url: 'https://shop.example/api/orders' } });
    tracks.message('tab', 'captureComment');
    await settle();
    const mode = modes.at(-1);
    if (!mode) throw new Error('Comment mode did not start');
    expect(mode).toMatchObject({ captureId: capture.captureId, startedAt: capture.startedAt });
    mode.saved(); mode.ended();
    tracks.message('tab', 'captureDone');
    await settle();
    expect(stopped).toEqual([capture.captureId]);

    const finished = await tracks.finish(capture);
    expect(finished).toEqual({ name: 'Order a pizza', tracks: { comments: { count: 1 }, steps: { path: 'steps.json', count: 3 }, layout: { path: 'layout.jsonl', count: 1 } } });
    expect(JSON.parse(new TextDecoder().decode(uploads.get('steps.json')?.[0]))).toEqual([
      { atMs: 0, kind: 'goto', url: 'https://shop.example/order' },
      { atMs: 3000, kind: 'fill', locator: "getByLabel('Name')", value: 'Ada', url: 'https://shop.example/order' },
      { atMs: 3000, kind: 'request', url: 'https://shop.example/api/orders', method: 'POST', mutating: true },
    ]);
    expect(completed.sort()).toEqual(['layout.jsonl', 'steps.json']);

    await tracks.ended(capture, { saved: true, tracks: { ...finished?.tracks, video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 14_000 } } });
    expect(tracks.shows('tab')).toBe(true);
    const fetches: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(input), body: JSON.parse(new TextDecoder().decode(init?.body instanceof Uint8Array ? init.body : new Uint8Array())) });
      return Response.json({ status: 'ok', value: { captureShare: { link: 'https://account.gitspace.test/c/share#secret' } } });
    }, { preconnect: realFetch.preconnect });
    try {
      for (const command of ['captureMention', 'captureShare', 'captureReplay', 'captureOpen']) { tracks.message('tab', command); await settle(); const loop = Promise.withResolvers<void>(); setImmediate(loop.resolve); await loop.promise; await settle(); }
    } finally { globalThis.fetch = realFetch; }
    expect(copied).toEqual([`capture://${capture.captureId}`, 'https://account.gitspace.test/c/share#secret']);
    expect(fetches).toEqual([{ url: 'https://account.gitspace.test/api/browser-relay/capture-shares', body: { op: 'create', captureId: capture.captureId, groupId: capture.groupId, comment: true, expiresInMinutes: 10_080 } }]);
    expect(sent).toEqual([{ captureReplay: { captureId: capture.captureId, groupId: capture.groupId } }]);
    expect(opened).toEqual([`https://account.gitspace.test/?project=project&workspace=workspace&capture=${capture.captureId}`]);
  });

  it('that failed shows no card, and the card leaves with another page', async () => {
    const { tracks, released } = await chrome();
    const capture: ChromeCapture = { captureId: crypto.randomUUID(), track: 'frames', groupId: crypto.randomUUID(), tabId: 4, targetId: 'tab', url: 'https://shop.example/', title: 'Shop', startedAt: Date.now(), ending: null };
    tracks.start(capture, null);
    await tracks.ended(capture, { saved: false, tracks: {} });
    expect(tracks.shows('tab')).toBe(false);
    expect(released).toEqual(['tab']);
    const again = { ...capture, captureId: crypto.randomUUID() };
    tracks.start(again, null);
    await tracks.finish(again);
    await tracks.ended(again, { saved: true, tracks: {} });
    expect(tracks.shows('tab')).toBe(true);
    tracks.event('tab', 'Page.frameNavigated', { frame: { id: 'main', url: 'https://elsewhere.example/' } });
    expect(tracks.shows('tab')).toBe(false);
  });
});
