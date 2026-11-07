// gitspace-ui specs for tests: the shapes of the blocks-mock examples (benchmark toggle, options with a decision, a
// question form, plan steps, a review batch, evidence, requirements, the ask card) with invented data, and a drawing
// with the Svg and Mermaid components.
import type { Spec } from '@json-render/core';

export interface BlockFixture { id: string; title: string; spec: Spec }

const MESSAGES = ['Say hello', 'Summarise the thread', 'Plan a week', 'Find a slot', 'Rename the list', 'Explain the error'];
const BEFORE = [4200, 4900, 5100, 4400, 3900, 4700];
const AFTER = [3300, 3800, 4100, 3500, 3100, 3900];

const PATCH = `diff --git a/src/stream.ts b/src/stream.ts
index 1111111..2222222 100644
--- a/src/stream.ts
+++ b/src/stream.ts
@@ -1,6 +1,7 @@
 export function deliver(stage: Stage) {
-  const buffered = stage.buffer();
-  return buffered.flush();
+  if (stage.liveChunks) return stage.stream();
+  const buffered = stage.buffer();
+  return buffered.flush();
 }
`;

const benchmark: BlockFixture = {
  id: 'benchmark',
  title: 'Benchmark with a toggle',
  spec: {
    root: 'card',
    state: {
      live: false,
      before: { bars: MESSAGES.map((label, index) => ({ label, values: { p50: BEFORE[index] ?? 0 } })), rows: MESSAGES.map((message, index) => ({ message, p50: BEFORE[index] ?? 0, p95: (BEFORE[index] ?? 0) + 900 })) },
      after: { bars: MESSAGES.map((label, index) => ({ label, values: { p50: AFTER[index] ?? 0 } })), rows: MESSAGES.map((message, index) => ({ message, p50: AFTER[index] ?? 0, p95: (AFTER[index] ?? 0) + 700 })) },
    },
    elements: {
      card: { type: 'Card', props: { title: 'First visible text, per message', description: 'p50 of the bench. Turn on live chunks to see the change.', eyebrow: null }, children: ['controls', 'tiles', 'chart', 'table', 'what-member-sees'] },
      controls: { type: 'Row', props: { gap: 'md', justify: 'between', wrap: true }, children: ['live', 'run'] },
      live: { type: 'Switch', props: { label: 'Live chunks (abc1234)', checked: { $bindState: '/live' } }, children: [] },
      run: { type: 'RunTag', props: { commit: { $cond: { $state: '/live' }, $then: 'abc1234', $else: 'main' }, machine: 'bench-1', sample: { $cond: { $state: '/live' }, $then: '3 × 6', $else: '4 × 6' }, label: 'Computed by GitSpace' }, children: [] },
      tiles: { type: 'Stats', props: { tiles: [
        { label: 'First visible text, p50', value: { $cond: { $state: '/live' }, $then: '3.6 s', $else: '4.5 s' }, detail: 'all six messages', tone: { $cond: { $state: '/live' }, $then: 'good', $else: 'neutral' } },
        { label: 'Replies with live text', value: { $cond: { $state: '/live' }, $then: '18 of 18', $else: '0 of 24' }, detail: null, tone: { $cond: { $state: '/live' }, $then: 'good', $else: 'neutral' } },
        { label: 'First token → text', value: { $cond: { $state: '/live' }, $then: '9 ms', $else: '240 ms' }, detail: 'p50', tone: null },
      ] }, children: [] },
      chart: { type: 'Chart', props: {
        title: { $cond: { $state: '/live' }, $then: 'abc1234 · text shows as the model writes it', $else: 'main · text shows after the whole attempt is saved' },
        unit: 'ms', max: 8000,
        series: [{ key: 'p50', label: 'p50', color: { $cond: { $state: '/live' }, $then: 'green', $else: 'gray' } }],
        rows: { $cond: { $state: '/live' }, $then: { $state: '/after/bars' }, $else: { $state: '/before/bars' } },
      }, children: [] },
      table: { type: 'Table', props: {
        columns: [{ key: 'message', label: 'Message', align: null, mono: null }, { key: 'p50', label: 'p50, ms', align: 'right', mono: true }, { key: 'p95', label: 'p95, ms', align: 'right', mono: true }],
        rows: { $cond: { $state: '/live' }, $then: { $state: '/after/rows' }, $else: { $state: '/before/rows' } },
        caption: { $cond: { $state: '/live' }, $then: '3 replies per message.', $else: '4 replies per message.' },
      }, children: [] },
      'what-member-sees': { type: 'BeforeAfter', props: {
        slider: true,
        before: { label: 'main', title: 'What the member sees', body: 'The typing indicator, then the **whole reply at once**.' },
        after: { label: 'abc1234', title: 'What the member sees', body: 'Text **as the model writes it**.' },
      }, children: [] },
    },
  },
};

