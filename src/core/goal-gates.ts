/**
 * Goal ⟷ rubric ⟷ workflow interconnect — the PURE half (web-safe).
 *
 * Everything here is data → data with no node imports, so the web panes
 * (WorkflowPanel gate chips, ReviewRubric slice badges, GoalDocPanel slice
 * navigation) compute the SAME slices/gates/warnings the CLI and daemon do.
 * The fs-bound half (loading `*.workflow.json`, the human-only waive write)
 * lives in core/goal-workflow.ts.
 *
 * - Doc slices: heading-anchored sections of the goal doc, parsed at read
 *   time (ids are NEVER stored in the doc). id = slugified heading, with a
 *   `-2`/`-3`… suffix on collisions.
 * - Gates: computed, never stored — a phase's gate is satisfied iff every
 *   owed requirement (wfPhase == phase, required) is accepted. Trivially
 *   satisfied when nothing is owed.
 */

import type { GoalRecord, GoalValidation, Requirement, TimelineEvent } from '../types/goals.js';

// ─── Doc slices ─────────────────────────────────────────────────────────────

export interface DocSlice {
  /** Stable-ish id: slugified heading text (deduped with -2/-3… suffixes). */
  id: string;
  /** Heading text as written (without the leading #s). */
  heading: string;
  /** Heading level (1-6). */
  level: number;
  /** 0-based line index of the heading in bodyMarkdown. */
  line: number;
}

export function slugifySliceId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

/**
 * Parse the goal doc into heading-anchored slices. ATX headings only
 * (`# `…`###### `); fenced code blocks are skipped so `# comment` lines in
 * code never become slices. Duplicate headings dedupe as `id-2`, `id-3`, …
 */
export function parseDocSlices(bodyMarkdown: string): DocSlice[] {
  const slices: DocSlice[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  const lines = bodyMarkdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const heading = match[2]!.trim();
    if (!heading) continue;
    const base = slugifySliceId(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    slices.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length,
      line: i,
    });
  }
  return slices;
}

// ─── Workflow spec shape (structural) ───────────────────────────────────────

/** Minimal shape we rely on from WorkflowSpecData (blocks/types/content.ts).
 *  Parsed structurally so core stays decoupled from zod block schemas. */
export interface WorkspaceWorkflowSpec {
  recipe?: string;
  phases?: Array<{
    name?: string;
    /** Slice ids this phase reads from the goal doc (interconnect seam). */
    slices?: string[];
    created?: Array<{ name?: string; type?: string; sliceId?: string }>;
  }>;
}

export interface WorkspaceWorkflow {
  /** Path of the spec relative to the artifacts mount. */
  path: string;
  spec: WorkspaceWorkflowSpec;
}

export function workflowPhaseNames(workflow: WorkspaceWorkflow | null): string[] {
  return workflowSpecPhaseNames(workflow?.spec ?? null);
}

export function workflowSpecPhaseNames(spec: WorkspaceWorkflowSpec | null): string[] {
  return (spec?.phases ?? [])
    .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
    .filter((name) => name.length > 0);
}

// ─── Workflow spec warnings (shared by `space workflow validate` + UI) ──────

/**
 * The pure warning scan of `space workflow validate`: dangling slice refs,
 * phase-name oddities. Amber state data — NEVER a hard failure. The CLI
 * wraps this with the fs load (core/goal-workflow.ts validateWorkspaceWorkflow);
 * the workflow pane calls it directly on the spec + doc it already has.
 */
export function workflowSpecWarnings(spec: WorkspaceWorkflowSpec | null, docSliceIds: string[]): string[] {
  const warnings: string[] = [];
  if (!spec) return warnings;
  const known = new Set(docSliceIds);
  const phases = workflowSpecPhaseNames(spec);
  const rawPhases = spec.phases ?? [];
  if (rawPhases.length !== phases.length) {
    warnings.push('Workflow has phase entries without a usable name.');
  }
  const dupes = phases.filter((name, i) => phases.indexOf(name) !== i);
  for (const dupe of [...new Set(dupes)]) {
    warnings.push(`Duplicate phase name in workflow: "${dupe}".`);
  }
  for (const phase of rawPhases) {
    const label = typeof phase?.name === 'string' && phase.name.trim() ? phase.name.trim() : '(unnamed)';
    for (const sliceId of phase?.slices ?? []) {
      if (!known.has(sliceId)) {
        warnings.push(`Phase "${label}" references slice "${sliceId}" that is not a heading in the goal doc.`);
      }
    }
    for (const artifact of phase?.created ?? []) {
      if (artifact?.sliceId && !known.has(artifact.sliceId)) {
        warnings.push(`Phase "${label}" artifact "${artifact.name ?? artifact.sliceId}" references slice "${artifact.sliceId}" that is not a heading in the goal doc.`);
      }
    }
  }
  return warnings;
}

// ─── Computed gates ─────────────────────────────────────────────────────────

export interface GateStatus {
  phase: string;
  /** Requirements owed by this phase (wfPhase == phase), contract order. */
  owed: Requirement[];
  /** Owed + required + not accepted — what blocks the gate. */
  unmet: Requirement[];
  /** true iff every owed required requirement is accepted (trivially true
   *  when nothing is owed). Waives do NOT flip this — see `waived`. */
  satisfied: boolean;
  /** A human waived this gate (timeline event kind 'gate', actor human/ui). */
  waived: boolean;
  /** satisfied || waived — may the phase end? */
  passable: boolean;
}

