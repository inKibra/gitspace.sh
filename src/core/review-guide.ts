/**
 * Review guide store (docs/REVIEW-GUIDE.md, pipeline Phases 2-3 contract).
 *
 * The narrator agent works from a WORKSHEET (analyzer clusters + grounding
 * quotes + staleness vs the cached guide) and SUBMITS sections through a
 * validating gate — schema + coverage are enforced server-side, unchanged
 * clusters keep their cached prose (incremental re-narration), and the merged
 * guide is committed to the artifacts branch as review/guide.json.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getProjectDir, getProjectWorkspacesDir, readProjectConfig } from './config.js';
import { analyzeReviewDiff, type ReviewAnalysis, type ReviewCluster } from './review-analysis.js';
import { artifactsScope, captureArtifacts, type ArtifactsScope } from './artifacts.js';
import { readWorkspaceGoal } from './goal-chain.js';
import { normalizeGuideAsks } from './guide-normalize.js';
import { SpacesError } from '../types/errors.js';
import type { GoalRecord } from '../types/goals.js';

export interface GuideExhibit {
  file: string;
  /** Optional unified-diff hunk headers to scope the exhibit; whole file when absent. */
  hunks?: string[];
  note?: string;
  /** Reviewer attention: slow-read vs skim. */
  slow?: boolean;
}

export interface GuideSection {
  clusterId: string;
  title: string;
  kind: ReviewCluster['type'];
  /** Markdown: what the change is, then its consequences (Linear semantics). */
  explanation: string;
  exhibits: GuideExhibit[];
  callouts?: Array<{ tone: 'risk' | 'mechanical' | 'decision'; text: string }>;
  /** Questions the narrator asks the reviewer. */
  asks?: string[];
  /** Requirement ids this section's phase actually advanced (computed hint from journal). */
  satisfies?: string[];
  /** Grounding refs: journal phases and/or session turn ids the prose cites. */
  cites?: { journalPhases?: string[]; turns?: string[] };
  /** Cluster content fingerprint the prose was written against (staleness). */
  contentHash?: string;
  /** Full member file list of the cluster (stamped server-side at submit). */
  files?: string[];
}

export interface ReviewGuide {
  version: 1;
  headSha: string;
  baseRef: string;
  generatedAt: string;
  /** Optional opening chapter: how the spec/canon evolved (from journal canon pins). */
  specEvolution?: string;
  sections: GuideSection[];
}

/** Goal validation timeline event serialized into the worksheet (JOIN with
 *  the goal ledger — phase-stamped where a journal phase was open). */
export interface WorksheetTimelineEvent {
  at: string;
  kind: string;
  tone: string;
  phase?: string;
  requirementId: string | null;
  title: string;
  body: string;
}

export interface GuideWorksheet {
  headSha: string;
  baseRef: string;
  clusters: Array<ReviewCluster & {
    /** false → cached section carries over; the narrator skips it. */
    stale: boolean;
    grounding: {
      journal: Array<{ phase: string; intent?: string; outcome?: string; decisions?: string[]; canonChanged?: string[] }>;
      /** breadcrumb sessions that touched these files (attribution lookups). */
      sessions: string[];
    };
  }>;
  cachedSections: number;
  canonTimeline: Array<{ phase: string; canonChanged: string[] }>;
  /** Goal-validation timeline (contract/generation/review/phase events),
   *  oldest first. Optional: absent when the workspace carries no goal. */
  goalTimeline?: WorksheetTimelineEvent[];
}

/** Serialize a goal's validation events for narrator/UI consumption. */
export function serializeGoalTimeline(goal: GoalRecord | null): WorksheetTimelineEvent[] | undefined {
  const events = goal?.validation?.events;
  if (!events || events.length === 0) return undefined;
  return events.map((e) => ({
    at: e.createdAt,
    kind: e.kind,
    tone: e.tone,
    ...(e.phase ? { phase: e.phase } : {}),
    requirementId: e.requirementId,
    title: e.title,
    body: e.body,
  }));
}

const GUIDE_PATH = 'review/guide.json';
const WORKSHEET_PATH = 'review/analysis.json';

/** The workspace's artifacts scope — GUIDE_PATH et al are relative to the
 *  goal folder it owns (`goals/<goal-id>/review/…`), never the mount root. */
function scopeFor(projectName: string, workspaceName: string): ArtifactsScope {
  return artifactsScope(join(getProjectWorkspacesDir(projectName), workspaceName));
}

/**
 * Where analyze actually wrote the worksheet, for telling the narrator what to
 * read. Callers MUST use this instead of composing the path themselves: a
 * workspace that owns a goal writes under `goals/<goal-id>/`, and the mount
 * root holds a DIFFERENT `review/analysis.json` — the one a goal-less
 * workspace writes, which arrives in every mount once it rolls up to main.
 * Guessing the root path therefore yields a real, parseable worksheet for
 * somebody else's diff rather than an honest ENOENT.
 */
