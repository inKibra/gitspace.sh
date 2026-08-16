import { z } from 'zod';
import { blockEnvelope, type Block, type BlockTier } from './block.js';

/**
 * A registered block type: its zod schema is the single source of truth for the
 * TS type (`z.infer`), the runtime validator, and the JSON-Schema catalog entry
 * the agent reads to learn the vocabulary.
 */
export interface BlockDefinition<S extends z.ZodType = z.ZodType> {
  type: string;
  tier: BlockTier;
  /** One line the agent reads to know when to author this block. */
  description: string;
  schema: S;
}

const registry = new Map<string, BlockDefinition>();

/** Register a block type. Throws on duplicate — a type is defined exactly once. */
export function defineBlock<S extends z.ZodType>(def: BlockDefinition<S>): BlockDefinition<S> {
  if (registry.has(def.type)) {
    throw new Error(`block type "${def.type}" is already registered`);
  }
  registry.set(def.type, def as unknown as BlockDefinition);
  return def;
}

export function getBlockDefinition(type: string): BlockDefinition | undefined {
  return registry.get(type);
}

export function hasBlock(type: string): boolean {
  return registry.has(type);
}

export function listBlockDefinitions(): BlockDefinition[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type));
}

export function listBlockTypes(): string[] {
  return listBlockDefinitions().map((d) => d.type);
}

/** Result of validating one block against its registered schema. Never silent. */
export type BlockValidation =
  | { ok: true; block: Block }
  | {
      ok: false;
      reason: 'malformed-envelope' | 'unknown-type' | 'invalid-data';
      type?: string;
      issues: string[];
    };

/**
 * Validate one block (envelope + data). Composition is the caller's job: a block
 * that embeds other blocks (e.g. `tool-call.result`) re-runs `validateBlock` on
 * each child, so the registry stays a flat, type-agnostic namespace.
 */
export function validateBlock(input: unknown): BlockValidation {
  const env = blockEnvelope.safeParse(input);
  if (!env.success) {
    return { ok: false, reason: 'malformed-envelope', issues: flattenIssues(env.error) };
  }
  const def = registry.get(env.data.type);
  if (!def) {
    return {
      ok: false,
      reason: 'unknown-type',
      type: env.data.type,
      issues: [`no block registered for type "${env.data.type}"`],
    };
  }
  const parsed = def.schema.safeParse(env.data.data);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-data', type: env.data.type, issues: flattenIssues(parsed.error) };
  }
  return { ok: true, block: { id: env.data.id, type: env.data.type, data: parsed.data } };
}

function flattenIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/** A machine-readable description of every block type — the agent's vocabulary. */
export interface BlockCatalogEntry {
  type: string;
  tier: BlockTier;
  description: string;
  /** JSON Schema for the block's `data`. */
  schema: unknown;
}

export function buildCatalog(): BlockCatalogEntry[] {
  return listBlockDefinitions().map((d) => ({
    type: d.type,
    tier: d.tier,
    description: d.description,
    schema: z.toJSONSchema(d.schema),
  }));
}
