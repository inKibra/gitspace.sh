/**
 * A capture's steps and layout tracks (docs/APERTURE-DESIGN.md §11; `browser-capture-tracks.ts` in protocol-runtime),
 * recorded on one clock with its video or frames, and the in-page capturing bar and saved card on your Chrome (the
 * agreed look is account-web's BrowsersMockExtension modes `capture`, `capture-comment` and `saved`).
 *
 * - `browserCaptureRecorderFunction` runs in an isolated world of the recorded tab (the extension's page world on your
 *   Chrome, `page.ts`; its own on the cloud browser): it turns your trusted clicks, typing, key presses and form changes into steps with
 *   Playwright locators computed in the page, masking secrets, and samples the visible elements when the page changes,
 *   at most twice a second. It reports (`step {…}`, `layout {…}`) through the function its `binding` names: a CDP
 *   binding on the cloud browser, `__gitspaceSend` (`page.ts`) on your Chrome.
 * - `CaptureTrackRecorder` receives those reports, the tab's navigations and its requests (`Network` domain) and
 *   keeps them on the capture's clock: steps in memory for `steps.json`, layout lines streamed to `layout.jsonl`.
 *   The cloud browser's captures use it too (account-worker `browser-capture.ts`).
 * - `browserCaptureBarFunction` draws the capturing bar (name ✎, time, steps and comments, Comment, sound, Done), its
 *   comment mode and the saved card in its own shadow root over the overlay; `CaptureTracksInChrome` runs them in the
 *   service worker.
 */
import { CAPTURE_LAYOUT_ELEMENTS, CAPTURE_LAYOUT_INTERVAL_MS, CAPTURE_SECRET_NAME, CAPTURE_SECRET_VALUE, CAPTURE_STEPS_MAX, CAPTURE_TRACK_FILES, captureMaskedUrl } from '@gitspace/protocol-runtime/browser-capture-rules';
import type { RuntimeBrowserCaptureStep, RuntimeBrowserCaptureTracks, RuntimeBrowserLayoutSample } from '@gitspace/protocol-runtime';
import { accountValue, relaySignature, sha256Hex, SIGNATURE_HEADER, type SigningIdentity } from './upload.js';

/**
 * In an isolated world of a recorded tab. `{ binding }` installs the recorder (once per document; again only names
 * the function it reports through), `{ flush: true }` answers the step of a field still being typed in (null if none) instead of reporting
 * it, `{ remove: true }` stops it. Only trusted events count, and none on GitSpace's own hosts (`data-gitspace-overlay`).
 * A click on a text field, checkbox, select or file input is left to the `fill`, `check`, `select` or `upload` its
 * change makes; typing becomes one `fill` when the field changes or another step comes. Values of password fields,
 * fields with `autocomplete` `cc-*` or `one-time-code`, and fields whose name or id looks secret are masked.
 * Locators: a unique `data-testid`, else role and accessible name (`exact` and `.nth` when needed), else the label,
 * else unique exact text, else CSS. Layout: the visible part of each element one can point at, as viewport fractions,
 * sampled on change (DOM, scroll, resize) at most once per `CAPTURE_LAYOUT_INTERVAL_MS`, and only when it differs.
 */
