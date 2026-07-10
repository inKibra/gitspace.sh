import type { ArtifactRef, Block, DiffLine, FileNode } from '../blocks/types';

export type Stage = 'plan' | 'code' | 'review' | 'ship';

export const STAGES: Stage[] = ['plan', 'code', 'review', 'ship'];
export const STAGE_LABEL: Record<Stage, string> = { plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship' };
export const STAGE_BLURB: Record<Stage, string> = {
  plan: 'Author the spec — goal, rubric, review-gated workflow. Not editing the repo.',
  code: 'Run the implementation workflow and guide it.',
  review: 'Code review — commit staging and the narrative arc of the change.',
  ship: 'Post-merge ops — monitor, deploy, crons, roll-up.',
};
export const STAGE_VAR: Record<Stage, string> = { plan: 'var(--stage-plan)', code: 'var(--stage-code)', review: 'var(--stage-review)', ship: 'var(--stage-ship)' };

export interface Workspace {
  id: string;
  name: string;
  project: string;
  stage: Stage;
  branch: string;
  chainTitle?: string;
  chainPos?: string;
  summary: string;
  agentBusy?: boolean;
  ready?: { passed: number; total: number };
}

export const WORKSPACES: Workspace[] = [
  { id: 'profile-model', name: 'profile-model', project: 'tone-tempo', stage: 'plan', branch: 'demo-01-foundation', chainTitle: 'Profile redesign', chainPos: '1/3', summary: 'Render the profile at 128 BPM from the shared model', agentBusy: true },
  { id: 'share-union', name: 'typed-share-union', project: 'tone-tempo', stage: 'plan', branch: 'ink-361', chainTitle: 'Outgoing sharing', chainPos: '1/2', summary: 'Add a typed multi-item share union (image/video/text)' },
  { id: 'haptics-plugin', name: 'haptics-plugin', project: 'tone-tempo', stage: 'code', branch: 'ink-366', chainTitle: 'Native haptics', summary: 'Verify the haptics plugin on real hardware', agentBusy: true, ready: { passed: 2, total: 5 } },
  { id: 'alarm-scaffold', name: 'alarmkit-scaffold', project: 'tone-tempo', stage: 'code', branch: 'ink-389', summary: 'Generic AlarmKit plugin + authorization flow', ready: { passed: 4, total: 6 } },
  { id: 'effects-pack', name: 'add-effects-pack', project: 'tone-tempo', stage: 'review', branch: 'ink-357', chainTitle: 'Editor effects', summary: 'Add the deterministic effects pack for composition', ready: { passed: 5, total: 6 } },
  { id: 'text-effects', name: 'consolidate-text-effects', project: 'tone-tempo', stage: 'review', branch: 'ink-356', summary: 'One shared text-effects module for all three consumers', ready: { passed: 6, total: 6 } },
  { id: 'feed-content', name: 'post-content-union', project: 'tone-tempo', stage: 'ship', branch: 'ink-372', summary: 'Post content model (video/photos/text/article-link)', ready: { passed: 7, total: 7 } },
  { id: 'trust-tiers', name: 'trust-tier-defaults', project: 'tone-tempo', stage: 'ship', branch: 'ink-379', summary: 'Default trust-tier weighting for streak constructs', ready: { passed: 5, total: 5 } },
];

// ── chain stack: the goals in a chain, for the sidebar navigator ──
// Shown in the left rail whenever the current workspace belongs to a chain, so
// you can move across the chain (shipped → active → planned) in one click.
export type ChainNodeStatus = 'shipped' | 'active' | 'planned';
export interface ChainStackNode {
  goalId: string;
  title: string;
  phase: Stage | 'planned';
  status: ChainNodeStatus;
  wsId?: string;                 // backing workspace, if one exists (navigable)
  branch?: string;
  ready?: { passed: number; total: number };
  note?: string;                 // e.g. 'repo pruned · base kept', 'not started'
}
export interface ChainStack { id: string; title: string; nodes: ChainStackNode[] }

export const CHAIN_STACKS: ChainStack[] = [
  {
    id: 'chain-editor-effects',
    title: 'Editor effects pipeline',
    nodes: [
      { goalId: 'g1', title: 'Effect type system', phase: 'ship', status: 'shipped', wsId: 'effects-pack', branch: 'ink-357', ready: { passed: 6, total: 6 }, note: 'shipped · base kept' },
      { goalId: 'g2', title: 'Consolidate text effects', phase: 'review', status: 'active', wsId: 'text-effects', branch: 'ink-356', ready: { passed: 6, total: 6 } },
      { goalId: 'g3', title: 'Share renderer migration', phase: 'planned', status: 'planned', note: 'unblocks when g2 ships' },
    ],
  },
];

// the chain the given workspace belongs to (with the current node marked), or null
export function chainForWorkspace(wsId: string): { chain: ChainStack; currentGoalId: string } | null {
  for (const chain of CHAIN_STACKS) {
    const node = chain.nodes.find((n) => n.wsId === wsId);
    if (node) return { chain, currentGoalId: node.goalId };
  }
  return null;
}

let n = 0;
const id = (p: string) => `${p}-${n++}`;

// ── PLAN: goal doc + review-gated workflow + the agent that authored it ──
export const planGoalBlocks: Block[] = [
  { id: id('b'), type: 'markdown', data: { text: '## Objective\n\nRender the profile screen at **128 BPM** from the shared profile model, so later UI and tests build on one source of truth.\n\n## Non-goals\n\nStorybook coverage. Article-link rendering. Camera capture.' } },
  { id: id('b'), type: 'callout', data: { tone: 'info', title: 'Intent & gameability contract', text: 'Done means `app.json` profile (displayName, tempo) flows through the renderer to a real summary screen. **Fail** if old per-screen tempo constants survive behind new names.' } },
];
export const planWorkflowBlocks: Block[] = [
  { id: id('b'), type: 'markdown', data: { text: '### Phase 1 — Shared profile model' } },
  { id: id('b'), type: 'checklist', data: { items: [
    { text: 'There is a single profile model consumed by the renderer', done: true, evidence: 'note' },
    { text: 'tempo ≤ 0 clamps to 1 BPM (no throw)', done: true, evidence: 'command' },
    { text: 'No duplicate legacy tempo constants remain', done: false, evidence: 'review' },
  ] } },
  { id: id('b'), type: 'markdown', data: { text: '### Phase 2 — Render + verify' } },
  { id: id('b'), type: 'checklist', data: { items: [
    { text: 'Summary screen shows name + "128 BPM" from the model', done: false, evidence: 'screenshot' },
    { text: 'verify:profile-model exits zero', done: false, evidence: 'command' },
  ] } },
  { id: id('b'), type: 'callout', data: { tone: 'warning', title: 'Reviewer gate', text: 'Fail if UI shows the tempo but the handoff payload is unchanged. Fail if decisive evidence is only "tests green" or an implementer summary.' } },
];
export const planAgentBlocks: Block[] = [
  { id: id('b'), type: 'agent-node', data: { role: 'Planner', model: 'sonnet-4.6', status: 'done', tokens: 18240, cost: 0.091, intent: 'Grounded the plan in app.json + the current renderer; extracted the gameability contract.' } },
  { id: id('b'), type: 'agent-node', data: { role: 'Planner', model: 'sonnet-4.6', status: 'running', intent: 'Drafting Phase 2 reviewer rubric from the goal doc.', tool: 'skill · review-gated-implementation' } },
];

// ── CODE: native transcript + run-graph + phase gate ──
export const codeTranscriptBlocks: Block[] = [
  { id: id('b'), type: 'agent-node', data: { role: 'Implementer', model: 'sonnet-4.6', status: 'done', tokens: 42110, cost: 0.21, intent: 'Phase 1: introduced the shared profile model + clamp.', tool: 'edit · src/profile/model.ts' } },
  { id: id('b'), type: 'diff', data: { file: 'src/profile/model.ts', lines: [
    { kind: 'hunk', text: '@@ -1,4 +1,9 @@' },
    { kind: 'ctx', text: 'export interface Profile {', ln: 1 },
    { kind: 'add', text: '  displayName: string;', ln: 2 },
    { kind: 'add', text: '  tempo: number; // clamped ≥ 1', ln: 3 },
    { kind: 'ctx', text: '}', ln: 4 },
    { kind: 'add', text: 'export const clampTempo = (n: number) => Math.max(1, n);', ln: 5 },
  ] } },
  { id: id('b'), type: 'agent-node', data: { role: 'Review-gate', model: 'sonnet-4.6', status: 'running', intent: 'Verifying Phase 1 evidence against the rubric — checking no legacy constants survive.', tool: 'bash · rg "BPM_CONST"' } },
];
export const codeRunGraph: Block = { id: id('b'), type: 'run-graph', data: {
  recipe: 'review-gated implementation',
  recipePath: '.gitspace/workflows/recipes/review-gated',
  rollup: ['9 agents', '142k tok', '$0.84', '2m11s'],
  phases: [
    { phase: 'implement', barrier: 'complete', nodes: [
      { role: 'implementer', status: 'done', target: 'HapticsPlugin.swift',
        meta: [{ label: 'model', value: 'sonnet' }, { label: 'tok', value: '31k' }, { value: '+142 −0' }],
        tags: [{ label: 'review-gated', kind: 'recipe' }] },
    ] },
    { phase: 'collect evidence', barrier: 'pipeline() · barrier', nodes: [
      { role: 'run · verify:haptics', status: 'done',
        meta: [{ label: 'exit', value: '0' }, { value: '1.2s' }], tags: [{ label: 'CommandResult', kind: 'schema' }] },
      { role: 'capture · device.mp4', status: 'done',
        meta: [{ value: '6.1 MB' }, { value: 'real hardware', tone: 'acc' }], tags: [{ label: 'Evidence', kind: 'schema' }] },
    ] },
    { phase: 'review-gate', barrier: 'parallel() · 3 wide', fan: 'out', nodes: [
      { role: 'reviewer', status: 'running', target: 'intent',
        meta: [{ label: 'model', value: 'opus' }, { label: 'tok', value: '19k' }, { value: 'target-shape · running', tone: 'acc' }],
        tags: [{ label: 'review-gated', kind: 'recipe' }, { label: 'Findings', kind: 'schema' }] },
      { role: 'reviewer', status: 'running', target: 'boundary',
        meta: [{ label: 'model', value: 'opus' }, { label: 'tok', value: '22k' }, { value: 'protected surfaces · running', tone: 'acc' }],
        tags: [{ label: 'review-gated', kind: 'recipe' }, { label: 'Findings', kind: 'schema' }] },
      { role: 'reviewer', status: 'done', target: 'proxy-trap',
        meta: [{ label: 'model', value: 'opus' }, { label: 'tok', value: '15k' }, { value: '1 finding' }],
        tags: [{ label: 'review-gated', kind: 'recipe' }, { label: 'Findings', kind: 'schema' }] },
    ] },
    { phase: 'adjudicate', barrier: 'fan-in · pending', fan: 'in', nodes: [
      { role: 'orchestrator', status: 'pending', dim: true,
        meta: [{ value: 'queued — owns PASS / FINDINGS on majority', tone: 'dim' }],
        tags: [{ label: 'Verdict', kind: 'schema' }] },
    ] },
  ],
} };
export const codeGateBlocks: Block[] = [
  { id: id('b'), type: 'verdict-chip', data: { verdict: 'partial', label: 'Phase 1 — awaiting gate', confidence: 'med' } },
  { id: id('b'), type: 'evidence', data: { name: 'verify:profile-model', source: 'captured', meta: 'exit 0 · 412ms', ref: { kind: 'inline', mime: 'text/plain', text: '$ bun run verify:profile-model\nprofile model ok: Demo Runner @ 128 bpm' } } },
];

// ── REVIEW: guide + commit staging + diff + verdicts ──
export const reviewGuideBlock: Block = { id: id('b'), type: 'guide', data: { sections: [
  { title: 'Shared effects module replaces 3 duplicates', signal: 'core', rationale: 'The load-bearing change: `scramble`/`writeOut` now resolve to one module. **All three** prior call sites updated.', anchors: ['src/effects/index.ts:1-40', 'src/editor/Scramble.ts:12'] },
  { title: 'Deterministic-over-frame guarantee', signal: 'core', rationale: 'Effects are pure over the frame clock — repeated runs produce identical output.', anchors: ['src/effects/frame.ts:8-44'] },
  { title: 'Generated barrel + import churn', signal: 'noise', rationale: 'Mechanical re-exports; safe to skim.', anchors: ['src/effects/generated.ts'] },
] } };
export const reviewDiffBlock: Block = { id: id('b'), type: 'diff', data: { file: 'src/effects/index.ts', lines: [
  { kind: 'hunk', text: '@@ -1,6 +1,3 @@' },
  { kind: 'del', text: 'import { scrambleA } from "./a";', ln: 1 },
  { kind: 'del', text: 'import { scrambleB } from "./b";', ln: 2 },
  { kind: 'add', text: 'export { scramble, writeOut } from "./core";', ln: 1 },
] } };
export const reviewVerdictBlocks: Block[] = [
  { id: id('b'), type: 'verdict-chip', data: { verdict: 'pass', label: 'Single source of truth', confidence: 'high' } },
  { id: id('b'), type: 'verdict-chip', data: { verdict: 'partial', label: 'Visual behavior preserved', severity: 'low', confidence: 'med' } },
];
export interface StagedFile { path: string; git: 'M' | 'U' | 'A' | 'D'; adds: number; dels: number; staged: boolean; }
export const reviewStaged: StagedFile[] = [
  { path: 'src/effects/core.ts', git: 'A', adds: 88, dels: 0, staged: true },
  { path: 'src/effects/index.ts', git: 'M', adds: 3, dels: 12, staged: true },
  { path: 'src/editor/Scramble.ts', git: 'M', adds: 2, dels: 9, staged: false },
  { path: 'src/effects/generated.ts', git: 'M', adds: 40, dels: 40, staged: false },
];

// ── SHIP: deploy + cron + roll-up ──
export const shipBlocks: Block[] = [
  { id: id('b'), type: 'verdict-chip', data: { verdict: 'pass', label: 'Merged — review passed', confidence: 'high' } },
  { id: id('b'), type: 'callout', data: { tone: 'success', title: 'Post-merge', text: 'Repo checkout can be pruned to reclaim disk — **artifacts and `base` are kept** so search/scripts still run on demand.' } },
  { id: id('b'), type: 'code', data: { lang: 'bash', text: '$ gssh ship deploy --script deploy/staging.sh\n✓ build  ✓ migrate  ✓ smoke\ndeployed tone-tempo@ink-372 → staging' } },
];
export interface CronJob { name: string; schedule: string; last: string; status: 'ok' | 'pending' | 'failed'; }
export const shipCrons: CronJob[] = [
  { name: 'feed-content smoke', schedule: '0 */6 * * *', last: '2h ago', status: 'ok' },
  { name: 'trust-tier drift check', schedule: '0 9 * * 1', last: 'Mon 09:00', status: 'ok' },
  { name: 'article-link health', schedule: '*/30 * * * *', last: '12m ago', status: 'pending' },
];
export interface ShippedRoll { name: string; merged: string; artifacts: number; repoOnDisk: boolean; }
export const shippedRollup: ShippedRoll[] = [
  { name: 'post-content-union', merged: '3d ago', artifacts: 5, repoOnDisk: true },
  { name: 'trust-tier-defaults', merged: '6d ago', artifacts: 4, repoOnDisk: false },
  { name: 'share-extension-target', merged: '9d ago', artifacts: 6, repoOnDisk: false },
];

// ── ship: composable gitspace-mini-app canvas ──────────────────────────────
// A panel hosts a gitspace-mini-app (generalised from the mockup apps). The app
// is pure presentation; it reads a DATA artifact that a WORKFLOW refreshes on a
// TRIGGER. App + data + workflow + trigger are all artifacts, fully decoupled.
export type ShipPanelSize = 'half' | 'full';
export interface ShipPanel {
  id: string;
  app: string;            // gitspace-mini-app id (registry key)
  title: string;
  artifact: string;       // the app artifact handle
  data: string;           // the data artifact the app reads
  size: ShipPanelSize;
  scope: 'workspace' | 'chain';
  source?: string;        // the workflow that refreshes the data
  updated?: string;       // data freshness
}

// data artifacts the mini-apps render ----------------------------------------
export interface MetricTile { label: string; value: string; delta?: string; tone?: 'up' | 'down' | 'flat' }
export const opsBoardData: MetricTile[] = [
  { label: 'MRR', value: '$12.4k', delta: '+6.1%', tone: 'up' },
  { label: 'Weekly active', value: '3,820', delta: '+2.4%', tone: 'up' },
  { label: 'Effects rendered / day', value: '48.1k', delta: '+11%', tone: 'up' },
  { label: 'Share conversion', value: '4.7%', delta: '−0.3%', tone: 'down' },
];

export interface SloRow { criterion: string; target: string; current: string; verdict: RubricVerdict; trend: number[] }
export const sloData: SloRow[] = [
  { criterion: 'Render p95 latency', target: '< 80ms', current: '61ms', verdict: 'pass', trend: [70, 66, 64, 68, 61, 59, 61] },
  { criterion: 'Deterministic across deploys', target: '100% golden', current: '100%', verdict: 'pass', trend: [100, 100, 100, 100, 100, 100, 100] },
  { criterion: 'No legacy import regressions', target: '0 imports', current: '0', verdict: 'pass', trend: [2, 1, 1, 0, 0, 0, 0] },
  { criterion: 'Share funnel healthy', target: '> 5%', current: '4.7%', verdict: 'partial', trend: [5.4, 5.2, 5.1, 4.9, 5.0, 4.8, 4.7] },
];

export type TriggerKind = 'cron' | 'manual' | 'event';
export type TriggerStatus = 'ok' | 'pending' | 'failed' | 'idle';
export interface TriggerRun { type: 'skill' | 'workflow' | 'command'; ref: string; prompt?: string }
export interface SideEffectGrant { grant: string; needsApproval: boolean }
export interface Trigger {
  id: string; name: string; kind: TriggerKind; when: string; scope: 'workspace' | 'project';
  does: string;                  // one-line intent
  runs: TriggerRun;              // the work: command / skill / workflow (+ prompt)
  reads: string[];              // inputs it consumes
  writes: string[];             // artifacts it is ALLOWED to mutate (capability scope)
  sideEffects: SideEffectGrant[]; // external grants beyond data (PR / email / deploy)
  feeds: string[];              // dashboards/panels that consume its output
  status: TriggerStatus;
  last: string; next?: string; cost?: string;
  history: ('ok' | 'fail' | 'pending')[];
}
export const triggers: Trigger[] = [
  { id: 'tr-ops', name: 'posthog-stripe-sync', kind: 'cron', when: 'every 6h', scope: 'workspace',
    does: 'Pull PostHog events + Stripe revenue, refresh the growth board.',
    runs: { type: 'skill', ref: 'ops-board-sync', prompt: `Refresh the growth board for this workspace.

1. Pull the last 7 days of PostHog funnels for "share_started → share_completed" and the "editor_open" cohort.
2. Pull Stripe MRR and active subscriber count as of now.
3. Compute week-over-week deltas for each tile; set tone up/down/flat.
4. Write ONLY data/ops-board.data.json (shape: MetricTile[]).

Do not infer numbers — every value must trace to a fetched response. If a source is unreachable, keep the prior value and mark it stale rather than guessing.` },
    reads: ['posthog.api', 'stripe.api'], writes: ['data/ops-board.data.json'], sideEffects: [], feeds: ['Growth & revenue'],
    status: 'ok', last: '2h ago', next: 'in 4h', cost: '1.2k tok · $0.03', history: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'] },
  { id: 'tr-sweep', name: 'weekly-feature-sweep', kind: 'cron', when: 'Mon 09:00', scope: 'workspace',
    does: 'Click through the shipped feature, collect fresh evidence it still works.',
    runs: { type: 'workflow', ref: 'verify-feature', prompt: `Confirm the shipped feature still works on staging and record the evidence.

1. Open staging, sign in as the demo user, and drive the feature end-to-end (the same flow the goal's rubric describes).
2. Capture a screenshot and the pass/fail result for each rubric criterion that is marked "monitor post-ship".
3. Measure render p95 over the run.
4. Append a dated entry to data/slo.data.json and drop captures under evidence/weekly/.

If any criterion fails, set its SLO verdict to red and stop — do not auto-remediate.` },
    reads: ['app.staging'], writes: ['data/slo.data.json', 'evidence/weekly/'], sideEffects: [], feeds: ['Operational SLOs'],
    status: 'ok', last: 'Mon 09:00', next: 'Mon 09:00', cost: '8.4k tok · $0.21', history: ['ok', 'ok', 'fail', 'ok', 'ok'] },
  { id: 'tr-funnel', name: 'share-funnel-watch', kind: 'event', when: 'on new share', scope: 'workspace',
    does: 'Probe the share funnel and update the SLO trend.',
    runs: { type: 'skill', ref: 'funnel-probe' },
    reads: ['posthog.api'], writes: ['data/slo.data.json'], sideEffects: [], feeds: ['Operational SLOs'],
    status: 'pending', last: '18m ago', cost: '0.4k tok · $0.01', history: ['ok', 'ok', 'pending'] },
  { id: 'tr-roll', name: 'chain-rollup', kind: 'event', when: 'when all chain goals ship', scope: 'project',
    does: 'Roll up each shipped workspace dashboard into the project.',
    runs: { type: 'workflow', ref: 'chain-rollup' },
    reads: ['chain/*/dashboards/'], writes: ['data/rollup.json', 'dashboards/'], sideEffects: [{ grant: 'promote-artifacts', needsApproval: true }], feeds: ['Chain roll-up'],
    status: 'idle', last: '—', history: [] },
  { id: 'tr-outreach', name: 'outreach-blast', kind: 'manual', when: 'manual', scope: 'workspace',
    does: 'Email the waitlist about the feature we just shipped.',
    runs: { type: 'skill', ref: 'campaign-send', prompt: `Run the launch outreach for the feature we just shipped.

1. Segment the waitlist from Stripe customers by trust tier (free / pro / team).
2. Draft a per-tier email from copy/launch.md — keep the shipped feature's one-line value prop at the top.
3. Render a preview for each tier and write data/campaign.data.json (recipients, subject, open/click placeholders).
4. HOLD: do not send. Surface the drafts for human approval; only send the tiers a human checks off.

Never email anyone outside the waitlist segment.` },
    reads: ['stripe.customers', 'copy/launch.md'], writes: ['data/campaign.data.json'], sideEffects: [{ grant: 'send-email', needsApproval: true }], feeds: ['Outreach'],
    status: 'ok', last: '3d ago', cost: '3.1k tok · $0.11', history: ['ok', 'ok'] },
  { id: 'tr-svc', name: 'nightly-render-bench', kind: 'cron', when: 'nightly 02:00', scope: 'project',
    does: 'Start the render-worker service, run the benchmark, then stop it. (rolled up: runs against base/main, latest pull)',
    runs: { type: 'command', ref: 'gssh service start render-worker && bun run bench' },
    reads: ['base/main'], writes: ['data/bench.data.json'], sideEffects: [{ grant: 'start-service', needsApproval: false }], feeds: ['Reliability'],
    status: 'ok', last: '02:00', next: 'in 9h', cost: '—', history: ['ok', 'ok', 'fail', 'ok'] },
];

// skills a trigger can run — reusable artifacts (SKILL.md), longer than the prompt.
// The prompt is the per-trigger instruction; the skill is the shared capability.
export interface SkillDef { name: string; summary: string; body: string }
export const SKILLS: Record<string, SkillDef> = {
  'ops-board-sync': {
    name: 'ops-board-sync', summary: 'Refresh a metrics-board data artifact from PostHog + Stripe.',
    body: `# ops-board-sync

Keeps a growth/revenue board's data artifact current from analytics + billing.

## When to use
A cron that should keep a metrics board fresh without a human in the loop.

## Inputs
- posthog.api — PostHog personal API key (from secrets), read scope
- stripe.api — Stripe restricted key, read scope

## Output
- one *.data.json shaped as MetricTile[] — { label, value, delta, tone }

## Rules
- Read-only on every external service; never write back to PostHog/Stripe.
- Never fabricate values — each tile must trace to a fetched response.
- Idempotent: the same time window must produce the same output.
- On a source error, keep the prior value and mark it stale; do not drop the tile.` },
  'funnel-probe': {
    name: 'funnel-probe', summary: 'Probe a single funnel and update one SLO row.',
    body: `# funnel-probe

Event-triggered probe that recomputes one funnel SLO when activity happens.

## When to use
On a high-signal event (e.g. a new share) where you want the SLO trend to react quickly.

## Inputs
- posthog.api (read)

## Output
- patches a single row of *.slo.data.json (current value + appends to trend)

## Rules
- Touch only the one SLO row you own; never rewrite the whole file.
- Cheap + fast — this runs on every event.` },
  'campaign-send': {
    name: 'campaign-send', summary: 'Draft tiered outreach and hold for approval before sending.',
    body: `# campaign-send

Drafts and (after approval) sends an outreach campaign tied to shipped work.

## When to use
Manual launch outreach — a campaign that acts on what a workspace just shipped.

## Inputs
- stripe.customers (read) — for segmentation
- copy/*.md — the message source

## Output
- data/campaign.data.json (drafts, segments, send status)

## Side-effects (require grant)
- send-email — GATED: drafts are produced first; nothing sends without explicit human approval per segment.

## Rules
- Never email outside the named segment.
- Personalize by tier; keep the value prop first.
- Record every send for the report.` },
};

// chain roll-up: each shipped workspace contributes its own dashboard ---------
export interface RollupNode {
  workspace: string; goal: string; shipped: string; repo: 'on-disk' | 'pruned';
  tiles: MetricTile[]; dashboards: number;
}
export const rollupData: RollupNode[] = [
  { workspace: 'add-effects-pack', goal: 'Effect type system', shipped: '6d ago', repo: 'pruned', dashboards: 2, tiles: [{ label: 'effects/day', value: '48.1k', delta: '+11%', tone: 'up' }, { label: 'render p95', value: '61ms', tone: 'flat' }] },
  { workspace: 'consolidate-text-effects', goal: 'Consolidate text effects', shipped: 'just now', repo: 'on-disk', dashboards: 1, tiles: [{ label: 'dupes', value: '0', delta: '−3', tone: 'up' }, { label: 'consumers', value: '3/3', tone: 'flat' }] },
];

// the canvas: which mini-apps are placed and how big --------------------------
export const shipCanvas: ShipPanel[] = [
  { id: 'p-ops', app: 'ops-board', title: 'Growth & revenue', artifact: 'ops-board.app', data: 'ops-board.data.json', size: 'half', scope: 'workspace', source: 'posthog-stripe-sync', updated: '2h ago' },
  { id: 'p-slo', app: 'slo-rubric', title: 'Operational SLOs', artifact: 'slo-rubric.app', data: 'slo.data.json', size: 'half', scope: 'workspace', source: 'weekly-feature-sweep', updated: '18m ago' },
  { id: 'p-rollup', app: 'chain-rollup', title: 'Chain roll-up · Editor effects pipeline', artifact: 'chain-rollup.app', data: 'rollup.json', size: 'full', scope: 'chain', source: 'chain-rollup', updated: 'on ship' },
  { id: 'p-crons', app: 'crons-triggers', title: 'Crons & triggers', artifact: 'triggers.component', data: 'triggers.json', size: 'full', scope: 'workspace' },
];

export interface ShipAppDef { app: string; title: string; blurb: string; scope: 'workspace' | 'chain' }
export const SHIP_APP_PALETTE: ShipAppDef[] = [
  { app: 'ops-board', title: 'Metrics board', blurb: 'PostHog + Stripe tiles, refreshed on a cron', scope: 'workspace' },
  { app: 'slo-rubric', title: 'Operational SLOs', blurb: 'ops criteria re-judged on a schedule, with trend', scope: 'workspace' },
  { app: 'chain-rollup', title: 'Chain roll-up', blurb: 'per-workspace dashboards across the chain', scope: 'chain' },
  { app: 'crons-triggers', title: 'Crons & triggers', blurb: 'the control plane: trigger → workflow → data', scope: 'workspace' },
  { app: 'campaign', title: 'Outreach campaign', blurb: 'a workflow that acts on what you shipped', scope: 'workspace' },
];

// resolve a data artifact id → its mock data (the app ⇄ data seam)
export const SHIP_DATA: Record<string, unknown> = {
  'ops-board.data.json': opsBoardData,
  'slo.data.json': sloData,
  'rollup.json': rollupData,
  'triggers.json': triggers,
};

// ── shell: explorer tree, terminal, notes, events ──
export const explorerTree: FileNode[] = [
  { name: 'src', path: 'src', kind: 'dir', depth: 0 },
  { name: 'app.json', path: 'src/app.json', kind: 'file', depth: 1, git: 'M' },
  { name: 'components', path: 'src/components', kind: 'dir', depth: 1 },
  { name: 'Profile.tsx', path: 'src/components/Profile.tsx', kind: 'file', depth: 2, git: 'U' },
  { name: 'plugins', path: 'src/plugins', kind: 'dir', depth: 1 },
  { name: 'HapticsPlugin.swift', path: 'src/plugins/HapticsPlugin.swift', kind: 'file', depth: 2, git: 'M' },
  { name: 'scripts', path: 'scripts', kind: 'dir', depth: 0 },
  { name: 'verify-haptics.ts', path: 'scripts/verify-haptics.ts', kind: 'file', depth: 1, git: 'M' },
  { name: 'package.json', path: 'package.json', kind: 'file', depth: 0 },
];

export interface TermLine { text: string; tone?: 'g' | 'p' | 'dim' }
export const termLines: TermLine[] = [
  { text: '$ bun run verify:haptics' },
  { text: 'haptics plugin ok: 3 patterns registered on main thread', tone: 'g' },
  { text: '$ git add src/plugins/HapticsPlugin.swift', tone: 'dim' },
  { text: '[ink-366 a1c4f2] Verify haptics on device', tone: 'p' },
  { text: '$ \u2588' },
];

export interface NoteItem { title: string; sub: string; dirty?: boolean; body: string }
export const notesList: NoteItem[] = [
  { title: 'Main-thread blocking', sub: 'editing · just now', dirty: true, body: 'Haptics must register on the main thread or the first pattern drops.\n\nverify:haptics should assert this before we mark the requirement accepted.' },
  { title: 'Custom pattern path', sub: '2h ago', body: 'Either implement real Core Haptics custom patterns or remove the fake path — no half-wired stub.' },
  { title: 'Notification feedback rubric', sub: 'yesterday', body: 'Rubric: notification feedback works AND the named first surfaces are migrated off raw waveforms.' },
];

export interface EventItem { time: string; tone: 'green' | 'blue' | 'amber' | 'dim'; text: string }
export const eventLog: EventItem[] = [
  { time: '14:22', tone: 'green', text: 'Phase 1 evidence accepted · verify:haptics exit 0' },
  { time: '14:21', tone: 'blue', text: 'review-gate started · parallel() · 3 reviewers' },
  { time: '14:18', tone: 'amber', text: 'reviewer · proxy-trap flagged symbol-only proof' },
  { time: '14:05', tone: 'dim', text: 'workspace haptics-plugin created from ink-366' },
];

// ── agent chat: native transcript (tool cards + composer) ──
export type TranscriptItem =
  | { kind: 'msg'; who: 'you' | 'agent'; text: string; tag?: string }
  | { kind: 'tool'; tool: string; target?: string; targetDim?: boolean; status: 'done' | 'running' | 'fallback'; meta?: string; diff?: DiffLine[]; note?: string; handoff?: boolean };

export const agentTranscript: TranscriptItem[] = [
  { kind: 'msg', who: 'you', text: 'Verify the haptics plugin registers patterns on the main thread. Don\u2019t accept symbol-only proof — run it on a real device.', tag: 'workflow' },
  { kind: 'tool', tool: 'read', target: 'src/plugins/HapticsPlugin.swift', status: 'done', meta: '214 lines · 40ms' },
  { kind: 'tool', tool: 'edit', target: 'src/plugins/HapticsPlugin.swift', status: 'done', meta: '+6 −1 · 120ms', diff: [
    { kind: 'ctx', ln: 71, text: 'func register(_ patterns: [HapticPattern]) {' },
    { kind: 'add', ln: 72, text: '  precondition(Thread.isMainThread, "register off main thread")' },
    { kind: 'ctx', ln: 73, text: '  engine.register(patterns)' },
  ] },
  { kind: 'tool', tool: 'device_probe', target: 'unregistered tool → generic renderer', targetDim: true, status: 'fallback', meta: '88ms' },
  { kind: 'tool', tool: 'eval', target: 'workflow · review-gated · 4 phases · 9 agents', status: 'running', handoff: true, note: 'Fan-out orchestration → see the Workflow tab ↗' },
  { kind: 'msg', who: 'agent', text: 'Phase 1 evidence captured (verify:haptics exit 0 + device.mp4). review-gate is running 3 reviewers in parallel; proxy-trap already returned 1 finding.' },
];

// ── explorer · artifacts mode ──
export type ArtifactPane = 'goal' | 'workflow' | 'review' | 'rubric' | 'notes' | 'events';
export interface ArtifactRow { group: string; icon: string; label: string; meta?: string; pane: ArtifactPane; ev?: string }
export const artifactTree: ArtifactRow[] = [
  { group: 'Goal', icon: '◇', label: 'goal.md', meta: 'doc', pane: 'goal' },
  { group: 'Goal', icon: '⛓', label: 'chain · 3 goals', meta: '2 of 3', pane: 'goal' },
  { group: 'Goal', icon: '☰', label: '4 requirements', meta: 'rubric', pane: 'rubric' },
  { group: 'Mockups', icon: '▦', label: 'effect-preview', meta: 'mini-app · agentation', pane: 'goal' },
  { group: 'Workflow', icon: '⟜', label: 'review-gated', meta: 'run · live', pane: 'workflow' },
  { group: 'Evidence', icon: '▸', label: 'effects.spec.ts', meta: 'exit 0', pane: 'rubric', ev: 'art-effects-spec' },
  { group: 'Evidence', icon: '▤', label: 'migration walkthrough', meta: '0:42', pane: 'rubric', ev: 'art-migrate-clip' },
  { group: 'Events', icon: '⚑', label: 'event log', pane: 'events' },
];

// ── review · findings (verdict + diff + thread + route-to-agent) ──
export interface ReviewThread { who: string; agent?: boolean; text: string }
export interface ReviewFinding { verdict: 'fail' | 'warn' | 'pass'; severity: string; title: string; diff?: DiffLine[]; thread?: ReviewThread; jump?: string }
export const reviewFindings: ReviewFinding[] = [
  { verdict: 'fail', severity: 'bug · high', title: 'Scramble.ts still imports the per-file effect', diff: [
    { kind: 'ctx', ln: 11, text: 'import { writeOut } from "../effects";' },
    { kind: 'del', ln: 12, text: 'import { scrambleB } from "./b"; // legacy' },
    { kind: 'add', ln: 12, text: 'import { scramble } from "../effects";' },
  ], thread: { who: 'reviewer · adversarial-verify ✓ 3/3', agent: true, text: 'Scramble.ts still pulls the per-file scramble — the “single source of truth” claim is violated here. Confirmed reproducible.' } },
  { verdict: 'warn', severity: 'nit', title: 'generated barrel re-exports unsorted — name the order rule', jump: 'src/effects/generated.ts ↗' },
];

// ── review · rubric (criterion → evidence → judgements → score) — the contract ──
// Each criterion owns its evidence (linked by artifact ref, shared with the artifact
// store) and a panel of judgements. A judgement is cast by a judge of some type:
//   command → a check ran (test/grep), llm → a final agent review eval, human → you.
// Human-gated criteria carry awaitingHuman until a person records a verdict.
export type RubricVerdict = 'pass' | 'fail' | 'partial' | 'pending';
export type JudgeType = 'human' | 'llm' | 'command';
export type EvidenceKind = 'command' | 'screenshot' | 'video' | 'review' | 'note' | 'file';

// snapshots are referenced by artifact id and resolved to an inline preview —
// not linked out. A captured frame, inlined as a tiny self-contained image.
const snap = (label: string, tint: string): ArtifactRef => ({
  kind: 'image', mime: 'image/svg+xml', width: 480, height: 270, bytes: 18432,
  dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">` +
    `<rect width="480" height="270" fill="#070707"/><rect x="0" y="0" width="480" height="26" fill="#0e0e0e"/>` +
    `<circle cx="14" cy="13" r="4" fill="${tint}"/><text x="30" y="17" fill="#8a8a8a" font-family="monospace" font-size="11">${label}</text>` +
    `<text x="24" y="150" fill="#e2e2e2" font-family="monospace" font-size="34">Demo Runner</text>` +
    `<text x="24" y="190" fill="${tint}" font-family="monospace" font-size="22">128 BPM</text>` +
    `<rect x="24" y="214" width="300" height="6" rx="3" fill="#141414"/><rect x="24" y="214" width="190" height="6" rx="3" fill="${tint}"/></svg>`),
});

export interface RubricEvidence {
  id: string;            // artifact ref — the snapshot's stable handle in the artifact store
  name: string;
  kind: EvidenceKind;
  source: 'captured' | 'asserted';
  meta?: string;
  ref: ArtifactRef;      // resolves to an inline preview (text/image/poster), never a bare link
}

export interface RubricJudgement {
  judge: string;         // 'you', 'review-gate · sonnet-4.6', 'verify:effects'
  type: JudgeType;
  verdict: RubricVerdict;
  score?: number;        // 0–100 confidence/quality this judge assigns
  note: string;
  at?: string;
  cites?: string[];      // evidence ids this judgement rests on
}

export interface RubricCriterion {
  id: string;
  criterion: string;
  rubric: string;        // what "done" means — the contract, plus the fail condition
  required: boolean;
  gate: JudgeType;       // who owns the verdict; 'human' ⇒ human-gated
  verdict: RubricVerdict;// rolled-up across judges
  score?: number;        // rolled-up 0–100
  evidence: RubricEvidence[];
  judgements: RubricJudgement[];
  awaitingHuman?: boolean;
}

export const reviewRubric: RubricCriterion[] = [
  {
    id: 'crit-single-module',
    criterion: 'One shared text-effects module used by all 3 consumers',
    rubric: 'Editor, Preview and Share all import from `effects/core`. **Fail** if any consumer keeps a private copy behind a new name.',
    required: true, gate: 'human', verdict: 'fail', score: 34,
    evidence: [
      { id: 'art-import-scan', name: 'grep · import scan', kind: 'command', source: 'captured', meta: 'rg "from \'./b\'" · 1 hit',
        ref: { kind: 'inline', mime: 'text/plain', text: '$ rg -n "from \'\\./b\'" src/effects\nsrc/effects/Scramble.ts:12:import { scramble } from \'./b\';\n\n1 file, 1 match — a private copy survives.' } },
      { id: 'art-scramble-diff', name: 'Scramble.ts:12', kind: 'file', source: 'captured', meta: 'still imports ./b',
        ref: { kind: 'path', path: 'src/effects/Scramble.ts:12', mime: 'text/x-typescript' } },
    ],
    judgements: [
      { judge: 'review-gate · sonnet-4.6', type: 'llm', verdict: 'fail', score: 30, at: '14:21', cites: ['art-import-scan'],
        note: 'Scramble.ts still imports the per-file effect — single-source contract is not met.' },
      { judge: 'proxy-trap · sonnet-4.6', type: 'llm', verdict: 'fail', score: 38, at: '14:21', cites: ['art-import-scan'],
        note: 'Confirmed via independent grep — one consumer kept a renamed private copy.' },
    ],
    awaitingHuman: true,
  },
  {
    id: 'crit-visual-preserved',
    criterion: 'Visual behavior preserved after migration',
    rubric: 'Rendered output is byte-identical to pre-migration for the golden inputs.',
    required: true, gate: 'command', verdict: 'pass', score: 96,
    evidence: [
      { id: 'art-effects-spec', name: 'effects.spec.ts', kind: 'command', source: 'captured', meta: 'exit 0 · 38 assertions',
        ref: { kind: 'inline', mime: 'text/plain', text: '$ bun test effects.spec.ts\n✓ scramble matches golden (12)\n✓ writeOut matches golden (14)\n✓ pulse matches golden (12)\n\n38 pass · 0 fail · 412ms' } },
      { id: 'art-summary-shot', name: 'summary screen', kind: 'screenshot', source: 'captured', meta: '480×270 · captured by agent',
        ref: snap('summary · render check', '#00ff66') },
    ],
    judgements: [
      { judge: 'verify:effects', type: 'command', verdict: 'pass', score: 100, at: '14:18', cites: ['art-effects-spec'],
        note: 'exit 0 — all golden assertions matched.' },
      { judge: 'review-gate · sonnet-4.6', type: 'llm', verdict: 'pass', score: 92, at: '14:21', cites: ['art-summary-shot'],
        note: 'Screenshot confirms the summary renders “128 BPM” from the shared model.' },
    ],
  },
  {
    id: 'crit-deterministic',
    criterion: 'Deterministic over the frame clock',
    rubric: 'Effects are a pure function of `(input, clock)` — same clock ⇒ same output.',
    required: true, gate: 'command', verdict: 'pass', score: 100,
    evidence: [
      { id: 'art-frame-test', name: 'frame.test.ts', kind: 'command', source: 'captured', meta: 'exit 0 · 1000 seeds',
        ref: { kind: 'inline', mime: 'text/plain', text: '$ bun test frame.test.ts\n✓ stable across 1000 frame seeds\n✓ no wall-clock reads in effects/*\n\n2 pass · 0 fail' } },
    ],
    judgements: [
      { judge: 'verify:determinism', type: 'command', verdict: 'pass', score: 100, at: '14:19', cites: ['art-frame-test'],
        note: 'exit 0 — identical output across 1000 seeded frame clocks.' },
    ],
  },
  {
    id: 'crit-no-legacy',
    criterion: 'No duplicate legacy implementations remain',
    rubric: 'Every legacy per-file effect is deleted. **Fail** if "tests are green" is the only proof — files must be gone.',
    required: true, gate: 'human', verdict: 'partial', score: 62,
    evidence: [
      { id: 'art-migrate-count', name: 'call-site migration', kind: 'command', source: 'captured', meta: '2 of 3 migrated',
        ref: { kind: 'inline', mime: 'text/plain', text: '$ gssh effects migrate --report\nEditor   ✓ migrated\nPreview  ✓ migrated\nShare    ✗ still on ./b\n\n2 of 3 call sites migrated.' } },
      { id: 'art-migrate-clip', name: 'migration walkthrough', kind: 'video', source: 'captured', meta: '0:42 · agent capture',
        ref: { kind: 'path', path: '.gitspace/.../migrate-consumers.mp4', mime: 'video/mp4' } },
    ],
    judgements: [
      { judge: 'review-gate · sonnet-4.6', type: 'llm', verdict: 'partial', score: 62, at: '14:21', cites: ['art-migrate-count'],
        note: 'Share consumer not yet migrated — one legacy import remains. Not done.' },
    ],
    awaitingHuman: true,
  },
];

// ── review · the PR as a story (scrollytelling walkthrough) ──
export interface WalkFile { path: string; lines: DiffLine[] }
export interface WalkComment { tone: 'fail' | 'warn' | 'info'; who: string; text: string }
export interface WalkStep { n: number; kind: string; title: string; what: string; why: string; files: WalkFile[]; comment?: WalkComment }
export const reviewWalkthrough: WalkStep[] = [
  { n: 1, kind: 'data types', title: 'Introduce the shared effect types',
    what: 'A new src/effects/types.ts defines Effect, EffectSpec, and FrameClock — the vocabulary the rest of the PR builds on.',
    why: 'Everything downstream (helpers, pipeline, UI) imports these; read them first and the rest of the diff reads itself.',
    files: [{ path: 'src/effects/types.ts   (new)', lines: [
      { kind: 'add', ln: 1, text: 'export interface FrameClock { frame: number; fps: number }' },
      { kind: 'add', ln: 2, text: '' },
      { kind: 'add', ln: 3, text: 'export interface EffectSpec {' },
      { kind: 'add', ln: 4, text: '  name: string;' },
      { kind: 'add', ln: 5, text: '  deterministic: true; // pure over the frame clock' },
      { kind: 'add', ln: 6, text: '}' },
      { kind: 'add', ln: 7, text: '' },
      { kind: 'add', ln: 8, text: 'export type Effect = (input: string, clock: FrameClock) => string;' },
    ] }] },
  { n: 2, kind: 'helpers + tests', title: 'One shared effects module',
    what: 'The two duplicated scramble/writeOut implementations collapse into src/effects/core.ts, with core.test.ts pinning determinism.',
    why: 'The load-bearing change — the single source of truth all three consumers will point at.',
    files: [
      { path: 'src/effects/core.ts   (new)', lines: [
        { kind: 'add', ln: 1, text: 'import type { Effect } from "./types";' },
        { kind: 'add', ln: 2, text: '' },
        { kind: 'add', ln: 3, text: 'export const scramble: Effect = (s, clock) =>' },
        { kind: 'add', ln: 4, text: '  shuffle(s, seed(clock.frame));' },
        { kind: 'add', ln: 5, text: '' },
        { kind: 'add', ln: 6, text: 'export const writeOut: Effect = (s, clock) =>' },
        { kind: 'add', ln: 7, text: '  s.slice(0, clock.frame);' },
      ] },
      { path: 'src/effects/core.test.ts   (new)', lines: [
        { kind: 'add', ln: 1, text: 'test("scramble is deterministic over the frame", () => {' },
        { kind: 'add', ln: 2, text: '  const c = { frame: 12, fps: 60 };' },
        { kind: 'add', ln: 3, text: '  expect(scramble("hello", c)).toBe(scramble("hello", c));' },
        { kind: 'add', ln: 4, text: '});' },
      ] },
    ] },
  { n: 3, kind: 'backend + test', title: 'Route the composition pipeline through core',
    what: 'The editor pipeline drops its private scrambleA import and composes via the shared module; the pipeline test asserts identical frames.',
    why: 'Proves the shared module behaves like the originals before any UI depends on it.',
    files: [{ path: 'src/editor/pipeline.ts', lines: [
      { kind: 'del', ln: 1, text: 'import { scrambleA } from "../effects/a";' },
      { kind: 'add', ln: 1, text: 'import { scramble } from "../effects/core";' },
      { kind: 'ctx', ln: 2, text: '' },
      { kind: 'ctx', ln: 3, text: 'export function compose(text, clock) {' },
      { kind: 'del', ln: 4, text: '  return scrambleA(text);' },
      { kind: 'add', ln: 4, text: '  return scramble(text, clock);' },
      { kind: 'ctx', ln: 5, text: '}' },
    ] }],
    comment: { tone: 'info', who: 'reviewer · intent ✓', text: 'Pipeline passes the frame clock through — matches the deterministic-over-frame requirement.' } },
  { n: 4, kind: 'frontend', title: 'Editor UI calls the shared effect',
    what: 'The editor component swaps its local scrambleB for the shared scramble.',
    why: 'Last consumer migrated — after this, no per-file effect should remain anywhere.',
    files: [{ path: 'src/components/Editor.tsx', lines: [
      { kind: 'del', ln: 14, text: 'import { scrambleB } from "../effects/b";' },
      { kind: 'add', ln: 14, text: 'import { scramble } from "../effects/core";' },
      { kind: 'ctx', ln: 15, text: '' },
      { kind: 'ctx', ln: 16, text: 'const out = useMemo(' },
      { kind: 'del', ln: 17, text: '  () => scrambleB(value),' },
      { kind: 'add', ln: 17, text: '  () => scramble(value, clock),' },
      { kind: 'ctx', ln: 18, text: '  [value, clock]);' },
    ] }],
    comment: { tone: 'fail', who: 'reviewer · adversarial-verify ✓ 3/3', text: 'But src/editor/Scramble.ts (a sibling) still imports ./b — the “single source of truth” claim is violated there.' } },
];

// ── goal doc as composed blocks (markdown · data-structure · mermaid · code-ref · tree · plan) ──
export const goalDocBlocks: Block[] = [
  { id: id('g'), type: 'intent', data: { quote: 'I keep finding the same scramble logic copy-pasted with subtle drift. I want ONE module everyone imports — and I never want a private copy sneaking back behind a new name.', source: 'you · kickoff', why: 'The north star: **single source of truth, enforced** — not just tidied once.' } },
  { id: id('g'), type: 'markdown', data: { text: '## Objective\n\nCollapse the three duplicated text-effects implementations into **one shared, deterministic module** that every consumer — the editor pipeline, the editor UI, and the share renderer — imports.\n\n## Non-goals\n\nNew effects. Changing visual output. The share-extension target (tracked separately).' } },
  { id: id('g'), type: 'callout', data: { tone: 'info', title: 'Gameability contract', text: 'Done means every consumer imports from `effects/core` and **no per-file effect remains**. Fail if a consumer keeps a private copy behind a new name, or if effects stop being deterministic over the frame clock.' } },
  { id: id('g'), type: 'markdown', data: { text: '## A pattern to follow\n\nThe `markdown-render` consolidation last quarter is the bar — one module, every caller migrated, dupes deleted.' } },
  { id: id('g'), type: 'code-ref', data: { path: 'src/render/markdown.ts', lines: '1-4', startLine: 1, exemplar: true, snippet: 'export const render: Renderer = (md, opts) =>\n  pipeline(md, opts);\n// one entrypoint — Editor, Preview, Share all import THIS', note: 'Good-work example: a single typed entrypoint, zero per-caller copies. Match this shape.' } },
  { id: id('g'), type: 'markdown', data: { text: '## Data model\n\nTwo small types carry the whole design — read these first.' } },
  { id: id('g'), type: 'data-structure', data: { name: 'FrameClock', lang: 'ts', fields: [
    { name: 'frame', type: 'number', note: 'current frame index' },
    { name: 'fps', type: 'number', note: 'frames per second' },
  ] } },
  { id: id('g'), type: 'data-structure', data: { name: 'Effect', lang: 'ts', fields: [
    { name: '(input, clock)', type: '(string, FrameClock) => string', note: 'a pure function of input + frame clock' },
  ], note: 'Determinism falls out of the type: the only inputs are the string and the clock.' } },
  { id: id('g'), type: 'markdown', data: { text: '## Architecture' } },
  { id: id('g'), type: 'mermaid', data: { title: 'One core, three consumers', code: 'graph LR\n  Editor["Editor.tsx"] --> Core\n  Pipeline["pipeline.ts"] --> Core\n  Scramble["Scramble.ts"] --> Core\n  Core["effects/core.ts"] --> Types["effects/types.ts"]\n  classDef hot fill:#001a0d,stroke:#00ff66,color:#00ff66;\n  class Core hot;' } },
  { id: id('g'), type: 'mermaid', data: { title: 'Determinism — identical inputs, identical frame', code: 'flowchart TD\n  A["input + FrameClock"] --> B["seed = seed(frame)"]\n  B --> C["shuffle (deterministic)"]\n  C --> D["output frame"]\n  D --> E{"same inputs?"}\n  E -->|yes| F["identical output ✓"]\n  E -->|no| G["different frame"]' } },
  { id: id('g'), type: 'markdown', data: { text: '## Feel it — interactive mock' } },
  { id: id('g'), type: 'mockup', data: { title: 'Effect preview', artifact: 'effect-preview.app', app: 'effect-preview' } },
  { id: id('g'), type: 'markdown', data: { text: '## What exists today\n\nThe duplication we are removing — two private, divergent copies:' } },
  { id: id('g'), type: 'code-ref', data: { path: 'src/editor/Scramble.ts', lines: '12-17', startLine: 12, snippet: 'import { scrambleB } from "./b";\n\nexport function scramble(text: string) {\n  // private copy — also lives in pipeline.ts\n  return scrambleB(text);\n}', note: 'Duplicate #1. The plan deletes this private copy and re-points it at core.' } },
  { id: id('g'), type: 'code-ref', data: { path: 'src/effects/a.ts', lines: '1-4', startLine: 1, snippet: 'export function scrambleA(s: string) {\n  // per-file impl — NOT frame-aware\n  return shuffleNonDeterministic(s);\n}', note: 'Duplicate #2 — not frame-aware. This is the determinism bug the shared module fixes.' } },
  { id: id('g'), type: 'boundaries', data: { items: [
    { surface: 'effects/index.ts public API', rule: 'Keep `scramble` / `writeOut` names + signatures — three call sites depend on them.' },
    { surface: 'visual output at frame N', rule: 'Pixels identical pre/post — this is a refactor, not a redesign.' },
    { surface: 'share-extension target', rule: 'Out of scope this goal — do not touch (it is goal 3 of the chain).' },
  ] } },
  { id: id('g'), type: 'anti-shortcut', data: { items: [
    { shortcut: 'Re-export the old per-file impls from core', why: 'Looks consolidated, but the duplicate logic still exists — the contract fails.' },
    { shortcut: '“tests are green” as the proof', why: 'Green tests do not prove `a.ts` / `b.ts` were deleted. Decisive evidence must show the files gone.' },
    { shortcut: 'Migrate 2 of 3 consumers and call it done', why: 'A surviving private copy is exactly the regression we are preventing.' },
  ] } },
  { id: id('g'), type: 'markdown', data: { text: '## Target structure' } },
  { id: id('g'), type: 'file-tree', data: { nodes: [
    { name: 'src/effects', path: 'src/effects', kind: 'dir', depth: 0 },
    { name: 'types.ts', path: 'src/effects/types.ts', kind: 'file', depth: 1, git: 'A' },
    { name: 'core.ts', path: 'src/effects/core.ts', kind: 'file', depth: 1, git: 'A' },
    { name: 'core.test.ts', path: 'src/effects/core.test.ts', kind: 'file', depth: 1, git: 'A' },
    { name: 'a.ts', path: 'src/effects/a.ts', kind: 'file', depth: 1, git: 'D' },
    { name: 'b.ts', path: 'src/effects/b.ts', kind: 'file', depth: 1, git: 'D' },
  ] } },
  { id: id('g'), type: 'markdown', data: { text: '## Implementation plan\n\nEach step cites the code it touches.' } },
  { id: id('g'), type: 'plan', data: { steps: [
    { title: 'Introduce the shared types', detail: 'Add `effects/types.ts` with `FrameClock` and `Effect` — the vocabulary everything else imports.', refs: ['src/effects/types.ts (new)'] },
    { title: 'One shared core + tests', detail: 'Collapse `scrambleA`/`scrambleB` into `effects/core.ts`; pin determinism in `core.test.ts`.', refs: ['src/effects/core.ts (new)', 'src/effects/core.test.ts (new)'] },
    { title: 'Route the pipeline through core', detail: 'Replace the private import in `pipeline.ts`; the pipeline test asserts identical frames.', refs: ['src/editor/pipeline.ts:1', 'src/editor/pipeline.test.ts'] },
    { title: 'Migrate the UI and delete the duplicates', detail: 'Point `Editor.tsx` and `Scramble.ts` at core, then **delete** `effects/a.ts` and `effects/b.ts`.', refs: ['src/components/Editor.tsx:14', 'src/editor/Scramble.ts:12', 'src/effects/a.ts', 'src/effects/b.ts'] },
  ] } },
  { id: id('g'), type: 'markdown', data: { text: '## Shape of the final evidence' } },
  { id: id('g'), type: 'evidence-shape', data: { items: [
    { requirement: 'All 3 consumers import effects/core', kind: 'command', captured: 'grep: 0 imports of effects/a|b outside core' },
    { requirement: 'Per-file impls deleted', kind: 'command', captured: 'git status shows a.ts + b.ts deleted' },
    { requirement: 'Deterministic over the frame clock', kind: 'test', captured: 'core.test.ts: same (text,frame) → same output' },
    { requirement: 'Visual output unchanged', kind: 'screenshot', captured: 'before/after frames identical at frame 7' },
  ] } },
  { id: id('g'), type: 'callout', data: { tone: 'warning', title: 'Risk', text: 'The migration is only complete when `effects/a.ts` and `effects/b.ts` are **deleted** — leaving them is how the “single source of truth” claim silently regresses.' } },
];

// ── goal chain: this goal's relationship to siblings (look up/down the chain) ──
export interface GoalChainDoc { id: string; title: string; status: 'shipped' | 'active' | 'planned'; blocks: Block[] }
const goalDocG1: Block[] = [
  { id: id('g1'), type: 'intent', data: { quote: 'The effect types should be tiny and obvious — two interfaces and you understand the whole system.', source: 'you · planning' } },
  { id: id('g1'), type: 'markdown', data: { text: '## Objective\n\nLand the shared `Effect` / `FrameClock` type system the rest of the chain builds on.' } },
  { id: id('g1'), type: 'callout', data: { tone: 'success', title: 'Shipped', text: 'Merged in ink-340 — downstream goals import these types.' } },
];
const goalDocG3: Block[] = [
  { id: id('g3'), type: 'intent', data: { quote: 'Once effects are shared, the share renderer should reuse them with zero copies.', source: 'you · planning' } },
  { id: id('g3'), type: 'markdown', data: { text: '## Objective\n\nPoint the share-extension renderer at `effects/core` and delete its private copy.' } },
  { id: id('g3'), type: 'callout', data: { tone: 'warning', title: 'Blocked', text: 'Planned — unblocks once **Consolidate text effects** (goal 2) lands and deletes the per-file impls.' } },
];
export const goalChain: GoalChainDoc[] = [
  { id: 'g1', title: 'Effect type system', status: 'shipped', blocks: goalDocG1 },
  { id: 'g2', title: 'Consolidate text effects', status: 'active', blocks: goalDocBlocks },
  { id: 'g3', title: 'Share renderer migration', status: 'planned', blocks: goalDocG3 },
];

// ── artifact search corpus: rated precedents + good/bad reports ──
export interface RatedPrecedent { label: string; surface: string; rating: number }
export const ratedPrecedents: RatedPrecedent[] = [
  { label: 'markdown-render consolidation', surface: 'effects/render', rating: 5 },
  { label: 'effect type system · goal 1', surface: 'effects/types', rating: 4 },
  { label: 'haptics plugin · verify on device', surface: 'plugins/haptics', rating: 4 },
];
export type ReportAttachmentType = 'conversation' | 'prompt' | 'skill' | 'tool' | 'workflow-snapshot' | 'goal-doc-snapshot';
export interface ReportAttachment { type: ReportAttachmentType; label: string }
export interface ReportItem { kind: 'praise' | 'good-pattern' | 'frustration' | 'workflow-quirk' | 'gitspace-quirk'; surface: string; note: string; attachments?: ReportAttachment[] }
export const reportItems: ReportItem[] = [
  { kind: 'good-pattern', surface: 'effects/render', note: 'one typed entrypoint, every caller migrated, dupes deleted', attachments: [{ type: 'goal-doc-snapshot', label: 'goal.md @ ship' }, { type: 'skill', label: 'space-goal-doc' }] },
  { kind: 'praise', surface: 'review walkthrough', note: 'story-ordered guide made the PR obvious to review', attachments: [{ type: 'conversation', label: 'review thread · 6 msgs' }, { type: 'workflow-snapshot', label: 'review-gated run' }] },
  { kind: 'frustration', surface: 'effects/scramble', note: 'duplicate logic drifted silently — there was no single source', attachments: [{ type: 'conversation', label: 'where it drifted' }, { type: 'tool', label: 'grep · import scan' }] },
  { kind: 'workflow-quirk', surface: 'review-gate', note: 'green tests were accepted as proof of deletion — they are not', attachments: [{ type: 'workflow-snapshot', label: 'phase 2 · gate' }, { type: 'prompt', label: 'reviewer prompt' }] },
  { kind: 'gitspace-quirk', surface: 'goal doc', note: 'no way to embed an interactive mock for feedback — fixed via agentation', attachments: [{ type: 'goal-doc-snapshot', label: 'before mock embed' }, { type: 'conversation', label: 'feature request' }] },
];

// ── workflow spec: review-gated implementation (typed dataflow: source vs artifact) ──
export const workflowSpec: Block = { id: id('wf'), type: 'workflow', data: {
  recipe: 'review-gated implementation',
  recipePath: '.gitspace/workflows/recipes/review-gated',
  rollup: ['3 phases', '9 agents', '142k tok', '$0.84'],
  phases: [
    {
      name: 'create data types',
      inputs: [{ name: 'goal doc', io: 'artifact' }, { name: 'effects/a.ts', io: 'source' }, { name: 'effects/b.ts', io: 'source' }],
      gate: { type: 'human', label: 'human approval' },
      loop: 'reviewer returns “changes” → implementation re-runs until the rubric passes',
      created: [
        { name: 'types brief', type: 'goal-slice', from: 'goal.md §Data model · L12–28', passedTo: 'implementation agent' },
        { name: 'type-review rubric', type: 'rubric', from: 'authored for this phase', passedTo: 'reviewer agent' },
      ],
      nodes: [
        { id: 'i1', role: 'implementation agent', kind: 'agent', modelRole: 'task', status: 'done', reads: [{ name: 'types brief', io: 'artifact' }, { name: 'effects/a.ts', io: 'source' }], writes: [{ name: 'types.ts', io: 'source' }], out: 'draft types.ts' },
        { id: 'r1', role: 'reviewer agent', kind: 'agent', modelRole: 'slow', status: 'done', reads: [{ name: 'type-review rubric', io: 'artifact' }, { name: 'types.ts', io: 'source' }], writes: [{ name: 'type-review.md', io: 'artifact' }], out: 'verdict + notes' },
        { id: 'g1', role: 'gate', kind: 'gate', gateType: 'human', status: 'done' },
      ],
      outputs: [{ name: 'types.ts', kind: 'code', io: 'source', required: true, status: 'created' }, { name: 'type-review.md', kind: 'note', io: 'artifact', required: true, status: 'created' }],
    },
    {
      name: 'shared core + tests',
      inputs: [{ name: 'types.ts', io: 'source' }],
      gate: { type: 'orchestration', label: 'orchestration agent · auto-pass on green tests + reviewer pass' },
      loop: 'failing tests OR reviewer “changes” → implementation re-runs',
      created: [{ name: 'core rubric', type: 'rubric', from: 'authored for this phase', passedTo: 'reviewer agent' }],
      nodes: [
        { id: 'i2', role: 'implementation agent', kind: 'agent', modelRole: 'task', status: 'done', reads: [{ name: 'types.ts', io: 'source' }], writes: [{ name: 'core.ts', io: 'source' }, { name: 'core.test.ts', io: 'source' }], out: 'core.ts + tests' },
        { id: 't2', role: 'test runner', kind: 'tool', status: 'done', reads: [{ name: 'core.test.ts', io: 'source' }], writes: [{ name: 'test-results', io: 'artifact' }], out: 'results' },
        { id: 'r2', role: 'reviewer agent', kind: 'agent', modelRole: 'slow', status: 'running', reads: [{ name: 'core rubric', io: 'artifact' }, { name: 'core.ts', io: 'source' }, { name: 'test-results', io: 'artifact' }], writes: [{ name: 'core-review.md', io: 'artifact' }], out: 'verdict' },
        { id: 'g2', role: 'gate', kind: 'gate', gateType: 'orchestration', status: 'pending' },
      ],
      outputs: [{ name: 'core.ts', kind: 'code', io: 'source', required: true, status: 'created' }, { name: 'core.test.ts', kind: 'test', io: 'source', required: true, status: 'created' }, { name: 'test-results', kind: 'evidence', io: 'artifact', required: true, status: 'created' }],
    },
    {
      name: 'migrate consumers',
      inputs: [{ name: 'core.ts', io: 'source' }],
      gate: { type: 'human', label: 'human approval' },
      loop: 'per-consumer review; “changes” loops back to implementation',
      created: [
        { name: 'migration plan', type: 'phased-goal', from: 'goal.md §Implementation plan · step 4', passedTo: 'implementation agent' },
        { name: 'visual-diff rubric', type: 'rubric', passedTo: 'reviewer agent' },
      ],
      nodes: [
        { id: 'i3', role: 'implementation agent', kind: 'agent', modelRole: 'task', status: 'pending', reads: [{ name: 'migration plan', io: 'artifact' }, { name: 'core.ts', io: 'source' }], writes: [{ name: 'pipeline.ts', io: 'source' }, { name: 'Editor.tsx', io: 'source' }], out: 'migrated files' },
        { id: 'r3', role: 'reviewer agent', kind: 'agent', modelRole: 'slow', status: 'pending', reads: [{ name: 'visual-diff rubric', io: 'artifact' }, { name: 'diff', io: 'source' }], writes: [{ name: 'migrate-review.md', io: 'artifact' }], out: 'verdict', fanout: { over: 'each changed consumer', instances: ['pipeline.ts', 'Editor.tsx', 'Scramble.ts'] } },
        { id: 'g3', role: 'gate', kind: 'gate', gateType: 'human', status: 'pending' },
      ],
      outputs: [{ name: 'pipeline.ts + Editor.tsx', kind: 'code', io: 'source', required: true, status: 'pending' }, { name: 'before/after.png', kind: 'screenshot', io: 'artifact', required: true, status: 'pending' }],
    },
  ],
} };

// ── cross-project home: the projects strip ──
export interface ProjectSummary { id: string; name: string; chains: number; workspaces: number; inProcess: number }
export const PROJECTS: ProjectSummary[] = [
  { id: 'tone-tempo', name: 'tone-tempo', chains: 3, workspaces: 8, inProcess: 2 },
  { id: 'inkibra-web', name: 'inkibra-web', chains: 1, workspaces: 2, inProcess: 0 },
  { id: 'relay-infra', name: 'relay-infra', chains: 2, workspaces: 3, inProcess: 1 },
];

// ── artifact folder structure (rethought) ──────────────────────────────────
// projectBase/
//   chains/<chain>/<workspace>/{ goal.md, rubric.json, evidence/, apps/, data/,
//                                workflows/, dashboards/*.dashboard.json }
//   dashboards/*.dashboard.json   (project-level)
//   apps/*.gssh.html              (shared mini-apps)
//   triggers.json
// A dashboard is itself an artifact (*.dashboard.json) referencing app + data.
export const projectArtifactTree: FileNode[] = [
  { name: 'projectBase', path: 'pb', kind: 'dir', depth: 0 },
  { name: 'chains', path: 'pb/c', kind: 'dir', depth: 1 },
  { name: 'editor-effects-pipeline', path: 'pb/c/eep', kind: 'dir', depth: 2 },
  { name: 'add-effects-pack', path: 'pb/c/eep/aep', kind: 'dir', depth: 3 },
  { name: 'goal.md', path: 'pb/c/eep/aep/g', kind: 'file', depth: 4 },
  { name: 'rubric.json', path: 'pb/c/eep/aep/r', kind: 'file', depth: 4 },
  { name: 'evidence', path: 'pb/c/eep/aep/ev', kind: 'dir', depth: 4 },
  { name: 'verify.effects.json', path: 'pb/c/eep/aep/ev/v', kind: 'file', depth: 5 },
  { name: 'summary.png', path: 'pb/c/eep/aep/ev/s', kind: 'file', depth: 5 },
  { name: 'dashboards', path: 'pb/c/eep/aep/d', kind: 'dir', depth: 4 },
  { name: 'effect-types.dashboard.json', path: 'pb/c/eep/aep/d/db', kind: 'file', depth: 5 },
  { name: 'apps', path: 'pb/c/eep/aep/a', kind: 'dir', depth: 4 },
  { name: 'ops-board.gssh.html', path: 'pb/c/eep/aep/a/ob', kind: 'file', depth: 5 },
  { name: 'data', path: 'pb/c/eep/aep/dt', kind: 'dir', depth: 4 },
  { name: 'ops-board.data.json', path: 'pb/c/eep/aep/dt/ob', kind: 'file', depth: 5 },
  { name: 'consolidate-text-effects', path: 'pb/c/eep/cte', kind: 'dir', depth: 3 },
  { name: 'goal.md', path: 'pb/c/eep/cte/g', kind: 'file', depth: 4 },
  { name: 'rubric.json', path: 'pb/c/eep/cte/r', kind: 'file', depth: 4 },
  { name: 'dashboards', path: 'pb/c/eep/cte/d', kind: 'dir', depth: 4 },
  { name: 'ship.dashboard.json', path: 'pb/c/eep/cte/d/db', kind: 'file', depth: 5 },
  { name: 'data', path: 'pb/c/eep/cte/dt', kind: 'dir', depth: 4 },
  { name: 'slo.data.json', path: 'pb/c/eep/cte/dt/slo', kind: 'file', depth: 5 },
  { name: 'dashboards', path: 'pb/d', kind: 'dir', depth: 1 },
  { name: 'project-growth.dashboard.json', path: 'pb/d/pg', kind: 'file', depth: 2 },
  { name: 'apps', path: 'pb/a', kind: 'dir', depth: 1 },
  { name: 'chains-rollup.gssh.html', path: 'pb/a/cr', kind: 'file', depth: 2 },
  { name: 'triggers.json', path: 'pb/t', kind: 'file', depth: 1 },
];

// ── dashboards: a dashboard is a named canvas of panels; panels link to mini-apps ──
// Ship mode = one workspace dashboard. A project holds many dashboards. Roll-up
// promotes a shipped workspace's whole dashboard up into the project.
export interface Dashboard { id: string; name: string; scope: 'workspace' | 'chain' | 'project'; source?: string; updated?: string; panels: ShipPanel[] }

const mkPanel = (id: string, app: string, title: string, data: string, size: ShipPanelSize = 'half'): ShipPanel =>
  ({ id, app, title, artifact: `${app}.app`, data, size, scope: 'chain' });

export const projectDashboards: Dashboard[] = [
  { id: 'db-growth', name: 'Project growth', scope: 'project', source: 'project-metrics-sync', updated: '1h ago',
    panels: [mkPanel('g-ops', 'ops-board', 'Growth · all chains', 'ops-board.data.json'), mkPanel('g-roll', 'chain-rollup', 'Chains roll-up', 'rollup.json', 'full')] },
  { id: 'db-aep', name: 'Effect type system', scope: 'chain', source: 'rolled up · add-effects-pack', updated: '6d ago',
    panels: [mkPanel('a-slo', 'slo-rubric', 'Effect SLOs', 'slo.data.json'), mkPanel('a-ops', 'ops-board', 'Effects metrics', 'ops-board.data.json')] },
];

// workspace-scope dashboards (the old "ship canvas" is just the workspace's dashboards)
export const workspaceDashboards: Dashboard[] = [
  { id: 'wd-ship', name: 'Ship dashboard', scope: 'workspace', source: 'verify:effects · weekly', updated: '18m ago', panels: shipCanvas },
  { id: 'wd-reliab', name: 'Reliability', scope: 'workspace', panels: [mkPanel('w-slo', 'slo-rubric', 'SLOs', 'slo.data.json'), mkPanel('w-crons', 'crons-triggers', 'Triggers', 'triggers.json', 'full')] },
];

// ── recently-shipped queue: deletion check → roll the workspace dashboard up ──
export interface ShippedQueueItem { workspace: string; chain: string; shipped: string; artifacts: number; rolledUp: boolean; dashboard: Dashboard }
export const recentlyShipped: ShippedQueueItem[] = [
  { workspace: 'add-effects-pack', chain: 'Editor effects', shipped: '6d ago', artifacts: 3, rolledUp: true, dashboard: projectDashboards[1] },
  { workspace: 'post-content-union', chain: 'Content', shipped: '3d ago', artifacts: 5, rolledUp: false,
    dashboard: { id: 'db-content', name: 'Content', scope: 'chain', source: 'rolled up · post-content-union', updated: 'now', panels: [mkPanel('c-ops', 'ops-board', 'Content metrics', 'ops-board.data.json'), mkPanel('c-slo', 'slo-rubric', 'Content SLOs', 'slo.data.json')] } },
  { workspace: 'trust-tier-defaults', chain: 'Trust', shipped: '6d ago', artifacts: 4, rolledUp: false,
    dashboard: { id: 'db-trust', name: 'Trust-tier', scope: 'chain', source: 'rolled up · trust-tier-defaults', updated: 'now', panels: [mkPanel('t-slo', 'slo-rubric', 'Trust-tier SLOs', 'slo.data.json')] } },
];

// ── services / processes (real GitSpace concept: processes.json + ports) ──
export interface ServicePort { name: string; port: number; protocol: string }
export interface ServiceDef {
  id: string; name: string; command: string;
  status: 'ready' | 'running' | 'stopped' | 'failed';
  ports: ServicePort[]; autostart: boolean; restart: string; uptime?: string;
}
export const services: ServiceDef[] = [
  { id: 'svc-web', name: 'sample-server', command: 'bun sample-server/index.ts', status: 'ready', ports: [{ name: 'web', port: 20728, protocol: 'http' }], autostart: true, restart: 'on-failure · 5', uptime: '2h 11m' },
  { id: 'svc-api', name: 'effects-api', command: 'bun run dev:api', status: 'running', ports: [{ name: 'api', port: 20731, protocol: 'http' }], autostart: false, restart: 'always', uptime: '34m' },
  { id: 'svc-worker', name: 'render-worker', command: 'bun run worker', status: 'stopped', ports: [], autostart: false, restart: 'no' },
];

// ── terminals (multi-pane: several shell terminals per workspace) ──
export interface TermSession { id: string; name: string; cwd: string; busy?: boolean }
export const terminals: TermSession[] = [
  { id: 'tm-build', name: 'shell · build', cwd: '…/consolidate-text-effects' },
  { id: 'tm-dev', name: 'dev server', cwd: '…/consolidate-text-effects', busy: true },
  { id: 'tm-scratch', name: 'scratch', cwd: '…/consolidate-text-effects' },
];

// ── project crons & triggers grouped by the workspace they rolled up from ──
export const projectTriggerGroups: { workspace: string; triggerIds: string[] }[] = [
  { workspace: 'add-effects-pack', triggerIds: ['tr-ops'] },
  { workspace: 'consolidate-text-effects', triggerIds: ['tr-sweep', 'tr-funnel'] },
  { workspace: 'post-content-union', triggerIds: ['tr-outreach'] },
  { workspace: '(project-level)', triggerIds: ['tr-roll'] },
];

// map a data artifact (what a panel reads / a tree node) → the trigger that writes it
export function triggerForData(dataArtifact?: string): Trigger | undefined {
  if (!dataArtifact) return undefined;
  const base = dataArtifact.split('/').pop();
  return triggers.find((t) => t.writes.some((w) => w === dataArtifact || w.split('/').pop() === base));
}

// ── evidence registry: every rubric evidence, addressable as an artifact ──
// Lets evidence open directly in its own tab (EvidenceViewer) without the rubric.
export const EVIDENCE: Record<string, RubricEvidence> =
  Object.fromEntries(reviewRubric.flatMap((c) => c.evidence.map((e) => [e.id, e])));

// ── project artifacts, flat per workspace (the "home" projection of the tree) ──
export type FlatArtifactKind = 'goal' | 'rubric' | 'evidence' | 'dashboard' | 'app' | 'data' | 'note';
export interface FlatArtifact { id: string; name: string; kind: FlatArtifactKind; ev?: string; cron?: boolean; noteIdx?: number }
export interface WsArtifacts { chain: string; workspace: string; artifacts: FlatArtifact[] }
export const projectWorkspaceArtifacts: WsArtifacts[] = [
  { chain: 'editor-effects-pipeline', workspace: 'add-effects-pack', artifacts: [
    { id: 'a1', name: 'goal.md', kind: 'goal' },
    { id: 'a2', name: 'rubric.json', kind: 'rubric' },
    { id: 'a3', name: 'effects.spec.ts', kind: 'evidence', ev: 'art-effects-spec' },
    { id: 'a4', name: 'summary screen', kind: 'evidence', ev: 'art-summary-shot' },
    { id: 'a5', name: 'effect-types.dashboard.json', kind: 'dashboard' },
    { id: 'a6', name: 'ops-board.gssh.html', kind: 'app' },
    { id: 'a7', name: 'ops-board.data.json', kind: 'data', cron: true },
  ] },
  { chain: 'editor-effects-pipeline', workspace: 'consolidate-text-effects', artifacts: [
    { id: 'b1', name: 'goal.md', kind: 'goal' },
    { id: 'b2', name: 'rubric.json', kind: 'rubric' },
    { id: 'b3', name: 'grep · import scan', kind: 'evidence', ev: 'art-import-scan' },
    { id: 'b4', name: 'migration walkthrough', kind: 'evidence', ev: 'art-migrate-clip' },
    { id: 'b5', name: 'ship.dashboard.json', kind: 'dashboard' },
    { id: 'b6', name: 'slo.data.json', kind: 'data', cron: true },
    { id: 'b7', name: 'Main-thread blocking', kind: 'note', noteIdx: 0 },
    { id: 'b8', name: 'Custom pattern path', kind: 'note', noteIdx: 1 },
  ] },
  { chain: 'sharing-reach', workspace: 'typed-share-union', artifacts: [
    { id: 'c1', name: 'goal.md', kind: 'goal' },
    { id: 'c2', name: 'share-funnel.gssh.html', kind: 'app' },
  ] },
];

// ── agent chat demo: one item per inventory case ──────────────────────────
export interface ChatModel { id: string; label: string; sub: string }
export const CHAT_MODELS: ChatModel[] = [
  { id: 'opus-4.8', label: 'Opus 4.8', sub: 'most capable' },
  { id: 'sonnet-4.6', label: 'Sonnet 4.6', sub: 'balanced' },
  { id: 'haiku-4.5', label: 'Haiku 4.5', sub: 'fast / cheap' },
  { id: 'fable-5', label: 'Fable 5', sub: 'experimental' },
];
export const SLASH_COMMANDS: { name: string; blurb: string }[] = [
  { name: 'code-review', blurb: 'review the current diff' },
  { name: 'verify', blurb: 'run the app and confirm a change works' },
  { name: 'run', blurb: 'launch and drive the app' },
  { name: 'simplify', blurb: 'reuse / simplify the changed code' },
  { name: 'security-review', blurb: 'security pass on the branch' },
  { name: 'schedule', blurb: 'schedule a recurring agent' },
];
export const MENTION_TARGETS: { token: string; kind: string }[] = [
  { token: 'HapticsPlugin.swift', kind: 'file' },
  { token: 'goal.md', kind: 'artifact' },
  { token: 'review-rubric', kind: 'artifact' },
  { token: 'ops-board.gssh.html', kind: 'app' },
  { token: 'effects-api', kind: 'service' },
  { token: 'agent·main', kind: 'agent' },
];

const chatShot = (label: string, tint: string) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="180" viewBox="0 0 440 180"><rect width="440" height="180" fill="#070707"/><rect width="440" height="22" fill="#0e0e0e"/><circle cx="12" cy="11" r="3.5" fill="${tint}"/><text x="26" y="15" fill="#8a8a8a" font-family="monospace" font-size="10">${label}</text>` +
    `<polyline points="20,150 80,120 140,130 200,90 260,100 320,60 400,70" fill="none" stroke="${tint}" stroke-width="2"/><text x="20" y="48" fill="#e2e2e2" font-family="monospace" font-size="13">share funnel · 7d</text></svg>`);

export type ChatItem =
  | { kind: 'user'; text: string; atts?: string[] }
  | { kind: 'assistant'; md: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: string; target?: string; status: 'running' | 'done' | 'error' | 'fallback'; meta?: string; out?: string; diff?: DiffLine[]; todo?: { done: boolean; text: string }[]; img?: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'image'; src: string; caption?: string }
  | { kind: 'subagent'; label: string; model: string; status: string; lines: string[] }
  | { kind: 'permission'; tool: string; detail: string }
  | { kind: 'hostui'; dialog: 'select' | 'confirm' | 'input'; prompt: string; options?: string[] }
  | { kind: 'error'; text: string; aborted?: boolean };

export const agentDemo: ChatItem[] = [
  { kind: 'user', text: 'Consolidate the text effects and verify on device. Use @HapticsPlugin.swift as the reference.', atts: ['device.mp4'] },
  { kind: 'thinking', text: 'The three effect copies diverge in Scramble.ts. I should grep for the private imports first, then collapse to effects/core and run the verify suite. The rubric wants files actually deleted, not just green tests.' },
  { kind: 'assistant', md: 'Here\'s the plan:\n\n1. **Find** the divergent copies (`a.ts` / `b.ts`).\n2. **Collapse** them into `effects/core`.\n3. **Verify** on device + run the golden suite.\n\n| consumer | status |\n| --- | --- |\n| Editor | ✓ migrated |\n| Preview | ✓ migrated |\n| Share | ✗ still on `./b` |' },
  { kind: 'tool', tool: 'bash', target: 'rg "from \'./b\'" src/effects', status: 'done', meta: '1 match · 40ms', out: 'src/effects/Scramble.ts:12:import { scramble } from \'./b\';' },
  { kind: 'tool', tool: 'edit', target: 'src/effects/Scramble.ts', status: 'done', meta: '+1 −1', diff: [
    { kind: 'del', text: "import { scramble } from './b';", ln: 12 },
    { kind: 'add', text: "import { scramble } from 'effects/core';", ln: 12 },
  ] },
  { kind: 'tool', tool: 'todo', status: 'done', meta: '2/3', todo: [
    { done: true, text: 'Collapse Editor + Preview onto effects/core' },
    { done: true, text: 'Rewrite Scramble import' },
    { done: false, text: 'Migrate Share consumer' },
  ] },
  { kind: 'subagent', label: 'review-gate', model: 'sonnet-4.6', status: 'running', lines: [
    'phase 1 · collect evidence (pipeline)',
    'reviewer + proxy-trap running in parallel',
    'proxy-trap returned 1 finding',
  ] },
  { kind: 'tool', tool: 'verify', target: 'on device', status: 'done', meta: 'exit 0', img: chatShot('verify · device capture', '#00ff66') },
  { kind: 'mermaid', code: 'flowchart LR\n  E[Editor] --> C[effects core]\n  P[Preview] --> C\n  S[Share] -.->|legacy| B[b.ts]' },
  { kind: 'assistant', md: 'Funnel after the change — share conversion dipped, watch it:' },
  { kind: 'image', src: chatShot('posthog · share funnel', '#5b9bff'), caption: 'share-funnel.gssh.html · updated 18m ago' },
  { kind: 'permission', tool: 'bash', detail: 'rm src/effects/b.ts  (delete the legacy copy)' },
  { kind: 'hostui', dialog: 'select', prompt: 'Which consumer should migrate first?', options: ['Editor', 'Preview', 'Share'] },
  { kind: 'error', text: 'Anthropic stream error (api_error): Internal server error — retrying (2/3)…' },
];

// ── agent settings data (shaped after the @oh-my-pi SDK) ──────────────────
export interface OmpProvider { id: string; label: string; status: 'connected' | 'not-connected'; via?: 'oauth' | 'api-key' }
export const OMP_PROVIDERS: OmpProvider[] = [
  { id: 'anthropic', label: 'Anthropic', status: 'connected', via: 'oauth' },
  { id: 'openai', label: 'OpenAI', status: 'connected', via: 'api-key' },
  { id: 'google', label: 'Google Gemini', status: 'not-connected' },
  { id: 'github-copilot', label: 'GitHub Copilot', status: 'not-connected' },
];
export interface OmpModel { id: string; label: string; provider: string; ctx: number; maxOut: number; costIn: number; costOut: number }
export const OMP_MODELS: OmpModel[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic', ctx: 200000, maxOut: 64000, costIn: 5, costOut: 25 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', provider: 'anthropic', ctx: 200000, maxOut: 64000, costIn: 3, costOut: 15 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', provider: 'anthropic', ctx: 200000, maxOut: 32000, costIn: 1, costOut: 5 },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', ctx: 400000, maxOut: 128000, costIn: 2, costOut: 10 },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', provider: 'openai', ctx: 400000, maxOut: 128000, costIn: 2, costOut: 10 },
  { id: 'gemini-3-pro', label: 'Gemini 3 Pro', provider: 'google', ctx: 1000000, maxOut: 64000, costIn: 2, costOut: 12 },
];
export const MODEL_ROLES = ['default', 'smol', 'slow', 'vision', 'plan', 'designer', 'commit', 'task'] as const;
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface AgentTool { name: string; tier: 'read' | 'write' | 'exec'; approval: 'allow' | 'prompt' | 'deny' }
export const AGENT_TOOLS: AgentTool[] = [
  { name: 'read', tier: 'read', approval: 'allow' },
  { name: 'search', tier: 'read', approval: 'allow' },
  { name: 'web', tier: 'read', approval: 'allow' },
  { name: 'edit', tier: 'write', approval: 'prompt' },
  { name: 'write', tier: 'write', approval: 'prompt' },
  { name: 'bash', tier: 'exec', approval: 'prompt' },
];
export const AGENT_SKILLS = ['space-goal', 'space-chain', 'space-review', 'space-notes', 'space-process-config', 'space-run-process', 'space-event-logs'];

export const USAGE_SESSION = { input: 842000, output: 318000, cacheRead: 1240000, cacheWrite: 96000, cost: 4.10 };
export const USAGE_MONTH = { tokens: 12_400_000, limit: 50_000_000, cost: 61.40 };
export interface CtxSlice { label: string; tokens: number; tone: string }
export const CONTEXT_BREAKDOWN: CtxSlice[] = [
  { label: 'system + skills', tokens: 18000, tone: 'dim' },
  { label: 'pinned files', tokens: 22000, tone: 'blue' },
  { label: 'history', tokens: 38000, tone: 'green' },
  { label: 'tool output', tokens: 6000, tone: 'amber' },
];
export const PINNED_FILES = ['HapticsPlugin.swift', 'goal.md', 'effects/core.ts'];

// ── real model-tab settings (pi-coding-agent settings schema · model tab) ──
export const MODEL_PARAMS = {
  thinkingLevel: 'high', temperature: 'default', topP: 'default', topK: 'default',
  serviceTier: 'none', retryAttempts: 3, fallbackPolicy: 'cooldown-expiry',
  hideThinkingBlock: false, repeatToolDescriptions: false,
};

// ── general settings: the unified SETTINGS_SCHEMA, by tab (real keys/labels) ──
export const SETTINGS_TABS = ['appearance', 'interaction', 'context', 'memory', 'tools', 'tasks', 'editing', 'providers'] as const;
export type SettingTab = typeof SETTINGS_TABS[number];
export interface SettingItem { key: string; tab: SettingTab; label: string; type: 'toggle' | 'enum' | 'number' | 'text'; value: string | number | boolean; options?: string[]; desc?: string }
export const GENERAL_SETTINGS: SettingItem[] = [
  // appearance
  { key: 'theme.dark', tab: 'appearance', label: 'Dark Theme', type: 'enum', value: 'titanium', options: ['titanium', 'carbon', 'midnight'] },
  { key: 'symbolPreset', tab: 'appearance', label: 'Symbol Preset', type: 'enum', value: 'Unicode', options: ['Unicode', 'Nerd Font', 'ASCII'] },
  { key: 'statusLine.preset', tab: 'appearance', label: 'Status Line Preset', type: 'enum', value: 'Default', options: ['Default', 'Minimal', 'Compact', 'Full', 'Nerd', 'ASCII', 'Custom'] },
  { key: 'statusLine.separator', tab: 'appearance', label: 'Status Line Separator', type: 'enum', value: 'Powerline', options: ['Powerline', 'Thin chevron', 'Slash', 'Pipe', 'Block', 'None', 'ASCII'] },
  { key: 'terminal.showImages', tab: 'appearance', label: 'Show Inline Images', type: 'toggle', value: true },
  { key: 'colorBlindMode', tab: 'appearance', label: 'Color-Blind Mode', type: 'toggle', value: false },
  { key: 'showTokenUsage', tab: 'appearance', label: 'Show Token Usage', type: 'toggle', value: true },
  // interaction
  { key: 'autoResume', tab: 'interaction', label: 'Auto Resume', type: 'toggle', value: false, desc: 'Resume the most recent session in this directory' },
  { key: 'power.preventIdleSleep', tab: 'interaction', label: 'Prevent Idle Sleep (macOS)', type: 'toggle', value: true },
  { key: 'power.preventDisplaySleep', tab: 'interaction', label: 'Prevent Display Sleep (macOS)', type: 'toggle', value: false },
  // context
  { key: 'contextPromotion.enabled', tab: 'context', label: 'Auto-Promote Context', type: 'toggle', value: false, desc: 'Switch to a bigger model on context exhaustion' },
  { key: 'compaction.enabled', tab: 'context', label: 'Auto-Compact', type: 'toggle', value: true },
  { key: 'compaction.strategy', tab: 'context', label: 'Compaction Strategy', type: 'enum', value: 'summarize', options: ['summarize', 'image-pages', 'truncate'] },
  { key: 'compaction.threshold', tab: 'context', label: 'Compaction Threshold', type: 'enum', value: '90%', options: ['70%', '80%', '90%', '95%'] },
  { key: 'compaction.saveHandoff', tab: 'context', label: 'Save Handoff Docs', type: 'toggle', value: true },
  // memory
  { key: 'memory.backend', tab: 'memory', label: 'Memory Backend', type: 'enum', value: 'mnemopi', options: ['off', 'mnemopi'] },
  { key: 'mnemopi.autoRecall', tab: 'memory', label: 'Mnemopi Auto Recall', type: 'toggle', value: true },
  { key: 'mnemopi.autoRetain', tab: 'memory', label: 'Mnemopi Auto Retain', type: 'toggle', value: true },
  { key: 'mnemopi.scoping', tab: 'memory', label: 'Mnemopi Scoping', type: 'enum', value: 'project', options: ['global', 'project'] },
  // tools
  { key: 'marketplace.autoUpdate', tab: 'tools', label: 'Marketplace Auto-Update', type: 'enum', value: 'Notify', options: ['Off', 'Notify', 'Auto'] },
  { key: 'tools.artifactSpillThreshold', tab: 'tools', label: 'Artifact spill threshold', type: 'enum', value: '30 KB', options: ['5 KB', '10 KB', '30 KB', '50 KB', '100 KB'] },
  { key: 'tools.outputMaxColumns', tab: 'tools', label: 'Output column cap', type: 'enum', value: '1024', options: ['Off', '512', '1024', '2048', '4096'] },
  // tasks
  { key: 'tasks.maxDepth', tab: 'tasks', label: 'Max subagent depth', type: 'number', value: 3 },
  { key: 'tasks.spawns', tab: 'tasks', label: 'Allowed spawns', type: 'text', value: '*' },
  // editing
  { key: 'editing.formatOnWrite', tab: 'editing', label: 'Format on Write', type: 'toggle', value: true },
  { key: 'editing.lsp', tab: 'editing', label: 'LSP diagnostics', type: 'toggle', value: true },
  // providers
  { key: 'providers.order', tab: 'providers', label: 'Provider order', type: 'text', value: 'anthropic, openai, google' },
];

// ── runtime status drives workspace COLOR (phase is positional, never colored) ──
export type WsStatus = 'working' | 'waiting' | 'permission' | 'error' | 'idle';
export const WS_STATUS_COLOR: Record<WsStatus, string> = {
  working: 'var(--gs-success)', waiting: 'var(--gs-info)', permission: 'var(--gs-warning)', error: 'var(--gs-danger)', idle: 'var(--gs-text-dim)',
};
export const WS_STATUS_LABEL: Record<WsStatus, string> = {
  working: 'agent working', waiting: 'waiting', permission: 'permission needed', error: 'error', idle: 'idle',
};
export const WS_STATUS: Record<string, WsStatus> = {
  'profile-model': 'working', 'share-union': 'idle', 'haptics-plugin': 'permission', 'alarm-scaffold': 'working',
  'effects-pack': 'waiting', 'text-effects': 'working', 'feed-content': 'idle', 'trust-tiers': 'error',
};

// ── command palette (Cmd-K) — action spine, mirrors the real commandPalette set ──
export interface PaletteCmd { id: string; label: string; group: 'Navigate' | 'Actions' | 'Open'; hint?: string; nav?: { type: 'board' | 'project' | 'workspace'; id?: string } }
export const PALETTE_COMMANDS: PaletteCmd[] = [
  // navigate
  { id: 'go-board', label: 'Go to all projects', group: 'Navigate', hint: '⊞', nav: { type: 'board' } },
  { id: 'go-project', label: 'Go to project home', group: 'Navigate', hint: 'tone-tempo', nav: { type: 'project' } },
  // actions (from the real palette)
  { id: 'add-repo', label: 'Add repo', group: 'Actions' },
  { id: 'add-ws', label: 'Add workspace', group: 'Actions' },
  { id: 'set-status', label: 'Set workspace status', group: 'Actions', hint: 'plan · code · review · ship' },
  { id: 'edit-bundle', label: 'Edit bundle config', group: 'Actions' },
  { id: 'refresh-bundle', label: 'Refresh bundle', group: 'Actions' },
  { id: 'run-scripts', label: 'Run workspace scripts', group: 'Actions' },
  { id: 'add-note', label: 'Add note', group: 'Actions' },
  { id: 'edit-proc', label: 'Edit process config', group: 'Actions' },
  { id: 'new-dash', label: 'New dashboard', group: 'Actions' },
  { id: 'new-trigger', label: 'New trigger', group: 'Actions' },
  // open
  { id: 'open-pr', label: 'Open GitHub PR', group: 'Open' },
  { id: 'open-review', label: 'Open review', group: 'Open' },
  { id: 'open-editor', label: 'Open in editor', group: 'Open' },
  { id: 'open-service', label: 'Open service in browser', group: 'Open' },
  { id: 'show-chains', label: 'Show goal chains', group: 'Open' },
];

// ── stage-as-mode: each phase unlocks abilities (not just a status) ──
export const STAGE_CAPS: Record<Stage, { note: string; unlocks: string[] }> = {
  plan: { note: 'spec only · repo read-only', unlocks: ['Goal / rubric / workflow authoring'] },
  code: { note: 'the only mode that edits the repo', unlocks: ['Repo editable ✎', 'Workflows enabled ⟜', 'Agent edits + runs'] },
  review: { note: 'review the change', unlocks: ['Diffs in file browser', 'Change Guide + rubric'] },
  ship: { note: 'post-merge ops', unlocks: ['Crons & triggers live ◷', 'Roll up to project'] },
};

// ── chain stack edges: git-stacking alignment status (real ChainStackEdgeStatus) ──
export type AlignStatus = 'aligned' | 'needs-rebase' | 'dirty-worktree' | 'missing-branch' | 'missing-workspace';
export const ALIGN_TONE: Record<AlignStatus, string> = {
  aligned: 'green', 'needs-rebase': 'amber', 'dirty-worktree': 'amber', 'missing-branch': 'red', 'missing-workspace': 'dim',
};
// per-workspace machine identity (local vs remote relay machine)
export interface MachineRef { name: string; online: boolean; remote: boolean }
export const WS_MACHINE: Record<string, MachineRef> = {
  'profile-model': { name: 'studio-mbp', online: true, remote: false },
  'share-union': { name: 'studio-mbp', online: true, remote: false },
  'haptics-plugin': { name: 'device-rig', online: true, remote: true },
  'alarm-scaffold': { name: 'studio-mbp', online: true, remote: false },
  'effects-pack': { name: 'cloud-01', online: true, remote: true },
  'text-effects': { name: 'studio-mbp', online: true, remote: false },
  'feed-content': { name: 'cloud-01', online: false, remote: true },
  'trust-tiers': { name: 'cloud-01', online: true, remote: true },
};

// richer chain stacks for the board "Stacks" lens (ordered goals + alignment + here)
export interface StackNode { goalId: string; title: string; phase: Stage | 'planned'; status: ChainNodeStatus; wsId?: string; align: AlignStatus; here?: boolean }
export interface BoardStack { id: string; title: string; group: string; nodes: StackNode[] }
export const BOARD_STACKS: BoardStack[] = [
  { id: 'eep', title: 'Editor effects pipeline', group: 'tone-tempo', nodes: [
    { goalId: 'g1', title: 'Effect type system', phase: 'ship', status: 'shipped', wsId: 'effects-pack', align: 'aligned' },
    { goalId: 'g2', title: 'Consolidate text effects', phase: 'review', status: 'active', wsId: 'text-effects', align: 'needs-rebase', here: true },
    { goalId: 'g3', title: 'Share renderer migration', phase: 'planned', status: 'planned', align: 'missing-workspace' },
  ] },
  { id: 'haptics', title: 'Native haptics', group: 'tone-tempo', nodes: [
    { goalId: 'h1', title: 'Haptics plugin', phase: 'code', status: 'active', wsId: 'haptics-plugin', align: 'dirty-worktree', here: false },
    { goalId: 'h2', title: 'AlarmKit scaffold', phase: 'code', status: 'active', wsId: 'alarm-scaffold', align: 'aligned' },
  ] },
  { id: 'content', title: 'Content + trust', group: 'tone-tempo', nodes: [
    { goalId: 'c1', title: 'Post content union', phase: 'ship', status: 'shipped', wsId: 'feed-content', align: 'aligned' },
    { goalId: 'c2', title: 'Trust-tier defaults', phase: 'ship', status: 'active', wsId: 'trust-tiers', align: 'missing-branch' },
  ] },
];

// ── toasts (command completion · success/error/info) ──
export interface Toast { id: string; tone: 'success' | 'error' | 'info'; text: string; sub?: string }
export const TOASTS: Toast[] = [
  { id: 't1', tone: 'success', text: 'verify:haptics exit 0', sub: 'haptics-plugin · device-rig' },
  { id: 't2', tone: 'error', text: 'render-worker failed to start', sub: 'port 20733 in use' },
  { id: 't3', tone: 'info', text: 'deployed tone-tempo@ink-356 → staging', sub: 'consolidate-text-effects' },
];

// ── bottom lifecycle taskbar (workspace create/delete script phases) ──
export interface LifecycleTask {
  title: string; status: 'running' | 'queued' | 'failed' | 'done';
  phase: string; phases: string[]; elapsed: string; log: string[];
}
export const LIFECYCLE_TASKS: LifecycleTask[] = [
  { title: 'Removing share-extension-target', status: 'running', phase: 'Remove', phases: ['Prepare', 'Setup', 'Select', 'Remove'], elapsed: '0:12',
    log: ['› running .gitspace/scripts/remove/', '✓ stopped 2 services', '✓ released ports 20728, 20731', '› git worktree remove …'] },
  { title: 'Creating profile-model-v2', status: 'queued', phase: 'Prepare', phases: ['Prepare', 'Setup', 'Select', 'Remove'], elapsed: '—', log: [] },
];

// ── inbox (notifications grouped project → workspace → session) ──
export type InboxKind = 'output' | 'error' | 'exit' | 'title' | 'permission';
export interface InboxItem { id: string; project: string; workspace: string; session: string; kind: InboxKind; title: string; meta: string; time: string; unread: boolean }
export const INBOX_ITEMS: InboxItem[] = [
  { id: 'i1', project: 'tone-tempo', workspace: 'haptics-plugin', session: 'agent·main', kind: 'permission', title: 'Permission needed — rm src/effects/b.ts', meta: 'review-gate', time: '2m', unread: true },
  { id: 'i2', project: 'tone-tempo', workspace: 'trust-tier-defaults', session: 'dev server', kind: 'error', title: 'render-worker crashed (exit 1)', meta: 'port in use', time: '6m', unread: true },
  { id: 'i3', project: 'tone-tempo', workspace: 'consolidate-text-effects', session: 'agent·main', kind: 'exit', title: 'verify:effects exit 0', meta: '412ms', time: '18m', unread: false },
  { id: 'i4', project: 'relay-infra', workspace: 'relay-upgrade', session: 'shell·build', kind: 'output', title: 'build complete · 0 errors', meta: 'bun build', time: '1h', unread: false },
];

// ── relay / remote machines surface ──
export type MachineStatus = 'online' | 'offline' | 'connecting' | 'error';
export interface Machine { id: string; name: string; status: MachineStatus; kind: 'local' | 'remote'; workspaces: number; lastSeen: string; detail?: string }
export const MACHINES: Machine[] = [
  { id: 'm-local', name: 'studio-mbp', status: 'online', kind: 'local', workspaces: 4, lastSeen: 'now', detail: 'this machine' },
  { id: 'm-rig', name: 'device-rig', status: 'online', kind: 'remote', workspaces: 1, lastSeen: 'now', detail: 'iPhone 15 attached' },
  { id: 'm-cloud', name: 'cloud-01', status: 'connecting', kind: 'remote', workspaces: 3, lastSeen: '…', detail: 'establishing relay session' },
  { id: 'm-old', name: 'old-laptop', status: 'offline', kind: 'remote', workspaces: 0, lastSeen: '3d ago' },
  { id: 'm-err', name: 'ci-runner', status: 'error', kind: 'remote', workspaces: 0, lastSeen: '1h ago', detail: 'relay handshake failed' },
];

// diff bases for review-mode file browser
export const DIFF_BASES = ['main', 'merge-base', 'review', 'unsaved', 'current file'] as const;
