// The block registry: one tiered namespace of agent-authored content types.
// Schemas are the single source of truth for the TS type, the runtime validator,
// and the JSON-Schema catalog. Importing this module registers the vocabulary.
//
// React-free by design: the server authors + validates blocks here; web renderers
// (a separate `*.web.tsx` layer) consume the same schemas for typed rendering.

import './types/content.js';
import './types/transcript.js';
import './types/interaction.js';

export { blockEnvelope, BLOCK_TIERS } from './block.js';
export type { Block, BlockTier } from './block.js';
export {
  defineBlock,
  getBlockDefinition,
  hasBlock,
  listBlockDefinitions,
  listBlockTypes,
  validateBlock,
  buildCatalog,
} from './registry.js';
export type { BlockDefinition, BlockValidation, BlockCatalogEntry } from './registry.js';

export * from './types/content.js';
export * from './types/transcript.js';
export * from './types/interaction.js';