export const browserCaptureRecorderFunction = `function(command) {
  const key = '__gitspaceCaptureRecorder';
  if (command.remove) { if (globalThis[key]) globalThis[key].dispose(); return true; }
  if (command.flush) return globalThis[key] ? globalThis[key].flush() : null;
  if (globalThis[key]) { globalThis[key].binding = command.binding; return true; }
  const SECRET = ${JSON.stringify(CAPTURE_SECRET_VALUE)}, SECRET_NAME = ${String(CAPTURE_SECRET_NAME)};
  const INTERVAL = ${CAPTURE_LAYOUT_INTERVAL_MS}, ELEMENTS = ${CAPTURE_LAYOUT_ELEMENTS}, LONG = 200;
  const state = { binding: command.binding, pending: null, timer: 0, last: 0, sampled: '' };
  const report = text => { const call = globalThis[state.binding]; if (typeof call === 'function') call(text); };
  const ours = node => node instanceof Element && node.hasAttribute('data-gitspace-overlay');
  const inOurs = event => event.composedPath().some(ours);
  const clean = text => String(text ?? '').replace(/\\s+/g, ' ').trim();
  const has = (table, name) => Object.prototype.hasOwnProperty.call(table, name);
  const typeOf = el => (el.getAttribute('type') || '').toLowerCase();
  const textOf = el => clean(el.innerText ?? el.textContent);
  const INPUT_ROLES = { '': 'textbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', search: 'searchbox', number: 'spinbutton', range: 'slider', checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button' };
  const TAG_ROLES = { button: 'button', summary: 'button', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', main: 'main', aside: 'complementary', article: 'article', dialog: 'dialog', table: 'table', ul: 'list', ol: 'list', li: 'listitem', option: 'option', fieldset: 'group', details: 'group', progress: 'progressbar', hr: 'separator', p: 'paragraph', td: 'cell', th: 'columnheader', tr: 'row', form: 'form', meter: 'meter' };
  const NAMED_BY_CONTENT = { button: 1, link: 1, heading: 1, checkbox: 1, radio: 1, option: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1, cell: 1, columnheader: 1, rowheader: 1, switch: 1, tooltip: 1 };
  const TEXT_TYPES = { '': 1, text: 1, email: 1, tel: 1, url: 1, search: 1, password: 1, number: 1, date: 1, 'datetime-local': 1, month: 1, time: 1, week: 1 };
  const TEXT_TAGS = { p: 1, li: 1, td: 1, th: 1, label: 1 };
  const ROLES = 'a[href],area[href],button,input,select,textarea,summary,img,h1,h2,h3,h4,h5,h6,[role],[contenteditable],nav,main,aside,article,dialog,table,ul,ol,li,option,fieldset,details,progress,hr,p,td,th,tr,form,meter,section';
  const LAYOUT = 'a[href],button,input:not([type=hidden]),select,textarea,summary,img,h1,h2,h3,h4,h5,h6,label,p,li,td,th,[role],[contenteditable],[tabindex],[data-testid]';
  const ACTIONABLE = 'button,a[href],input,select,textarea,summary,label,option,[role],[contenteditable],[onclick],[tabindex]';
  const roleOf = el => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit === 'none' || explicit === 'presentation' ? null : explicit;
    const tag = el.localName;
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') return has(INPUT_ROLES, typeOf(el)) ? INPUT_ROLES[typeOf(el)] : null;
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'img') return el.getAttribute('alt') === '' ? null : 'img';
    if (tag === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
    return has(TAG_ROLES, tag) ? TAG_ROLES[tag] : null;
  };
  const labelOf = el => el.labels ? clean([...el.labels].map(textOf).join(' ')) : '';
  const nameOf = el => {
    const labelledBy = clean(el.getAttribute('aria-labelledby'));
    if (labelledBy) { const text = clean(labelledBy.split(' ').map(id => { const ref = document.getElementById(id); return ref ? textOf(ref) : ''; }).join(' ')); if (text) return text; }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.localName, type = tag === 'input' ? typeOf(el) : '';
    if (type === 'button' || type === 'submit' || type === 'reset') return clean(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    if (type === 'image') return clean(el.getAttribute('alt')) || 'Submit';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return labelOf(el) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));
    if (tag === 'img' || tag === 'area') return clean(el.getAttribute('alt')) || clean(el.getAttribute('title'));
    const role = roleOf(el);
    if (role && has(NAMED_BY_CONTENT, role)) { const text = textOf(el); if (text) return text; }
    return clean(el.getAttribute('title'));
  };
  const visible = el => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
  const quote = text => { const slash = String.fromCharCode(92); return "'" + text.split(slash).join(slash + slash).split("'").join(slash + "'") + "'"; };
  const byRole = (role, name, exact) => 'getByRole(' + quote(role) + ', { name: ' + quote(name) + (exact ? ', exact: true' : '') + ' })';
  const pathOf = el => {
    const path = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node !== el && node.id) { path.unshift('#' + CSS.escape(node.id)); break; }
      const same = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [node];
      path.unshift(same.length > 1 ? node.localName + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : node.localName);
    }
    return path.join(' > ');
  };
  const unique = (selector, el) => { try { const found = document.querySelectorAll(selector); return found.length === 1 && found[0] === el; } catch { return false; } };
  const cssOf = el => {
    if (el.id && unique('#' + CSS.escape(el.id), el)) return '#' + CSS.escape(el.id);
    for (const name of ['data-test', 'data-qa', 'name']) {
      const value = el.getAttribute(name);
      const selector = value && value.length <= LONG ? el.localName + '[' + name + '="' + CSS.escape(value) + '"]' : '';
      if (selector && unique(selector, el)) return selector;
    }
    return pathOf(el);
  };
  const locatorOf = el => {
    const testId = el.getAttribute('data-testid');
    if (testId && testId.length <= LONG && unique('[data-testid="' + CSS.escape(testId) + '"]', el)) return 'getByTestId(' + quote(testId) + ')';
    const role = roleOf(el), name = nameOf(el);
    if (role && name && name.length <= LONG) {
      const lower = name.toLowerCase();
      const same = [...document.querySelectorAll(ROLES)].filter(other => other === el || (roleOf(other) === role && visible(other) && nameOf(other).toLowerCase().includes(lower)));
      if (same.length === 1) return byRole(role, name, false);
      const exact = same.filter(other => other === el || nameOf(other) === name);
      return byRole(role, name, true) + (exact.length > 1 ? '.nth(' + exact.indexOf(el) + ')' : '');
    }
    const label = el.localName === 'input' || el.localName === 'select' || el.localName === 'textarea' ? labelOf(el) : '';
    if (label && label.length <= LONG) {
      const lower = label.toLowerCase();
      if ([...document.querySelectorAll('input,select,textarea')].filter(other => labelOf(other).toLowerCase().includes(lower)).length === 1) return 'getByLabel(' + quote(label) + ')';
    }
    const text = textOf(el);
    if (text && text.length <= 80 && !el.querySelector('input,select,textarea')) {
      const matches = [...document.body.querySelectorAll('*')].filter(other => (other.textContent ?? '').includes(text) && textOf(other) === text && ![...other.children].some(child => textOf(child) === text));
      if (matches.length === 1 && matches[0] === el) return 'getByText(' + quote(text) + ', { exact: true })';
    }
    return 'locator(' + quote(cssOf(el)) + ')';
  };
  const targetOf = event => { const node = event.composedPath()[0]; return node instanceof Element ? node : node && node.parentElement ? node.parentElement : null; };
  const fillable = el => el.localName === 'textarea' || (el.localName === 'input' && has(TEXT_TYPES, typeOf(el))) || el.isContentEditable;
  const checkable = el => el.localName === 'input' && (typeOf(el) === 'checkbox' || typeOf(el) === 'radio');
  const secret = el => {
    if (el.localName === 'input' && typeOf(el) === 'password') return true;
    if (clean(el.getAttribute('autocomplete')).toLowerCase().split(' ').some(token => token.startsWith('cc-') || token === 'one-time-code')) return true;
    return SECRET_NAME.test(el.getAttribute('name') || '') || SECRET_NAME.test(el.id || '');
  };
  const entry = (kind, el, value) => {
    const step = { kind, url: location.href };
    if (el) step.locator = locatorOf(el);
    if (value !== undefined) step.value = String(value).slice(0, 4096);
    return step;
  };
  const send = (kind, el, value) => report('step ' + JSON.stringify(entry(kind, el, value)));
  const typed = el => entry('fill', el, secret(el) ? SECRET : el.isContentEditable ? textOf(el) : el.value);
  const flush = () => { const el = state.pending; state.pending = null; if (el && el.isConnected) report('step ' + JSON.stringify(typed(el))); };
  const field = el => el.isContentEditable ? el.closest('[contenteditable]') || el : el;
  const onInput = event => {
    if (!event.isTrusted || inOurs(event)) return;
    const el = targetOf(event);
    if (!el || !fillable(field(el))) return;
    if (state.pending && state.pending !== field(el)) flush();
    state.pending = field(el);
  };
  const onChange = event => {
    if (!event.isTrusted || inOurs(event)) return;
    const el = targetOf(event);
    if (!el) return;
    if (fillable(el)) { if (state.pending !== el) flush(); state.pending = el; flush(); return; }
    flush();
    if (checkable(el)) send('check', el, el.checked ? 'true' : 'false');
    else if (el.localName === 'select') send('select', el, secret(el) ? SECRET : [...el.selectedOptions].map(option => clean(option.label || option.textContent)).join(', '));
    else if (el.localName === 'input' && typeOf(el) === 'file') send('upload', el, [...(el.files || [])].map(file => file.name).join(', '));
  };
  const onClick = event => {
    if (!event.isTrusted || event.button !== 0 || inOurs(event)) return;
    const target = targetOf(event);
    if (!target) return;
    const el = target.closest(ACTIONABLE) || target, control = el.localName === 'label' ? el.control : el;
    if (control && (fillable(control) || checkable(control) || control.localName === 'select' || control.localName === 'option' || (control.localName === 'input' && typeOf(control) === 'file'))) return;
    flush();
    send('click', el);
  };
  const NAMED_KEYS = { Enter: 1, Escape: 1, Tab: 1 };
  const PAGE_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, Backspace: 1, Delete: 1 };
  const MODIFIERS = { Control: 1, Shift: 1, Alt: 1, Meta: 1, CapsLock: 1, AltGraph: 1 };
  const onKey = event => {
    if (!event.isTrusted || event.isComposing || inOurs(event) || has(MODIFIERS, event.key)) return;
    const el = targetOf(event);
    const typing = el && (fillable(el) || el.localName === 'select');
    if (!(event.ctrlKey || event.metaKey || event.altKey) && !has(NAMED_KEYS, event.key) && (typing || !has(PAGE_KEYS, event.key))) return;
    flush();
    const chord = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Meta' : '', event.shiftKey ? 'Shift' : '', event.key === ' ' ? 'Space' : event.key].filter(Boolean).join('+');
    send('press', el && el !== document.body && el !== document.documentElement ? el : null, chord);
  };
  const share = (value, size) => Math.round(Math.min(1, Math.max(0, value / size)) * 10000) / 10000;
  const sample = () => {
    state.timer = 0; state.last = Date.now();
    const width = innerWidth, height = innerHeight;
    if (!width || !height) return;
    const elements = [];
    for (const el of document.querySelectorAll(LAYOUT)) {
      if (elements.length >= ELEMENTS) break;
      const rect = el.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
      if (right - left < 1 || bottom - top < 1 || el.closest('[aria-hidden="true"]') || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))) continue;
      elements.push({ role: roleOf(el) || (el.localName === 'label' ? 'label' : 'generic'), name: (nameOf(el) || (has(TEXT_TAGS, el.localName) ? textOf(el) : '')).slice(0, 256), selector: (el.id ? '#' + CSS.escape(el.id) : pathOf(el)).slice(0, 1024), box: { x: share(left, width), y: share(top, height), w: share(right - left, width), h: share(bottom - top, height) } });
    }
    const text = JSON.stringify({ viewport: { w: Math.round(width), h: Math.round(height) }, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) }, elements });
    if (text === state.sampled) return;
    state.sampled = text;
    report('layout ' + text);
  };
  const changed = () => { if (!state.timer) state.timer = setTimeout(sample, Math.max(0, state.last + INTERVAL - Date.now())); };
  // Changes inside GitSpace's own hosts, or that only add or remove them, are not the page's.
  const foreign = record => {
    const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (node && node.closest('[data-gitspace-overlay]')) return false;
    return !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(ours));
  };
  const observer = new MutationObserver(records => { if (records.some(foreign)) changed(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const listeners = [['click', onClick], ['input', onInput], ['change', onChange], ['keydown', onKey], ['scroll', changed], ['resize', changed], ['pagehide', flush]];
  for (const [type, listener] of listeners) addEventListener(type, listener, { capture: true, passive: true });
  changed();
  globalThis[key] = {
    get binding() { return state.binding; },
    set binding(value) { state.binding = value; },
    flush() { const el = state.pending; state.pending = null; return el && el.isConnected ? typed(el) : null; },
    dispose() {
      observer.disconnect(); clearTimeout(state.timer);
      for (const [type, listener] of listeners) removeEventListener(type, listener, { capture: true });
      delete globalThis[key];
    },
  };
  return true;
}`;

