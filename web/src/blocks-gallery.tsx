import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { BlockView, BlockHostProvider, listRendererTypes, type BlockHost } from '../../src/blocks/render/index.web.js';
import { listBlockTypes } from '../../src/blocks/index.js';

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

// Long enough to exercise the tool-call scroll policy rather than growing the
// transcript without bound.
const LONG_LOG = Array.from({ length: 60 }, (_, i) =>
  `[${String(i).padStart(3, '0')}] src/blocks/agent/__tests__/message-blocks.test.ts > tool-call > case ${i} ... ok`,
).join('\n');

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

  // ── goal-doc planning vocabulary ──────────────────────────────────────────
  { label: 'intent', block: { id: 'in', type: 'intent', data: { quote: 'I want to look and make sure project crons are working.', source: 'pre-merge review', why: 'Crons are the last unverified surface before the branch merges.' } } },
  { label: 'boundaries', block: { id: 'bd', type: 'boundaries', data: { items: [{ surface: 'src/lib/tmux-lite/artifact-share.ts', rule: 'svg stays text/plain — XSS defense, not drift' }, { surface: 'relay E2E protocol', rule: 'no changes without an explicit protocol ticket' }] } } },
  { label: 'anti-shortcut', block: { id: 'as', type: 'anti-shortcut', data: { items: [{ shortcut: 'Mark the cron test green by asserting the scheduler list is non-empty', why: 'Proves discovery ran, not that a trigger fired, completed, and survived restart.' }, { shortcut: 'Loosen the workflow schema until existing specs pass', why: 'Removes the validator that catches the drift instead of fixing the drift.' }] } } },
  { label: 'plan', block: { id: 'pl', type: 'plan', data: { steps: [{ title: 'Unify the workflow validator', detail: 'Parse against the canonical Zod schema instead of casting.', refs: ['src/core/goal-workflow.ts:57-75', 'src/blocks/types/content.ts:326-338'] }, { title: 'Surface field-level issues', detail: 'Report Zod issue paths from space workflow validate.', refs: ['src/commands/space-workflow.ts:12-35'] }, { title: 'Add the drift sentinel', detail: 'Validate every fenced JSON example in SKILL.md against the schema.', refs: ['src/lib/tmux-lite/agents/skills/space-artifacts/SKILL.md:209-228'] }] } } },
  { label: 'evidence-shape', block: { id: 'es', type: 'evidence-shape', data: { items: [{ requirement: 'Project crons fire and record a run', kind: 'test', captured: 'cron-scope-restart.test.ts — run log transitions to ok' }, { requirement: 'Audio artifacts play', kind: 'screenshot', captured: 'rubric requirement view with an audio player' }, { requirement: 'Workflow drift is caught', kind: 'command', captured: 'space workflow validate --json reports field-level issues' }] } } },
  { label: 'workflow (recipe traversal)', block: { id: 'wf', type: 'workflow', data: { recipe: 'audit → fix → verify', recipePath: '.gitspace/recipes/pre-merge.recipe.md', rollup: ['pre-merge fixes'], phases: [{ name: 'audit', slices: ['scope'], inputs: [{ name: 'branch diff', io: 'source' }], created: [{ name: 'audit notes', type: 'note', from: 'audit', sliceId: 'scope' }], nodes: [{ id: 'a1', agent: 'explore', kind: 'agent', status: 'done', reads: [{ name: 'branch diff', io: 'source' }], writes: [{ name: 'audit notes', io: 'artifact' }] }], outputs: [{ name: 'audit notes', kind: 'note', io: 'artifact', required: true, status: 'created' }] }, { name: 'fix', inputs: [{ name: 'audit notes', io: 'artifact' }], gate: { type: 'human', label: 'approve plan' }, nodes: [{ id: 'f1', agent: 'task', modelRole: 'pi/task', kind: 'agent', status: 'running', reads: [{ name: 'audit notes', io: 'artifact' }], writes: [{ name: 'patch', io: 'artifact' }] }, { id: 'f2', kind: 'gate', gateType: 'human', status: 'pending' }], outputs: [{ name: 'patch', kind: 'evidence', io: 'artifact', required: true, status: 'pending' }] }] } } },

  // ── tool-call variants (complete args/details + scroll policy) ─────────────
  { label: 'tool-call · retain (structured args, previously invisible)', block: { id: 'tc-ret', type: 'tool-call', data: { tool: 'retain', target: '2 items', status: 'done', args: { items: [{ content: 'The block gallery lives at web/blocks-gallery.html', context: 'pre-merge audit' }, { content: 'ArtifactPanel reads through the chunked ranged reader', context: 'pre-merge audit' }] }, details: { count: 2 }, result: [{ id: 'tc-ret-r', type: 'code', data: { text: '2 memories stored.' } }] } } },
  { label: 'tool-call · recall (full query)', block: { id: 'tc-rec', type: 'tool-call', data: { tool: 'recall', target: 'cron scope', status: 'done', args: { query: 'how are project-scoped triggers discovered by the scheduler' }, result: [{ id: 'tc-rec-r', type: 'code', data: { text: '3 memories matched.' } }] } } },
  { label: 'tool-call · long output (scrolls, does not grow)', block: { id: 'tc-long', type: 'tool-call', data: { tool: 'bash', target: 'bun test', status: 'done', meta: '60 lines', args: { command: 'bun test src/blocks' }, result: [{ id: 'tc-long-r', type: 'code', data: { text: LONG_LOG } }] } } },
  { label: 'tool-call · running', block: { id: 'tc-run', type: 'tool-call', data: { tool: 'grep', target: 'triggers/', status: 'running', args: { pattern: 'triggers/', path: 'src' } } } },
  { label: 'tool-call · error', block: { id: 'tc-err', type: 'tool-call', data: { tool: 'read', target: 'src/missing.ts', status: 'error', args: { path: 'src/missing.ts' }, result: [{ id: 'tc-err-r', type: 'error', data: { text: 'ENOENT: no such file or directory' } }] } } },
  { label: 'tool-call · legacy (no args/details)', block: { id: 'tc-old', type: 'tool-call', data: { tool: 'write', target: 'src/a.ts', status: 'done', meta: '+12' } } },
  { label: 'unknown type → markdown fallback', block: { id: '18', type: 'mystery-block', data: { text: 'Unsupported types **degrade to markdown** instead of disappearing.' } } },
  { label: 'invalid data → loud error', block: { id: '19', type: 'message', data: { role: 'robot', text: 'bad role' } } },
];

