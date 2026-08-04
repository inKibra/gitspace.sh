import { mock } from 'bun:test';

// @pierre/diffs (the shiki-based highlighter) lives in web/node_modules and is
// not resolvable under the root bun-test runtime. Shared web renderers pull it
// (code + diff blocks, and markdown fenced-code highlighting). Stub it in a
// preload so the mock is registered before any test's import graph resolves.
mock.module('@pierre/diffs/react', () => ({ File: () => null }));
mock.module('@pierre/diffs', () => ({}));

// `mermaid` is likewise web-only; the markdown renderer imports it (```mermaid
// fences render as diagrams). Stub its default export for the root test runtime.
mock.module('mermaid', () => ({
  default: { initialize: () => {}, render: async () => ({ svg: '' }) },
}));

// `mock.module` is process-GLOBAL and `mock.restore()` does not undo it, so any
// invocation that loads more than one test file into a single process reports
// failures belonging to other files' mocks. Measured on this repo: bare
// `bun test` reported 125 failures and then hung; the same tree run one file per
// process reported 5. That gap is invisible unless you already know about it.
//
// Bun gives a preload no way to count the files it will run (process.argv holds
// only the first, and a preload-registered beforeAll fires once per PROCESS, not
// per file), so this cannot be narrowed to multi-file runs — it fires whenever
// the run is not isolated. `bun run test` (scripts/test-isolated.ts) sets the var.
if (process.env.GSSH_TEST_ISOLATED !== '1') {
  console.error(
    '\x1b[2m[test] not isolated — mock.module leaks between files in one process. '
    + 'Full-suite results are only trustworthy from `bun run test`.\x1b[0m',
  );
}