/** One step as the page reports it, before it is put on the capture's clock. */
const PAGE_STEP_KINDS: Record<string, RuntimeBrowserCaptureStep['kind']> = { click: 'click', fill: 'fill', press: 'press', select: 'select', check: 'check', upload: 'upload' };
/** Request types a step keeps whatever their method: the page's own fetches. Any type but these keeps only its
 * requests that change data; pings and CORS preflights never count. */
const PAGE_FETCHES: Record<string, true> = { XHR: true, Fetch: true, EventSource: true };
const SKIPPED_REQUESTS: Record<string, true> = { Ping: true, Preflight: true, CSPViolationReport: true };
const encoder = new TextEncoder();
const fraction = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

/**
 * A capture's steps and layout on its clock (`atMs` from `startedAt`, as each report arrives): steps kept for
 * `steps.json` (at most `CAPTURE_STEPS_MAX`), layout lines written to `layout` as they come, at most one per
 * `CAPTURE_LAYOUT_INTERVAL_MS` (a sample arriving sooner waits for that time; a later one replaces it). The first step
 * is the page it starts on.
 */
export class CaptureTrackRecorder {
  private readonly steps: RuntimeBrowserCaptureStep[] = [];
  private lines = 0;
  private lastLine = Number.NEGATIVE_INFINITY;
  private waiting: Omit<RuntimeBrowserLayoutSample, 'atMs'> | null = null;
  private finished = false;
  private written: Promise<void> = Promise.resolve();

  constructor(private readonly options: { startedAt: number; url: string; layout(line: Uint8Array): Promise<void> }) { this.navigated(options.url); }

  get stepCount(): number { return this.steps.length; }

  /** A report from the page's recorder (`step {…}` or `layout {…}`); false for anything else. */
  page(payload: string): boolean {
    const space = payload.indexOf(' '), kind = payload.slice(0, space);
    if (space < 0 || (kind !== 'step' && kind !== 'layout')) return false;
    let value: unknown;
    try { value = JSON.parse(payload.slice(space + 1)); } catch { return true; }
    if (kind === 'step') this.pageStep(record(value));
    else this.sample(record(value));
    return true;
  }

  /** The tab's main frame went to `url`; the same address again, with nothing between, is one step. */
  navigated(url: string): void {
    const masked = captureMaskedUrl(url).slice(0, 8192), last = this.steps.at(-1);
    if (last?.kind !== 'goto' || last.url !== masked) this.add({ kind: 'goto', url: masked });
  }

  /** A request the page sent (`Network.requestWillBeSent`): its own fetches, and any other request that changes data. */
  request(params: unknown): void {
    const event = record(params), request = record(event.request), type = text(event.type, 64), method = text(request.method, 16).toUpperCase(), url = text(request.url, 1 << 16);
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (!method || !url || url.startsWith('data:') || SKIPPED_REQUESTS[type] || method === 'OPTIONS' || (!mutating && !PAGE_FETCHES[type])) return;
    this.add({ kind: 'request', url: captureMaskedUrl(url).slice(0, 8192), method, ...(mutating ? { mutating: true } : {}) });
  }

