/**
 * The in-page overlay on a tab of your Chrome while an agent uses it (docs/APERTURE-DESIGN.md §6.4): a floating
 * control at the bottom of the tab (the workspace group, what is happening, Stop), a glow in the group colour while a
 * script runs, and the agent's cursor at each point it clicks or moves to.
 *
 * A fixed function the extension calls in its own isolated world (`Runtime.callFunctionOn`), never in the page's. The
 * overlay leaves the page and what the agent reads alone: a closed shadow root under an `aria-hidden` host marked
 * `data-gitspace-overlay` (which the screenshot mask hides), styled inline only (no stylesheet a page's CSP could
 * refuse), nothing focusable, and pointer-transparent except the control while your own pointer is over it, so an
 * agent's clicks and hit tests reach the page. Stop calls the binding named in `show`, added to this world only.
 *
 * One argument: `{ show?: { mode: 'run' | 'step', name, color, binding }, cursor?: { x, y, type }, conceal?: boolean,
 * remove?: true }`. `show` installs the overlay where the document lacks it (after a navigation) and refreshes it; an
 * overlay not refreshed for 75 s removes itself, so one whose debugger channel Chrome dropped does not stay. The cursor
 * travels to each point along a curved path, eased, overshooting slightly and settling, in the time Fitts's law gives
 * a hand (260 + 170·log2(1 + d/22) ms); it presses on `mousePressed` and fades after 5 s idle.
 */
export const browserOverlayFunction = `function(command) {
  const key = '__gitspaceOverlay';
  if (command.remove) { if (globalThis[key]) globalThis[key].dispose(); return true; }
  let overlay = globalThis[key];
  if (!overlay && !command.show) return false;
  if (!overlay) {
    for (const stale of document.querySelectorAll('[data-gitspace-overlay]')) stale.remove();
    const make = (tag, css, parent) => { const el = document.createElement(tag); el.style.cssText = css; parent.appendChild(el); return el; };
    const host = document.createElement('div');
    host.setAttribute('data-gitspace-overlay', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483646;contain:layout style';
    const root = host.attachShadow({ mode: 'closed' });
    const font = 'font:500 12px/16px system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;';
    const glow = make('div', 'position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .4s ease', root);
    const pill = make('div', font + 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:5px 5px 5px 12px;border-radius:999px;background:rgba(17,19,24,.92);color:#f1f3f4;box-shadow:0 6px 20px rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);pointer-events:none;user-select:none;white-space:nowrap;transition:opacity .2s ease', root);
    const dot = make('span', 'width:8px;height:8px;border-radius:50%;flex:none', pill);
    const name = make('span', 'font-weight:600;overflow:hidden;text-overflow:ellipsis', pill);
    const what = make('span', 'color:#bdc1c6', pill);
    const stop = make('button', 'all:unset;' + font + 'cursor:pointer;padding:4px 12px;border-radius:999px;background:#d93025;color:#fff;font-weight:600', pill);
    stop.type = 'button'; stop.tabIndex = -1; stop.textContent = 'Stop';
    const cursor = make('div', 'position:fixed;left:0;top:0;pointer-events:none;opacity:0;transition:opacity .4s ease;will-change:transform', root);
    const svgns = 'http://www.w3.org/2000/svg';
    const arrow = document.createElementNS(svgns, 'svg');
    arrow.setAttribute('width', '20'); arrow.setAttribute('height', '22'); arrow.setAttribute('viewBox', '0 0 20 22');
    arrow.style.cssText = 'display:block;overflow:visible;transform-origin:2px 2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';
    const path = document.createElementNS(svgns, 'path');
    path.setAttribute('d', 'M2 2 L2 18 L6.6 14 L9.6 20.6 L12.4 19.4 L9.4 12.8 L15.6 12.8 Z');
    path.setAttribute('stroke', '#ffffff'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linejoin', 'round');
    arrow.appendChild(path); cursor.appendChild(arrow);
    const label = make('span', font + 'position:absolute;left:14px;top:18px;padding:1px 7px;border-radius:999px;color:#fff;font-size:11px;font-weight:600;white-space:nowrap', cursor);
    label.textContent = 'agent';
    const state = { x: null, y: null, target: null, frame: 0, fade: 0, side: 1, press: false, seen: Date.now(), binding: '' };
    const place = (x, y) => { state.x = x; state.y = y; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    const pressAt = () => {
      arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
      const ring = make('div', 'position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;pointer-events:none;border:2px solid ' + label.style.background, root);
      ring.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
      ring.animate([{ opacity: .7, scale: .3 }, { opacity: 0, scale: 1.4 }], { duration: 450, easing: 'ease-out' }).finished.then(() => ring.remove(), () => ring.remove());
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
    // Your own pointer over the control makes it clickable; the agent's pointer (each point it is about to use) never does.
    const hover = event => {
      const box = pill.getBoundingClientRect();
      const inside = event.clientX >= box.left - 4 && event.clientX <= box.right + 4 && event.clientY >= box.top - 4 && event.clientY <= box.bottom + 4;
      const agent = state.target && Math.abs(event.clientX - state.target[0]) < 1 && Math.abs(event.clientY - state.target[1]) < 1;
      pill.style.pointerEvents = inside && !agent ? 'auto' : 'none';
    };
    document.addEventListener('mousemove', hover, { capture: true, passive: true });
    // Nothing on the control reaches the page, and pressing it never moves focus out of the page.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) pill.addEventListener(type, event => { event.stopPropagation(); if (type !== 'click') event.preventDefault(); });
    stop.addEventListener('click', () => { const call = globalThis[state.binding]; if (typeof call === 'function') { call('stop'); what.textContent = 'Stopping…'; } });
    const expiry = setInterval(() => { if (Date.now() - state.seen > 75000) overlay.dispose(); }, 15000);
    overlay = {
      apply(next) {
        if (next.show) {
          state.seen = Date.now(); state.binding = next.show.binding;
          const color = next.show.color;
          dot.style.background = color; label.style.background = color; path.setAttribute('fill', color);
          pill.style.borderColor = color;
          glow.style.boxShadow = 'inset 0 0 0 2px ' + color + ', inset 0 0 28px 2px ' + color + '66';
          glow.style.opacity = next.show.mode === 'run' ? '1' : '0';
          name.textContent = 'GitSpace · ' + next.show.name;
          what.textContent = next.show.mode === 'run' ? 'Running a script' : 'Working';
          if (!host.isConnected) document.documentElement.appendChild(host);
        }
        if (next.conceal !== undefined) host.style.visibility = next.conceal ? 'hidden' : 'visible';
        if (next.cursor) move(next.cursor.x, next.cursor.y, next.cursor.type);
      },
      dispose() {
        cancelAnimationFrame(state.frame); clearTimeout(state.fade); clearInterval(expiry);
        document.removeEventListener('mousemove', hover, { capture: true });
        host.remove(); delete globalThis[key];
      },
    };
    globalThis[key] = overlay;
    document.documentElement.appendChild(host);
  }
  overlay.apply(command);
  return true;
}`;
