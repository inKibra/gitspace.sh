/**
 * The in-page overlay on a tab of your Chrome while an agent uses it, you hold it, a capture records it, people watch
 * its share or it is in a workspace group (docs/APERTURE-DESIGN.md §6.4, §7.2, §8, §9, §11; the agreed look is
 * account-web's BrowsersMockExtension `Bar`, `Pointer` and `CommentLayer`): a white toolbar at the bottom of the tab
 * (the GitSpace mark, who acts and on which workspace, what it is doing, Comment, Capture, Take over and Stop for the
 * agent; while you hold the tab, "You're in control", the paused agent and Resume agent; while a capture records, REC
 * with its time and Stop capture; on a tab of a workspace group nothing uses, "GitSpace · <workspace> · idle" with
 * Comment and Capture), a frame round the tab (blue while the agent acts, grey while you hold it, red while a capture
 * records), the agent's cursor at each point it clicks or moves to, the named pointers of the people watching the
 * tab's shares, and the comment tool (`comments.ts`). It draws nothing for your own pointer: while a share shows it to
 * its viewers, it says where it is instead (`report`), and each viewer draws it.
 *
 * A fixed function the extension runs in its own isolated world, the content-script world of `page.js` (`page.ts`;
 * `chrome.scripting.executeScript`), never in the page's. The overlay leaves the page and what the agent reads alone:
 * a closed shadow root under an `aria-hidden` host marked `data-gitspace-overlay` (which the screenshot mask hides),
 * styled inline only (no stylesheet a page's CSP could refuse), nothing in the tab order, and pointer-transparent
 * except the toolbar while your own pointer is over it and the comment tool while it is on, so an agent's clicks and
 * hit tests reach the page. It tells the extension through `__gitspaceSend` (`page.ts`, a runtime message from this
 * world, which no page script reaches; it answers a promise of the extension's reply): its buttons send `stop`,
 * `capture`, `captureStop`, `takeover`, `resume` or `everythingEnd`, and the comment tool `comment <what> <json>`; while
 * the agent acts (`run`, `step`), each trusted pointer or key press on the page (not on the toolbar, and not while you
 * comment) sends `take`: the agent's own input is trusted too, which the extension tells apart. With `report`, your
 * pointer sends `pointer {"x":…,"y":…}` (fractions of the viewport) at most ten times a second, and `pointer null` once
 * it leaves the tab. Mouse events at the agent's cursor are the agent's, and are not reported.
 *
 * One argument: `{ show?: { mode: 'run' | 'step' | 'capture' | 'you' | 'idle', workspace, agent, doing,
 * capture: 'none' | 'ready' | 'recording', recording: { startedAt, sound, tracks } | null, comments, everything } | null, comment?:
 * CommentView | null, cursor?: { x, y, type }, pointers?: [{ id, name, color, x, y }], report?: boolean, conceal?:
 * boolean, remove?: true }`. `agent` and `doing` (what it is doing) may be null; in `you`, `agent` is the paused agent;
 * `comments` says the account takes comments (Comment shows); `everything` is when Everything ends (an ISO time) while the
 * workspace's agent has it, else null (End now shows beside its time left). `show` installs the overlay where the document lacks it
 * (after a navigation) and refreshes it; `show: null` hides the toolbar, frame and cursor, leaving the pointers.
 * `comment` is the comment tool (`CommentView`, `comments.ts`): a view turns it on or redraws it, null takes it away; a
 * command without `comment` leaves it as it is. `pointers` (x and y are fractions of the viewport) is everyone pointing
 * now: each glides to its new place, eased, and one left out leaves; they install the overlay too, as `report` and
 * `comment` do. An overlay not refreshed for 75 s asks the extension (`refresh`), which draws it again or removes it;
 * one whose extension is gone (updated or turned off) removes itself. The cursor travels to each point along a curved
 * path, eased, overshooting slightly and settling, in the time Fitts's law gives a hand (260 + 170·log2(1 + d/22) ms);
 * it presses on `mousePressed` (with a ripple) and fades after 5 s idle.
 *
 * One overlay per document: its host is the only `data-gitspace-overlay` element on the page besides the capture
 * bar's (`capture-tracks.ts`; both register in this world's `__gitspaceHosts`). It removes any other, such as a toolbar
 * an earlier version of the extension drew in a world of its own, when it installs and whenever one appears, and puts
 * its own host back should anything else take it away.
 */
