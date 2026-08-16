/**
 * Every mapping from a status value to something visible.
 *
 * These are LOOKUPS, not decisions. The decision is made once —
 * `determineAgentState` for a session, `deriveWorkspaceStatusSummary` for a
 * workspace — and everything here just renders the answer.
 *
 * They are `Record<Enum, …>` on purpose. An if/else chain or a `switch` with a
 * `default` silently absorbs a new status: that is exactly how `dormant` ended
 * up painted blue in four separate places. With an exhaustive record, adding a
 * status is a type error in every table until it is handled.
 *
 * The two workspace tables differ deliberately — the kanban card edge uses
 * brighter variants than the project chip — but they live together so a new
 * colour cannot be added to one and forgotten in the other.
 */

import type { AgentSessionRenderState } from '../../agents/agent-runtime-types.js';
import type { WorkspaceStatusColor } from '../workspaces/workspace-status.js';

/** Project/workspace chips (app shell). */
export const WORKSPACE_CHIP_COLOR: Record<WorkspaceStatusColor, string> = {
  green: 'var(--gs-success)',
  red: 'var(--gs-danger)',
  orange: 'var(--gs-warning)',
  blue: 'var(--gs-info)',
  dim: 'var(--gs-text-ghost)',
};

/** Kanban card edge/dot — brighter variants than the chip, by design. */
export const WORKSPACE_EDGE_COLOR: Record<WorkspaceStatusColor, string> = {
  green: 'var(--gs-accent)',
  orange: 'var(--gs-warning-bright)',
  red: 'var(--gs-danger-hover)',
  blue: 'var(--gs-info)',
  dim: 'var(--gs-text-ghost)',
};

/**
 * Agent session dot colour.
 *
 * `closed`, `dormant` and `archived` are all "not live" and share grey: nothing
 * is running, so nothing should draw the eye. They remain distinct states
 * because they mean different things (dismissed / resumable / filed away) — the
 * shared colour is a rendering choice, not a lost distinction.
 */
export const AGENT_STATE_COLOR: Record<AgentSessionRenderState, string> = {
  'permission-needed': 'var(--gs-warning-bright)',
  running: 'var(--gs-running)',
  waiting: 'var(--gs-info)',
  retrying: 'var(--gs-danger)',
  closed: 'var(--gs-text-ghost)',
  dormant: 'var(--gs-text-ghost)',
  archived: 'var(--gs-text-ghost)',
};

/**
 * Same mapping as {@link AGENT_STATE_COLOR}, pre-baked into Tailwind classes.
 *
 * Two tables because the consumers need different things: the kanban edge and
 * the chips take a raw CSS value for an inline style, while the sidebar dot
 * takes a class. The class strings MUST be written out literally — Tailwind
 * scans source text, so a template literal built at runtime produces no CSS.
 */
export const AGENT_STATE_DOT_CLASS: Record<AgentSessionRenderState, string> = {
  'permission-needed': 'text-[var(--gs-warning-bright)]',
  running: 'text-[var(--gs-running)]',
  waiting: 'text-[var(--gs-info)]',
  retrying: 'text-[var(--gs-danger)]',
  closed: 'text-[var(--gs-text-ghost)]',
  dormant: 'text-[var(--gs-text-ghost)]',
  archived: 'text-[var(--gs-text-ghost)]',
};

/** Agent session status word shown beside the title. */
export const AGENT_STATE_LABEL: Record<AgentSessionRenderState, string> = {
  'permission-needed': 'needs permission',
  running: 'running',
  waiting: 'waiting',
  retrying: 'retrying',
  closed: 'closed',
  dormant: 'dormant',
  archived: 'archived',
};

/**
 * The chain-node dot.
 *
 * RULE: a lit dot beside a chain node means the WORKSPACE STATUS of the goal's
 * workspace — the same colour that workspace shows in the strip, the chips and
 * the kanban edge. There is no second meaning. Every surface that draws one
 * (the workspace rail, the project overview's chain strip, anywhere later) fills
 * it from {@link WORKSPACE_CHIP_COLOR}.
 *
 * A goal with no workspace has no status to report and draws the hollow variant.
 * Phase, "has a workspace", and "is the current node" are NOT dot colours: they
 * were, and a lit green dot ended up meaning nothing more than "a workspace
 * exists" while that workspace was red two panels away.
 */
export const CHAIN_NODE_DOT_BASE = 'flex-none rounded-full border-2';
/** No workspace yet → nothing to report. */
export const CHAIN_NODE_DOT_EMPTY = 'border-[var(--gs-border-active)] bg-[var(--gs-bg)]';

/** A goal's position in its chain, as rendered. Distinct from agent state: a
 *  chain node is about the goal's progress, not about a session's activity. */
export type ChainNodeState = 'shipped' | 'active' | 'planned';

/**
 * Tone for a chain node's label/glyph. Shared because the goal-chain rail and
 * the goal doc's chain both render the same three states, and had drifted into
 * two byte-identical private copies — which is exactly how they stop being
 * identical. Literal class strings, per the note above.
 */
export const CHAIN_NODE_TONE_CLASS: Record<ChainNodeState, string> = {
  shipped: 'text-[var(--gs-success)]',
  active: 'text-[var(--gs-accent)]',
  planned: 'text-[var(--gs-text-dim)]',
};
