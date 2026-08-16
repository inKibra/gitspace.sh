import { z } from 'zod';

/**
 * The on-the-wire envelope every block shares. `data` is opaque here and is
 * validated against the block type's own schema at the ingest/render boundary
 * (see `validateBlock`). Blocks are authored by an agent, so they are untrusted
 * until validated — unlike GitSpace's internal JSON, which is trust-cast.
 */
export const blockEnvelope = z.object({
  id: z.string(),
  type: z.string(),
  data: z.unknown(),
});

/** A block as authored/transported: a type tag + data validated against that type. */
export interface Block<T = unknown> {
  id: string;
  type: string;
  data: T;
}

/**
 * Where a block sits in the rendering hierarchy. Organizes the catalog and the
 * build order; the registry itself is one flat namespace.
 * - transcript:  the live conversation primitives (message, thinking, tool-call)
 * - interaction: things the human acts on (verdict-chip, approval-gate, …)
 * - structural:  layout/flow (run-graph, dataflow)
 * - content:     reusable content units (markdown, code, diff, evidence, …)
 */
export type BlockTier = 'transcript' | 'interaction' | 'structural' | 'content';
export const BLOCK_TIERS: readonly BlockTier[] = ['transcript', 'interaction', 'structural', 'content'];
