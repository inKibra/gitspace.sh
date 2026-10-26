/**
 * The in-page overlay on a tab of your Chrome while an agent uses it, you hold it, a capture records it or people watch
 * its share (docs/APERTURE-DESIGN.md §6.4, §7.2, §8, §11; the agreed look is account-web's BrowsersMockExtension `Bar`
 * and `Pointer`): a white toolbar at the bottom of the tab (the GitSpace mark, who acts and on which workspace, what it
 * is doing, Capture, Take over and Stop for the agent; while you hold the tab, "You're in control", the paused agent
 * and Resume agent; while a capture records, REC with its time and Stop capture), a frame round the tab (blue while
 * the agent acts, grey while you hold it, red while a capture records), the agent's cursor at each point it clicks or
 * moves to, and the named pointers of the people watching the tab's shares. It draws nothing for your own pointer:
 * while a share shows it to its viewers, it says where it is instead (`report`), and each viewer draws it.
 *
 * A fixed function the extension calls in its own isolated world (`Runtime.callFunctionOn`), never in the page's. The
 * overlay leaves the page and what the agent reads alone: a closed shadow root under an `aria-hidden` host marked
 * `data-gitspace-overlay` (which the screenshot mask hides), styled inline only (no stylesheet a page's CSP could
 * refuse), nothing focusable, and pointer-transparent except the toolbar while your own pointer is over it, so an
 * agent's clicks and hit tests reach the page. Its buttons call the binding named in `show` (added to this world
 * only) with `stop`, `capture`, `captureStop`, `takeover` or `resume`; while the agent acts (`run`, `step`), each
 * trusted pointer or key press on the page (not on the toolbar) calls it with `take`: the agent's own input is trusted
 * too, which the extension tells apart. With `report`, your pointer calls the binding it names with
 * `pointer {"x":…,"y":…}` (fractions of the viewport) at most ten times a second, and `pointer null` once it leaves the
 * tab. Mouse events at the agent's cursor are the agent's, and are not reported.
 *
 * One argument: `{ show?: { mode: 'run' | 'step' | 'capture' | 'you', workspace, agent, doing, binding, capture:
 * 'none' | 'ready' | 'recording', recording: { startedAt, sound } | null } | null, cursor?: { x, y, type }, pointers?:
 * [{ id, name, color, x, y }], report?: string | null, conceal?: boolean, remove?: true }`. `agent` and `doing` (what it
 * is doing) may be null; in `you`, `agent` is the paused agent. `show` installs the overlay where the document lacks it
 * (after a navigation) and refreshes it; `show: null` hides the toolbar, frame and cursor, leaving the pointers.
 * `pointers` (x and y are fractions of the viewport) is everyone pointing now: each glides to its new place, eased,
 * and one left out leaves; they install the overlay too, as `report` does. An overlay not refreshed for 75 s removes
 * itself, so one whose debugger channel Chrome dropped does not stay. The cursor travels to each point along a curved
 * path, eased, overshooting slightly and settling, in the time Fitts's law gives a hand (260 + 170·log2(1 + d/22) ms);
 * it presses on `mousePressed` (with a ripple) and fades after 5 s idle.
 */