  /** Writes the waiting layout sample and answers `steps.json` and the tracks it makes. */
  async finish(): Promise<{ steps: Uint8Array; tracks: Pick<RuntimeBrowserCaptureTracks, 'steps' | 'layout'> }> {
    this.finished = true;
    if (this.waiting) this.write(this.waiting);
    await this.written;
    return { steps: encoder.encode(JSON.stringify(this.steps)), tracks: { steps: { path: CAPTURE_TRACK_FILES.steps, count: this.steps.length }, ...(this.lines ? { layout: { path: CAPTURE_TRACK_FILES.layout, count: this.lines } } : {}) } };
  }

  private add(step: Omit<RuntimeBrowserCaptureStep, 'atMs'>): void {
    if (this.finished || this.steps.length >= CAPTURE_STEPS_MAX) return;
    this.steps.push({ atMs: Math.max(0, Date.now() - this.options.startedAt), ...step });
  }

  private pageStep(step: Record<string, unknown>): void {
    const kind = typeof step.kind === 'string' && Object.hasOwn(PAGE_STEP_KINDS, step.kind) ? PAGE_STEP_KINDS[step.kind] : undefined;
    if (!kind) return;
    const locator = text(step.locator, 2048), value = typeof step.value === 'string' ? step.value.slice(0, 4096) : undefined;
    this.add({ kind, ...(locator ? { locator } : {}), ...(value !== undefined ? { value } : {}), url: captureMaskedUrl(text(step.url, 1 << 16)).slice(0, 8192) });
  }

  private sample(value: Record<string, unknown>): void {
    if (this.finished) return;
    const viewport = record(value.viewport), scroll = record(value.scroll);
    const elements = (Array.isArray(value.elements) ? value.elements : []).slice(0, CAPTURE_LAYOUT_ELEMENTS).map(item => {
      const element = record(item), box = record(element.box);
      return { role: text(element.role, 64), name: text(element.name, 256), selector: text(element.selector, 1024), box: { x: fraction(box.x), y: fraction(box.y), w: fraction(box.w), h: fraction(box.h) } };
    });
    const dimension = (size: unknown) => typeof size === 'number' && Number.isFinite(size) ? Math.max(1, Math.round(size)) : 1;
    const offset = (position: unknown) => typeof position === 'number' && Number.isFinite(position) ? position : 0;
    const taken = { viewport: { w: dimension(viewport.w), h: dimension(viewport.h) }, scroll: { x: offset(scroll.x), y: offset(scroll.y) }, elements };
    const wait = this.lastLine + CAPTURE_LAYOUT_INTERVAL_MS - Date.now();
    if (wait <= 0 && !this.waiting) { this.write(taken); return; }
    if (!this.waiting) setTimeout(() => { if (this.waiting && !this.finished) this.write(this.waiting); }, Math.max(0, wait));
    this.waiting = taken;
  }

  private write(sample: Omit<RuntimeBrowserLayoutSample, 'atMs'>): void {
    this.waiting = null;
    this.lastLine = Date.now();
    this.lines++;
    const line = encoder.encode(JSON.stringify({ atMs: Math.max(0, this.lastLine - this.options.startedAt), ...sample }) + '\n');
    this.written = this.written.then(() => this.options.layout(line));
  }
}

/** The service worker's view of the tab's main frame navigating (`Page.frameNavigated`) and its requests. */
export function captureTrackEvent(recorder: CaptureTrackRecorder, method: string, params: unknown): void {
  if (method === 'Network.requestWillBeSent') recorder.request(params);
  else if (method === 'Page.frameNavigated') {
    const frame = record(record(params).frame);
    if (frame.parentId === undefined && typeof frame.url === 'string') recorder.navigated(frame.url);
  }
}

/** What the capture bar shows (`browserCaptureBarFunction`'s `show`). */
export type CaptureBarView =
  | { mode: 'capture' | 'comment'; name: string; startedAt: number; steps: number; comments: number; sound: boolean | null; saving: boolean }
  | { mode: 'saved'; name: string; workspace: string; pills: string[]; mention: string; share: string; replay: string; notice: string | null };

/**
 * In the extension's page world (`page.ts`), above the overlay (docs/APERTURE-DESIGN.md §11; the mock's `capture`,
 * `capture-comment` and `saved` modes). `{ show: CaptureBarView | null, binding }` draws or hides it; `{ copy }` puts
 * text on the clipboard (resolves whether it did); `{ remove: true }` takes it away. While capturing: a red dot, the
 * name with ✎ (click to rename: Enter keeps it, Escape does not), the time, steps and comments; Comment (or C outside
 * a field), the sound toggle for video, and Done; the REC badge in the corner. In comment mode: the comment tool's
 * line with Back to doing (Esc is the comment tool's own) and Done. Saved: the card with the tracks, the mention, Copy
 * mention, Share, Replay steps, Open in GitSpace and ✕. Its buttons call the function `binding` names with `captureComment`,
 * `captureBack`, `captureSound`, `captureDone`, `captureName "<name>"`, `captureMention`, `captureShare`,
 * `captureReplay`, `captureOpen` and `captureClose`. Styled inline in a closed shadow root, nothing focusable but the
 * name being renamed.
 */
