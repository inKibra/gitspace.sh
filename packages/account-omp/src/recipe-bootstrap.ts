import { pathToFileURL } from 'node:url';
import { prepareOmpRuntimeArtifact } from './runtime-recipe.js';

// Selection and manifest authentication happen in the machine; installation never changes that immutable selection.
const entrypoint = await prepareOmpRuntimeArtifact(import.meta.dir);
await import(pathToFileURL(entrypoint).href);