/**
 * Self-reported coverage. The schema registry is the vocabulary; a type is only
 * genuinely shippable once it also has a web renderer and a fixture here. A
 * missing renderer otherwise only shows up as the unsupported-block fallback at
 * render time, in whichever surface happens to hit it first.
 *
 * This lives in the gallery rather than a test because importing the full web
 * renderer index outside the web build pulls @pierre/diffs, mermaid, and
 * friends (see the note in src/blocks/render/__tests__/BlockView.web.test.tsx).
 */
function coverageGaps(): { missingRenderer: string[]; missingFixture: string[]; orphanRenderer: string[] } {
  const schemaTypes = listBlockTypes();
  const rendererTypes = new Set(listRendererTypes());
  const fixtureTypes = new Set(
    SAMPLES.map((s) => (s.block as { type?: string } | null)?.type).filter((t): t is string => typeof t === 'string'),
  );
  return {
    missingRenderer: schemaTypes.filter((t) => !rendererTypes.has(t)),
    missingFixture: schemaTypes.filter((t) => !fixtureTypes.has(t)),
    orphanRenderer: [...rendererTypes].filter((t) => !schemaTypes.includes(t)),
  };
}

function CoverageBanner() {
  const { missingRenderer, missingFixture, orphanRenderer } = coverageGaps();
  const total = listBlockTypes().length;
  const clean = missingRenderer.length === 0 && missingFixture.length === 0 && orphanRenderer.length === 0;
  const rows: { label: string; types: string[] }[] = [
    { label: 'registered but no web renderer', types: missingRenderer },
    { label: 'registered but no fixture below', types: missingFixture },
    { label: 'renderer with no registered schema', types: orphanRenderer },
  ].filter((r) => r.types.length > 0);

  return (
    <div style={{
      border: `1px solid ${clean ? 'var(--gs-border)' : 'var(--gs-danger)'}`,
      background: clean ? 'var(--gs-bg-elevated)' : 'rgba(255,51,51,0.06)',
      padding: '8px 10px', marginBottom: 20, fontSize: 11,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      color: clean ? 'var(--gs-text-muted)' : 'var(--gs-danger)',
    }}>
      {clean
        ? `coverage ok · ${total} registered block types, each with a renderer and a fixture`
        : rows.map((r) => (
          <div key={r.label} style={{ marginBottom: 2 }}>{r.label}: {r.types.join(', ')}</div>
        ))}
    </div>
  );
}

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
          <div style={{ fontSize: 12, color: 'var(--gs-text-muted)', margin: '4px 0 12px' }}>
            one of each registered block, via <code>BlockView</code> (validate → render). interactive blocks route through a live block host.
          </div>
          <CoverageBanner />
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
