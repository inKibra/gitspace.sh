/** Side-effect entrypoint: populate PI_DOCS_EMBED before any SDK import.
 *  Kept separate from pi-docs-embed.ts so importers get the install by import
 *  ORDER alone — a call site inside a module body would run after the SDK's
 *  own module graph had already been evaluated. */
import { installPiDocsEmbed } from './pi-docs-embed.js';

installPiDocsEmbed();