export const browserCaptureBarFunction = `function(command) {
  const key = '__gitspaceCaptureBar';
  if (command.remove) { if (globalThis[key]) globalThis[key].dispose(); return true; }
  if (typeof command.copy === 'string') {
    const text = command.copy;
    const fallback = () => { let done = false; const listener = event => { event.clipboardData.setData('text/plain', text); event.preventDefault(); done = true; }; document.addEventListener('copy', listener, true); try { document.execCommand('copy'); } catch {} document.removeEventListener('copy', listener, true); return done; };
    return navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, fallback) : fallback();
  }
  let bar = globalThis[key];
  if (!bar && !command.show) return false;
  if (!bar) {
    const RED = '#dc2626', PURPLE = '#a142f4';
    const font = 'font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:0;-webkit-font-smoothing:antialiased;';
    const svgns = 'http://www.w3.org/2000/svg';
    const make = (tag, css, parent) => { const el = document.createElement(tag); el.style.cssText = css; parent.appendChild(el); return el; };
    const icon = (parent, size, d) => { const el = document.createElementNS(svgns, 'svg'); el.setAttribute('width', size); el.setAttribute('height', size); el.setAttribute('viewBox', '0 0 24 24'); el.style.cssText = 'display:block;flex:none'; const path = document.createElementNS(svgns, 'path'); for (const [name, value] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(name, value); el.appendChild(path); parent.appendChild(el); return el; };
    const pulse = el => el.animate([{ opacity: 1 }, { opacity: .5 }, { opacity: 1 }], { duration: 2000, easing: 'cubic-bezier(.4,0,.6,1)', iterations: Infinity });
    const host = document.createElement('div');
    host.setAttribute('data-gitspace-overlay', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483647;contain:layout style';
    (globalThis.__gitspaceHosts ??= new WeakSet()).add(host);
    const root = host.attachShadow({ mode: 'closed' });
    const state = { binding: command.binding, view: null, clock: 0, renaming: false };
    const press = text => { const call = globalThis[state.binding]; if (typeof call === 'function') call(text); return typeof call === 'function'; };
    const swallow = el => { for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) el.addEventListener(type, event => { event.stopPropagation(); if (type !== 'click' && !state.renaming) event.preventDefault(); }); };
    const button = (parent, label, dark, onClick) => {
      const el = make('button', 'all:unset;' + font + 'flex:none;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;' + (dark ? 'background:#171717;color:#fff;border:1px solid #171717' : 'background:#fff;color:#262626;border:1px solid #d4d4d4'), parent);
      el.type = 'button'; el.tabIndex = -1;
      if (label) el.append(label);
      if (!dark) { el.addEventListener('pointerenter', () => { el.style.background = '#fafafa'; }); el.addEventListener('pointerleave', () => { el.style.background = '#fff'; }); }
      el.addEventListener('click', onClick);
      return el;
    };
    const elapsed = startedAt => { const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
    // The name and its ✎: a click on ✎ makes the name editable; Enter or leaving it renames, Escape puts it back.
    const nameField = parent => {
      const name = make('span', 'outline:none;border-radius:4px', parent);
      const pencil = make('span', 'font-weight:400;color:#a3a3a3;cursor:pointer;margin-left:4px', parent);
      pencil.textContent = '✎';
      const finish = keep => {
        if (!state.renaming) return;
        state.renaming = false; name.contentEditable = 'false'; name.style.boxShadow = 'none';
        const next = name.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200);
        if (keep && next && next !== state.view.name) { state.view.name = next; press('captureName ' + JSON.stringify(next)); }
        name.textContent = state.view.name;
      };
      pencil.addEventListener('click', () => {
        if (state.renaming) return;
        state.renaming = true; name.contentEditable = 'plaintext-only'; name.style.boxShadow = '0 0 0 2px #1a73e855'; name.focus();
        const range = document.createRange(); range.selectNodeContents(name); const selection = root.getSelection ? root.getSelection() : getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      name.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finish(true); } if (event.key === 'Escape') { event.preventDefault(); finish(false); } });
      name.addEventListener('blur', () => finish(true));
      return name;
    };
    // The REC badge, top left.
    const badge = make('div', font + 'position:fixed;left:12px;top:12px;display:none;align-items:center;gap:6px;padding:4px 10px;border-radius:9999px;background:rgba(0,0,0,.75);color:#fff;font-size:11px;line-height:16px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap', root);
    pulse(make('span', 'flex:none;width:8px;height:8px;border-radius:50%;background:' + RED, badge));
    const badgeText = make('span', '', badge);
    // The capturing bar, bottom centre.
    const strip = make('div', font + 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;align-items:center;gap:10px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 12px;border-radius:16px;border:1px solid #e5e5e5;background:#fff;color:#262626;font-size:13px;line-height:20px;pointer-events:auto;user-select:none;white-space:nowrap', root);
    swallow(strip);
    pulse(make('span', 'flex:none;width:12px;height:12px;border-radius:50%;background:' + RED, strip));
    const words = make('div', 'min-width:0;overflow:hidden', strip);
    const title = make('div', 'font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis', words);
    const lead = make('span', '', title);
    const name = nameField(title);
    const tail = make('span', '', title);
    const line = make('div', 'font-size:12px;line-height:16px;color:#737373;overflow:hidden;text-overflow:ellipsis', words);
    make('span', 'flex:none;width:1px;height:24px;background:#e5e5e5', strip);
    const comment = button(strip, '', false, () => press('captureComment'));
    icon(comment, '14', 'M12 13.5v-6m-3 3h6M7 18v2.335c0 .533 0 .8.11.937a.5.5 0 0 0 .39.188c.176 0 .384-.167.8-.5l2.385-1.908c.487-.39.731-.585 1.002-.724.241-.122.497-.212.762-.267.299-.061.61-.061 1.235-.061H16.2c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 15.72 21 14.88 21 13.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 5.28 3 6.12 3 7.8V14c0 .93 0 1.395.102 1.777a3 3 0 0 0 2.122 2.12C5.605 18 6.07 18 7 18Z');
    comment.append('Comment');
    const sound = button(strip, '', false, () => press('captureSound'));
    sound.style.padding = '6px 8px'; sound.style.fontWeight = '400';
    const back = button(strip, 'Back to doing (Esc)', false, () => press('captureBack'));
    const done = button(strip, 'Done', true, () => { if (press('captureDone')) done.textContent = 'Saving…'; });
    // The saved card.
    const card = make('div', font + 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;flex-direction:column;gap:12px;width:560px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:16px;border-radius:16px;border:1px solid #e5e5e5;background:#fff;color:#262626;font-size:13px;line-height:20px;box-shadow:0 25px 50px -12px rgba(0,0,0,.25);pointer-events:auto;user-select:none', root);
    swallow(card);
    const head = make('div', 'display:flex;align-items:center;gap:10px', card);
    const mark = document.createElementNS(svgns, 'svg'); mark.setAttribute('width', '22'); mark.setAttribute('height', '22'); mark.setAttribute('viewBox', '0 0 512 512'); mark.style.cssText = 'display:block;flex:none;border-radius:6px'; head.appendChild(mark);
    for (const [d, color] of [['M85 106 213 233 85 360', '#05a84c'], ['M256 405H426', '#06c958']]) { const path = document.createElementNS(svgns, 'path'); path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '42'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); mark.appendChild(path); }
    const heading = make('div', 'min-width:0;flex:1', head);
    const savedTitle = make('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', heading);
    savedTitle.append('Capture saved: ');
    const savedName = nameField(savedTitle);
    const where = make('div', 'font-size:12px;line-height:16px;color:#737373', heading);
    const close = make('button', 'all:unset;flex:none;align-self:flex-start;cursor:pointer;color:#a3a3a3;font-size:14px;line-height:16px;padding:2px 4px', head);
    close.type = 'button'; close.tabIndex = -1; close.textContent = '✕'; close.addEventListener('click', () => press('captureClose'));
    const pills = make('div', 'display:flex;flex-wrap:wrap;gap:6px', card);
    const advice = make('p', 'margin:0;font-size:12px;line-height:16px;color:#525252;white-space:normal', card);
    advice.append('Mention ');
    const chip = make('span', 'border-radius:4px;background:#f5f5f5;padding:0 4px;font-weight:500', advice);
    advice.append(' in the chat: the agent can turn it into a skill, follow up on your comment, or watch the moment you mean. Sharing sends the whole recording.');
    const actions = make('div', 'display:flex;align-items:center;gap:8px', card);
    const mention = button(actions, 'Copy mention', false, () => press('captureMention'));
    const shareButton = button(actions, 'Share', false, () => press('captureShare'));
    const replay = button(actions, 'Replay steps', false, () => press('captureReplay'));
    make('span', 'flex:1', actions);
    button(actions, 'Open in GitSpace', true, () => press('captureOpen'));
    const notice = make('div', 'display:none;font-size:12px;line-height:16px;color:#b91c1c;white-space:normal', card);
    // C comments while capturing, outside a field and GitSpace's own hosts (in comment mode, Esc is the comment tool's).
    const keys = event => {
      if (!event.isTrusted || state.view?.mode !== 'capture' || (event.key !== 'c' && event.key !== 'C') || event.ctrlKey || event.metaKey || event.altKey || event.composedPath().some(node => node instanceof Element && node.hasAttribute('data-gitspace-overlay'))) return;
      const target = event.composedPath()[0];
      if (target instanceof Element && (target.isContentEditable || target.closest('input,textarea,select'))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      press('captureComment');
    };
    addEventListener('keydown', keys, true);
    const show = view => {
      state.view = view;
      clearInterval(state.clock);
      const capturing = view.mode === 'capture' || view.mode === 'comment';
      strip.style.display = capturing ? 'flex' : 'none';
      badge.style.display = capturing ? 'flex' : 'none';
      card.style.display = capturing ? 'none' : 'flex';
      if (!state.renaming) { name.textContent = view.name; savedName.textContent = view.name; }
      if (capturing) {
        const tone = view.mode === 'comment' ? PURPLE : RED;
        strip.style.boxShadow = '0 10px 30px rgba(0,0,0,.18), 0 0 0 1px ' + tone + '55';
        const tick = () => {
          const time = elapsed(view.startedAt);
          badgeText.textContent = 'REC ' + time + ' · ' + (view.sound === null ? 'frames · no sound' : view.sound ? 'tabCapture · with sound' : 'tabCapture · no sound');
          if (view.mode === 'capture') { lead.textContent = 'Capturing · '; tail.textContent = ' · ' + time + ' · ' + plural(view.steps, 'step') + ' · ' + plural(view.comments, 'comment'); tail.style.cssText = ''; }
          else { lead.textContent = ''; tail.textContent = ' · ' + time; tail.style.cssText = 'font-weight:400;color:#737373'; }
        };
        tick(); state.clock = setInterval(tick, 1000);
        line.textContent = view.mode === 'capture' ? 'Do it as you normally would; press C to point something out. Secrets are masked.' : 'Comment tool · click an element or drag an area · ' + plural(view.comments, 'comment');
        comment.style.display = view.mode === 'capture' ? 'inline-flex' : 'none';
        sound.style.display = view.mode === 'capture' && view.sound !== null ? 'inline-flex' : 'none';
        sound.textContent = view.sound ? '🔊 Sound' : '🔇 No sound';
        back.style.display = view.mode === 'comment' ? 'inline-flex' : 'none';
        done.textContent = view.saving ? 'Saving…' : 'Done';
        done.style.opacity = view.saving ? '.6' : '1';
      } else {
        where.textContent = 'In the Browser tab of ' + view.workspace + ' · not in the repository';
        pills.replaceChildren(...view.pills.map(text => { const pill = document.createElement('span'); pill.style.cssText = 'border-radius:9999px;background:#f5f5f5;padding:2px 8px;font-size:11px;line-height:16px;color:#404040'; pill.textContent = text; return pill; }));
        chip.textContent = '@' + view.name;
        mention.textContent = view.mention; shareButton.textContent = view.share; replay.textContent = view.replay;
        notice.style.display = view.notice ? 'block' : 'none'; notice.textContent = view.notice || '';
      }
    };
    bar = {
      apply(next) {
        if (next.binding) state.binding = next.binding;
        if (next.show) { if (!host.isConnected) document.documentElement.appendChild(host); show(next.show); }
        else if (next.show === null) { state.view = null; clearInterval(state.clock); host.remove(); }
      },
      dispose() { clearInterval(state.clock); removeEventListener('keydown', keys, true); host.remove(); delete globalThis[key]; },
    };
    globalThis[key] = bar;
  }
  bar.apply(command);
  return true;
}`;

