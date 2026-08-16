import { describe, expect, it } from 'bun:test';
import { normalizeGuideAsks } from '../guide-normalize.js';

describe('normalizeGuideAsks', () => {
  it('unwraps the {text} shape a narrator borrows from callouts', () => {
    // The exact payload that white-screened the app: `callouts` is
    // Array<{tone, text}>, so the narrator wrote asks the same way. Rendered as
    // a React child it threw "Objects are not valid as a React child (found:
    // object with keys {text})" out of ChangeGuidePane, and the ErrorBoundary
    // took the whole app down rather than losing one section.
    expect(normalizeGuideAsks([{ text: 'Is a scheduled CI job worth it?' }]))
      .toEqual(['Is a scheduled CI job worth it?']);
  });

  it('keeps plain strings and drops entries nothing can render', () => {
    expect(normalizeGuideAsks(['plain', { text: 'wrapped' }, { nope: 1 }, 42, null, '  ']))
      .toEqual(['plain', 'wrapped']);
  });

  it('returns undefined for a non-array so the section renders nothing', () => {
    expect(normalizeGuideAsks(undefined)).toBeUndefined();
    expect(normalizeGuideAsks('one ask')).toBeUndefined();
  });

  it('never yields a non-string, whatever the input', () => {
    const out = normalizeGuideAsks([{ text: 'a' }, 'b', { text: '' }, { text: 3 }, [], {}]) ?? [];
    for (const ask of out) expect(typeof ask).toBe('string');
    expect(out).toEqual(['a', 'b']);
  });
});
