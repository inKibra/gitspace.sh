/**
 * Track-changes overlay, injected into the blog in dev by BlogPost.tsx.
 * Highlights unstaged edits inline on the rendered page and offers a review
 * panel: Accept stages the hunk via the :5191 server; Accept all clears.
 */
(() => {
  const S = 'http://localhost:5191';
  let marks = [];
  let panel = null;

  const CSS = `
    .tc-ins { background: rgba(0,255,102,.16); box-shadow: inset 0 -2px 0 rgba(0,255,102,.7); border-radius: 2px; }
    .tc-del { color: #ff8f8f; text-decoration: line-through; background: rgba(255,85,85,.1);
              border-radius: 2px; padding: 0 3px; margin-right: 4px; font-size: .92em; }
    .tc-hover { background: rgba(0,255,102,.3) !important; }
    @keyframes tc-flash {
      0%, 100% { background: rgba(0,255,102,.16); box-shadow: inset 0 -2px 0 rgba(0,255,102,.7); }
      20%, 60% { background: rgba(0,255,102,.5); box-shadow: 0 0 0 4px rgba(0,255,102,.55), 0 0 22px rgba(0,255,102,.5); }
      40%, 80% { background: rgba(0,255,102,.2); box-shadow: 0 0 0 2px rgba(0,255,102,.25); }
    }
    .tc-flash { animation: tc-flash 1.5s ease 1; }
    @keyframes tc-flash-del {
      0%, 100% { box-shadow: none; }
      20%, 60% { box-shadow: 0 0 0 3px rgba(255,85,85,.55), 0 0 16px rgba(255,85,85,.45); }
    }
    .tc-flash-del { animation: tc-flash-del 1.5s ease 1; }
    #tc-panel { position: fixed; right: 18px; bottom: 18px; width: 380px; max-height: 55vh; z-index: 99999;
                background: #050505; border: 1px solid #1a1a1a; color: #e6e6e6;
                font: 12px/1.6 ui-monospace, Menlo, monospace; display: flex; flex-direction: column; }
    #tc-panel header { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
                       border-bottom: 1px solid #1a1a1a; }
    #tc-panel header .dot { width: 9px; height: 9px; background: #00ff66; }
    #tc-panel header b { font-weight: 500; letter-spacing: .08em; }
    #tc-panel header button { margin-left: auto; }
    #tc-body { overflow-y: auto; padding: 6px 0; }
    .tc-item { padding: 9px 14px; border-bottom: 1px solid #111; cursor: pointer; }
    .tc-item:hover { background: #0a0a0a; }
    .tc-item .loc { color: #6a6a6a; font-size: 10.5px; margin-bottom: 3px; }
    .tc-item .del { color: #ff8f8f; text-decoration: line-through; display: block; }
    .tc-item .ins { color: #7dffb0; display: block; }
    .tc-item .row { display: flex; gap: 8px; margin-top: 6px; }
    #tc-panel button { background: #000; color: #e6e6e6; border: 1px solid #1a1a1a;
                       font: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer; }
    #tc-panel button:hover { background: #0f0f0f; }
    #tc-panel button.ok { background: #00ff66; color: #000; border-color: #00ff66; font-weight: 600; }
    .tc-empty { color: #6a6a6a; padding: 16px 14px; }
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ── DOM matching ─────────────────────────────────────────────────────── */

  const collectTextNodes = (rootEl) => {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('#tc-panel, script, style')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  };

  /** Find `needle` (whitespace-collapsed) across text nodes; returns node slices. */
  function findInDom(rootEl, needle) {
    if (!needle || needle.length < 4) return null;
    const nodes = collectTextNodes(rootEl);
    let all = '';
    const map = []; // index in `all` → [nodeIdx, offset]
    nodes.forEach((n, ni) => {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        all += t[i];
        map.push([ni, i]);
      }
    });
    let norm = '';
    const nmap = []; // index in `norm` → index in `all`
    let prevSpace = false;
    for (let i = 0; i < all.length; i++) {
      const c = /\s/.test(all[i]) ? ' ' : all[i];
      if (c === ' ' && prevSpace) continue;
      prevSpace = c === ' ';
      norm += c;
      nmap.push(i);
    }
    const idx = norm.indexOf(needle);
    if (idx < 0) return null;
    const a = map[nmap[idx]];
    const b = map[nmap[idx + needle.length - 1]];
    // build per-node slices [nodeIdx, from, toExclusive]
    const slices = [];
    for (let ni = a[0]; ni <= b[0]; ni++) {
      const from = ni === a[0] ? a[1] : 0;
      const to = ni === b[0] ? b[1] + 1 : nodes[ni].nodeValue.length;
      if (to > from) slices.push([nodes[ni], from, to]);
    }
    return slices;
  }

  function wrapSlice(node, from, to, cls, title) {
    const target = from > 0 ? node.splitText(from) : node;
    if (to - from < target.nodeValue.length) target.splitText(to - from);
    const span = document.createElement('span');
    span.className = cls;
    if (title) span.title = title;
    target.parentNode.replaceChild(span, target);
    span.appendChild(target);
    return span;
  }

  const unwrap = (span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  };

  function clearMarks() {
    marks.forEach(unwrap);
    document.querySelectorAll('.tc-del-chip').forEach((el) => el.remove());
    marks = [];
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  async function accept(id) {
    await fetch(S + '/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  async function acceptAll() {
    await fetch(S + '/accept-all', { method: 'POST' });
    refresh();
  }

  function render(changes) {
    clearMarks();
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'tc-panel';
    const header = document.createElement('header');
    header.innerHTML = `<span class="dot"></span><b>TRACK CHANGES · ${changes.length}</b>`;
    const allBtn = document.createElement('button');
    allBtn.className = 'ok';
    allBtn.textContent = 'Accept all';
    allBtn.onclick = acceptAll;
    header.appendChild(allBtn);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.id = 'tc-body';
    panel.appendChild(body);

    if (!changes.length) {
      body.innerHTML = '<div class="tc-empty">Clean. All changes accepted (staged). Commit to finalize.</div>';
    }

    const article = document.querySelector('article') || document.body;

    for (const c of changes) {
      // inline highlight where the inserted prose is findable on the page
      let firstMark = null;
      const changeSpans = [];
      const slices = c.insText ? findInDom(article, c.insText) : null;
      if (slices) {
        for (const [node, from, to] of slices) {
          const m = wrapSlice(node, from, to, 'tc-ins', c.delText ? 'was: ' + c.delText : 'inserted');
          marks.push(m);
          changeSpans.push(m);
          if (!firstMark) firstMark = m;
        }
        if (c.delText && firstMark) {
          const chip = document.createElement('span');
          chip.className = 'tc-del tc-del-chip';
          chip.textContent = c.delText.length > 70 ? c.delText.slice(0, 67) + '…' : c.delText;
          firstMark.parentNode.insertBefore(chip, firstMark);
          changeSpans.push(chip);
        }
      }

      // panel entry
      const item = document.createElement('div');
      item.className = 'tc-item';
      const loc = document.createElement('div');
      loc.className = 'loc';
      loc.textContent = `${c.file.split('/').pop()} · line ${c.line}${slices ? '' : ' · (not visible on page)'}`;
      item.appendChild(loc);
      if (c.delText) {
        const d = document.createElement('span');
        d.className = 'del';
        d.textContent = c.delText.length > 120 ? c.delText.slice(0, 117) + '…' : c.delText;
        item.appendChild(d);
      }
      if (c.insText) {
        const i2 = document.createElement('span');
        i2.className = 'ins';
        i2.textContent = c.insText.length > 120 ? c.insText.slice(0, 117) + '…' : c.insText;
        item.appendChild(i2);
      }
      const row = document.createElement('div');
      row.className = 'row';
      const ok = document.createElement('button');
      ok.className = 'ok';
      ok.textContent = 'Accept';
      ok.onclick = (e) => {
        e.stopPropagation();
        accept(c.id);
      };
      row.appendChild(ok);
      item.appendChild(row);
      if (firstMark) {
        const fm = firstMark;
        // click → scroll to the change and FLASH it; hover → soft highlight
        item.onclick = () => {
          fm.scrollIntoView({ behavior: 'smooth', block: 'center' });
          for (const s of changeSpans) {
            const cls = s.classList.contains('tc-del') ? 'tc-flash-del' : 'tc-flash';
            s.classList.remove(cls);
            void s.offsetWidth; // restart the animation
            s.classList.add(cls);
            setTimeout(() => s.classList.remove(cls), 1600);
          }
        };
        item.onmouseenter = () =>
          changeSpans.forEach((s) => !s.classList.contains('tc-del') && s.classList.add('tc-hover'));
        item.onmouseleave = () => changeSpans.forEach((s) => s.classList.remove('tc-hover'));
      }
      body.appendChild(item);
    }

    document.body.appendChild(panel);
  }

  async function refresh() {
    try {
      const changes = await (await fetch(S + '/changes')).json();
      render(changes);
    } catch {
      /* server not running; stay quiet */
    }
  }

  window.__tcCleanup = () => {
    clearMarks();
    if (panel) panel.remove();
    style.remove();
  };

  refresh();
})();
