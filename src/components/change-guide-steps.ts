/**
 * Change-guide walkthrough model and its two derivations.
 *
 * Kept out of ChangeGuide.web.tsx deliberately. That module imports the diff
 * renderer, which resolves only in the web build, so anything living beside it is
 * unreachable from a Node test — which is exactly how `walkStepsFromGuide` came to
 * silently discard the narrator's per-exhibit metadata with nothing to catch it.
 *
 * Two sources produce the same step shape:
 *   - `buildWalkSteps`: heuristic fallback, groups changed files by top-level dir.
 *   - `walkStepsFromGuide`: the narrated guide committed by the narrator agent.
 */
import type { ReviewChangedFile } from '../types/review.js';
import type { ReviewGuide } from '../core/review-guide.js';

/* ── Walkthrough step model + derivation ───────────────────────────────────── */

export interface WalkStepFile {
  path: string;
  prevPath?: string;
  changeType: ReviewChangedFile['changeType'];
  /** Guide-mode: why the narrator put this file in front of you. */
  note?: string;
  /** Guide-mode: the narrator marked this one as needing judgment, not a skim.
   *  This is the guide's whole point — an unmarked wall of diffs is the diff
   *  browser it was supposed to replace. */
  slow?: boolean;
}

export interface WalkStepComment {
  who: string;
  tone: 'pass' | 'fail' | 'info' | 'warn';
  text: string;
}

export interface WalkStep {
  n: number;
  /** Short uppercase phase label (e.g. 'core', 'docs', 'tests') */
  kind: string;
  title: string;
  /** Narrative: what this phase of the change is */
  what: string;
  /** Narrative: why it matters for the reviewer */
  why: string;
  files: WalkStepFile[];
  /** Optional reviewer comment thread closing the section (mock: ReviewStage .thread). */
  comment?: WalkStepComment;
  /** Guide-mode: stable section id (read-state persists under it). */
  sectionId?: string;
  /** Guide-mode: markdown explanation (rendered over `why` plain text). */
  explanationMd?: string;
  /** Guide-mode: narrator questions for the reviewer. */
  asks?: string[];
  /** Guide-mode: attention callouts. */
  callouts?: Array<{ tone: 'risk' | 'mechanical' | 'decision'; text: string }>;
  /** Guide-mode: full member file list (exhibits are the subset with diffs shown). */
  allFiles?: string[];
}

const ROOT_GROUP = '(root)';


function topLevelDir(path: string): string {
  const idx = path.indexOf('/');
  return idx === -1 ? ROOT_GROUP : path.slice(0, idx);
}

function kindForGroup(dir: string): string {
  const d = dir.toLowerCase();
  if (dir === ROOT_GROUP) return 'config';
  if (d === 'docs' || d === 'doc') return 'docs';
  if (d === 'test' || d === 'tests' || d === '__tests__' || d === 'e2e') return 'tests';
  if (d === 'web' || d === 'app' || d === 'ui') return 'surface';
  if (d === 'src' || d === 'lib' || d === 'core') return 'core';
  if (d === 'scripts' || d === 'tools' || d === 'bin') return 'tooling';
  return 'change';
}

const CHANGE_WORD: Record<ReviewChangedFile['changeType'], string> = {
  new: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  modified: 'modified',
};

/**
 * Heuristic guide: group changed files into phases by top-level directory.
 * Replaceable by an agent-authored WalkStep[] source later — keep the shape stable.
 */
export function buildWalkSteps(files: ReviewChangedFile[]): WalkStep[] {
  const groups = new Map<string, WalkStepFile[]>();
  for (const f of files) {
    const dir = topLevelDir(f.filePath);
    const list = groups.get(dir) ?? [];
    list.push({ path: f.filePath, prevPath: f.prevFilePath, changeType: f.changeType });
    groups.set(dir, list);
  }
  const dirs = [...groups.keys()].sort((a, b) => {
    if (a === ROOT_GROUP) return 1;
    if (b === ROOT_GROUP) return -1;
    return a.localeCompare(b);
  });
  return dirs.map((dir, i) => {
    const stepFiles = [...(groups.get(dir) ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    const counts = new Map<string, number>();
    for (const f of stepFiles) counts.set(CHANGE_WORD[f.changeType], (counts.get(CHANGE_WORD[f.changeType]) ?? 0) + 1);
    const breakdown = [...counts.entries()].map(([word, n]) => `${n} ${word}`).join(', ');
    const surface = dir === ROOT_GROUP ? 'the repository root' : `${dir}/`;
    return {
      n: i + 1,
      kind: kindForGroup(dir),
      title: dir === ROOT_GROUP ? 'Repository root' : `${dir}/`,
      what: `${stepFiles.length} file${stepFiles.length === 1 ? '' : 's'} changed under ${surface} — ${breakdown}.`,
      why: `These files share the ${surface} surface and land together as one phase of the change; review them as a unit before moving on.`,
      files: stepFiles,
    };
  });
}

/**
 * Narrated guide → walk steps.
 *
 * Exported and pure for the same reason `buildWalkSteps` is: this mapping is the
 * only place the narrator's work can be silently thrown away, and it was. It
 * dropped `note` and `slow` — the two things that make an exhibit a curated
 * reading order rather than a file list — and stamped every exhibit 'modified',
 * so an added or renamed file was labelled wrongly in its own header.
 *
 * `changeType` here is provisional: git's name-status is the authority and the
 * pane overrides it at render, where the rename source is also known.
 */
export function walkStepsFromGuide(guide: ReviewGuide): WalkStep[] {
  return guide.sections.map((section, i) => ({
    n: i + 1,
    kind: section.kind,
    title: section.title,
    what: '',
    why: section.explanation,
    explanationMd: section.explanation,
    files: section.exhibits.map((e) => ({
      path: e.file,
      changeType: 'modified' as const,
      note: e.note,
      slow: e.slow,
    })),
    sectionId: section.clusterId,
    asks: section.asks,
    callouts: section.callouts,
    allFiles: section.files,
  }));
}
