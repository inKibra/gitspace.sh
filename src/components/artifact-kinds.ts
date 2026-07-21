/**
 * Artifact kind classification (mock: ProjectArtifactsRail KIND_* tables).
 * Kinds drive grouping, icons and open-behavior across the artifact rails.
 */

export type ArtifactKind = 'goal' | 'rubric' | 'workflow' | 'evidence' | 'dashboard' | 'app' | 'data' | 'report' | 'note' | 'other';

export const KIND_ICON: Record<ArtifactKind, string> = {
  goal: '◇', rubric: '☰', workflow: '⟜', evidence: '▸', dashboard: '▦', app: '◧', data: '▤', report: '⚑', note: '✎', other: '·',
};

export const KIND_LABEL: Record<ArtifactKind, string> = {
  goal: 'Goal', rubric: 'Rubric', workflow: 'Workflow', evidence: 'Evidence', dashboard: 'Dashboards', app: 'Apps', data: 'Data', report: 'Reports', note: 'Notes', other: 'Other',
};

export const KIND_ORDER: ArtifactKind[] = ['goal', 'rubric', 'workflow', 'evidence', 'dashboard', 'app', 'data', 'report', 'note', 'other'];

/**
 * Strip a leading `goals/<goal-id>/` segment, yielding the GOAL-RELATIVE path.
 *
 * The artifacts tree moved to a goal-keyed layout (df0a94f): every goal owns
 * `goals/<goal-id>/` and the daemon lists artifacts MOUNT-relative, so the UI
 * now sees `goals/<goal-id>/reports/x` where the folder conventions
 * (`reports/`, `data/`, `validation/`, `goal.md`, …) live goal-relative. Path
 * matchers — classification, special-file detection, the mini-app data picker,
 * the project-home reports feed — must reconcile on ONE basis, and goal-relative
 * is the basis that `local://` and the favorites manifest already use.
 *
 * Only strips when the prefix is present, so a still-flat repo (`reports/x`) or a
 * project-root artifact (`README.md`) passes through untouched. A rolled-up
 * artifact seen from the tree root (`goals/<id>/reports/x`) is normalized the
 * same way, which is correct — it IS a report.
 */
export function toGoalRelative(path: string): string {
  return path.replace(/^goals\/[^/]+\//, '');
}

/** The leading `goals/<goal-id>/` segment of a mount-relative path, or '' when
 *  the path is flat (pre-migration repo) or project-root. */
export function goalPrefixOf(path: string): string {
  const m = /^goals\/[^/]+\//.exec(path);
  return m ? m[0] : '';
}

/**
 * Candidate mount-relative paths for a report attachment ref, in preference
 * order. Refs inside `*.report.json` are written GOAL-RELATIVE (`local://`
 * binds to the goal folder), so they must be anchored to THE REPORT'S OWN
 * `goals/<id>/` prefix — never to any ambient/current goal context. That one
 * rule covers the whole matrix:
 *   - report at goals/<id>/reports/x.report.json + ref `reports/x.md`
 *       → goals/<id>/reports/x.md
 *   - same report + OLD-FLAT ref written pre-migration (`demos/y.webm`)
 *       → goals/<id>/demos/y.webm (old-flat == goal-relative after migration)
 *   - report on a FLAT (un-migrated) repo → ref resolves at the mount root
 *   - report under goals/<id>/ viewed from MAIN (rolled-up) → that SAME <id>
 *       folder, not the viewing workspace's goal
 * FALLBACK: the ref as-is — covers refs already written mount-relative.
 * A ref that itself starts with `goals/` is already mount-relative (goal-
 * relative paths can never legitimately start with `goals/`; nested goals/
 * dirs are refused at capture time), so it gets no anchored candidate.
 */
export function attachmentRefCandidates(reportPath: string, ref: string): string[] {
  const clean = ref.replace(/^\/+/, '');
  const prefix = goalPrefixOf(reportPath);
  if (!prefix || clean.startsWith('goals/')) return [clean];
  return [prefix + clean, clean];
}

/**
 * Resolve a report attachment ref to the mount-relative path to open, or null
 * when NO candidate exists (the caller must surface a missing state, never a
 * broken viewer). `exists` is the existence oracle — prefer a membership test
 * against the artifact listing; a read-probe works too. Without an oracle the
 * anchored candidate is returned optimistically.
 */
export function resolveAttachmentRef(reportPath: string, ref: string, exists?: (path: string) => boolean): string | null {
  const candidates = attachmentRefCandidates(reportPath, ref);
  if (!exists) return candidates[0] ?? null;
  return candidates.find(exists) ?? null;
}

/** Classify an artifact path (conventions per docs/ARTIFACTS-FS.md). Accepts a
 *  mount-relative goal-keyed path (`goals/<id>/reports/x`) or a flat one. */
export function classifyArtifact(path: string): ArtifactKind {
  // Session scratch has an address but NO TYPE until promoted — without this
  // guard, extension-keyed kinds (*.dashboard.json, *.gssh.html, *.data.json)
  // would leak scratch into curated surfaces (docs/ARTIFACT-PROTOCOL.md Q2).
  // Checked on the raw path: `.sessions` lives at the mount root, not in a goal.
  if (path === '.sessions' || path.startsWith('.sessions/')) return 'other';
  // Reconcile onto the goal-relative basis the folder conventions are written
  // in, so `goals/<id>/reports/x` classifies the same as a flat `reports/x`.
  const rel = toGoalRelative(path);
  const base = rel.split('/').pop() ?? rel;
  if (base === 'goal.md' || rel.startsWith('goal/')) return 'goal';
  if (base === 'rubric.json' || base.endsWith('.rubric.json')) return 'rubric';
  if (base.endsWith('.workflow.json')) return 'workflow';
  if (base.endsWith('.dashboard.json')) return 'dashboard';
  if (base.endsWith('.gssh.html')) return 'app';
  if (base.endsWith('.data.json') || rel.startsWith('data/')) return 'data';
  if (rel.startsWith('reports/')) return 'report';
  if (rel.startsWith('validation/') || rel.startsWith('evidence/') || rel.startsWith('shots/') || rel.startsWith('demos/')) return 'evidence';
  if (rel.startsWith('notes/')) return 'note';
  return 'other';
}

/** UTF-8-safe base64 decode (bare atob() yields Latin-1 and mangles —, ✦, etc). */
export function decodeBase64Utf8(base64: string): string {
  return new TextDecoder('utf-8').decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

/** UTF-8-safe base64 encode (bare btoa() throws on non-Latin-1 input). */
export function encodeBase64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