/** Where this Chrome's signed capture share requests go (label `share`, as share requests). */
const CAPTURE_SHARES_PATH = '/api/browser-relay/capture-shares';
/** A capture's share link made from the saved card lasts a week and takes comments. */
const CAPTURE_SHARE_MINUTES = 10_080;

/** A capture recording on this Chrome as the service worker keeps it (`background.js` `captures`). */
export type ChromeCapture = { captureId: string; track: 'video' | 'frames'; groupId: string; tabId: number; targetId: string; url: string; title: string; startedAt: number; ending: Promise<unknown> | null };
/** One file of a capture uploaded as it is recorded (`upload.ts` `Upload`). */
type TrackUpload = { write(bytes: Uint8Array): Promise<void>; complete(): Promise<unknown>; abort(): Promise<void> };
/** Comment mode of the in-page comment tool (`comments.ts`) for a capture: comments made in it are the capture's;
 * `saved` follows each one stored, `ended` the tool turning off from the page. */
export type CaptureCommentMode = { captureId: string; startedAt: number; saved(): void; ended(): void };
/** What the tracks need from the service worker. */
export type CaptureTracksHost = {
  account: string;
  upload(capture: ChromeCapture, file: typeof CAPTURE_TRACK_FILES[keyof typeof CAPTURE_TRACK_FILES], mediaType: string): TrackUpload;
  /** Draws the tab's in-page overlay again (which draws the bar, `draw`). */
  redraw(targetId: string): void;
  /** Runs the recorder (`browserCaptureRecorderFunction`) or the bar (`browserCaptureBarFunction`) in the tab's page
   * world (`page.ts`) and answers its value. */
  call(targetId: string, name: 'recorder' | 'bar', argument: unknown): Promise<unknown>;
  send(message: object): void;
  identity(): Promise<SigningIdentity | undefined>;
  commentMode(targetId: string, mode: CaptureCommentMode | null): Promise<void>;
  /** The workspace group's name and its project and workspace, if this Chrome has it. */
  group(groupId: string): Promise<{ name: string; projectId: string; workspaceId: string } | null>;
  open(url: string): Promise<void>;
  /** Done: the capture ends as Stop capture ends it (`endCapture`). */
  stop(capture: ChromeCapture): Promise<unknown>;
  /** The sound of a video capture's recording, on or off. */
  sound(capture: ChromeCapture, on: boolean): Promise<void>;
  /** Nothing of the tracks shows on the tab any more: the debugger leaves it unless something else uses it. */
  release(targetId: string): Promise<void>;
};
type Live = { capture: ChromeCapture; recorder: CaptureTrackRecorder; layout: TrackUpload; name: string; comments: number; commenting: boolean; sound: boolean | null };
type Card = { captureId: string; groupId: string; name: string; workspace: string; ids: { projectId: string; workspaceId: string } | null; pills: string[]; mention: string; share: string; replay: string; notice: string | null };