export function guideWorksheetPath(projectName: string, workspaceName: string): string {
  return scopeFor(projectName, workspaceName).abs(WORKSHEET_PATH);
}

// `asks` normalization is shared with the share viewer, which fetches
// review/guide.json as raw artifact bytes instead of going through this read.

export function readReviewGuide(projectName: string, workspaceName: string): ReviewGuide | null {
  const path = scopeFor(projectName, workspaceName).abs(GUIDE_PATH);
  if (!existsSync(path)) return null;
  try {
    const guide = JSON.parse(readFileSync(path, 'utf8')) as ReviewGuide;
    return {
      ...guide,
      sections: (guide.sections ?? []).map((section) => ({ ...section, asks: normalizeGuideAsks(section.asks) })),
    };
  } catch {
    return null;
  }
}

interface JournalEntryLite {
  phase: string;
  intent?: string;
  outcome?: string;
  decisions?: string[];
  filesTouched?: string[];
  delta?: { canonChanged?: string[]; requirementsAdvanced?: Array<{ id: string }> };
}

function readJournal(mount: string): JournalEntryLite[] {
  const dir = join(mount, 'journal');
  if (!existsSync(dir)) return [];
  const out: JournalEntryLite[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as JournalEntryLite);
    } catch { /* skip */ }
  }
  return out;
}

function breadcrumbSessions(mount: string, files: string[]): string[] {
  const log = join(mount, 'blame', 'edits.jsonl');
  if (!existsSync(log)) return [];
  const want = new Set(files);
  const sessions = new Set<string>();
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const crumb = JSON.parse(line) as { sessionId: string; file: string };
      if (want.has(crumb.file)) sessions.add(crumb.sessionId);
    } catch { /* skip */ }
  }
  return [...sessions];
}

/**
 * Build the narrator's worksheet: analysis + grounding + staleness vs the
 * cached guide. Committed to the artifacts branch so the narrator session
 * (and later audits) read a pinned input, not a moving target.
 */
export async function buildGuideWorksheet(projectName: string, workspaceName: string, baseRef?: string): Promise<GuideWorksheet> {
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  if (!baseRef) {
    try {
      baseRef = readProjectConfig(projectName).baseBranch ?? 'main';
    } catch {
      baseRef = 'main';
    }
  }
  const scope = scopeFor(projectName, workspaceName);
  if (!existsSync(join(scope.mountDir, '.git'))) {
    throw new SpacesError('Review guide requires the artifacts mount (.gitspace/artifacts).', 'USER_ERROR', 1);
  }
  const analysis: ReviewAnalysis = analyzeReviewDiff(workspaceDir, baseRef!);
  const cached = readReviewGuide(projectName, workspaceName);
  const cachedByCluster = new Map((cached?.sections ?? []).map((s) => [s.clusterId, s]));
  const journal = readJournal(scope.rootDir);

  const clusters = analysis.clusters.map((cluster) => {
    const phases = new Set(cluster.signals.journalPhases ?? []);
    const entries = journal
      .filter((j) => phases.has(j.phase) || (j.filesTouched ?? []).some((f) => cluster.files.includes(f)))
      .map((j) => ({ phase: j.phase, intent: j.intent, outcome: j.outcome, decisions: j.decisions, canonChanged: j.delta?.canonChanged }));
    return {
      ...cluster,
      stale: cachedByCluster.get(cluster.id)?.contentHash !== cluster.contentHash,
      grounding: { journal: entries, sessions: breadcrumbSessions(scope.rootDir, cluster.files) },
    };
  });

  let goalTimeline: WorksheetTimelineEvent[] | undefined;
  try {
    goalTimeline = serializeGoalTimeline(readWorkspaceGoal(projectName, workspaceName));
  } catch { /* no goal — worksheet stays journal-grounded */ }

  const worksheet: GuideWorksheet = {
    headSha: analysis.headSha,
    baseRef: baseRef!,
    clusters,
    cachedSections: clusters.filter((c) => !c.stale).length,
    canonTimeline: journal
      .filter((j) => (j.delta?.canonChanged ?? []).length > 0)
      .map((j) => ({ phase: j.phase, canonChanged: j.delta!.canonChanged! })),
    ...(goalTimeline ? { goalTimeline } : {}),
  };

  await captureArtifacts(getProjectDir(projectName), scope.mountDir, [
    { path: scope.rel(WORKSHEET_PATH), content: JSON.stringify(worksheet, null, 2) + '\n' },
  ], { message: `guide: worksheet @ ${analysis.headSha.slice(0, 7)}`, provenance: { tool: 'review-guide' } });
  return worksheet;
}

