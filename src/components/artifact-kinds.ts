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

/** Classify a mount-relative artifact path (conventions per docs/ARTIFACTS-FS.md). */
export function classifyArtifact(path: string): ArtifactKind {
  // Session scratch has an address but NO TYPE until promoted — without this
  // guard, extension-keyed kinds (*.dashboard.json, *.gssh.html, *.data.json)
  // would leak scratch into curated surfaces (docs/ARTIFACT-PROTOCOL.md Q2).
  if (path === '.sessions' || path.startsWith('.sessions/')) return 'other';
  const base = path.split('/').pop() ?? path;
  if (base === 'goal.md' || path.startsWith('goal/')) return 'goal';
  if (base === 'rubric.json' || base.endsWith('.rubric.json')) return 'rubric';
  if (base.endsWith('.workflow.json')) return 'workflow';
  if (base.endsWith('.dashboard.json')) return 'dashboard';
  if (base.endsWith('.gssh.html')) return 'app';
  if (base.endsWith('.data.json') || path.startsWith('data/')) return 'data';
  if (path.startsWith('reports/')) return 'report';
  if (path.startsWith('validation/') || path.startsWith('evidence/') || path.startsWith('shots/') || path.startsWith('demos/')) return 'evidence';
  if (path.startsWith('notes/')) return 'note';
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
