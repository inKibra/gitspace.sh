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

/** Model-role id → user-facing display name (mirrors OMP's MODEL_ROLES names;
 *  `task` displays as 'Current model' — the AGENTS-tab vocabulary for
 *  follows-the-session's-model — rather than OMP's internal 'Subtask'). */
export const MODEL_ROLE_LABELS: Record<string, string> = {
  default: 'Default',
  task: 'Current model',
  slow: 'Thinking',
  smol: 'Fast',
  plan: 'Architect',
  designer: 'Designer',
  vision: 'Vision',
  commit: 'Commit',
  tiny: 'Tiny',
  advisor: 'Advisor',
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

const isRoleRef = (s: string): boolean => /^pi\//i.test(s.trim());

/**
 * Chip label for a NAMED agent's live model resolution, matching the AGENTS
 * tab labeling. Effective spec = override > frontmatter:
 *  - unset or `pi/task` → 'Current model' (inherits the session's model)
 *  - single `pi/<role>` → the role label, with the resolved concrete model
 *    appended when the role expanded to one ('Thinking — gpt-5.5:xhigh')
 *  - multi-role pins → joined role labels ('Architect, Thinking')
 *  - a concrete pin passes through as-is (same as the AGENTS tab)
 */
export function agentResolutionLabel(a: { model: string | null; overrideModel: string | null; resolvedModel: string | null }): string {
  const effective = (a.overrideModel ?? a.model)?.trim() || null;
  if (!effective) return 'Current model';
  const parts = effective.split(',').map((s) => s.trim()).filter(Boolean);
  const label = parts
    .map((p) => (isRoleRef(p) ? modelRoleLabel(p) : p))
    .join(', ');
  if (label === MODEL_ROLE_LABELS.task) return label; // pi/task: no model suffix
  const resolved = a.resolvedModel?.trim();
  // Append the concrete resolution only when the pin was a role ref that
  // actually expanded to a model (an unexpanded/unresolved ref stays a label).
  if (parts.length === 1 && isRoleRef(parts[0]) && resolved && !isRoleRef(resolved) && resolved !== effective) {
    return `${label} — ${resolved}`;
  }
  return label;
}
