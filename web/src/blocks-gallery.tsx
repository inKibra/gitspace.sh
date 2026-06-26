import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { BlockView, BlockHostProvider, type BlockHost } from '../../src/blocks/render/index.web.js';

// A self-contained sample .gssh.html mini-app: listens for its data over
// postMessage and renders it. Runs in a sandboxed iframe (scripts only).
const MINI_APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:'JetBrains Mono',ui-monospace,monospace;background:#000;color:#d4d4d4;padding:12px}
  .t{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px}
  .tiles{display:flex;gap:8px;flex-wrap:wrap}
  .tile{border:1px solid #1a1a1a;padding:8px 10px;min-width:84px}
  .v{font-size:18px;color:#00ff66}.l{font-size:10px;color:#777;margin-top:2px}
</style></head><body>
  <div class="t">ops board · mini-app</div>
  <div class="tiles" id="tiles">waiting for data…</div>
  <script>
    window.addEventListener('message', function(e){
      if(!e.data || e.data.type!=='gssh:data') return;
      var tiles=(e.data.data&&e.data.data.tiles)||[];
      document.getElementById('tiles').innerHTML = tiles.map(function(t){
        return '<div class="tile"><div class="v">'+t.value+'</div><div class="l">'+t.label+'</div></div>';
      }).join('');
    });
  </script>
</body></html>`;

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,5 @@
 const x = 1;
-const y = 2;
+const y = 3;
 function f() {
   return x + y;
 }`;

const SAMPLES: { label: string; block: unknown }[] = [
  { label: 'message · user', block: { id: '1', type: 'message', data: { role: 'user', text: 'render one of each block please' } } },
  { label: 'message · assistant', block: { id: '2', type: 'message', data: { role: 'assistant', text: 'Here you go — **all ten** block types.\n\n- validated against zod\n- composed (tool-call nests blocks)\n- fallback-safe' } } },
  { label: 'thinking', block: { id: '3', type: 'thinking', data: { text: 'Pick a representative sample for each tier, then render through BlockView…' } } },
  { label: 'markdown', block: { id: '4', type: 'markdown', data: { text: '## Markdown\n\nProse with **bold**, `inline code`, and a [link](https://example.com).\n\n1. first\n2. second' } } },
  { label: 'callout', block: { id: '5', type: 'callout', data: { tone: 'warning', title: 'Heads up', text: 'Callouts highlight a single point.' } } },
  { label: 'code', block: { id: '6', type: 'code', data: { lang: 'ts', startLine: 1, text: 'const x = 1;\nfunction f() {\n  return x + 1;\n}' } } },
  { label: 'code-ref', block: { id: '7', type: 'code-ref', data: { path: 'src/effects/core.ts', lines: '12-14', startLine: 12, snippet: 'export function scramble() {\n  return run();\n}', note: 'reuse this pattern', exemplar: true } } },
  { label: 'data-structure', block: { id: '8', type: 'data-structure', data: { name: 'Block', lang: 'ts', fields: [{ name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'data', type: 'unknown', note: 'validated per type' }] } } },
  { label: 'diff · @pierre/diffs', block: { id: '9', type: 'diff', data: { file: 'src/a.ts', patch: PATCH } } },
  { label: 'file-tree · @pierre/trees', block: { id: '10', type: 'file-tree', data: { paths: ['src/index.ts', 'src/blocks/registry.ts', 'src/blocks/render/index.web.tsx', 'web/main.tsx'], gitStatus: [{ path: 'src/blocks/registry.ts', status: 'added' }, { path: 'web/main.tsx', status: 'modified' }] } } },
  { label: 'tool-call (composes nested blocks)', block: { id: '11', type: 'tool-call', data: { tool: 'edit', target: 'src/a.ts', status: 'done', meta: '+1 -1', result: [{ id: '11a', type: 'diff', data: { file: 'src/a.ts', patch: PATCH } }, { id: '11b', type: 'code', data: { text: 'bun test ✓ 13 pass' } }] } } },
  { label: 'subagent', block: { id: '12', type: 'subagent', data: { label: 'verify:haptics', model: 'sonnet-4.6', status: 'running', lines: ['attaching device-rig…', 'running 5 gates', '3/5 passed'] } } },
  { label: 'image', block: { id: '13', type: 'image', data: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='80'%3E%3Crect width='320' height='80' fill='%23080808'/%3E%3Cpolyline points='0,62 64,40 128,48 192,18 256,30 320,10' fill='none' stroke='%2300ff66' stroke-width='2'/%3E%3C/svg%3E", caption: 'share funnel · last 7d' } } },
  { label: 'verdict-chip', block: { id: '14', type: 'verdict-chip', data: { verdict: 'pass', label: 'no proxy traps', confidence: 'high' } } },
  { label: 'approval-gate (permission)', block: { id: '15', type: 'approval-gate', data: { tool: 'bash', detail: 'rm src/effects/b.ts  (delete the legacy copy)' } } },
  { label: 'hostui-dialog · select', block: { id: '16', type: 'hostui-dialog', data: { dialog: 'select', prompt: 'Which consumer should migrate first?', options: ['Editor', 'Preview', 'Share'] } } },
  { label: 'error (retryable)', block: { id: '17', type: 'error', data: { text: 'Anthropic stream error (api_error): Internal server error — retrying (2/3)…' } } },
  { label: 'checklist / todos', block: { id: 'cl', type: 'checklist', data: { title: 'review checklist', items: [{ text: 'no proxy traps introduced', done: true, evidence: 'verify:effects' }, { text: 'device test passes on rig', done: true }, { text: 'docs updated', done: false }] } } },
  { label: 'review-gate', block: { id: 'rg', type: 'review-gate', data: { label: 'advance to ship', status: 'pending', detail: 'All gates green. Approve to merge + roll up the workspace.' } } },
  { label: 'table', block: { id: 'tbl', type: 'table', data: { columns: ['consumer', 'status', 'owner'], rows: [['Editor', 'migrated', 'agent·main'], ['Preview', 'migrated', 'agent·main'], ['Share', 'pending', 'you']], caption: 'effects/core migration' } } },
  { label: 'evidence (captured · image)', block: { id: 'ev', type: 'evidence', data: { name: 'share-funnel.png', source: 'captured', meta: 'posthog · 7d', ref: { kind: 'image', mime: 'image/svg+xml', dataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='70'%3E%3Crect width='320' height='70' fill='%23000'/%3E%3Cpolyline points='0,55 64,35 128,42 192,16 256,26 320,8' fill='none' stroke='%2300ff66' stroke-width='2'/%3E%3C/svg%3E" } } } },
  { label: 'mermaid (diagram)', block: { id: 'mmd', type: 'mermaid', data: { title: 'effects consolidation', code: 'flowchart LR\n  E[Editor] --> C[effects core]\n  P[Preview] --> C\n  S[Share] -.->|legacy| B[b.ts]' } } },
  { label: 'mini-app (sandboxed .gssh.html)', block: { id: 'ma', type: 'mini-app', data: { name: 'ops-board.gssh.html', html: MINI_APP_HTML, height: 150, data: { tiles: [{ label: 'MRR', value: '$12.4k' }, { label: 'Signups', value: '318' }, { label: 'Churn', value: '2.1%' }] } } } },
  { label: 'unknown type → markdown fallback', block: { id: '18', type: 'mystery-block', data: { text: 'Unsupported types **degrade to markdown** instead of disappearing.' } } },
  { label: 'invalid data → loud error', block: { id: '19', type: 'message', data: { role: 'robot', text: 'bad role' } } },
];

function Gallery() {
  const [log, setLog] = useState<string[]>([]);
  const push = (line: string) => setLog((l) => [line, ...l].slice(0, 8));
  const host: BlockHost = {
    readOnly: false,
    resolve: (blockId, response) => push(`resolve(${blockId}) → ${JSON.stringify(response)}`),
    dispatch: (action) => push(`dispatch ${JSON.stringify(action)}`),
  };
  return (
    <div style={{
      height: '100vh', overflowY: 'auto', background: 'var(--gs-bg)', color: 'var(--gs-text)', padding: '24px',
      // clean fonts: Inter for UI/prose, JetBrains Mono for code (scoped via --gs-font)
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontFeatureSettings: '"cv01", "ss03"', letterSpacing: '-0.003em',
      ['--gs-font' as string]: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace",
    } as CSSProperties}>
      <BlockHostProvider host={host}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <h1 style={{ fontSize: 16, margin: 0 }}>Block Registry — render gallery</h1>
          <div style={{ fontSize: 12, color: 'var(--gs-text-muted)', margin: '4px 0 20px' }}>
            one of each registered block, via <code>BlockView</code> (validate → render). interactive blocks route through a live block host.
          </div>
          {SAMPLES.map((s, i) => (
            <section key={i} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gs-text-dim)', marginBottom: 4 }}>{s.label}</div>
              <BlockView block={s.block} />
            </section>
          ))}
        </div>
      </BlockHostProvider>
      {log.length > 0 && (
        <div style={{ position: 'fixed', bottom: 12, right: 12, width: 340, background: 'var(--gs-bg-elevated)', border: '1px solid var(--gs-border-active)', padding: 8, fontSize: 10, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: 'var(--gs-text-muted)', zIndex: 10 }}>
          <div style={{ color: 'var(--gs-accent)', marginBottom: 4 }}>block host · actions</div>
          {log.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Gallery />);
