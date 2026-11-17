import { describe, expect, it } from 'bun:test';
import { blockMarkdown, decisionMarkdown, evidenceMarkdown, guideSectionMarkdown, requirementMarkdown } from '../src/block-markdown.js';
import type { EvidenceReference, JournalEntryView } from '../src/inspector-contract.js';
import { extractBlocks, fenceSpec, gitspaceUiCatalog } from '../src/gitspace-ui.js';

const fence = '```';

/** A one-element spec of `type` with `props`. */
function one(type: string, props: Record<string, unknown>): Record<string, unknown> {
  return { root: 'block', elements: { block: { type, props, children: [] } }, state: {} };
}

/** A spec whose root `type` holds Text children reading `texts`. */
function holding(type: string, props: Record<string, unknown>, texts: readonly string[]): Record<string, unknown> {
  const children = texts.map((_, index) => `child${index}`);
  return { root: 'block', elements: { block: { type, props, children }, ...Object.fromEntries(texts.map((text, index) => [`child${index}`, { type: 'Text', props: { text }, children: [] }])) }, state: {} };
}

/** Each catalog component: a spec of it and what its Markdown holds. */
const CASES: Record<keyof typeof gitspaceUiCatalog.components, { spec: Record<string, unknown>; holds: readonly string[] }> = {
  Card: { spec: holding('Card', { title: 'Cache plan', description: 'Two steps', eyebrow: 'Plan' }, ['first child', 'second child']), holds: ['Plan', '**Cache plan**', 'Two steps', 'first child\n\nsecond child'] },
  Stack: { spec: holding('Stack', {}, ['top', 'bottom']), holds: ['top\n\nbottom'] },
  Row: { spec: holding('Row', {}, ['left', 'right']), holds: ['left\n\nright'] },
  Text: { spec: one('Text', { text: 'Heading', size: 'title' }), holds: ['**Heading**'] },
  Markdown: { spec: one('Markdown', { content: 'Some *emphasis*' }), holds: ['Some *emphasis*'] },
  Badge: { spec: one('Badge', { label: 'stale' }), holds: ['**stale**'] },
  Table: {
    spec: one('Table', { columns: [{ key: 'store', label: 'Store' }, { key: 'read', label: 'Read', align: 'right' }], rows: [{ store: 'KV | edge', read: '4 ms' }, { store: 'D1', read: 19 }], caption: 'Reads' }),
    holds: ['**Reads**', '| Store | Read |\n| --- | ---: |\n| KV \\| edge | 4 ms |\n| D1 | 19 |'],
  },
  Stats: { spec: one('Stats', { tiles: [{ label: 'p50', value: '1.8 s', detail: 'was 3.1 s', tone: 'good' }] }), holds: ['- **p50:** 1.8 s (was 3.1 s)'] },
  Chart: {
    spec: one('Chart', { title: 'Memory', unit: 'bytes', series: [{ key: 'held', label: 'Held', color: 'blue' }], rows: [{ label: 'turn 1', values: { held: 8388608 } }, { label: 'turn 2', values: {} }] }),
    holds: ['**Memory**', '|  | Held |', '| turn 1 | 8 MB |', '| turn 2 | – |'],
  },
  Checklist: {
    spec: { root: 'list', elements: { list: { type: 'Checklist', props: { title: 'Release' }, repeat: { statePath: '/checks', key: 'id' }, children: ['item'] }, item: { type: 'ChecklistItem', props: { index: { $index: true }, label: { $item: 'label' }, checked: { $bindItem: 'done' }, note: { $item: 'note' } }, children: [] } }, state: { checks: [{ id: 'a', label: 'Suites pass', done: true, note: '826 tests' }, { id: 'b', label: 'Smoke run', done: false }] } },
    holds: ['**Release**', '- [x] Suites pass — 826 tests\n- [ ] Smoke run'],
  },
  ChecklistItem: { spec: one('ChecklistItem', { index: 0, label: 'Deploy', checked: false, note: 'after 02:30' }), holds: ['- [ ] Deploy — after 02:30'] },
  Steps: { spec: one('Steps', { steps: [{ title: 'Push', detail: 'to develop' }, { title: 'Launch', detail: 'the build', where: 'scripts/launch.ts' }], active: 0 }), holds: ['1. **Push**: to develop', '2. **Launch**: the build (`scripts/launch.ts`)'] },
  Switch: { spec: one('Switch', { label: 'Dark mode', checked: true }), holds: ['- [x] Dark mode'] },
  Segmented: { spec: one('Segmented', { options: [{ value: 'a', label: 'Day' }, { value: 'b', label: 'Week' }], value: 'b' }), holds: ['Day · **Week**'] },
  RadioGroup: { spec: one('RadioGroup', { label: 'Cache', options: [{ value: 'kv', label: 'KV', description: 'cheap' }, { value: 'do', label: 'DO' }], value: 'do' }), holds: ['**Cache**', '- [ ] KV — cheap\n- [x] DO'] },
  TextField: { spec: one('TextField', { label: 'Name', value: 'Shelf' }), holds: ['**Name:** Shelf'] },
  Button: { spec: { root: 'card', elements: { card: { type: 'Card', props: { title: 'Pick' }, children: ['note'], slots: { footer: ['send'] } }, note: { type: 'Text', props: { text: 'Choose one.' }, children: [] }, send: { type: 'Button', props: { label: 'Send' }, children: [] } }, state: {} }, holds: ['**Pick**\n\nChoose one.'] },
  Diff: { spec: one('Diff', { patch: 'diff --git a/x.ts b/x.ts\n-old\n+new', title: 'x.ts' }), holds: ['**x.ts**', '```diff\ndiff --git a/x.ts b/x.ts\n-old\n+new\n```'] },
  CodeExcerpt: { spec: one('CodeExcerpt', { path: 'src/cache.ts', startLine: 10, lines: ['const a = 1;', 'const b = 2;'], commit: 'abcdef1234', highlight: [11], note: 'b is new' }), holds: ['`src/cache.ts` lines 10–11 at abcdef1', '```ts\nconst a = 1;\nconst b = 2;\n```', 'Marked: line 11', 'b is new'] },
  CommandRun: { spec: one('CommandRun', { command: 'bun test', exitCode: 1, durationMs: 2400, output: 'fail: one', truncated: true }), holds: ['`bun test`: exit 1 (failed) in 2.4 s', '```text\nfail: one\n```', 'the end of a longer output'] },
  TestReport: {
    spec: one('TestReport', { runner: 'vitest', passed: 10, failed: 1, skipped: null, durationMs: 900, failures: [{ name: 'adds', file: 'a.test.ts', message: 'expected 2\nreceived 3' }], flaky: ['retries'], note: 'one flaky' }),
    holds: ['**Tests (vitest):** 10 passed, 1 failed in 900 ms', '- **adds** (`a.test.ts`): expected 2\n  received 3', 'Flaky: retries', 'one flaky'],
  },
  ChangeSet: {
    spec: one('ChangeSet', { base: 'main', files: [{ path: 'a/x.ts', added: 3, removed: 1, status: 'modified' }, { path: 'README.md', added: 1, removed: 0, status: 'added' }], groups: [{ name: 'a', paths: ['a/x.ts'] }] }),
    holds: ['**Changes** against `main`: 2 files, +4 −1', '**a**\n- `a/x.ts` +3 −1 (modified)', '**Other**\n- `README.md` +1 −0 (added)'],
  },
  RunTag: { spec: one('RunTag', { commit: '4f2c9a1', machine: 'lab', sample: 'n=20', label: 'bench' }), holds: ['_4f2c9a1 · lab · n=20: bench_'] },
  BeforeAfter: { spec: one('BeforeAfter', { before: { label: 'Before', body: 'a bubble' }, after: { label: 'After', title: 'A notice', body: 'a row' } }), holds: ['**Before**\n\na bubble', '**After: A notice**\n\na row'] },
  AskCard: {
    spec: one('AskCard', { questionId: 'q', question: 'Which cache?', prompt: 'We need **one**.', options: [{ value: 'kv', label: 'KV', description: 'cheap' }, { value: 'do', label: 'DO' }], value: '' }),
    holds: ['**Which cache?**', 'We need **one**.', '- KV — cheap\n- DO'],
  },
  Svg: { spec: one('Svg', { svg: '<svg viewBox="0 0 4 4"><title>Request path</title><rect width="4" height="4"/></svg>' }), holds: ['(diagram) Request path'] },
  Mermaid: { spec: one('Mermaid', { source: 'flowchart LR\n  a --> b' }), holds: ['```mermaid\nflowchart LR\n  a --> b\n```'] },
  FlowMap: {
    spec: one('FlowMap', { areas: [{ id: 'w', name: 'Worker', group: 'api' }, { id: 'c', name: 'Cache', group: 'api' }], paths: [{ id: 'p', from: 'w', to: 'c', label: 'get', state: 'added' }], steps: [{ paths: ['p'], from: 'w', to: 'c', caption: 'The worker reads the cache.' }] }),
    holds: ['1. **Worker** → **Cache**: The worker reads the cache.'],
  },
  Roadmap: {
    spec: one('Roadmap', { phases: [{ title: 'Now', status: 'active', when: 'v2', note: 'reminders', items: [{ label: 'Claim', status: 'done', refs: [{ pr: 12 }] }, { label: 'Digest', status: 'needs-you', decide: { question: 'Daily?', options: ['yes', 'no'] } }] }] }),
    holds: ['**Now** (active, v2): reminders', '- [x] Claim: PR #12', '- [ ] Digest (needs-you); decide: Daily? (yes / no)'],
  },
  CallDiff: {
    spec: one('CallDiff', { title: 'Reads', language: 'ts', lines: [{ depth: 0, code: 'reply(req)', change: 'same' }, { depth: 1, code: 'kv.get(key)', change: 'removed' }, { depth: 1, code: 'cache.get(key)', change: 'added', note: 'strong' }] }),
    holds: ['**Reads**', '```diff\n  reply(req)\n-   kv.get(key)\n+   cache.get(key)  # strong\n```'],
  },
  StateFlow: {
    spec: one('StateFlow', { services: [{ id: 'w', name: 'Worker' }, { id: 'c', name: 'Cache' }], steps: [{ from: 'w', to: 'c', label: 'get(key)', change: 'added', caption: 'Reads go to the cache.', sets: [{ service: 'c', key: 'hits', value: '1' }] }, { from: 'c', to: 'w', label: 'reply', caption: 'It answers.' }] }),
    holds: ['1. **Worker** → **Cache**: `get(key)` (added). Reads go to the cache. Sets Cache.hits = 1.', '2. **Cache** → **Worker**: `reply`. It answers.'],
  },
  MetricDelta: {
    spec: one('MetricDelta', { metrics: [{ label: 'p95', before: 4400, after: 2600, unit: 'ms', better: 'lower' }, { label: 'Hit rate', before: 50, after: 40, unit: 'percent', better: 'higher' }] }),
    holds: ['| Metric | Before | After | Change |', '| p95 | 4.4 s | 2.6 s | -40.91% (better) |', '| Hit rate | 50% | 40% | -20% (worse) |'],
  },
  LogTable: { spec: one('LogTable', { title: 'Errors', lines: [{ at: '09:12', level: 'error', source: 'api', text: 'timeout', repeat: 3, highlight: true }, { level: 'info', text: 'retry' }] }), holds: ['**Errors**', '```text\n> 09:12 ERROR [api] timeout (×3)\n  INFO retry\n```'] },
  Timeline: {
    spec: one('Timeline', { title: 'Deploy', events: [{ at: '2026-11-16T09:20:00Z', kind: 'error', label: '5xx spike', detail: 'from the cache' }, { at: '2026-11-16T09:12:00Z', kind: 'deploy', label: 'v41 live' }] }),
    holds: ['**Deploy**', '- **2026-11-16T09:12:00Z** deploy: v41 live\n- **2026-11-16T09:20:00Z** error: 5xx spike. from the cache'],
  },
  Tradeoffs: {
    spec: one('Tradeoffs', { question: 'Where do replies live?', options: [{ id: 'kv', label: 'KV' }, { id: 'do', label: 'Durable Object' }], criteria: [{ label: 'Consistency', scores: [1, 3], note: 'reads after writes' }, { label: 'Cost', scores: [3, 2] }], recommended: 'do', note: 'Scores are my judgement.' }),
    holds: ['**Where do replies live?**', '|  | KV | Durable Object (recommended) |', '| Consistency (reads after writes) | 1/3 | 3/3 |', '| Cost | 3/3 | 2/3 |', 'Recommended: **Durable Object**', 'Scores are my judgement.'],
  },
  CheckGrid: { spec: one('CheckGrid', { title: 'CI', columns: ['linux', 'mac'], rows: [{ label: 'unit', cells: ['pass', 'fail'] }] }), holds: ['**CI**', '|  | linux | mac |', '| unit | pass | fail |'] },
  SchemaDiff: {
    spec: one('SchemaDiff', { tables: [{ name: 'loans', change: 'changed', rows: '84k rows', cost: 'lock', columns: [{ name: 'id', type: 'uuid', change: 'same', key: 'primary' }, { name: 'reminded_at', type: 'timestamptz', change: 'added', nullable: true }, { name: 'due', type: 'date', change: 'changed', typeFrom: 'text', renamedFrom: 'due_on' }, { name: 'legacy', type: 'int', change: 'removed' }], indexes: [{ name: 'loans_due_idx', columns: ['due'], change: 'added' }] }] }),
    holds: ['**loans** (changed, 84k rows, cost: lock)', '- added `reminded_at` timestamptz (nullable)', '- changed `due` text → date (renamed from `due_on`)', '- removed `legacy` int', '- added index `loans_due_idx` (due)'],
  },
  WorkspaceGraph: { spec: one('WorkspaceGraph', { workspaces: [{ workspace: 'api' }, { workspace: 'web', dependsOn: ['api'], note: 'waits for the API' }] }), holds: ['- `api`\n- `web`, depends on `api`: waits for the API'] },
  Rank: { spec: one('Rank', { question: 'What first?', items: [{ id: 'a', label: 'Digest' }, { id: 'b', label: 'SMS' }] }), holds: ['**What first?**', '1. Digest\n2. SMS'] },
  Budget: { spec: one('Budget', { label: 'Inference', unit: 'usd', limit: 10, days: [{ day: 'Mon', used: 2.5 }, { day: 'Tue', used: 4 }] }), holds: ['**Inference:** $6.5 of $10 used, $3.5 left', '| Mon | $2.5 |'] },
  BlockRef: {
    spec: { root: 'card', elements: { card: { type: 'Card', props: { title: 'Again' }, children: ['ref', 'tile'] }, ref: { type: 'BlockRef', props: { id: 'numbers' }, children: [] }, tile: { type: 'Stats', id: 'numbers', props: { tiles: [{ label: 'Hits', value: 9 }] }, children: [] } }, state: {} },
    holds: ['**Again**', '- **Hits:** 9\n\n- **Hits:** 9'],
  },
  Image: { spec: one('Image', { src: 'drive://workspace/shot.png', alt: 'The board', caption: 'After the fix' }), holds: ['![The board](drive://workspace/shot.png)', '_After the fix_'] },
  Video: { spec: one('Video', { src: 'capture:run-1', alt: 'The replay' }), holds: ['[Video: The replay](capture:run-1)'] },
  Sequence: {
    spec: one('Sequence', { title: 'Fix', frames: [{ content: { type: 'Markdown', props: { content: '**Cached**.' }, children: [] }, say: 'Replies are cached now.' }, { content: { ref: 'elsewhere' }, caption: 'Reads hit it first.' }] }),
    holds: ['**Fix**', '**1.**\n\n**Cached**.\n\n> Replies are cached now.', '**2.**\n\n_(block "elsewhere")_\n\n> Reads hit it first.'],
  },
  Reply: { spec: one('Reply', { comment: 'cm-0123456789ab', quote: 'the p95 tile', text: 'p95 of 20 runs.' }), holds: ['> the p95 tile\n\np95 of 20 runs.'] },
};

