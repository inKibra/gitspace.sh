/**
 * Model-role vocabulary for workflow surfaces.
 *
 * Standalone on purpose: web renderers (src/blocks/render/*.web.tsx) import
 * this, so it must not pull daemon code (tmux-lite, pi-coordinator) into the
 * browser bundle. The daemon side (pi-coordinator) imports the alias table
 * from here and prefixes ids with `pi/` for OMP role references.
 *
 * Role ids mirror OMP's model roles (pi/task, pi/slow, pi/smol, pi/plan).
 * Display names are the user vocabulary — UI surfaces speak roles natively
 * and never render raw model names.
 */

/** Model-role id → user-facing display name. */
export const MODEL_ROLE_LABELS: Record<string, string> = {
  task: 'Current model',
  slow: 'Thinking',
  smol: 'Fast',
  plan: 'Architect',
};

/** Claude Code frontmatter model aliases → model-role ids.
 *  - opus: Claude's deep-reasoning tier → slow (reviewer-grade role)
 *  - sonnet: Claude's balanced daily-driver → task (inherits the session's
 *    default model — the OMP equivalent of "use the normal model")
 *  - haiku: Claude's cheap/fast tier → smol
 *  - inherit: explicit "use the parent's model" → task
 */
export const CLAUDE_MODEL_ALIAS_TO_MODEL_ROLE: Record<string, string> = {
  opus: 'slow',
  sonnet: 'task',
  haiku: 'smol',
  inherit: 'task',
};

/** 'pi/slow' or 'PI/Slow' or 'slow' → 'slow'. */
export function normalizeModelRole(role: string): string {
  return role.trim().toLowerCase().replace(/^pi\//, '');
}

/** Display name for a model-role id ('slow' → 'Thinking'). Unknown roles fall
 *  back to the normalized id itself (a role id, never a model name). */
export function modelRoleLabel(role: string): string {
  const id = normalizeModelRole(role);
  return MODEL_ROLE_LABELS[id] ?? id;
}

/**
 * Chip label for a workflow node. Prefers `modelRole`; a legacy `model` value
 * is translated through the alias table. Untranslatable raw model names yield
 * undefined (no chip) — the workflow surface speaks roles, not models.
 */
export function wfNodeModelRoleLabel(n: { modelRole?: string; model?: string }): string | undefined {
  if (n.modelRole) return modelRoleLabel(n.modelRole);
  if (n.model) {
    const role = CLAUDE_MODEL_ALIAS_TO_MODEL_ROLE[n.model.trim().toLowerCase()];
    return role ? modelRoleLabel(role) : undefined;
  }
  return undefined;
}