const STAGED_ON_STEP = 'Live chunks (over the side channel)';

const options: BlockFixture = {
  id: 'options',
  title: 'Options with a decision',
  spec: {
    root: 'card',
    state: {},
    elements: {
      card: { type: 'Card', props: { eyebrow: 'decision', title: 'Where does the live text come from?', description: 'Pick one; it waits in your message so you can say why.' }, children: ['tradeoffs', 'change', 'staged', 'sent'], slots: { footer: ['observer', 'onstep'] } },
      tradeoffs: { type: 'Table', props: {
        columns: [{ key: 'aspect', label: '', align: null, mono: null }, { key: 'observer', label: 'Side channel (`onText`)', align: null, mono: null }, { key: 'onstep', label: 'Live `chunk` steps', align: null, mono: null }],
        rows: [
          { aspect: 'How text leaves the flow', observer: 'A parallel observer', onstep: 'The `chunk` steps consumers already handle' },
          { aspect: 'Retry buffering', observer: 'Kept', onstep: 'Kept for every stage without `liveChunks`' },
        ],
        caption: null,
      }, children: [] },
      change: { type: 'Diff', props: { title: 'Live chunks: what a stage opts in with', patch: PATCH }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/decision' }, { $state: '/sent/decision', not: true }], props: { label: 'staged · in your message', color: 'amber', variant: 'dot' }, children: [] },
      sent: { type: 'Badge', visible: { $state: '/sent/decision' }, props: { label: { $template: 'sent · ${/sent/decision}' }, color: 'green', variant: 'dot' }, children: [] },
      observer: { type: 'Button', props: { label: 'Keep the side channel', disabled: null, variant: { $cond: { $state: '/staged/decision', eq: 'The side channel (over live chunks)' }, $then: 'primary', $else: 'secondary' } }, on: { press: {
        action: 'stage', params: { kind: 'decision', key: 'decision', label: 'The side channel (over live chunks)', detail: null, payload: { choice: 'Side channel' } },
      } }, children: [] },
      onstep: { type: 'Button', props: { label: 'Use live chunks', disabled: null, variant: { $cond: { $state: '/staged/decision', eq: STAGED_ON_STEP }, $then: 'primary', $else: 'secondary' } }, on: { press: {
        action: 'stage', params: { kind: 'decision', key: 'decision', label: STAGED_ON_STEP, detail: null, payload: { choice: 'Live chunks' } },
      } }, children: [] },
    },
  },
};

const question: BlockFixture = {
  id: 'question',
  title: 'A question form',
  spec: {
    root: 'card',
    state: {
      answer: '',
      note: '',
      options: [
        { value: 'accept', label: 'Accept the flicker', description: 'Ship as is; the withdrawal stays covered by tests.' },
        { value: 'hold', label: 'Hold text until the reply is committed', description: 'No flicker, but text starts later.' },
        { value: 'later', label: 'Decide after the full bench run', description: 'Keep it in Review until the long run reports.' },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'The agent asks', title: 'Accept the brief flicker?', description: null }, children: ['prompt', 'answer', 'note', 'staged', 'sent'], slots: { footer: ['add'] } },
      prompt: { type: 'Markdown', props: { content: 'Text written before a tool call now shows live and is withdrawn when the call starts. None of the **160 benched replies** withdrew text.' }, children: [] },
      answer: { type: 'RadioGroup', props: { label: 'Your answer', value: { $bindState: '/answer' }, options: { $state: '/options' } }, children: [] },
      note: { type: 'TextField', props: { label: 'Note for the agent', value: { $bindState: '/note' }, placeholder: 'Optional' }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/flicker' }, { $state: '/sent/flicker', not: true }], props: { label: 'staged · in your message', color: 'amber', variant: 'dot' }, children: [] },
      sent: { type: 'Badge', visible: { $state: '/sent/flicker' }, props: { label: 'sent with your message', color: 'green', variant: 'dot' }, children: [] },
      add: { type: 'Button', props: { label: 'Add to message', variant: 'primary', disabled: { $cond: { $state: '/answer', eq: '' }, $then: true, $else: false } }, on: { press: {
        action: 'stage', params: {
          kind: 'answer', key: 'flicker',
          label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/answer' }, field: 'label' } },
          detail: { $cond: { $state: '/note', eq: '' }, $then: null, $else: { $template: 'note: ${/note}' } },
          payload: { answer: { $state: '/answer' }, note: { $state: '/note' } },
        },
      } }, children: [] },
    },
  },
};

const steps: BlockFixture = {
  id: 'steps',
  title: 'Plan steps with play',
  spec: {
    root: 'card',
    state: {
      step: 0,
      path: [
        { title: 'provider', detail: 'The model streams `delta` events.', where: 'provider/openai', section: 'flow-live', sectionTitle: 'The flow delivers chunks live' },
        { title: 'flow', detail: 'Each delta becomes a `chunk` step.', where: 'src/flow.ts', section: 'flow-live', sectionTitle: 'The flow delivers chunks live' },
        { title: 'processor', detail: 'Coalesces replies and appends `messageText`.', where: 'src/processor.ts', section: 'processor', sectionTitle: 'The processor publishes the reply' },
        { title: 'app', detail: 'Shows the live reply in the bubble.', where: 'app/conversation.tsx', section: 'app-live', sectionTitle: 'The app shows the live reply' },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'plan', title: 'One reply chunk, end to end', description: 'Where a piece of the reply goes after this change.' }, children: ['steps'], slots: { footer: ['open'] } },
      steps: { type: 'Steps', props: { steps: { $state: '/path' }, active: { $bindState: '/step' }, play: true, intervalMs: 1600 }, children: [] },
      open: { type: 'Button', props: { label: 'Open this step in the Change Guide', variant: 'secondary', disabled: null }, on: { press: { action: 'open_guide_section', params: {
        section: { $computed: 'pick', args: { items: { $state: '/path' }, index: { $state: '/step' }, field: 'section' } },
        title: { $computed: 'pick', args: { items: { $state: '/path' }, index: { $state: '/step' }, field: 'sectionTitle' } },
      } } }, children: [] },
    },
  },
};