describe('blockMarkdown', () => {
  it('writes every catalog component as Markdown holding its content', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(gitspaceUiCatalog.components).sort());
    for (const [component, { spec, holds }] of Object.entries(CASES)) {
      const markdown = blockMarkdown(spec);
      expect({ component, json: markdown.includes('```json') }).toEqual({ component, json: false });
      for (const part of holds) expect({ component, markdown }).toEqual({ component, markdown: expect.stringContaining(part) });
    }
  });

  it('leaves out a button and hidden elements, and reads state, templates and computed values', () => {
    const spec = {
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: { $template: 'Threads for ${/owner}' }, description: { $computed: 'progress', args: { items: { $state: '/threads' }, field: 'done', noun: 'done' } } }, children: ['shown', 'hidden'], slots: { footer: ['send'] } },
        shown: { type: 'Text', visible: { $state: '/threads/0/done' }, props: { text: { $cond: { $state: '/count', gt: 1 }, $then: 'several', $else: 'one' } }, children: [] },
        hidden: { type: 'Text', visible: { $state: '/threads/1/done' }, props: { text: 'never shown' }, children: [] },
        send: { type: 'Button', props: { label: 'Send' }, children: [] },
      },
      state: { owner: 'ana', count: 2, threads: [{ done: true }, { done: false }] },
    };
    expect(blockMarkdown(spec)).toBe('**Threads for ana**\n\n1 of 2 done\n\nseveral');
  });

  it('reads a short-form fence as its full form', () => {
    const props = { question: 'Which cache?', options: [{ value: 'kv', label: 'KV' }, { value: 'do', label: 'DO' }] };
    const short = extractBlocks(`${fence}gitspace-ui AskCard id=cache ask=required\n${JSON.stringify(props)}\n${fence}`)[0];
    const read = fenceSpec(short?.body ?? '', short?.info ?? '');
    const full = { root: 'block', elements: { block: { type: 'AskCard', id: 'cache', props: { questionId: 'cache', question: 'Which cache?', prompt: 'Which cache?', options: props.options, value: '' }, children: [] } }, state: {} };
    expect('spec' in read ? blockMarkdown(read.spec) : read.issue.message).toBe(blockMarkdown(full));
    expect(blockMarkdown(full)).toBe('**Which cache?**\n\n- KV\n- DO');
  });

  it('draws a ref to another block of the document through refSpec, and never follows a ref back to itself', () => {
    const walk = { root: 'block', elements: { block: { type: 'Sequence', id: 'walk', props: { title: 'Walk', frames: [{ content: { ref: 'numbers' }, say: 'Numbers.' }, { content: { ref: 'other#x' }, say: 'Elsewhere.' }] }, children: [] } }, state: {} };
    const numbers = { root: 'block', elements: { block: { type: 'Card', id: 'numbers', props: { title: 'Numbers' }, children: ['tiles', 'back'] }, tiles: { type: 'Stats', props: { tiles: [{ label: 'Hits', value: 9 }] }, children: [] }, back: { type: 'BlockRef', props: { id: 'walk' }, children: [] } }, state: {} };
    const refSpec = (ref: string): unknown => ref === 'numbers' ? numbers : ref === 'walk' ? walk : undefined;
    expect(blockMarkdown(walk, refSpec)).toBe('**Walk**\n\n**1.**\n\n**Numbers**\n\n- **Hits:** 9\n\n_(block "walk")_\n\n> Numbers.\n\n**2.**\n\n_(block "other#x")_\n\n> Elsewhere.');
    expect(blockMarkdown(walk)).toContain('**1.**\n\n_(block "numbers")_');
  });

  it('writes the title and JSON of what it cannot read, and never throws', () => {
    expect(blockMarkdown(one('Gauge', { title: 'Speed' }))).toBe(`**Speed**\n\n${fence}json\n${JSON.stringify({ type: 'Gauge', props: { title: 'Speed' }, children: [] }, null, 2)}\n${fence}`);
    expect(blockMarkdown(one('Table', { title: 'Bad', columns: 'none' }))).toStartWith('**Bad**\n\n```json\n');
    expect(blockMarkdown('not a spec')).toBe(`**Block**\n\n${fence}json\n"not a spec"\n${fence}`);
    const cyclic: Record<string, unknown> = { root: 'a' };
    cyclic.elements = { a: { type: 'Card', props: { title: cyclic }, children: [] } };
    expect(blockMarkdown(cyclic)).toStartWith('**Block**\n\n```json\n');
    expect(blockMarkdown(one('Markdown', { content: 'a ``` fence' }))).toBe('a ``` fence');
    expect(blockMarkdown(one('Mermaid', { source: 'a ``` b' }))).toBe('````mermaid\na ``` b\n````');
  });
});