/**
 * Validate + merge + commit narrator sections. Enforces:
 *  - headSha matches the worksheet (no narrating a moved target)
 *  - every submitted section references a real cluster id
 *  - COVERAGE: every stale cluster is narrated or explicitly carried over;
 *    unchanged clusters keep their cached prose automatically.
 */
export async function submitGuideSections(
  projectName: string,
  workspaceName: string,
  input: { headSha: string; sections: GuideSection[]; specEvolution?: string },
  now: Date = new Date(),
): Promise<ReviewGuide> {
  const scope = scopeFor(projectName, workspaceName);
  const worksheetPath = scope.abs(WORKSHEET_PATH);
  if (!existsSync(worksheetPath)) {
    throw new SpacesError('No worksheet — run `gssh space guide analyze` first.', 'USER_ERROR', 1);
  }
  const worksheet = JSON.parse(readFileSync(worksheetPath, 'utf8')) as GuideWorksheet;
  if (input.headSha !== worksheet.headSha) {
    // Name the file. "Re-run analyze" alone is a trap: the usual cause is
    // narrating a different review/analysis.json (the mount-root one belonging
    // to a goal-less workspace) rather than a genuinely moved HEAD, and analyze
    // has already been rewriting the correct file every time.
    throw new SpacesError(
      `Worksheet at ${worksheetPath} is for ${worksheet.headSha.slice(0, 7)} but submission targets ${input.headSha.slice(0, 7)}. `
        + 'If HEAD moved, re-run `gssh space guide analyze`; if it did not, you narrated a different worksheet file — narrate that path.',
      'USER_ERROR',
      1,
    );
  }
  const clusterById = new Map(worksheet.clusters.map((c) => [c.id, c]));
  for (const section of input.sections) {
    if (!clusterById.has(section.clusterId)) {
      throw new SpacesError(`Section references unknown cluster ${section.clusterId}.`, 'USER_ERROR', 1);
    }
    if (!section.title?.trim() || !section.explanation?.trim()) {
      throw new SpacesError(`Section for ${section.clusterId} is missing title or explanation.`, 'USER_ERROR', 1);
    }
    // `asks` is a plain string list while the sibling `callouts` is
    // `{tone, text}` — narrators mirror the object shape into asks, which used
    // to persist happily and then crash the reviewer's guide pane on render.
    // Reject at the boundary where agent-authored JSON enters.
    const badAsk = (section.asks ?? []).find((ask) => typeof ask !== 'string');
    if (badAsk !== undefined) {
      throw new SpacesError(
        `Section ${section.clusterId} has a non-string entry in "asks" (${JSON.stringify(badAsk)}). `
          + 'asks is a list of plain strings — ["Should X stay?"]; only callouts take {tone, text}.',
        'USER_ERROR',
        1,
      );
    }
    const files = new Set(clusterById.get(section.clusterId)!.files);
    for (const exhibit of section.exhibits ?? []) {
      if (!files.has(exhibit.file)) {
        throw new SpacesError(`Exhibit ${exhibit.file} is not in cluster ${section.clusterId} — exhibits must stay inside their section's files.`, 'USER_ERROR', 1);
      }
    }
  }

  const cached = readReviewGuide(projectName, workspaceName);
  const cachedById = new Map((cached?.sections ?? []).map((s) => [s.clusterId, s]));
  const submittedById = new Map(input.sections.map((s) => [s.clusterId, s]));

  const sections: GuideSection[] = [];
  const missing: string[] = [];
  for (const cluster of worksheet.clusters) {
    const submitted = submittedById.get(cluster.id);
    if (submitted) { sections.push({ ...submitted, kind: cluster.type, contentHash: cluster.contentHash, files: cluster.files }); continue; }
    const carried = cachedById.get(cluster.id);
    if (carried && !cluster.stale) { sections.push(carried); continue; }
    missing.push(cluster.id);
  }
  if (missing.length > 0) {
    throw new SpacesError(`Coverage: ${missing.length} stale cluster(s) not narrated: ${missing.join(', ')}.`, 'USER_ERROR', 1);
  }

  const guide: ReviewGuide = {
    version: 1,
    headSha: worksheet.headSha,
    baseRef: worksheet.baseRef,
    generatedAt: now.toISOString(),
    specEvolution: input.specEvolution ?? cached?.specEvolution,
    sections,
  };
  await captureArtifacts(getProjectDir(projectName), scope.mountDir, [
    { path: scope.rel(GUIDE_PATH), content: JSON.stringify(guide, null, 2) + '\n' },
  ], { message: `guide: ${sections.length} sections @ ${guide.headSha.slice(0, 7)}`, provenance: { tool: 'review-guide' } });
  return guide;
}
