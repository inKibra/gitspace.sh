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
