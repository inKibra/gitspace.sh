import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { generatedBundle } from '../src/build.js';

test('the served bundle is built from the current sources', async () => {
  expect(await Bun.file(join(import.meta.dir, '../src/bundle.generated.ts')).text(), 'Run `bun run build` in packages/browser-extension').toBe(await generatedBundle());
});