export const browserOverlayFunction = `function(command) {
  const key = '__gitspaceOverlay';
  // Removing also clears a toolbar another world left on the page (an earlier debugger session's, which Chrome took
  // away or whose removal did not finish): the page keeps it after its world's session ends.
  if (command.remove) { if (globalThis[key]) globalThis[key].dispose(); for (const stale of document.querySelectorAll('[data-gitspace-overlay]')) stale.remove(); return true; }
  let overlay = globalThis[key];
  if (!overlay && !command.show && !command.pointers?.length && !command.report) return false;
  if (!overlay) {
    for (const stale of document.querySelectorAll('[data-gitspace-overlay]')) stale.remove();
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
    const root = host.attachShadow({ mode: 'closed' });
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
    const state = { x: null, y: null, target: null, frame: 0, fade: 0, side: 1, press: false, seen: Date.now(), binding: '', mode: null, capture: 'none', clock: 0, report: null, at: null, reported: 'null', reportedAt: 0, reportTimer: 0 };
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
      const send = () => {
        state.reportTimer = 0;
        const text = JSON.stringify(state.at), call = globalThis[state.report];
        if (!state.report || text === state.reported || typeof call !== 'function') return;
        state.reported = text; state.reportedAt = Date.now();
        call('pointer ' + text);
      };
      const wait = state.reportedAt + 100 - Date.now();
      if (wait <= 0) send(); else state.reportTimer = setTimeout(send, wait);
    };
    // Your own pointer over the toolbar makes it clickable; the agent's pointer (each point it is about to use) never
    // does, and is not reported.
    const hover = event => {
      const box = bar.getBoundingClientRect();
      const inside = event.clientX >= box.left - 4 && event.clientX <= box.right + 4 && event.clientY >= box.top - 4 && event.clientY <= box.bottom + 4;
      const agent = state.target && Math.abs(event.clientX - state.target[0]) < 1 && Math.abs(event.clientY - state.target[1]) < 1;
      bar.style.pointerEvents = inside && !agent ? 'auto' : 'none';
      if (!agent) report({ x: Math.min(1, Math.max(0, event.clientX / innerWidth)), y: Math.min(1, Math.max(0, event.clientY / innerHeight)) });
    };
    const leave = event => { if (event.type === 'visibilitychange' ? document.visibilityState === 'hidden' : !event.relatedTarget) report(null); };
    document.addEventListener('mousemove', hover, { capture: true, passive: true });
    document.addEventListener('mouseout', leave, { capture: true, passive: true });
    document.addEventListener('visibilitychange', leave);
    // Nothing on the toolbar reaches the page, and pressing it never moves focus out of the page.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) bar.addEventListener(type, event => { event.stopPropagation(); if (type !== 'click') event.preventDefault(); });
    const press = command => { const call = globalThis[state.binding]; if (typeof call === 'function') call(command); return typeof call === 'function'; };
    stop.addEventListener('click', () => { if (press('stop')) what.textContent = 'Stopping…'; });
    takeOver.addEventListener('click', () => { if (press('takeover')) what.textContent = 'Taking over…'; });
    resume.addEventListener('click', () => { if (press('resume')) what.textContent = 'Resuming…'; });
    // Your pointer or key press on the page while the agent acts there takes the tab; one on the toolbar does not, and
    // a page's own events (not trusted) never do.
    const take = event => { if (event.isTrusted && (state.mode === 'run' || state.mode === 'step') && !event.composedPath().includes(host)) press('take'); };
    addEventListener('pointerdown', take, { capture: true, passive: true });
    addEventListener('keydown', take, { capture: true, passive: true });
    capture.addEventListener('click', () => { if (press(state.capture === 'recording' ? 'captureStop' : 'capture')) captureLabel.data = state.capture === 'recording' ? 'Saving…' : 'Starting…'; });
    // A recording's time, counted here between refreshes.
    const elapsed = startedAt => { const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    const expiry = setInterval(() => { if (Date.now() - state.seen > 75000) overlay.dispose(); }, 15000);
    const show = next => {
      state.binding = next.binding; state.mode = next.mode; state.capture = next.capture;
      const capturing = next.mode === 'capture', yours = next.mode === 'you', recording = next.capture === 'recording' && next.recording ? next.recording : null;
      const tone = recording ? RED : BLUE;
      bar.style.display = 'flex';
      bar.style.boxShadow = '0 10px 30px rgba(0,0,0,.18)' + (yours && !recording ? '' : ', 0 0 0 1px ' + tone + '55');
      frame.style.boxShadow = yours && !recording ? 'inset 0 0 0 2px #a3a3a3' : 'inset 0 0 0 3px ' + tone + ', inset 0 0 ' + (recording ? '22px ' + tone + '40' : '26px ' + tone + '55');
      frame.style.opacity = next.mode === 'run' || next.mode === 'step' || yours || recording ? '1' : '0';
      logo.style.display = capturing ? 'none' : '';
      logoDot.style.display = yours ? 'none' : '';
      recDot.style.display = capturing ? '' : 'none';
      // While capturing, the second part is the recording's time, in the title's weight with even digits.
      where.style.cssText = capturing ? 'font-variant-numeric:tabular-nums' : 'font-weight:400;color:#737373';
      what.style.color = yours ? '#737373' : '#525252';
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
      } else {
        who.textContent = next.agent ?? next.workspace;
        where.textContent = next.agent ? ' · ' + next.workspace : '';
        what.textContent = (next.doing ?? (next.mode === 'run' ? 'Running a script' : 'Working')) + '…';
      }
      label.textContent = next.agent ?? 'agent';
      // Capture, or Stop capture with a red dot while it records; alone while only a capture uses the tab.
      capture.style.display = next.capture === 'none' ? 'none' : 'inline-flex';
      firstDivider.style.display = next.capture === 'none' && capturing ? 'none' : '';
      captureLabel.data = next.capture === 'recording' ? 'Stop capture' : 'Capture';
      captureIcon.style.display = next.capture === 'recording' ? 'none' : '';
      captureDot.style.display = next.capture === 'recording' && !capturing ? '' : 'none';
      paint(capture, capturing);
      // Take over and Stop while the agent acts; Resume agent while you hold the tab.
      takeOver.style.display = capturing || yours ? 'none' : 'inline-flex';
      stop.style.display = capturing || yours ? 'none' : 'inline-flex';
      resume.style.display = yours ? 'inline-flex' : 'none';
      secondDivider.style.display = capturing || next.capture === 'none' ? 'none' : '';
    };
    overlay = {
      apply(next) {
        if (next.show !== undefined || next.pointers || next.report) { state.seen = Date.now(); if (!host.isConnected) document.documentElement.appendChild(host); }
        if (next.show) show(next.show);
        if (next.show === null) { state.binding = ''; state.mode = null; clearInterval(state.clock); bar.style.display = 'none'; frame.style.opacity = '0'; cursor.style.opacity = '0'; }
        if (next.pointers) point(next.pointers);
        if (next.report !== undefined && next.report !== state.report) { clearTimeout(state.reportTimer); state.reportTimer = 0; state.report = next.report; state.reported = 'null'; }
        if (next.conceal !== undefined) host.style.visibility = next.conceal ? 'hidden' : 'visible';
        if (next.cursor) move(next.cursor.x, next.cursor.y, next.cursor.type);
      },
      dispose() {
        cancelAnimationFrame(state.frame); clearTimeout(state.fade); clearInterval(expiry); clearInterval(state.clock); clearTimeout(state.reportTimer);
        for (const pointer of pointers.values()) cancelAnimationFrame(pointer.frame);
        document.removeEventListener('mousemove', hover, { capture: true });
        document.removeEventListener('mouseout', leave, { capture: true });
        document.removeEventListener('visibilitychange', leave);
        removeEventListener('pointerdown', take, { capture: true });
        removeEventListener('keydown', take, { capture: true });
        host.remove(); delete globalThis[key];
      },
    };
    globalThis[key] = overlay;
    document.documentElement.appendChild(host);
  }
  overlay.apply(command);
  return true;
}`;
