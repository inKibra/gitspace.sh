// gitspace-ui specs for tests, one per block shape (a load test with a toggle, options with a decision, a question form,
// plan steps, a review batch, evidence, requirements, the ask card), with invented data about a bakery's ordering app,
// and a drawing with the Svg and Mermaid components.
import type { Spec } from '@json-render/core';

export interface BlockFixture { id: string; title: string; spec: Spec }

const PAGES = ['Menu', 'Basket', 'Checkout', 'Order status', 'Pickup slots', 'Account'];
const BEFORE = [1100, 1340, 1610, 900, 1150, 760];
const AFTER = [400, 520, 640, 350, 470, 300];

const PATCH = `diff --git a/src/menu.ts b/src/menu.ts
index 1111111..2222222 100644
--- a/src/menu.ts
+++ b/src/menu.ts
@@ -1,4 +1,6 @@
 export async function loadMenu(shop: Shop) {
+  const cached = await shop.cache.get('menu');
+  if (cached) return cached;
   const items = await shop.db.menuItems();
   return items;
 }
`;

const benchmark: BlockFixture = {
  id: 'benchmark',
  title: 'Load test with a toggle',
  spec: {
    root: 'card',
    state: {
      cached: false,
      before: { bars: PAGES.map((label, index) => ({ label, values: { p50: BEFORE[index] ?? 0 } })), rows: PAGES.map((page, index) => ({ page, p50: BEFORE[index] ?? 0, p95: (BEFORE[index] ?? 0) + 600 })) },
      after: { bars: PAGES.map((label, index) => ({ label, values: { p50: AFTER[index] ?? 0 } })), rows: PAGES.map((page, index) => ({ page, p50: AFTER[index] ?? 0, p95: (AFTER[index] ?? 0) + 250 })) },
    },
    elements: {
      card: { type: 'Card', props: { title: 'Menu ready, per page', description: 'p50 of the load test. Turn on the menu cache to see the change.', eyebrow: null }, children: ['controls', 'tiles', 'chart', 'table', 'what-customer-sees'] },
      controls: { type: 'Row', props: { gap: 'md', justify: 'between', wrap: true }, children: ['cached', 'run'] },
      cached: { type: 'Switch', props: { label: 'Menu cache (abc1234)', checked: { $bindState: '/cached' } }, children: [] },
      run: { type: 'RunTag', props: { commit: { $cond: { $state: '/cached' }, $then: 'abc1234', $else: 'main' }, machine: 'load-test-1', sample: { $cond: { $state: '/cached' }, $then: '5 × 6', $else: '4 × 6' }, label: 'Computed by GitSpace' }, children: [] },
      tiles: { type: 'Stats', props: { tiles: [
        { label: 'Menu ready, p50', value: { $cond: { $state: '/cached' }, $then: '0.4 s', $else: '1.1 s' }, detail: 'all six pages', tone: { $cond: { $state: '/cached' }, $then: 'good', $else: 'neutral' } },
        { label: 'Pages served from the cache', value: { $cond: { $state: '/cached' }, $then: '17 of 18', $else: '0 of 18' }, detail: null, tone: { $cond: { $state: '/cached' }, $then: 'good', $else: 'neutral' } },
        { label: 'Menu lookup', value: { $cond: { $state: '/cached' }, $then: '3 ms', $else: '85 ms' }, detail: 'p50', tone: null },
      ] }, children: [] },
      chart: { type: 'Chart', props: {
        title: { $cond: { $state: '/cached' }, $then: 'abc1234 · menu served from the cache', $else: 'main · menu read from the database' },
        unit: 'ms', max: 2000,
        series: [{ key: 'p50', label: 'p50', color: { $cond: { $state: '/cached' }, $then: 'green', $else: 'gray' } }],
        rows: { $cond: { $state: '/cached' }, $then: { $state: '/after/bars' }, $else: { $state: '/before/bars' } },
      }, children: [] },
      table: { type: 'Table', props: {
        columns: [{ key: 'page', label: 'Page', align: null, mono: null }, { key: 'p50', label: 'p50, ms', align: 'right', mono: true }, { key: 'p95', label: 'p95, ms', align: 'right', mono: true }],
        rows: { $cond: { $state: '/cached' }, $then: { $state: '/after/rows' }, $else: { $state: '/before/rows' } },
        caption: { $cond: { $state: '/cached' }, $then: '5 loads per page.', $else: '4 loads per page.' },
      }, children: [] },
      'what-customer-sees': { type: 'BeforeAfter', props: {
        slider: true,
        before: { label: 'main', title: 'What the customer sees', body: 'A spinner, then the **whole menu at once**.' },
        after: { label: 'abc1234', title: 'What the customer sees', body: 'The menu **right away**.' },
      }, children: [] },
    },
  },
};