const review: BlockFixture = {
  id: 'review',
  title: 'Review feedback batch',
  spec: {
    root: 'card',
    state: {
      threads: [
        { id: 't1', path: 'src/flow.ts', line: 42, finding: 'Guard the empty chunk', reply: '**Fixed** in abc1234.', status: 'Fixed', url: 'https://example.com/pr/7#t1', include: true },
        { id: 't2', path: 'src/processor.ts', line: 88, finding: 'Drain before complete', reply: 'The drain already runs first.', status: 'Outdated', url: 'https://example.com/pr/7#t2', include: true },
        { id: 't3', path: 'app/conversation.tsx', line: 12, finding: 'Name the timeout', reply: '**Fixed**: `LIVE_TIMEOUT_MS`.', status: 'Fixed', url: 'https://example.com/pr/7#t3', include: true },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'PR #7 · review bot', title: 'Three open review threads', description: 'Untick a thread to leave it out.' }, children: ['count', 'threads', 'staged', 'sent'], slots: { footer: ['add'] } },
      count: { type: 'Text', props: { text: { $computed: 'progress', args: { items: { $state: '/threads' }, field: 'include', noun: 'threads included' } }, size: 'caption', tone: 'muted', mono: null }, children: [] },
      threads: { type: 'Stack', props: { gap: 'sm' }, repeat: { statePath: '/threads', key: 'id' }, children: ['thread'] },
      thread: { type: 'Card', props: { eyebrow: null, title: { $item: 'finding' }, description: null }, children: ['where', 'reply', 'thread-actions'] },
      where: { type: 'Text', props: { text: { $template: '${path}:${line}' }, size: 'caption', tone: 'muted', mono: true }, children: [] },
      reply: { type: 'Markdown', props: { content: { $item: 'reply' } }, children: [] },
      'thread-actions': { type: 'Row', props: { gap: 'md', justify: 'between', wrap: true }, children: ['include', 'thread-end'] },
      include: { type: 'Switch', props: { label: 'Include', checked: { $bindItem: 'include' } }, children: [] },
      'thread-end': { type: 'Row', props: { gap: 'sm', justify: 'end', wrap: null }, children: ['status', 'open'] },
      status: { type: 'Badge', props: { label: { $item: 'status' }, color: { $cond: { $item: 'status', eq: 'Fixed' }, $then: 'green', $else: 'gray' }, variant: 'dot' }, children: [] },
      open: { type: 'Button', props: { label: 'Open thread', variant: 'ghost', disabled: null }, on: { press: { action: 'open_url', params: { url: { $template: '${url}' }, label: { $template: '${path}:${line}' } } } }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/review' }, { $state: '/sent/review', not: true }], props: { label: 'staged · in your message', color: 'amber', variant: 'dot' }, children: [] },
      sent: { type: 'Badge', visible: { $state: '/sent/review' }, props: { label: { $template: 'sent · ${/sent/review}' }, color: 'green', variant: 'dot' }, children: [] },
      add: { type: 'Button', props: { label: 'Add to message', variant: 'primary', disabled: null }, on: { press: { action: 'stage', params: {
        kind: 'review', key: 'review',
        label: { $computed: 'progress', args: { items: { $state: '/threads' }, field: 'include', noun: 'threads' } },
        detail: 'review bot · PR #7',
        payload: { threads: { $computed: 'where', args: { items: { $state: '/threads' }, field: 'include' } } },
      } } }, children: [] },
    },
  },
};