export const browserOverlayFunction = `function(command) {
  const key = '__gitspaceOverlay';
  // Removing also clears a toolbar another world left on the page (an earlier version's, from a world of its own): the
  // page keeps it after that world's extension is gone.
  if (command.remove) { if (globalThis[key]) globalThis[key].dispose(); for (const stale of document.querySelectorAll('[data-gitspace-overlay]')) stale.remove(); return true; }
  let overlay = globalThis[key];
  if (!overlay && !command.show && !command.pointers?.length && !command.report && !command.comment) return false;
  if (!overlay) {
    const ours = globalThis.__gitspaceHosts ??= new WeakSet();
    const foreign = node => node instanceof Element && node.hasAttribute('data-gitspace-overlay') && !ours.has(node);
    for (const stale of document.querySelectorAll('[data-gitspace-overlay]')) if (foreign(stale)) stale.remove();
    const BLUE = '#1a73e8', RED = '#dc2626';
    const svgns = 'http://www.w3.org/2000/svg';
    const make = (tag, css, parent) => { const el = document.createElement(tag); el.style.cssText = css; parent.appendChild(el); return el; };
    const svg = (parent, width, height, viewBox, css) => { const el = document.createElementNS(svgns, 'svg'); el.setAttribute('width', width); el.setAttribute('height', height); el.setAttribute('viewBox', viewBox); el.style.cssText = css; parent.appendChild(el); return el; };
    const path = (parent, attributes) => { const el = document.createElementNS(svgns, 'path'); for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value); parent.appendChild(el); return el; };
    const pulse = el => el.animate([{ opacity: 1 }, { opacity: .5 }, { opacity: 1 }], { duration: 2000, easing: 'cubic-bezier(.4,0,.6,1)', iterations: Infinity });
    const host = document.createElement('div');
    host.setAttribute('data-gitspace-overlay', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483646;contain:layout style';
    ours.add(host);
    const root = host.attachShadow({ mode: 'closed' });
    // An overlay whose host left the page, or whose extension is gone (updated or turned off: this world's
    // \`chrome.runtime.id\` is no more), lets go of the page at its next event, so its listeners never take your keys
    // and clicks.
    const gone = () => { if (host.isConnected && globalThis.chrome?.runtime?.id) return false; overlay?.dispose(); return true; };
    // What the overlay tells the extension (\`__gitspaceSend\`, \`page.ts\`): a promise of its reply, rejected when it
    // cannot be told.
    const send = text => { try { return Promise.resolve(globalThis.__gitspaceSend(text)); } catch (error) { return Promise.reject(error); } };
    // Another toolbar appearing goes at once; this one's host comes back should anything else take it away.
    const guard = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (foreign(node)) node.remove();
        for (const node of record.removedNodes) if (node === host && globalThis[key] === overlay) document.documentElement.appendChild(host);
      }
    });
    guard.observe(document.documentElement, { childList: true });
    const font = 'font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:0;-webkit-font-smoothing:antialiased;';
    const frame = make('div', 'position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .4s ease', root);
    // The toolbar: mark or REC, who and what, then its buttons.
    const bar = make('div', font + 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;align-items:center;gap:10px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 12px;border-radius:16px;border:1px solid #e5e5e5;background:#fff;color:#262626;font-size:13px;line-height:20px;pointer-events:none;user-select:none;white-space:nowrap', root);
    const logo = make('span', 'position:relative;flex:none;width:22px;height:22px', bar);
    const mark = svg(logo, '22', '22', '0 0 512 512', 'display:block;border-radius:6px');
    const gradient = (id, y1, y2, to) => { const g = document.createElementNS(svgns, 'linearGradient'); g.setAttribute('id', id); g.setAttribute('x1', '0'); g.setAttribute('x2', '0'); g.setAttribute('y1', y1); g.setAttribute('y2', y2); g.setAttribute('gradientUnits', 'userSpaceOnUse'); for (const [offset, color] of [['0', '#037935'], ['1', to]]) { const stop = document.createElementNS(svgns, 'stop'); stop.setAttribute('offset', offset); stop.setAttribute('stop-color', color); g.appendChild(stop); } return g; };
    const defs = document.createElementNS(svgns, 'defs'); defs.append(gradient('gs-chevron', '85', '381', '#05e063'), gradient('gs-line', '398', '426', '#06c958')); mark.appendChild(defs);
    path(mark, { d: 'M85 106 213 233 85 360', fill: 'none', stroke: 'url(#gs-chevron)', 'stroke-width': '42', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    path(mark, { d: 'M256 405H426', stroke: 'url(#gs-line)', 'stroke-width': '42', 'stroke-linecap': 'round' });
    const logoDot = make('span', 'position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;box-sizing:border-box;border-radius:50%;border:2px solid #fff;background:' + BLUE, logo);
    pulse(logoDot);
    const recDot = make('span', 'flex:none;width:12px;height:12px;border-radius:50%;display:none;background:' + RED, bar);
    pulse(recDot);
    const text = make('div', 'min-width:0;overflow:hidden', bar);
    const title = make('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis', text);
    const who = make('span', '', title);
    const where = make('span', 'font-weight:400;color:#737373', title);
    const what = make('div', 'font-size:12px;line-height:16px;color:#525252;overflow:hidden;text-overflow:ellipsis', text);
    const divider = () => make('span', 'flex:none;width:1px;height:24px;background:#e5e5e5', bar);
    const firstDivider = divider();
    const button = () => {
      const el = make('button', 'all:unset;' + font + 'flex:none;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;font-weight:500;cursor:pointer', bar);
      el.type = 'button'; el.tabIndex = -1;
      el.addEventListener('pointerenter', () => { if (!el.dataset.dark) el.style.background = '#fafafa'; });
      el.addEventListener('pointerleave', () => { if (!el.dataset.dark) el.style.background = '#fff'; });
      return el;
    };
    const paint = (el, dark) => { if (dark) el.dataset.dark = '1'; else delete el.dataset.dark; el.style.background = dark ? '#171717' : '#fff'; el.style.color = dark ? '#fff' : '#262626'; el.style.border = '1px solid ' + (dark ? '#171717' : '#d4d4d4'); };
    const capture = button();
    // Untitled UI's Recording01, as the mock's Capture shows it; a red dot while recording.
    const captureIcon = svg(capture, '14', '14', '0 0 24 24', 'display:block;flex:none');
    path(captureIcon, { d: 'M3 10v4m4.5-8v12M12 3v18m4.5-15v12m4.5-8v4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const captureDot = make('span', 'flex:none;width:8px;height:8px;border-radius:50%;display:none;background:' + RED, capture);
    const captureLabel = capture.appendChild(document.createTextNode('Capture'));
    // Everything (powers.ts): "Everything · 52 min left" in amber and End now, while the workspace's agent has it.
    const everythingLeft = make('span', font + 'flex:none;display:none;align-items:center;padding:4px 8px;border-radius:8px;font-size:12px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;color:#92400e;background:#fef3c7;border:1px solid #fcd34d', bar);
    const endEverything = button();
    endEverything.textContent = 'End now';
    paint(endEverything, false);
    endEverything.style.display = 'none';
    const secondDivider = divider();
    const takeOver = button();
    takeOver.textContent = 'Take over';
    paint(takeOver, false);
    const stop = button();
    stop.textContent = 'Stop';
    paint(stop, true);
    // Resume agent: blue, as the mock draws it.
    const resume = button();
    resume.textContent = 'Resume agent';
    paint(resume, true);
    resume.style.background = BLUE; resume.style.border = '1px solid ' + BLUE;
    const cursor = make('div', 'position:fixed;left:0;top:0;pointer-events:none;opacity:0;transition:opacity .4s ease;will-change:transform', root);
    const labelCss = font + 'position:absolute;left:16px;top:20px;padding:2px 6px;border-radius:6px;color:#fff;font-size:11px;line-height:16px;font-weight:500;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1)';
    // An arrow with a white outline: the agent's cursor, and each person's pointer.
    const arrowIn = parent => {
      const arrow = svg(parent, '22', '24', '0 0 22 24', 'display:block;overflow:visible;transform-origin:2px 2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))');
      return { arrow, path: path(arrow, { d: 'M2 2 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z', stroke: '#ffffff', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }) };
    };
    const { arrow, path: arrowPath } = arrowIn(cursor);
    arrowPath.setAttribute('fill', BLUE);
    const label = make('span', labelCss + ';background:' + BLUE, cursor);
    const people = make('div', 'position:fixed;inset:0;pointer-events:none', root);
    const state = { x: null, y: null, target: null, frame: 0, fade: 0, side: 1, press: false, expiry: 0, mode: null, capture: 'none', tracked: false, clock: 0, report: false, at: null, reported: 'null', reportedAt: 0, reportTimer: 0, everything: 0 };
    const place = (x, y) => { state.x = x; state.y = y; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    const pressAt = () => {
      arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.86)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
      const ring = make('div', 'position:fixed;left:0;top:0;width:32px;height:32px;margin:-16px 0 0 -16px;box-sizing:border-box;border-radius:50%;pointer-events:none;border:2px solid ' + BLUE, root);
      ring.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
      ring.animate([{ opacity: .9, scale: .3 }, { opacity: 0, scale: 1.4 }], { duration: 520, easing: 'ease-out' }).finished.then(() => ring.remove(), () => ring.remove());
    };
    const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const bezier = (t, a, b, c, d) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
    const move = (x, y, type) => {
      cursor.style.opacity = '1';
      clearTimeout(state.fade); state.fade = setTimeout(() => { cursor.style.opacity = '0'; }, 5000);
      if (type === 'mousePressed') state.press = true;
      if (state.target && state.target[0] === x && state.target[1] === y) { if (!state.frame && state.press) { state.press = false; pressAt(); } return; }
      state.target = [x, y];
      if (state.x === null) place(x - 48, y + 36);
      cancelAnimationFrame(state.frame);
      const x0 = state.x, y0 = state.y, dx = x - x0, dy = y - y0, d = Math.hypot(dx, dy) || 1;
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260 + 170 * Math.log2(1 + d / 22);
      state.side = -state.side;
      const bend = Math.min(90, d * .18) * state.side, nx = -dy / d * bend, ny = dx / d * bend;
      const over = Math.min(14, d * .05), ex = x + dx / d * over, ey = y + dy / d * over;
      const c1x = x0 + dx * .3 + nx, c1y = y0 + dy * .3 + ny, c2x = x0 + dx * .75 + nx * .5, c2y = y0 + dy * .75 + ny * .5;
      const start = performance.now(), split = .82;
      const step = now => {
        const t = duration ? (now - start) / duration : 1;
        if (t >= 1) { place(x, y); state.frame = 0; if (state.press) { state.press = false; pressAt(); } return; }
        if (t < split) { const s = ease(t / split); place(bezier(s, x0, c1x, c2x, ex), bezier(s, y0, c1y, c2y, ey)); }
        else { const s = ease((t - split) / (1 - split)); place(ex + (x - ex) * s, ey + (y - ey) * s); }
        state.frame = requestAnimationFrame(step);
      };
      state.frame = requestAnimationFrame(step);
    };
    // People watching a share: each pointer glides to its latest place (they come about ten times a second).
    const pointers = new Map();
    const point = list => {
      const now = new Set();
      for (const item of list) {
        now.add(item.id);
        let pointer = pointers.get(item.id);
        if (!pointer) {
          const element = make('div', 'position:fixed;left:0;top:0;pointer-events:none;will-change:transform', people);
          pointer = { element, path: arrowIn(element).path, tag: make('span', labelCss, element), x: null, y: null, frame: 0 };
          pointers.set(item.id, pointer);
        }
        pointer.path.setAttribute('fill', item.color); pointer.tag.style.background = item.color; pointer.tag.textContent = item.name + ' · watching';
        const x = item.x * innerWidth, y = item.y * innerHeight, x0 = pointer.x ?? x, y0 = pointer.y ?? y, start = performance.now();
        const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120;
        cancelAnimationFrame(pointer.frame);
        const step = time => {
          const t = duration ? Math.min(1, (time - start) / duration) : 1, s = ease(t);
          pointer.x = x0 + (x - x0) * s; pointer.y = y0 + (y - y0) * s;
          pointer.element.style.transform = 'translate(' + pointer.x + 'px,' + pointer.y + 'px)';
          pointer.frame = t < 1 ? requestAnimationFrame(step) : 0;
        };
        step(start);
      }
      for (const [id, pointer] of pointers) if (!now.has(id)) { cancelAnimationFrame(pointer.frame); pointer.element.remove(); pointers.delete(id); }
    };
    // Your own pointer while a share shows it to its viewers (report): where it is, at most ten times a second and
    // always the latest, and null once it left the tab.
    const report = at => {
      state.at = at;
      if (!state.report || state.reportTimer) return;
      const tell = () => {
        state.reportTimer = 0;
        const text = JSON.stringify(state.at);
        if (!state.report || text === state.reported) return;
        state.reported = text; state.reportedAt = Date.now();
        send('pointer ' + text).catch(() => {});
      };
      const wait = state.reportedAt + 100 - Date.now();
      if (wait <= 0) tell(); else state.reportTimer = setTimeout(tell, wait);
    };
    // Your own pointer over the toolbar makes it clickable; the agent's pointer (each point it is about to use) never
    // does, and is not reported.
    const hover = event => {
      if (gone()) return;
      const box = bar.getBoundingClientRect();
      const inside = event.clientX >= box.left - 4 && event.clientX <= box.right + 4 && event.clientY >= box.top - 4 && event.clientY <= box.bottom + 4;
      const agent = state.target && Math.abs(event.clientX - state.target[0]) < 1 && Math.abs(event.clientY - state.target[1]) < 1;
      bar.style.pointerEvents = inside && !agent ? 'auto' : 'none';
      if (!agent) report({ x: Math.min(1, Math.max(0, event.clientX / innerWidth)), y: Math.min(1, Math.max(0, event.clientY / innerHeight)) });
    };
    const leave = event => { if (gone()) return; if (event.type === 'visibilitychange' ? document.visibilityState === 'hidden' : !event.relatedTarget) report(null); };
    document.addEventListener('mousemove', hover, { capture: true, passive: true });
    document.addEventListener('mouseout', leave, { capture: true, passive: true });
    document.addEventListener('visibilitychange', leave);
    // Nothing on the toolbar reaches the page, and pressing it never moves focus out of the page.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) bar.addEventListener(type, event => { event.stopPropagation(); if (type !== 'click') event.preventDefault(); });
    const press = command => { send(command).catch(() => {}); };
    stop.addEventListener('click', () => { press('stop'); what.textContent = 'Stopping…'; });
    takeOver.addEventListener('click', () => { press('takeover'); what.textContent = 'Taking over…'; });
    resume.addEventListener('click', () => { press('resume'); what.textContent = 'Resuming…'; });
    // Your pointer or key press on the page while the agent acts there takes the tab; one on the toolbar does not, and
    // a page's own events (not trusted) never do.
    const take = event => { if (gone()) return; if (event.isTrusted && (state.mode === 'run' || state.mode === 'step') && !comments.on() && !event.composedPath().includes(host)) press('take'); };
    addEventListener('pointerdown', take, { capture: true, passive: true });
    addEventListener('keydown', take, { capture: true, passive: true });
    capture.addEventListener('click', () => { press(state.capture === 'recording' ? 'captureStop' : 'capture'); captureLabel.data = state.capture === 'recording' ? 'Saving…' : 'Starting…'; });
    endEverything.addEventListener('click', () => { press('everythingEnd'); endEverything.textContent = 'Ending…'; });
    // ── Comments (CommentTool; comments.ts) ──
    // The toolbar's Comment, and comment mode on the tab: what is under your pointer is outlined (dashed purple, with
    // its role and name), a click anchors a new comment to that element and a drag to an area, and the draft asks for
    // the text ("On … · as <you>"); each thread of the page has a numbered pin at its anchor (found again by its
    // selector, else by its box where the page was scrolled then), which opens it with its replies, Reply and Resolve
    // or Reopen. Esc closes what is open, then leaves comment mode. While no agent acts on the tab your pointer goes to
    // the comment layer (a crosshair; the page sees none of it); while one acts the layer stands aside, so the agent's
    // input and hit tests reach the page, and your own presses there are taken before the page sees them. It all sends
    // \`comment <what> <json>\`; the element under each number it sends (\`hover\` and \`pick\`) carries that number in its
    // \`data-gitspace-pick\` attribute (the DOM is the page's and every world's) for the extension to read, until a later
    // one of its kind takes its place or the draft closes. What you close (Esc, Done, Cancel, another pin) closes here at
    // once, then the extension hears of it; a view of a comment mode you closed (its \`session\`) never opens it again.
    const PURPLE = '#a142f4';
    const MESSAGE_PLUS = 'M12 13.5v-6m-3 3h6M7 18v2.335c0 .533 0 .8.11.937a.5.5 0 0 0 .39.188c.176 0 .384-.167.8-.5l2.385-1.908c.487-.39.731-.585 1.002-.724.241-.122.497-.212.762-.267.299-.061.61-.061 1.235-.061H16.2c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 15.72 21 14.88 21 13.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 5.28 3 6.12 3 7.8V14c0 .93 0 1.395.102 1.777a3 3 0 0 0 2.122 2.12C5.605 18 6.07 18 7 18Z';
    const icon = (parent, size, css) => path(svg(parent, size, size, '0 0 24 24', 'display:block;flex:none;' + css), { d: MESSAGE_PLUS, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    // Comment, before Capture as the mock has them; the idle toolbar's " · idle".
    const commentButton = button();
    bar.insertBefore(commentButton, capture);
    icon(commentButton, '14', '');
    commentButton.appendChild(document.createTextNode('Comment'));
    paint(commentButton, false);
    const titleTail = make('span', 'font-weight:400', title);
    const comments = (() => {
      const beneath = make('div', 'position:fixed;inset:0;pointer-events:none', root);
      root.insertBefore(beneath, bar);
      const layer = make('div', 'position:fixed;inset:0;display:none;cursor:crosshair;pointer-events:auto;touch-action:none', beneath);
      const areas = make('div', 'position:fixed;inset:0;pointer-events:none', beneath);
      const outline = make('div', 'position:fixed;left:0;top:0;display:none;box-sizing:border-box;border-radius:4px;pointer-events:none;outline:2px dashed ' + PURPLE, beneath);
      const chip = make('span', font + 'position:fixed;left:0;top:0;display:none;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:6px;color:#fff;font-size:11px;line-height:16px;font-weight:500;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.1);background:' + PURPLE, beneath);
      const region = make('div', 'position:fixed;left:0;top:0;display:none;box-sizing:border-box;border-radius:4px;pointer-events:none;outline:2px dashed ' + PURPLE + ';background:' + PURPLE + '1a', beneath);
      const over = make('div', 'position:fixed;inset:0;pointer-events:none', root);
      const pins = make('div', 'position:fixed;inset:0;pointer-events:none', over);
      const popover = make('div', font + 'position:fixed;left:0;top:0;display:none;flex-direction:column;gap:8px;width:288px;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid #e5e5e5;background:#fff;color:#262626;font-size:12px;line-height:16px;box-shadow:0 25px 50px -12px rgba(0,0,0,.25);pointer-events:auto;cursor:auto;user-select:text', over);
      // Its own bar while no capture's bar shows: what the tool does, how many comments the page has, Done.
      const strip = make('div', font + 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;align-items:center;gap:10px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 12px;border-radius:16px;border:1px solid #e5e5e5;background:#fff;color:#262626;font-size:13px;line-height:20px;pointer-events:auto;user-select:none;white-space:nowrap;box-shadow:0 10px 30px rgba(0,0,0,.18), 0 0 0 1px ' + PURPLE + '55', over);
      icon(strip, '18', 'color:' + PURPLE);
      const stripText = make('div', 'min-width:0;overflow:hidden', strip);
      const stripTitle = make('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis', stripText);
      const stripWhat = make('div', 'font-size:12px;line-height:16px;color:#737373;overflow:hidden;text-overflow:ellipsis', stripText);
      make('span', 'flex:none;width:1px;height:24px;background:#e5e5e5', strip);
      const plain = (tag, css, parent, value) => { const element = make(tag, css, parent); element.textContent = value; return element; };
      const action = (parent, label, css) => { const element = plain('button', 'all:unset;' + font + 'flex:none;cursor:pointer;' + css, parent, label); element.type = 'button'; element.tabIndex = -1; return element; };
      const done = action(strip, 'Done (Esc)', 'display:inline-flex;align-items:center;box-sizing:border-box;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;font-weight:500;background:#171717;color:#fff;border:1px solid #171717');
      // Nothing of the tool reaches the page: not its presses, not what you type into it.
      for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout']) over.addEventListener(type, event => event.stopPropagation());
      for (const type of ['pointerdown', 'mousedown']) { pins.addEventListener(type, event => event.preventDefault()); strip.addEventListener(type, event => event.preventDefault()); }
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick']) layer.addEventListener(type, event => { event.stopPropagation(); event.preventDefault(); if (type.startsWith('pointer')) pointer(event); });
      layer.addEventListener('pointerleave', () => { hovered = null; place(); });
      // \`view\`: what the extension says (\`CommentView\`); \`open\`: the draft or thread whose popover shows; \`writing\`:
      // the write sent last, until the extension says how it ended; \`closed\`: the session of the comment mode you
      // closed here.
      let view = null, open = null, hovered = null, drag = null, writing = null, failed = null, field = null, focused = 0, seq = 0, placing = 0, closed = null, listening = false;
      let pinned = [], outlined = [];
      // Each call is answered by the extension's reply; one nobody waits on fails quietly.
      const call = (what, value) => { const sent = send('comment ' + what + (value === undefined ? '' : ' ' + JSON.stringify(value))); sent.catch(() => {}); return sent; };
      const width = () => document.documentElement.clientWidth || innerWidth, height = () => document.documentElement.clientHeight || innerHeight;
      const fraction = value => Math.min(1, Math.max(0, value));
      const layerOn = () => view !== null && state.mode !== 'run' && state.mode !== 'step';
      // The element under the latest number of each kind (\`hover\`, \`pick\`), marked in the page for the extension.
      const PICK = 'data-gitspace-pick';
      const marks = { hover: null, pick: null };
      const unmark = kind => {
        const mark = marks[kind];
        marks[kind] = null;
        if (!mark || !mark.element) return;
        const rest = (mark.element.getAttribute(PICK) || '').split(' ').filter(n => n && n !== String(mark.seq));
        if (rest.length) mark.element.setAttribute(PICK, rest.join(' ')); else mark.element.removeAttribute(PICK);
      };
      const keep = (kind, element) => {
        unmark(kind);
        seq += 1;
        marks[kind] = { element, seq };
        if (element) element.setAttribute(PICK, ((element.getAttribute(PICK) || '') + ' ' + seq).trim());
        return seq;
      };
      // The page's element under a point, past this overlay and the agent's cursor.
      const hit = (x, y) => (document.elementsFromPoint(x, y) || []).find(element => element !== host && !element.closest('[data-gitspace-overlay], gitspace-cursor')) ?? null;
      const page = element => element && element !== document.documentElement && element !== document.body ? element : null;
      const ago = at => { const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(at)) / 60000); return minutes < 1 ? 'just now' : minutes < 60 ? minutes + ' min ago' : minutes < 1440 ? Math.floor(minutes / 60) + ' h ago' : Math.floor(minutes / 1440) + ' d ago'; };
      const rectOf = element => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; };
      // Where a thread's anchor is now: its element by selector, else its box where the page was scrolled then.
      const anchored = thread => {
        if (!thread.area && thread.selector) {
          let element = null;
          try { element = document.querySelector(thread.selector); } catch {}
          if (element) { const box = rectOf(element); if (box.right > box.left || box.bottom > box.top) return box; }
        }
        const w = thread.viewport ? thread.viewport.w : width(), h = thread.viewport ? thread.viewport.h : height();
        const left = thread.box.x * w + (thread.scroll ? thread.scroll.x - scrollX : 0), top = thread.box.y * h + (thread.scroll ? thread.scroll.y - scrollY : 0);
        return { left, top, right: left + thread.box.w * w, bottom: top + thread.box.h * h };
      };
      // The draft's anchor: its element while it is on the page, else where it was picked.
      const drafted = () => open.element && open.element.isConnected && !open.area ? rectOf(open.element) : { left: open.rect.left - scrollX, top: open.rect.top - scrollY, right: open.rect.right - scrollX, bottom: open.rect.bottom - scrollY };
      // A pin sits on its anchor's top-right corner, as the mock's do.
      const pinAt = (rect, area) => ({ x: Math.max(0, Math.min(rect.right - 10, width() - 24)), y: rect.top - (area ? 12 : 10) });
      const hoverAt = (x, y) => {
        const element = page(hit(x, y));
        if (element === (hovered && hovered.element)) return;
        if (!element) unmark('hover');
        hovered = element ? { element, seq: keep('hover', element) } : null;
        place();
        if (hovered) call('hover', { seq: hovered.seq });
      };
      // A click anchors a draft to the element there; a drag of more than 4 px anchors it to the area, with the nearest
      // element holding all of it.
      const pointer = event => {
        if (event.type === 'pointerdown') { if (event.button === 0) { drag = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, moved: false }; try { layer.setPointerCapture(event.pointerId); } catch {} } return; }
        if (event.type === 'pointercancel') { drag = null; place(); return; }
        if (event.type === 'pointermove') {
          if (!drag) { hoverAt(event.clientX, event.clientY); return; }
          drag.x = event.clientX; drag.y = event.clientY; drag.moved = drag.moved || Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 4;
          place(); return;
        }
        if (event.type !== 'pointerup' || !drag) return;
        const { x0, y0 } = drag, x = event.clientX, y = event.clientY, moved = drag.moved || Math.hypot(x - x0, y - y0) > 4;
        drag = null;
        if (open && open.kind === 'draft') call('cancel', { seq: open.seq });
        failed = null;
        if (moved) {
          const left = Math.min(x0, x), top = Math.min(y0, y), right = Math.max(x0, x), bottom = Math.max(y0, y);
          let element = hit((left + right) / 2, (top + bottom) / 2);
          for (; page(element); element = element.parentElement) { const box = rectOf(element); if (box.left <= left && box.top <= top && box.right >= right && box.bottom >= bottom) break; }
          const n = keep('pick', page(element));
          open = { kind: 'draft', seq: n, element: page(element), area: true, rect: { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY } };
          call('pick', { seq: n, area: { x: fraction(left / width()), y: fraction(top / height()), width: fraction((right - left) / width()), height: fraction((bottom - top) / height()) } });
        } else {
          const element = page(hit(x0, y0)), n = keep('pick', element);
          const rect = element ? rectOf(element) : { left: x0, top: y0, right: x0, bottom: y0 };
          open = { kind: 'draft', seq: n, element, area: false, rect: { left: rect.left + scrollX, top: rect.top + scrollY, right: rect.right + scrollX, bottom: rect.bottom + scrollY } };
          call('pick', { seq: n, at: { x: fraction(x0 / width()), y: fraction(y0 / height()), width: 0, height: 0 } });
        }
        render();
      };
      // While an agent acts here the layer stands aside: your own presses on the page come here first, and the agent's
      // (at the point its cursor is about to use) go on to the page.
      const intercept = event => {
        if (gone() || !view || layerOn() || !event.isTrusted || event.composedPath().includes(host)) return;
        if (state.target && Math.abs(event.clientX - state.target[0]) < 1 && Math.abs(event.clientY - state.target[1]) < 1) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type.startsWith('pointer')) pointer(event);
      };
      const INTERCEPTED = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'];
      const escape = event => {
        if (gone() || !view || event.key !== 'Escape' || !event.isTrusted) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!open) { off(); return; }
        if (open.kind === 'draft') call('cancel', { seq: open.seq });
        open = null; failed = null; render();
      };
      const schedule = () => { if (view && !placing) placing = requestAnimationFrame(() => { placing = 0; place(); }); };
      // The window's listeners are there only while comment mode is on.
      const listen = on => {
        if (on === listening) return;
        listening = on;
        const method = on ? 'addEventListener' : 'removeEventListener';
        for (const type of INTERCEPTED) globalThis[method](type, intercept, { capture: true });
        globalThis[method]('keydown', escape, { capture: true });
        globalThis[method]('scroll', schedule, { capture: true, passive: true });
        globalThis[method]('resize', schedule, { passive: true });
      };
      // Comment mode off here at once (Esc, Done), then the extension hears of it.
      const off = () => { closed = view.session; tool.apply(null); call('off'); };
      done.addEventListener('click', () => { if (view) off(); });
      commentButton.addEventListener('click', () => call('on'));
      // Sending… until the extension says how the write ended (\`done\`); one it did not take (its reply says why, or
      // none came) says so at once.
      const write = (kind, value) => {
        if (!open || !view || view.busy !== null || writing) return;
        seq += 1; failed = null;
        const sent = writing = { seq, kind, key: popover.dataset.key };
        call(kind, { seq, ...value }).then(reply => reply && reply.error ? String(reply.error) : null, error => error && error.message ? error.message : 'GitSpace did not answer').then(error => {
          if (!error || writing !== sent) return;
          failed = { key: sent.key, message: error }; writing = null; render();
        });
        render();
      };
      const submit = () => {
        const text = field ? field.value.trim() : '';
        if (!text || !open) return;
        if (open.kind === 'draft') { if (view.draft && view.draft.seq === open.seq) write('post', { text }); }
        else write('reply', { threadId: open.id, text });
      };
      // Everything follows the page: pins and areas at their anchors, the draft's and the open thread's popover beside
      // its pin, the outline round what is under your pointer, the area being dragged.
      const place = () => {
        for (const { element, rect, area } of pinned) { const at = pinAt(rect(), area); element.style.transform = 'translate(' + at.x + 'px,' + at.y + 'px)'; }
        for (const { element, rect } of outlined) { const box = rect(); element.style.transform = 'translate(' + box.left + 'px,' + box.top + 'px)'; element.style.width = box.right - box.left + 'px'; element.style.height = box.bottom - box.top + 'px'; }
        const target = view && !drag && hovered && hovered.element.isConnected ? rectOf(hovered.element) : null;
        outline.style.display = target ? 'block' : 'none';
        const label = target && view && view.hover && view.hover.seq === hovered.seq ? view.hover.label : '';
        chip.style.display = label ? 'block' : 'none';
        if (target) {
          outline.style.transform = 'translate(' + (target.left - 3) + 'px,' + (target.top - 3) + 'px)'; outline.style.width = target.right - target.left + 6 + 'px'; outline.style.height = target.bottom - target.top + 6 + 'px';
          chip.textContent = label;
          chip.style.transform = 'translate(' + Math.max(0, target.left - 3) + 'px,' + (target.top - 27 >= 0 ? target.top - 27 : target.bottom + 5) + 'px)';
        }
        region.style.display = drag && drag.moved ? 'block' : 'none';
        if (drag && drag.moved) { region.style.transform = 'translate(' + Math.min(drag.x0, drag.x) + 'px,' + Math.min(drag.y0, drag.y) + 'px)'; region.style.width = Math.abs(drag.x - drag.x0) + 'px'; region.style.height = Math.abs(drag.y - drag.y0) + 'px'; }
        const anchor = open && pinned.find(item => item.key === popover.dataset.key);
        if (anchor && popover.style.display !== 'none') {
          const at = pinAt(anchor.rect(), anchor.area);
          const left = at.x + 30 + 288 <= width() - 8 ? at.x + 30 : Math.max(8, at.x - 296);
          const top = Math.max(8, Math.min(at.y - 10, height() - popover.offsetHeight - 8));
          popover.style.transform = 'translate(' + left + 'px,' + top + 'px)';
        }
      };
      const pin = (n, color, key, rect, area, onClick) => {
        const element = plain('button', 'all:unset;' + font + 'position:fixed;left:0;top:0;display:flex;align-items:center;justify-content:center;width:24px;height:24px;box-sizing:border-box;border-radius:12px 12px 12px 0;font-size:11px;line-height:16px;font-weight:700;color:#fff;cursor:pointer;pointer-events:auto;box-shadow:0 4px 6px -1px rgba(0,0,0,.1),0 2px 4px -2px rgba(0,0,0,.1);background:' + color + (open && popover.dataset.key === key ? ';outline:2px solid #fff;box-shadow:0 0 0 4px ' + color : ''), pins, String(n));
        element.type = 'button'; element.tabIndex = -1;
        element.addEventListener('click', onClick);
        pinned.push({ element, key, rect, area });
      };
      const message = line => {
        const row = make('div', 'display:flex;gap:8px', popover);
        plain('span', 'flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;font-size:10px;line-height:12px;font-weight:700;color:#fff;background:' + (line.agent ? BLUE : '#525252'), row, line.agent ? 'AI' : (line.who[0] || '?').toUpperCase());
        const body = make('div', 'min-width:0', row);
        const meta = make('div', 'font-size:11px;line-height:16px', body);
        plain('strong', 'font-weight:600', meta, line.who + (line.guest ? ' (guest)' : ''));
        plain('span', 'color:#a3a3a3', meta, ' · ' + ago(line.at));
        plain('div', 'white-space:pre-wrap;overflow-wrap:anywhere', body, line.text);
      };
      const render = () => {
        layer.style.display = layerOn() ? 'block' : 'none';
        pins.replaceChildren(); areas.replaceChildren(); pinned = []; outlined = [];
        if (!open || open.kind !== 'draft') unmark('pick');
        if (!view) { unmark('hover'); open = null; hovered = null; drag = null; field = null; writing = null; failed = null; popover.replaceChildren(); popover.style.display = 'none'; strip.style.display = 'none'; place(); placeBar(); return; }
        const count = view.threads.length;
        strip.style.display = view.bar ? 'flex' : 'none';
        placeBar();
        stripTitle.replaceChildren('Commenting', plain('span', 'font-weight:400;color:#737373', stripTitle, ' · ' + view.workspace));
        stripWhat.textContent = view.error ? view.error : 'Comment tool · click an element or drag an area · ' + count + (count === 1 ? ' comment' : ' comments');
        const thread = open && open.kind === 'thread' ? view.threads.find(entry => entry.id === open.id) : null;
        if (open && open.kind === 'thread' && !thread) open = null;
        const key = open ? open.kind + ':' + (open.kind === 'draft' ? open.seq : open.id) : '';
        const kept = field && popover.dataset.key === key ? { value: field.value, focused: root.activeElement === field, start: field.selectionStart, end: field.selectionEnd } : null;
        popover.dataset.key = key;
        for (const entry of view.threads) {
          const color = entry.resolved ? '#a3a3a3' : entry.area ? PURPLE : BLUE;
          if (entry.area && !entry.resolved) { const element = make('div', 'position:fixed;left:0;top:0;box-sizing:border-box;border-radius:4px;pointer-events:none;outline:2px dashed ' + PURPLE + ';background:' + PURPLE + '10', areas); outlined.push({ element, rect: () => anchored(entry) }); }
          pin(entry.n, color, 'thread:' + entry.id, () => anchored(entry), entry.area, () => { if (open && open.kind === 'draft') call('cancel', { seq: open.seq }); open = { kind: 'thread', id: entry.id }; failed = null; render(); });
        }
        if (open && open.kind === 'draft') pin(count + 1, open.area ? PURPLE : BLUE, key, drafted, open.area, () => {});
        popover.replaceChildren(); field = null;
        popover.style.display = open ? 'flex' : 'none';
        if (open) {
          const draft = open.kind === 'draft', ready = draft && view.draft !== null && view.draft.seq === open.seq;
          const head = make('div', 'font-size:11px;line-height:16px;color:#737373', popover);
          head.append('On ' + (draft ? ready ? view.draft.label : '…' : thread.label) + (draft ? ' · as ' : ' · files into '));
          plain('strong', 'font-weight:600;color:#404040', head, draft ? view.name || 'you' : view.workspace);
          if (thread) for (const line of thread.comments) message(line);
          if (thread && thread.resolved) plain('div', 'font-size:11px;line-height:16px;color:#737373', popover, 'Resolved by ' + thread.resolved);
          field = make('textarea', 'all:unset;' + font + 'display:block;box-sizing:border-box;width:100%;min-height:44px;max-height:160px;overflow:auto;padding:6px 8px;border-radius:8px;border:1px solid #d4d4d4;font-size:12px;line-height:16px;color:#262626;background:#fff;white-space:pre-wrap;cursor:text', popover);
          field.placeholder = draft ? 'Write a comment…' : 'Reply…'; field.rows = 2; field.maxLength = 4000; field.tabIndex = -1;
          field.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } });
          if (failed && failed.key === key) plain('div', 'font-size:11px;line-height:16px;color:' + RED, popover, failed.message);
          const footer = make('div', 'display:flex;align-items:center;gap:8px', popover);
          const busy = writing !== null && writing.key === key;
          if (draft) action(footer, 'Cancel', 'font-size:11px;line-height:16px;color:#737373').addEventListener('click', () => { call('cancel', { seq: open.seq }); open = null; failed = null; render(); });
          else action(footer, busy && writing.kind === 'resolve' ? 'Saving…' : thread.resolved ? 'Reopen' : 'Resolve', 'font-size:11px;line-height:16px;color:#737373').addEventListener('click', () => write('resolve', { threadId: thread.id, reopen: thread.resolved !== null }));
          make('span', 'flex:1', footer);
          const primary = action(footer, busy && writing.kind !== 'resolve' ? 'Sending…' : draft ? 'Comment' : 'Reply', 'padding:4px 10px;border-radius:8px;font-size:12px;line-height:16px;font-weight:500;color:#fff;background:' + BLUE + (draft && !ready ? ';opacity:.5;cursor:default' : ''));
          primary.addEventListener('click', submit);
          if (kept) { field.value = kept.value; if (kept.focused) { field.focus(); field.setSelectionRange(kept.start, kept.end); } }
        }
        place();
      };
      const tool = {
        on: () => view !== null,
        /** Its own bar shows, in place of the toolbar. */
        strip: () => view !== null && view.bar,
        apply(next) {
          if (next && next.session === closed) return;
          view = next;
          listen(view !== null);
          if (view && view.focus && view.focus.seq !== focused) {
            focused = view.focus.seq;
            const thread = view.threads.find(entry => entry.id === view.focus.thread);
            if (thread) { open = { kind: 'thread', id: thread.id }; failed = null; const box = anchored(thread); if (box.top < 0 || box.bottom > height()) scrollBy({ top: box.top - height() / 3, behavior: 'smooth' }); }
          }
          // The write sent last ended: a comment closes its draft and a reply empties its field; a failure says why.
          if (view && writing && view.done && view.done.seq === writing.seq && view.busy !== writing.seq) {
            if (view.done.error) failed = { key: writing.key, message: view.done.error };
            else if (writing.kind === 'post' && open && open.kind === 'draft') open = null;
            else if (writing.kind === 'reply' && field) field.value = '';
            writing = null;
          }
          render();
        },
        dispose() {
          cancelAnimationFrame(placing);
          listen(false);
          unmark('hover'); unmark('pick');
        },
      };
      return tool;
    })();
    // ── end Comments ──
    // A recording's time, counted here between refreshes.
    const elapsed = startedAt => { const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    // Not refreshed for 75 s, the overlay asks the extension, which draws it again or removes it; one that cannot ask
    // (its extension is gone) leaves.
    const expire = () => { state.expiry = setTimeout(expire, 75000); send('refresh').catch(() => overlay.dispose()); };
    // The toolbar shows while something uses the tab, unless a capture's own bar (\`capture-tracks.ts\`) or the comment
    // tool's strip takes its place.
    const placeBar = () => { bar.style.display = state.mode !== null && !(state.mode === 'capture' && state.tracked) && !comments.strip() ? 'flex' : 'none'; };
    const show = next => {
      state.mode = next.mode; state.capture = next.capture;
      const capturing = next.mode === 'capture', yours = next.mode === 'you', idle = next.mode === 'idle', recording = next.capture === 'recording' && next.recording ? next.recording : null;
      // A capture recording its steps (\`tracks\`) has its own bar (\`capture-tracks.ts\`): this one gives way to it, or sits
      // above it while the agent acts or you hold the tab.
      const tracked = recording?.tracks === true;
      state.tracked = tracked;
      const tone = recording ? RED : BLUE;
      placeBar();
      bar.style.bottom = tracked ? '76px' : '16px';
      bar.style.boxShadow = '0 10px 30px rgba(0,0,0,.18)' + (yours && !recording ? '' : ', 0 0 0 1px ' + tone + '55');
      frame.style.boxShadow = yours && !recording ? 'inset 0 0 0 2px #a3a3a3' : 'inset 0 0 0 3px ' + tone + ', inset 0 0 ' + (recording ? '22px ' + tone + '40' : '26px ' + tone + '55');
      frame.style.opacity = next.mode === 'run' || next.mode === 'step' || yours || recording ? '1' : '0';
      logo.style.display = capturing ? 'none' : '';
      logoDot.style.display = yours || idle ? 'none' : '';
      recDot.style.display = capturing ? '' : 'none';
      // While capturing, the second part is the recording's time, in the title's weight with even digits.
      where.style.cssText = capturing ? 'font-variant-numeric:tabular-nums' : 'font-weight:400;color:#737373';
      what.style.color = yours ? '#737373' : '#525252';
      // Idle, one line in the mock's weights: "GitSpace · <workspace> · idle".
      title.style.fontWeight = idle ? '400' : '600';
      what.style.display = idle ? 'none' : '';
      titleTail.textContent = idle ? ' · idle' : '';
      clearInterval(state.clock);
      if (capturing) {
        who.textContent = 'Capturing · ' + next.workspace;
        where.textContent = '';
        what.textContent = 'REC · ' + (recording?.sound ? 'tabCapture · with sound' : 'frames · no sound');
        const tick = () => { where.textContent = ' · ' + elapsed(recording.startedAt); };
        if (recording) { tick(); state.clock = setInterval(tick, 1000); }
      } else if (yours) {
        who.textContent = "You're in control";
        where.textContent = '';
        what.textContent = (next.agent ?? 'main') + ' is paused · it sees your changes when it resumes';
        cursor.style.opacity = '0';
        // The agent's ghost cursor of a script (\`gitspace-cursor\`, in the page's own world) goes too; its next draw,
        // once you hand the tab back, brings it back.
        for (const ghost of document.querySelectorAll('gitspace-cursor')) ghost.remove();
      } else if (idle) {
        who.textContent = 'GitSpace · ';
        where.style.cssText = 'font-weight:600;color:#262626';
        where.textContent = next.workspace;
      } else {
        who.textContent = next.agent ?? next.workspace;
        where.textContent = next.agent ? ' · ' + next.workspace : '';
        what.textContent = (next.doing ?? (next.mode === 'run' ? 'Running a script' : 'Working')) + '…';
      }
      label.textContent = next.agent ?? 'agent';
      // Capture, or Stop capture with a red dot while it records; alone while only a capture uses the tab.
      capture.style.display = next.capture === 'none' || tracked ? 'none' : 'inline-flex';
      // Comment where the account takes comments, apart from while a capture records (its own bar has Comment).
      const commentable = next.comments === true && !capturing && next.capture !== 'recording';
      commentButton.style.display = commentable ? 'inline-flex' : 'none';
      firstDivider.style.display = next.capture === 'none' && capturing ? 'none' : '';
      captureLabel.data = next.capture === 'recording' ? 'Stop capture' : 'Capture';
      captureIcon.style.display = next.capture === 'recording' ? 'none' : '';
      captureDot.style.display = next.capture === 'recording' && !capturing ? '' : 'none';
      paint(capture, capturing);
      // Take over and Stop while the agent acts; Resume agent while you hold the tab; neither while idle.
      takeOver.style.display = capturing || yours || idle ? 'none' : 'inline-flex';
      stop.style.display = capturing || yours || idle ? 'none' : 'inline-flex';
      resume.style.display = yours ? 'inline-flex' : 'none';
      secondDivider.style.display = capturing || idle || !(commentable || (next.capture !== 'none' && !tracked)) ? 'none' : '';
      // Everything's time left, redrawn as each minute passes until it ends (the extension refreshes the toolbar then).
      clearTimeout(state.everything);
      const until = typeof next.everything === 'string' ? Date.parse(next.everything) : NaN;
      everythingLeft.style.display = endEverything.style.display = until > Date.now() ? 'inline-flex' : 'none';
      endEverything.textContent = 'End now';
      const left = () => {
        const ms = until - Date.now();
        if (!(ms > 0)) { everythingLeft.style.display = endEverything.style.display = 'none'; return; }
        everythingLeft.textContent = 'Everything · ' + Math.max(1, Math.ceil(ms / 60000)) + ' min left';
        state.everything = setTimeout(left, ms % 60000 || 60000);
      };
      left();
    };
    overlay = {
      apply(next) {
        if (next.show !== undefined || next.pointers || next.report || next.comment) { clearTimeout(state.expiry); state.expiry = setTimeout(expire, 75000); if (!host.isConnected) document.documentElement.appendChild(host); }
        if (next.show) show(next.show);
        if (next.comment !== undefined) comments.apply(next.comment);
        if (next.show === null) { state.mode = null; clearInterval(state.clock); placeBar(); frame.style.opacity = '0'; cursor.style.opacity = '0'; }
        if (next.pointers) point(next.pointers);
        if (next.report !== undefined && next.report !== state.report) { clearTimeout(state.reportTimer); state.reportTimer = 0; state.report = next.report; state.reported = 'null'; }
        if (next.conceal !== undefined) host.style.visibility = next.conceal ? 'hidden' : 'visible';
        if (next.cursor) move(next.cursor.x, next.cursor.y, next.cursor.type);
      },
      dispose() {
        cancelAnimationFrame(state.frame); clearTimeout(state.fade); clearTimeout(state.expiry); clearInterval(state.clock); clearTimeout(state.reportTimer); clearTimeout(state.everything);
        guard.disconnect();
        for (const pointer of pointers.values()) cancelAnimationFrame(pointer.frame);
        document.removeEventListener('mousemove', hover, { capture: true });
        document.removeEventListener('mouseout', leave, { capture: true });
        document.removeEventListener('visibilitychange', leave);
        removeEventListener('pointerdown', take, { capture: true });
        removeEventListener('keydown', take, { capture: true });
        comments.dispose();
        host.remove(); delete globalThis[key];
      },
    };
    globalThis[key] = overlay;
    document.documentElement.appendChild(host);
  }
  overlay.apply(command);
  return true;
}`;

/** In any world of the page (the DOM is all of theirs): the element the comment tool marked with number `seq`
 * (`data-gitspace-pick`, for `comment hover` and `comment pick`), for the extension to read; null when none has it. */
export const browserPickedElementFunction = `function(seq) {
  return document.querySelector('[data-gitspace-pick~="' + Number(seq) + '"]');
}`;