const clock = (ms: number) => { const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** What the recorder and the bar report through in the extension's page world (`page.ts`). */
const PAGE_SEND = '__gitspaceSend';
/** The commands of the capturing bar and the saved card (`browserCaptureBarFunction`). */
const BAR_COMMANDS: Record<string, true> = { captureComment: true, captureBack: true, captureSound: true, captureDone: true, captureName: true, captureMention: true, captureShare: true, captureReplay: true, captureOpen: true, captureClose: true };

/**
 * Steps and layout tracks of the captures recording on your Chrome, their capturing bar and, once one is saved, its
 * card on the tab. A tab keeps its overlay while either shows (`shows`).
 */
export class CaptureTracksInChrome {
  private readonly live = new Map<string, Live>();
  private readonly cards = new Map<string, Card>();
  private readonly drawn = new Set<string>();

  constructor(private readonly host: CaptureTracksHost) {}

  /** A capture began: its tracks record from now; `sound` is null for frames (no sound to record). */
  start(capture: ChromeCapture, sound: boolean | null): void {
    const layout = this.host.upload(capture, CAPTURE_TRACK_FILES.layout, 'application/x-ndjson');
    const recorder = new CaptureTrackRecorder({ startedAt: capture.startedAt, url: capture.url, layout: line => layout.write(line) });
    this.live.set(capture.captureId, { capture, recorder, layout, name: capture.title.replace(/\s+/gu, ' ').trim().slice(0, 200) || 'Capture', comments: 0, commenting: false, sound });
    this.cards.delete(capture.targetId);
  }

  /** Whether the tab shows a capturing bar or a saved card. */
  shows(targetId: string): boolean { return this.cards.has(targetId) || this.recordingOn(targetId) !== undefined; }

  /** A debugger event of the tab: a navigation or a request of a capture recording it. Another document takes a saved
   * card away, and a recording's bar and recorder are drawn in it at once. */
  event(targetId: string, method: string, params: unknown): void {
    const live = this.recordingOn(targetId);
    if (live) captureTrackEvent(live.recorder, method, params);
    if (method !== 'Page.frameNavigated' || record(record(params).frame).parentId !== undefined) return;
    if (live) this.host.redraw(targetId);
    else if (this.cards.delete(targetId)) void this.host.release(targetId);
  }

  /** A message from the tab's page world (`page.ts`); false when it is not the tracks'. */
  message(targetId: string, payload: string): boolean {
    const live = this.recordingOn(targetId);
    if (payload.startsWith('step ') || payload.startsWith('layout ')) {
      if (live?.recorder.page(payload) && payload.startsWith('step ')) this.host.redraw(targetId);
      return true;
    }
    const space = payload.indexOf(' '), command = space < 0 ? payload : payload.slice(0, space);
    if (!BAR_COMMANDS[command]) return false;
    const card = this.cards.get(targetId);
    if (command === 'captureName') {
      let name: unknown;
      try { name = JSON.parse(payload.slice(space + 1)); } catch { return true; }
      if (typeof name !== 'string' || !name.trim()) return true;
      const named = name.replace(/\s+/gu, ' ').trim().slice(0, 200);
      if (live) live.name = named;
      else if (card) { card.name = named; this.host.send({ captureName: { captureId: card.captureId, groupId: card.groupId, name: named } }); }
      this.host.redraw(targetId);
      return true;
    }
    if (live) void this.recordingButton(targetId, live, command);
    else if (card) void this.cardButton(targetId, card, command);
    return true;
  }

  /** Draws the tab's recorder, bar or card in the page world (after the overlay itself), or takes them away. */
  async draw(targetId: string): Promise<void> {
    const live = this.recordingOn(targetId), card = this.cards.get(targetId);
    if (!live && !card) {
      if (!this.drawn.delete(targetId)) return;
      await this.host.call(targetId, 'recorder', { remove: true });
      await this.host.call(targetId, 'bar', { remove: true });
      return;
    }
    this.drawn.add(targetId);
    await this.host.call(targetId, 'recorder', live ? { binding: PAGE_SEND } : { remove: true });
    await this.host.call(targetId, 'bar', { binding: PAGE_SEND, show: live ? this.recordingView(live) : card ? this.cardView(card) : null });
  }

  /** A capture ends: the field being typed in becomes its last step, comment mode ends, `steps.json` uploads and
   * `layout.jsonl` completes. Answers its tracks and name; null for a capture without tracks. */
  async finish(capture: ChromeCapture): Promise<{ tracks: Pick<RuntimeBrowserCaptureTracks, 'steps' | 'layout' | 'comments'>; name: string } | null> {
    const live = this.live.get(capture.captureId);
    if (!live) return null;
    this.host.redraw(capture.targetId);
    const typing = await this.host.call(capture.targetId, 'recorder', { flush: true }).catch(() => null);
    if (typing) live.recorder.page(`step ${JSON.stringify(typing)}`);
    if (live.commenting) await this.host.commentMode(capture.targetId, null).catch(() => {});
    const finished = await live.recorder.finish();
    const steps = this.host.upload(capture, CAPTURE_TRACK_FILES.steps, 'application/json');
    let tracks: Pick<RuntimeBrowserCaptureTracks, 'steps' | 'layout' | 'comments'> = { comments: { count: live.comments } };
    try { await steps.write(finished.steps); await steps.complete(); tracks = { ...tracks, steps: finished.tracks.steps }; } catch { await steps.abort().catch(() => {}); }
    if (finished.tracks.layout) { try { await live.layout.complete(); tracks = { ...tracks, layout: finished.tracks.layout }; } catch { await live.layout.abort().catch(() => {}); } }
    else await live.layout.abort().catch(() => {});
    return { tracks, name: live.name };
  }

  /** A capture ended: one saved shows its card on the tab; either way its bar goes, and with no card the debugger may
   * leave the tab. */
  async ended(capture: ChromeCapture, outcome: { saved: boolean; tracks: RuntimeBrowserCaptureTracks }): Promise<void> {
    const live = this.live.get(capture.captureId);
    this.live.delete(capture.captureId);
    if (!live || !outcome.saved) { await this.host.release(capture.targetId); return; }
    const group = await this.host.group(capture.groupId).catch(() => null), { steps, comments, video, frames, layout, image } = outcome.tracks;
    const pills = [
      ...(steps ? [plural(steps.count, 'step')] : []), ...(comments?.count ? [plural(comments.count, 'comment')] : []),
      ...(video ? [`video ${clock(video.durationMs)}${video.sound ? ' · sound' : ''}`] : []), ...(frames ? [plural(frames.count, 'frame')] : []), ...(image ? ['screenshot'] : []), ...(layout ? ['page layout'] : []),
    ];
    this.cards.set(capture.targetId, { captureId: capture.captureId, groupId: capture.groupId, name: live.name, workspace: group?.name ?? 'your workspace', ids: group ? { projectId: group.projectId, workspaceId: group.workspaceId } : null, pills, mention: 'Copy mention', share: 'Share', replay: 'Replay steps', notice: null });
    this.host.redraw(capture.targetId);
  }

  /** The tab's debugger session ended (the tab closed, or you cancelled debugging): its card goes. */
  forget(targetId: string): void { this.cards.delete(targetId); this.drawn.delete(targetId); }

  private recordingOn(targetId: string): Live | undefined { for (const live of this.live.values()) if (live.capture.targetId === targetId) return live; return undefined; }

  private recordingView(live: Live): CaptureBarView {
    return { mode: live.commenting ? 'comment' : 'capture', name: live.name, startedAt: live.capture.startedAt, steps: live.recorder.stepCount, comments: live.comments, sound: live.sound, saving: live.capture.ending !== null };
  }

  private cardView(card: Card): CaptureBarView {
    return { mode: 'saved', name: card.name, workspace: card.workspace, pills: card.pills, mention: card.mention, share: card.share, replay: card.replay, notice: card.notice };
  }

  private async recordingButton(targetId: string, live: Live, command: string): Promise<void> {
    const { capture } = live;
    if (command === 'captureDone') { await this.host.stop(capture); return; }
    if (command === 'captureSound' && live.sound !== null) {
      const on = !live.sound;
      await this.host.sound(capture, on);
      live.sound = on;
    } else if (command === 'captureComment' && !live.commenting) {
      live.commenting = true;
      this.host.redraw(targetId);
      try {
        await this.host.commentMode(targetId, {
          captureId: capture.captureId, startedAt: capture.startedAt,
          saved: () => { live.comments++; this.host.redraw(targetId); },
          ended: () => { live.commenting = false; this.host.redraw(targetId); },
        });
      } catch { live.commenting = false; }
    } else if (command === 'captureBack' && live.commenting) {
      live.commenting = false;
      await this.host.commentMode(targetId, null);
    }
    this.host.redraw(targetId);
  }

  private async cardButton(targetId: string, card: Card, command: string): Promise<void> {
    card.notice = null;
    try {
      if (command === 'captureClose') { this.cards.delete(targetId); await this.host.release(targetId); return; }
      else if (command === 'captureMention') {
        // The mention the chat reads (`captureMention` in protocol-runtime).
        card.mention = await this.host.call(targetId, 'bar', { copy: `capture://${card.captureId}` }) === true ? 'Copied' : 'Copy mention';
        if (card.mention !== 'Copied') card.notice = 'Chrome did not let GitSpace copy here';
      } else if (command === 'captureShare') {
        card.share = 'Sharing…';
        this.host.redraw(targetId);
        const identity = await this.host.identity();
        if (!identity) throw new Error('This Chrome is not paired');
        const link = shareLink(await captureShareRequest(this.host.account, identity, { op: 'create', captureId: card.captureId, groupId: card.groupId, comment: true, expiresInMinutes: CAPTURE_SHARE_MINUTES }));
        const copied = await this.host.call(targetId, 'bar', { copy: link }) === true;
        card.share = copied ? 'Link copied' : 'Share';
        if (!copied) card.notice = `Share link: ${link}`;
      } else if (command === 'captureReplay') {
        this.host.send({ captureReplay: { captureId: card.captureId, groupId: card.groupId } });
        card.replay = 'Asked the agent';
      } else if (command === 'captureOpen') {
        const url = new URL('/', this.host.account);
        if (card.ids) { url.searchParams.set('project', card.ids.projectId); url.searchParams.set('workspace', card.ids.workspaceId); url.searchParams.set('capture', card.captureId); }
        await this.host.open(url.href);
      }
    } catch (error) {
      if (command === 'captureShare') card.share = 'Share';
      card.notice = error instanceof Error ? error.message : String(error);
    }
    this.host.redraw(targetId);
  }
}

/** The link of the share a capture share request answered. */
function shareLink(value: unknown): string {
  const share = record(record(value).captureShare);
  if (typeof share.link !== 'string') throw new Error('GitSpace answered no share link');
  return share.link;
}

/** One signed capture share request (`POST /api/browser-relay/capture-shares`, label `share`); resolves with the value
 * of the account's `ok` reply, or fails with its message. */
export async function captureShareRequest(account: string, identity: SigningIdentity, request: { op: 'create'; captureId: string; groupId: string; comment: boolean; expiresInMinutes: number }): Promise<unknown> {
  const body = new TextEncoder().encode(JSON.stringify(request));
  const header = await relaySignature(identity, 'share', 'POST', CAPTURE_SHARES_PATH, await sha256Hex(body));
  return accountValue(await fetch(new URL(CAPTURE_SHARES_PATH, account).href, { method: 'POST', body, headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store' }), '');
}