const evidence: BlockFixture = {
  id: 'evidence',
  title: 'Evidence',
  spec: {
    root: 'card',
    state: {
      run: 'short',
      short: {
        commit: 'abc1234', sample: '3 × 6 vs 4 × 6', label: 'Bench · short run',
        tiles: [
          { label: 'First visible text, p50', value: '3.6 s', detail: 'main 4.5 s · −20%', tone: 'good' },
          { label: 'Replies with live text', value: '18 of 18', detail: 'main 0 of 24', tone: 'good' },
          { label: 'Accepted → saved, p50', value: '5.6 s', detail: 'main 4.6 s · unresolved', tone: 'bad' },
        ],
        bars: MESSAGES.map((label, index) => ({ label, values: { before: BEFORE[index] ?? 0, after: AFTER[index] ?? 0 } })),
        supporting: [{ label: 'Total p50', before: 6100, after: 6050 }, { label: 'Total p95', before: 8800, after: 8700 }],
      },
      long: {
        commit: 'def5678', sample: '20 × 6 per side', label: 'Bench · long run',
        tiles: [
          { label: 'First visible text, p50', value: '3.2 s', detail: 'main 5.8 s · −45%', tone: 'good' },
          { label: 'Replies with live text', value: '120 of 120', detail: 'main 0 of 120', tone: 'good' },
          { label: 'Accepted → saved, p50', value: '5.7 s', detail: 'main 5.8 s · no change', tone: 'neutral' },
        ],
        bars: MESSAGES.map((label, index) => ({ label, values: { before: (BEFORE[index] ?? 0) + 800, after: (AFTER[index] ?? 0) - 300 } })),
        supporting: [{ label: 'Total p50', before: 6200, after: 6180 }, { label: 'Total p95', before: 9100, after: 9000 }],
      },
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'evidence', title: 'Is first text sooner, with no slower total?', description: 'Compare the short re-bench with the 120-reply run.' }, children: ['pick', 'run', 'tiles', 'chart', 'supporting'] },
      pick: { type: 'Segmented', props: { value: { $bindState: '/run' }, options: [{ value: 'short', label: '3 × 6 · abc1234' }, { value: 'long', label: '120 replies · def5678' }] }, children: [] },
      run: { type: 'RunTag', props: {
        commit: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/commit' }, $else: { $state: '/short/commit' } },
        machine: 'bench-1',
        sample: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/sample' }, $else: { $state: '/short/sample' } },
        label: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/label' }, $else: { $state: '/short/label' } },
      }, children: [] },
      tiles: { type: 'Stats', props: { tiles: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/tiles' }, $else: { $state: '/short/tiles' } } }, children: [] },
      chart: { type: 'Chart', props: {
        title: 'First visible text, p50 per message', unit: 'ms', max: 8000,
        series: [{ key: 'before', label: 'before', color: 'gray' }, { key: 'after', label: 'after', color: 'green' }],
        rows: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/bars' }, $else: { $state: '/short/bars' } },
      }, children: [] },
      supporting: { type: 'Table', props: {
        columns: [{ key: 'label', label: 'p50 / p95, ms', align: null, mono: null }, { key: 'before', label: 'before', align: 'right', mono: true }, { key: 'after', label: 'after', align: 'right', mono: true }],
        rows: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/supporting' }, $else: { $state: '/short/supporting' } },
        caption: null,
      }, children: [] },
    },
  },
};

