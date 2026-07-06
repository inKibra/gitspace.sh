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
import { captureArtifacts } from './artifacts.js';
import { SpacesError } from '../types/errors.js';

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
}

const GUIDE_PATH = 'review/guide.json';
const WORKSHEET_PATH = 'review/analysis.json';

function mountDirFor(projectName: string, workspaceName: string): string {
  return join(getProjectWorkspacesDir(projectName), workspaceName, '.gitspace', 'artifacts');
}

export function readReviewGuide(projectName: string, workspaceName: string): ReviewGuide | null {
  const path = join(mountDirFor(projectName, workspaceName), GUIDE_PATH);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReviewGuide;
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
  const mount = mountDirFor(projectName, workspaceName);
  if (!existsSync(join(mount, '.git'))) {
    throw new SpacesError('Review guide requires the artifacts mount (.gitspace/artifacts).', 'USER_ERROR', 1);
  }
  const analysis: ReviewAnalysis = analyzeReviewDiff(workspaceDir, baseRef!);
  const cached = readReviewGuide(projectName, workspaceName);
  const cachedByCluster = new Map((cached?.sections ?? []).map((s) => [s.clusterId, s]));
  const journal = readJournal(mount);

  const clusters = analysis.clusters.map((cluster) => {
    const phases = new Set(cluster.signals.journalPhases ?? []);
    const entries = journal
      .filter((j) => phases.has(j.phase) || (j.filesTouched ?? []).some((f) => cluster.files.includes(f)))
      .map((j) => ({ phase: j.phase, intent: j.intent, outcome: j.outcome, decisions: j.decisions, canonChanged: j.delta?.canonChanged }));
    return {
      ...cluster,
      stale: cachedByCluster.get(cluster.id)?.contentHash !== cluster.contentHash,
      grounding: { journal: entries, sessions: breadcrumbSessions(mount, cluster.files) },
    };
  });

  const worksheet: GuideWorksheet = {
    headSha: analysis.headSha,
    baseRef: baseRef!,
    clusters,
    cachedSections: clusters.filter((c) => !c.stale).length,
    canonTimeline: journal
      .filter((j) => (j.delta?.canonChanged ?? []).length > 0)
      .map((j) => ({ phase: j.phase, canonChanged: j.delta!.canonChanged! })),
  };

  await captureArtifacts(getProjectDir(projectName), mount, [
    { path: WORKSHEET_PATH, content: JSON.stringify(worksheet, null, 2) + '\n' },
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
  const mount = mountDirFor(projectName, workspaceName);
  const worksheetPath = join(mount, WORKSHEET_PATH);
  if (!existsSync(worksheetPath)) {
    throw new SpacesError('No worksheet — run `gssh space guide analyze` first.', 'USER_ERROR', 1);
  }
  const worksheet = JSON.parse(readFileSync(worksheetPath, 'utf8')) as GuideWorksheet;
  if (input.headSha !== worksheet.headSha) {
    throw new SpacesError(`Worksheet is for ${worksheet.headSha.slice(0, 7)} but submission targets ${input.headSha.slice(0, 7)} — re-run analyze.`, 'USER_ERROR', 1);
  }
  const clusterById = new Map(worksheet.clusters.map((c) => [c.id, c]));
  for (const section of input.sections) {
    if (!clusterById.has(section.clusterId)) {
      throw new SpacesError(`Section references unknown cluster ${section.clusterId}.`, 'USER_ERROR', 1);
    }
    if (!section.title?.trim() || !section.explanation?.trim()) {
      throw new SpacesError(`Section for ${section.clusterId} is missing title or explanation.`, 'USER_ERROR', 1);
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
  await captureArtifacts(getProjectDir(projectName), mount, [
    { path: GUIDE_PATH, content: JSON.stringify(guide, null, 2) + '\n' },
  ], { message: `guide: ${sections.length} sections @ ${guide.headSha.slice(0, 7)}`, provenance: { tool: 'review-guide' } });
  return guide;
}
