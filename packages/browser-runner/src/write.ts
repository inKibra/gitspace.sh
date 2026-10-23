import { writeBrowserRunner } from './index.js';

const [target] = process.argv.slice(2);
if (!target) throw new Error('Usage: bun src/write.ts <output.js>');
await writeBrowserRunner(target);