describe('record Markdown', () => {
  const commit = 'c0ffee1'.padEnd(40, '0');
  const git: EvidenceReference = { kind: 'git', generation: 2, path: 'src/parse.ts', blobId: null, commitId: commit, label: 'Parser' };
  const run: EvidenceReference = { kind: 'command', runId: 'run-7', command: 'bun test', exitCode: 0, artifactUrl: null, artifactHash: null, generation: 2, label: 'Tests' };
  const artifact: EvidenceReference = { kind: 'artifact', url: 'drive://ws/shot.png', hash: `sha256:${'a'.repeat(64)}`, generation: 2, label: 'Screenshot', mediaType: 'image/png' };
  const thread: EvidenceReference = { kind: 'review-thread', threadId: 'thread-1', messageId: null, label: 'Old review' };

  it('names each kind of evidence in one line', () => {
    expect(evidenceMarkdown(git)).toBe('**Parser**: `src/parse.ts` @ `c0ffee1`');
    expect(evidenceMarkdown(run)).toBe('**Tests**: run `run-7`, exit code 0');
    expect(evidenceMarkdown(artifact)).toBe(`**Screenshot**: artifact \`drive://ws/shot.png\` (\`sha256:${'a'.repeat(64)}\`)`);
    expect(evidenceMarkdown(thread)).toBe('**Old review**: review thread `thread-1`');
  });

  it('writes a requirement as a task item, checked once accepted, with its status, description and evidence', () => {
    const requirement = { id: 'parses', title: 'Parses v2', description: 'Every *sample* parses.', required: true, status: 'accepted' as const, workflowNodeId: null, criterionId: null, evidence: [run] };
    expect(requirementMarkdown(requirement)).toBe('- [x] **Parses v2** (accepted)\n\n  Every *sample* parses.\n\n  - **Tests**: run `run-7`, exit code 0');
    expect(requirementMarkdown({ ...requirement, status: 'review', required: false, description: '', evidence: [] })).toBe('- [ ] **Parses v2** (evidence to check, optional)');
    expect(requirementMarkdown({ ...requirement, status: 'missing', evidence: [] })).toStartWith('- [ ] **Parses v2** (no evidence)');
  });

  it('writes a decision with who and when, its quotes and what it replaces, struck through once superseded', () => {
    const entry: JournalEntryView = {
      projectId: 'p', spaceId: 's', id: 'stream', sequence: 4, kind: 'decision', phaseRunId: null, phase: 'build', title: 'Stream the input', body: 'Files reach 2 GB.',
      outcome: null, decisions: [], surprises: [], evidence: [], snapshot: null, delta: null, reverted: null, createdAt: '2026-11-17T10:00:00.000Z', createdBy: 'agent',
      citations: [{ conversationId: 'c', messageId: 'm', who: 'Ana', at: '2026-11-17T09:00:00.000Z', quote: 'Some files are huge.' }], supersedes: 'buffer',
    };
    expect(decisionMarkdown(entry, null)).toBe('### Stream the input\n\n*agent, 2026-11-17T10:00:00.000Z*\n\nFiles reach 2 GB.\n\n> Some files are huge.\n>\n> — Ana, 2026-11-17T09:00:00.000Z\n\nSupersedes buffer.');
    expect(decisionMarkdown(entry, 'Use mmap')).toStartWith('### ~~Stream the input~~\n\nSuperseded by Use mmap.');
  });

  it('writes a guide section with its parts, the diagram fence kept and each exhibit\'s lines', () => {
    const diagram = '```mermaid\ngraph LR\n  a --> b\n```';
    const markdown = guideSectionMarkdown({
      id: 'parse', title: 'Parse headers', kind: 'behavior', summary: 'Reads v2.', explanation: 'Checks the version first.', why: 'v2 files carry one.',
      callouts: [{ tone: 'risk', text: 'v1 files still load.' }], diagram, evidence: [run], requirementIds: [],
      exhibits: [{ path: 'src/parse.ts', blobId: null, note: 'The check.', slowRead: true, ranges: [{ start: 3, end: 9, note: 'version' }] }],
    }, 2);
    expect(markdown).toBe([
      '### §2 Parse headers', '*behavior*', 'Reads v2.', 'Checks the version first.', '**Why:** v2 files carry one.', '> **Risk:** v1 files still load.', diagram,
      '- `src/parse.ts`: The check.\n  - lines 3–9: version', '**Evidence**\n- **Tests**: run `run-7`, exit code 0',
    ].join('\n\n'));
  });
});
