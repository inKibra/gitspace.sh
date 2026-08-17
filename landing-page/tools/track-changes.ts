/**
 * Track-changes for the blog, as an overlay on the REAL rendered page.
 *
 *   bun tools/track-changes.ts     (this server, :5191)
 *   bun run dev                    (the blog, :5180)
 *
 * BlogPost.tsx injects /overlay.js in dev. The overlay highlights unstaged
 * edits inline on the page (insertions green, deletions red) with a review
 * panel. Baseline is the GIT INDEX:
 *   Accept a change  → stages that hunk (disappears from the overlay)
 *   Accept all       → git add (clears the overlay)
 *   Commit           → finalizes everything accepted
 * A raw word-diff view stays at http://localhost:5191/.
 */

const FILES = ['src/episodes'];

const root = new URL('..', import.meta.url).pathname;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', ...args], { cwd: root });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
};

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const stripJsx = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ') // tags
    .replace(/\{[^}]*\}/g, ' ') // jsx expressions
    .replace(/\s+/g, ' ')
    .trim();

interface Change {
  id: string;
  file: string;
  line: number;
  patch: string; // single-hunk patch, applies with git apply --cached
  delText: string; // plain prose of removed lines
  insText: string; // plain prose of added lines
}

/** Parse `git diff -U3` (worktree vs index) into single-hunk changes. */
function collectChanges(): Change[] {
  const { out } = git('diff', '-U3', '--', ...FILES);
  const changes: Change[] = [];
  let file = '';
  let fileHeader: string[] = [];
  let hunkLines: string[] | null = null;
  let hunkStart = 0;

  const flush = () => {
    if (!hunkLines || !file) return;
    const patch = [...fileHeader, ...hunkLines].join('\n') + '\n';
    const delText = stripJsx(
      hunkLines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)).join(' '),
    );
    const insText = stripJsx(
      hunkLines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join(' '),
    );
    changes.push({ id: `${file}@${hash(patch)}`, file, line: hunkStart, patch, delText, insText });
    hunkLines = null;
  };

  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
      file = line.split(' b/').pop() ?? '';
      fileHeader = [line];
    } else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      fileHeader.push(line);
    } else if (line.startsWith('@@')) {
      flush();
      hunkStart = Number(line.match(/\+(\d+)/)?.[1] ?? 0);
      hunkLines = [line];
    } else if (hunkLines && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
      if (line !== '' || hunkLines.length > 0) hunkLines.push(line);
    }
  }
  flush();
  return changes;
}

// raw fallback view (word-diff vs index)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rawView(): string {
  const { out } = git('diff', '--word-diff=porcelain', '--unified=1', '--', ...FILES);
  if (!out.trim()) return '<div class="empty">No unstaged changes. The overlay on the blog is clear too.</div>';
  const parts: string[] = [];
  let open = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (open) parts.push('</div>');
      open = false;
      parts.push(`<h2>${esc(line.split(' b/').pop() ?? '')}</h2>`);
    } else if (line.startsWith('@@')) {
      if (open) parts.push('</div>');
      parts.push(`<div class="hunk"><span class="ln">line ${line.match(/\+(\d+)/)?.[1] ?? '?'}</span>`);
      open = true;
    } else if (line === '~') {
      if (open) parts.push('<br/>');
    } else if (line.startsWith('+') && open) parts.push(`<ins>${esc(line.slice(1))}</ins>`);
    else if (line.startsWith('-') && open) parts.push(`<del>${esc(line.slice(1))}</del>`);
    else if (line.startsWith(' ') && open) parts.push(`<span>${esc(line.slice(1))}</span>`);
  }
  if (open) parts.push('</div>');
  return parts.join('');
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Blog · track changes (raw)</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#000; color:#e6e6e6; font-family:ui-monospace,Menlo,monospace; padding:34px 44px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:26px; }
  header .block { width:11px; height:19px; background:#00ff66; }
  h1 { font-size:14px; font-weight:500; letter-spacing:.1em; }
  .sub { color:#6a6a6a; font-size:12px; margin-left:auto; }
  h2 { font-size:12px; letter-spacing:.14em; color:#00ff66; margin:30px 0 10px; text-transform:uppercase; }
  .hunk { border:1px solid #1a1a1a; border-left:3px solid #333; background:#080808;
          padding:14px 18px; margin-bottom:10px; font-size:14.5px; line-height:1.85; word-break:break-word; }
  .ln { display:block; color:#3a3a3a; font-size:11px; margin-bottom:8px; }
  ins { background:rgba(0,255,102,.14); color:#7dffb0; text-decoration:none; padding:1px 2px; }
  del { background:rgba(255,85,85,.12); color:#ff8f8f; text-decoration:line-through; padding:1px 2px; }
  span { color:#9c9c9c; }
  .empty { color:#6a6a6a; padding:40px 0; }
</style></head>
<body>
<header><div class="block"></div><h1>BLOG · TRACK CHANGES <span style="color:#6a6a6a">raw view · overlay lives on the blog itself</span></h1>
<div class="sub">accept on the blog page · commit = finalize</div></header>
<div id="diff"></div>
<script>
  async function refresh(){ document.getElementById('diff').innerHTML = await (await fetch('/diff')).text(); }
  refresh(); setInterval(refresh, 1500);
</script>
</body></html>`;

Bun.serve({
  port: 5191,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (p === '/overlay.js') {
      return new Response(Bun.file(new URL('./overlay.js', import.meta.url).pathname), {
        headers: { ...CORS, 'content-type': 'text/javascript' },
      });
    }
    if (p === '/changes') {
      return Response.json(collectChanges(), { headers: CORS });
    }
    if (p === '/accept' && req.method === 'POST') {
      const { id } = (await req.json()) as { id: string };
      const change = collectChanges().find((c) => c.id === id);
      if (!change) return Response.json({ ok: false, error: 'stale change id' }, { headers: CORS });
      const proc = Bun.spawnSync(['git', 'apply', '--cached', '--whitespace=nowarn', '-'], {
        cwd: root,
        stdin: new TextEncoder().encode(change.patch),
      });
      return Response.json(
        { ok: proc.exitCode === 0, error: proc.stderr.toString() || undefined },
        { headers: CORS },
      );
    }
    if (p === '/accept-all' && req.method === 'POST') {
      const r = git('add', '--', ...FILES);
      return Response.json({ ok: r.ok, error: r.ok ? undefined : r.err }, { headers: CORS });
    }
    if (p === '/diff') return new Response(rawView(), { headers: { ...CORS, 'content-type': 'text/html' } });
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
  },
});

console.log('track changes → overlay on http://localhost:5180/notes/babysitting-agents-sucks (raw: http://localhost:5191)');
