import { describe, expect, it } from 'vitest';
import { matchAstPatterns } from '../src/ast-match.js';

// Runs in workerd, which forbids compiling WebAssembly at runtime: the grammars must load from bundled modules.
describe('cloud AST rule matching', () => {
  const rule = ['JSON.parse($ARG) as unknown', "typeof parsed !== 'object'"];

  it('matches code structure, not text, for each file language', async () => {
    expect(await matchAstPatterns('const value = JSON.parse(body) as unknown;', ['src/provider.ts'], rule)).toBe(true);
    expect(await matchAstPatterns('const view = <pre>{JSON.parse(body) as unknown}</pre>;', ['src/View.tsx'], rule)).toBe(true);
    expect(await matchAstPatterns("if (typeof parsed !== 'object') throw new Error('bad');", ['lib/read.mjs'], rule)).toBe(true);
    // The same words in a comment or string are not the pattern.
    expect(await matchAstPatterns('// JSON.parse(body) as unknown\nconst note = "typeof parsed !== \'object\'";', ['src/provider.ts'], rule)).toBe(false);
    expect(await matchAstPatterns('const value = validateParseProviderPayload(body);', ['src/provider.ts'], rule)).toBe(false);
  });

  it('skips files without a bundled grammar and patterns that do not parse', async () => {
    expect(await matchAstPatterns('value = json.loads(body)', ['tool.py'], ['json.loads($ARG)'])).toBe(false);
    expect(await matchAstPatterns('const value = JSON.parse(body) as unknown;', ['src/provider.ts'], ['(((', 'JSON.parse($ARG) as unknown'])).toBe(true);
  });
});