function isWaiveEventForPhase(event: TimelineEvent, phase: string): boolean {
  return event.kind === 'gate'
    && event.payload.startsWith('gate.waived')
    && event.payload.split('\n').some((line) => line.trim() === `phase: ${phase}`);
}

/**
 * Computed gate for a workflow phase: satisfied iff every owed requirement
 * (wfPhase == phase, required) is accepted; trivially satisfied when none
 * are owed. Optional requirements are listed as owed but never block.
 */
export function gateStatusForPhase(goal: Pick<GoalRecord, 'validation'>, phase: string): GateStatus {
  const validation = goal.validation;
  const owed = (validation.reqOrder ?? [])
    .map((id) => validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r))
    .filter((r) => r.wfPhase === phase);
  const unmet = owed.filter((r) => r.required !== false && r.status !== 'accepted');
  const waived = (validation.events ?? []).some((e) => isWaiveEventForPhase(e, phase));
  const satisfied = unmet.length === 0;
  return { phase, owed, unmet, satisfied, waived, passable: satisfied || waived };
}

/** One required requirement that is NOT green (not accepted, and — when it
 *  belongs to a workflow phase — that phase has not been waived). */
export interface UnmetRequiredGate {
  requirement: Requirement;
  /** wfPhase the requirement is owed by, or null when unphased/legacy. */
  phase: string | null;
}

export interface GoalGateSummary {
  /** true iff every REQUIRED requirement is accepted, or its owning phase's
   *  gate was waived by a human. Trivially green when no required reqs exist. */
  green: boolean;
  /** The required requirements blocking green (accepted-or-waived fails). */
  unmet: UnmetRequiredGate[];
  /** Count of required requirements considered. */
  requiredTotal: number;
}

/**
 * Goal-level "is validation satisfied" signal for the roll-up guard.
 *
 * Honest definition: every REQUIRED requirement is accepted OR its owning
 * workflow phase's gate was waived by a human. This deliberately combines the
 * two half-signals — readiness (which knows "accepted" but ignores human waive
 * authority) and per-phase gates (which honor waives but only see requirements
 * that declare a wfPhase, missing unphased/legacy required reqs). Neither alone
 * answers "may this goal merge to main"; together they do.
 */
export function goalGateSummary(goal: Pick<GoalRecord, 'validation'>): GoalGateSummary {
  const validation = goal.validation;
  const requirements = (validation.reqOrder ?? [])
    .map((id) => validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r))
    .filter((r) => r.required !== false);
  const events = validation.events ?? [];
  const phaseWaived = (phase: string): boolean => events.some((e) => isWaiveEventForPhase(e, phase));
  const unmet: UnmetRequiredGate[] = [];
  for (const r of requirements) {
    if (r.status === 'accepted') continue;
    const phase = r.wfPhase ?? null;
    if (phase && phaseWaived(phase)) continue;
    unmet.push({ requirement: r, phase });
  }
  return { green: unmet.length === 0, unmet, requiredTotal: requirements.length };
}

export interface GateWaiveInfo {
  reason: string;
  actor: string;
  at: string;
}

/** The most recent human waive recorded against a phase (timeline event kind
 *  'gate', payload `gate.waived`) — reason/actor for the UI's hover state. */
export function gateWaiveInfoForPhase(validation: GoalValidation, phase: string): GateWaiveInfo | null {
  const events = validation.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (!isWaiveEventForPhase(event, phase)) continue;
    const field = (name: string): string | null => {
      for (const line of event.payload.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${name}: `)) return trimmed.slice(name.length + 2);
      }
      return null;
    };
    return {
      reason: field('reason') ?? event.body,
      actor: field('actor') ?? 'human/ui',
      at: event.createdAt,
    };
  }
  return null;
}

/**
 * Same-run judging (gen==judge dedup): a command judgment with no command of
 * its own, or whose command is identical to the generation command, never
 * re-executes on `review run`. The expectation is applied to the LATEST
 * generation run's captured exit/stdout/stderr instead — one execution, one
 * verdict. Pure (web-safe) so panes and CLI classify identically.
 */
export function isSameRunJudgment(r: Pick<Requirement, 'generation' | 'judgment'>): boolean {
  if (r.judgment.kind !== 'command') return false;
  if (!r.judgment.command?.trim()) return true;
  return r.generation.kind === 'command' && r.judgment.command === r.generation.command;
}

/** One line per owed requirement — the contract printout phase-start and a
 *  blocked phase-end both show the agent. */
export function describeOwedRequirement(r: Requirement): string {
  const bits = [
    `${r.id} · ${r.status}${r.required === false ? ' · optional' : ''}`,
    `  rubric: ${r.rubric}`,
  ];
  if (r.generation.kind === 'command') bits.push(`  generate: space goal artifact run --requirement ${r.id}   (${r.generation.command})`);
  else bits.push(`  generate: space goal artifact attach --requirement ${r.id} …   (manual)`);
  if (r.judgment.kind === 'command') bits.push(`  judge: space goal review run --requirement ${r.id}   (${isSameRunJudgment(r) ? 'same-run — judges the latest generation run' : r.judgment.command} · ${r.judgment.expect.kind})`);
  else if (r.judgment.kind === 'llm') bits.push(`  judge: space goal requirement verdict --requirement ${r.id} --accept|--reject --notes "…"   (llm${r.judgment.modelHint ? ` · ${r.judgment.modelHint}` : ''})`);
  else bits.push(`  judge: space goal requirement verdict --requirement ${r.id} --accept|--reject --notes "…"   (human)`);
  if (r.sliceId) bits.push(`  slice: ${r.sliceId}`);
  return bits.join('\n');
}