const STAGED_REDIS = 'Redis (over in-memory)';

const options: BlockFixture = {
  id: 'options',
  title: 'Options with a decision',
  spec: {
    root: 'card',
    state: {},
    elements: {
      card: { type: 'Card', props: { eyebrow: 'decision', title: 'Where should the menu cache live?', description: 'Pick one; it waits in your message so you can say why.' }, children: ['tradeoffs', 'change', 'staged', 'sent'], slots: { footer: ['memory', 'redis'] } },
      tradeoffs: { type: 'Table', props: {
        columns: [{ key: 'aspect', label: '', align: null, mono: null }, { key: 'memory', label: 'In memory, per server', align: null, mono: null }, { key: 'redis', label: 'Shared `Redis`', align: null, mono: null }],
        rows: [
          { aspect: 'Survives a deploy', memory: 'No: each server warms it again', redis: 'Yes' },
          { aspect: 'An edited item', memory: 'Stale for up to 5 minutes per server', redis: 'Cleared once for every server' },
        ],
        caption: null,
      }, children: [] },
      change: { type: 'Diff', props: { title: 'The menu cache: what loadMenu checks first', patch: PATCH }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/decision' }, { $state: '/sent/decision', not: true }], props: { label: 'staged · in your message', color: 'amber', variant: 'dot' }, children: [] },
      sent: { type: 'Badge', visible: { $state: '/sent/decision' }, props: { label: { $template: 'sent · ${/sent/decision}' }, color: 'green', variant: 'dot' }, children: [] },
      memory: { type: 'Button', props: { label: 'Keep it in memory', disabled: null, variant: { $cond: { $state: '/staged/decision', eq: 'In memory (over Redis)' }, $then: 'primary', $else: 'secondary' } }, on: { press: {
        action: 'stage', params: { kind: 'decision', key: 'decision', label: 'In memory (over Redis)', detail: null, payload: { choice: 'In memory' } },
      } }, children: [] },
      redis: { type: 'Button', props: { label: 'Use Redis', disabled: null, variant: { $cond: { $state: '/staged/decision', eq: STAGED_REDIS }, $then: 'primary', $else: 'secondary' } }, on: { press: {
        action: 'stage', params: { kind: 'decision', key: 'decision', label: STAGED_REDIS, detail: null, payload: { choice: 'Redis' } },
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
        { value: 'grey', label: 'Grey them out', description: 'Ship as is; the basket refuses sold-out items.' },
        { value: 'hide', label: 'Hide them until restocked', description: 'A shorter menu, but regulars lose sight of their favourites.' },
        { value: 'later', label: 'Decide after the weekend trial', description: 'Keep it in Review until the trial reports.' },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'The agent asks', title: 'Show sold-out items greyed out?', description: null }, children: ['prompt', 'answer', 'note', 'staged', 'sent'], slots: { footer: ['add'] } },
      prompt: { type: 'Markdown', props: { content: 'An item that sells out now stays on the menu, greyed out, until midnight. In the **40 test orders**, no one tried to add a greyed-out item.' }, children: [] },
      answer: { type: 'RadioGroup', props: { label: 'Your answer', value: { $bindState: '/answer' }, options: { $state: '/options' } }, children: [] },
      note: { type: 'TextField', props: { label: 'Note for the agent', value: { $bindState: '/note' }, placeholder: 'Optional' }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/soldout' }, { $state: '/sent/soldout', not: true }], props: { label: 'staged · in your message', color: 'amber', variant: 'dot' }, children: [] },
      sent: { type: 'Badge', visible: { $state: '/sent/soldout' }, props: { label: 'sent with your message', color: 'green', variant: 'dot' }, children: [] },
      add: { type: 'Button', props: { label: 'Add to message', variant: 'primary', disabled: { $cond: { $state: '/answer', eq: '' }, $then: true, $else: false } }, on: { press: {
        action: 'stage', params: {
          kind: 'answer', key: 'soldout',
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
        { title: 'storefront', detail: 'The customer taps **Order**.', where: 'web/basket.tsx', section: 'basket', sectionTitle: 'The basket places the order' },
        { title: 'api', detail: 'Checks stock and reserves a pickup slot.', where: 'src/orders.ts', section: 'orders', sectionTitle: 'Orders reserve a slot' },
        { title: 'kitchen', detail: 'Adds the order to the baking queue.', where: 'src/kitchen.ts', section: 'kitchen', sectionTitle: 'The kitchen queue' },
        { title: 'notify', detail: 'Texts the customer when it is ready.', where: 'src/notify.ts', section: 'notify', sectionTitle: 'The customer hears it is ready' },
      ],
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'plan', title: 'One order, end to end', description: 'Where an order goes after this change.' }, children: ['steps'], slots: { footer: ['open'] } },
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
        { id: 't1', path: 'src/orders.ts', line: 42, finding: 'Guard the empty basket', reply: '**Fixed** in abc1234.', status: 'Fixed', url: 'https://example.com/pr/7#t1', include: true },
        { id: 't2', path: 'src/kitchen.ts', line: 88, finding: 'Release the slot on cancel', reply: 'The cancel handler already releases it.', status: 'Outdated', url: 'https://example.com/pr/7#t2', include: true },
        { id: 't3', path: 'src/notify.ts', line: 12, finding: 'Name the retry delay', reply: '**Fixed**: `SMS_RETRY_MS`.', status: 'Fixed', url: 'https://example.com/pr/7#t3', include: true },
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
        commit: 'abc1234', sample: '5 × 6 vs 4 × 6', label: 'Load test · short run',
        tiles: [
          { label: 'Menu ready, p50', value: '0.4 s', detail: 'main 1.1 s · −64%', tone: 'good' },
          { label: 'Pages served from the cache', value: '17 of 18', detail: 'main 0 of 18', tone: 'good' },
          { label: 'Checkout, p50', value: '1.3 s', detail: 'main 1.2 s · unresolved', tone: 'bad' },
        ],
        bars: PAGES.map((label, index) => ({ label, values: { before: BEFORE[index] ?? 0, after: AFTER[index] ?? 0 } })),
        supporting: [{ label: 'Checkout p50', before: 1200, after: 1210 }, { label: 'Checkout p95', before: 2100, after: 2080 }],
      },
      long: {
        commit: 'def5678', sample: '200 per side', label: 'Load test · long run',
        tiles: [
          { label: 'Menu ready, p50', value: '0.35 s', detail: 'main 1.2 s · −71%', tone: 'good' },
          { label: 'Pages served from the cache', value: '196 of 200', detail: 'main 0 of 200', tone: 'good' },
          { label: 'Checkout, p50', value: '1.2 s', detail: 'main 1.2 s · no change', tone: 'neutral' },
        ],
        bars: PAGES.map((label, index) => ({ label, values: { before: (BEFORE[index] ?? 0) + 100, after: (AFTER[index] ?? 0) - 50 } })),
        supporting: [{ label: 'Checkout p50', before: 1250, after: 1240 }, { label: 'Checkout p95', before: 2300, after: 2290 }],
      },
    },
    elements: {
      card: { type: 'Card', props: { eyebrow: 'evidence', title: 'Is the menu faster, with no slower checkout?', description: 'Compare the short load test with the 200-load run.' }, children: ['pick', 'run', 'tiles', 'chart', 'supporting'] },
      pick: { type: 'Segmented', props: { value: { $bindState: '/run' }, options: [{ value: 'short', label: '5 × 6 · abc1234' }, { value: 'long', label: '200 loads · def5678' }] }, children: [] },
      run: { type: 'RunTag', props: {
        commit: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/commit' }, $else: { $state: '/short/commit' } },
        machine: 'load-test-1',
        sample: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/sample' }, $else: { $state: '/short/sample' } },
        label: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/label' }, $else: { $state: '/short/label' } },
      }, children: [] },
      tiles: { type: 'Stats', props: { tiles: { $cond: { $state: '/run', eq: 'long' }, $then: { $state: '/long/tiles' }, $else: { $state: '/short/tiles' } } }, children: [] },
      chart: { type: 'Chart', props: {
        title: 'Menu ready, p50 per page', unit: 'ms', max: 2000,
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
        { id: 'r1', title: 'The menu shows from the cache', required: true, accepted: true },
        { id: 'r2', title: 'An edited item shows within a minute', required: true, accepted: false },
        { id: 'r3', title: 'The load test reports menu time', required: false, accepted: false },
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
        { value: 'drop', label: 'Drop them', description: 'The menu loads in half the time; items show as text.' },
        { value: 'keep', label: 'Keep them', description: 'Photos load after the text, as now.' },
      ],
    },
    elements: {
      ask: { type: 'AskCard', props: {
        questionId: 'photos',
        question: 'Keep the pastry photos on the menu?',
        prompt: 'The photos are most of the menu page. Without them it loads in **0.2 s** instead of **0.4 s**.\n\nKeep the pastry photos on the menu?',
        options: { $state: '/options' },
        value: { $bindState: '/answer' },
        staged: { $state: '/staged/photos' },
        sent: { $state: '/sent/photos' },
        answered: { $state: '/answered' },
      }, on: { answer: { action: 'answer_question', params: {
        questionId: 'photos',
        question: 'Keep the pastry photos on the menu?',
        answer: { $state: '/answer' },
        label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/answer' }, field: 'label' } },
      } } }, children: [] },
    },
  },
};

export const SVG_DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 64" role="img"><title>Order</title><rect x="4" y="16" width="80" height="32" rx="6" fill="none" stroke="currentColor"/><text x="44" y="36" text-anchor="middle" font-size="12" fill="currentColor">basket</text><line x1="84" y1="32" x2="152" y2="32" stroke="var(--muted-foreground)"/><rect x="152" y="16" width="84" height="32" rx="6" fill="var(--surface-2)" stroke="var(--focus-ring)"/><text x="194" y="36" text-anchor="middle" font-size="12" fill="var(--foreground)">kitchen</text></svg>';

const drawing: BlockFixture = {
  id: 'drawing',
  title: 'Svg and Mermaid',
  spec: {
    root: 'card',
    state: {},
    elements: {
      card: { type: 'Card', props: { eyebrow: 'map', title: 'Where an order goes', description: null }, children: ['svg', 'mermaid'] },
      svg: { type: 'Svg', props: { svg: SVG_DRAWING }, children: [] },
      mermaid: { type: 'Mermaid', props: { source: 'flowchart LR\n  storefront --> api --> kitchen --> notify' }, children: [] },
    },
  },
};

export const BLOCK_FIXTURES: readonly BlockFixture[] = [benchmark, options, question, steps, review, evidence, requirements, ask, drawing];