const requirements: BlockFixture = {
  id: 'requirements',
  title: 'Requirements',
  spec: {
    root: 'card',
    state: {
      requirements: [
        { id: 'r1', title: 'Text shows while the model writes', required: true, accepted: true },
        { id: 'r2', title: 'A withdrawn attempt leaves no text', required: true, accepted: false },
        { id: 'r3', title: 'The bench reports first-text time', required: false, accepted: false },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'goal', title: 'Requirements', description: 'Tick a requirement to accept it; untick to reopen it.' }, children: ['progress', 'list'] },
      progress: { type: 'Text', props: { text: { $computed: 'progress', args: { items: { $state: '/requirements' }, field: 'accepted', noun: 'requirements accepted' } }, size: 'body', tone: null, mono: null }, children: [] },
      list: { type: 'Checklist', props: { title: null }, repeat: { statePath: '/requirements', key: 'id' }, children: ['item'] },
      item: { type: 'ChecklistItem', props: {
        index: { $index: true },
        label: { $item: 'title' },
        checked: { $bindItem: 'accepted' },
        note: { $cond: { $item: 'required' }, $then: 'required', $else: 'optional' },
      }, on: { change: { action: 'accept_requirement', params: { id: { $template: '${id}' }, accepted: { $cond: { $item: 'accepted' }, $then: true, $else: false }, label: { $template: '${title}' }, checkedPath: { $item: 'accepted' } } } }, children: [] },
    },
  },
};

const ask: BlockFixture = {
  id: 'ask',
  title: 'The agent’s question (ask card)',
  spec: {
    root: 'ask',
    state: {
      answer: '',
      options: [
        { value: 'drop', label: 'Drop it', description: 'Four model calls before the first word, unchanged; ≈ 9% more input tokens.' },
        { value: 'keep', label: 'Keep it', description: 'Fewer model calls comes back into this goal.' },
      ],
    },
    elements: {
      ask: { type: 'AskCard', props: {
        questionId: 'batch',
        question: 'Keep the batch-searches prompt rule?',
        prompt: 'The rule was meant to cut model calls before the first word. On the bench it left them at **4** and cost **≈ 9% more input tokens**.\n\nKeep the batch-searches prompt rule?',
        options: { $state: '/options' },
        value: { $bindState: '/answer' },
        staged: { $state: '/staged/batch' },
        sent: { $state: '/sent/batch' },
        answered: { $state: '/answered' },
      }, on: { answer: { action: 'answer_question', params: {
        questionId: 'batch',
        question: 'Keep the batch-searches prompt rule?',
        answer: { $state: '/answer' },
        label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/answer' }, field: 'label' } },
      } } }, children: [] },
    },
  },
};

export const SVG_DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 64" role="img"><title>Flow</title><rect x="4" y="16" width="80" height="32" rx="6" fill="none" stroke="currentColor"/><text x="44" y="36" text-anchor="middle" font-size="12" fill="currentColor">flow</text><line x1="84" y1="32" x2="152" y2="32" stroke="var(--muted-foreground)"/><rect x="152" y="16" width="84" height="32" rx="6" fill="var(--surface-2)" stroke="var(--focus-ring)"/><text x="194" y="36" text-anchor="middle" font-size="12" fill="var(--foreground)">processor</text></svg>';

const drawing: BlockFixture = {
  id: 'drawing',
  title: 'Svg and Mermaid',
  spec: {
    root: 'card',
    state: {},
    elements: {
      card: { type: 'Card', props: { eyebrow: 'map', title: 'Where the chunk goes', description: null }, children: ['svg', 'mermaid'] },
      svg: { type: 'Svg', props: { svg: SVG_DRAWING }, children: [] },
      mermaid: { type: 'Mermaid', props: { source: 'flowchart LR\n  provider --> flow --> processor --> app' }, children: [] },
    },
  },
};

export const BLOCK_FIXTURES: readonly BlockFixture[] = [benchmark, options, question, steps, review, evidence, requirements, ask, drawing];
