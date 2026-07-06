// Web renderer layer for the block registry. Importing this registers every web
// renderer. Pairs with the React-free schema core in `../index.ts` — schemas
// validate, these render. Styling: Tailwind utilities over `--gs-*` tokens.

import './content.web.js';
import './transcript.web.js';
import './interaction.web.js';
import './code.web.js'; // @pierre/diffs (shiki) — resolves in the web build only
import './diff.web.js'; // @pierre/diffs — resolves in the web build only
import './file-tree.web.js'; // @pierre/trees — resolves in the web build only
import './mermaid.web.js'; // mermaid — resolves in the web build only
import './mini-app.web.js';
import './goal-blocks.web.js';
import './workflow.web.js';

export { BlockView, BlockList, defineRenderer, hasRenderer } from './registry.web.js';
export { Markdown, BLOCK_MD_OPTIONS } from './markdown.web.js';
export { BlockHostProvider, useBlockHost } from './host.web.js';
export type { BlockHost, BlockAction } from './host.web.js';
export { AgentTranscript } from './AgentTranscript.web.js';
export { useTranscript } from './useTranscript.web.js';
export type { UseTranscript, TranscriptMode } from './useTranscript.web.js';
