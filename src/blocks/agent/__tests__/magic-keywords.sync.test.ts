/**
 * Drift guard: keep our web-side MAGIC_KEYWORDS in sync with oh-my-pi's
 * `modes/magic-keywords`. The SDK doesn't export the list, so we mirror it in
 * magic-keywords.ts and assert here that the SDK still recognizes each keyword.
 *
 * If this fails, OMP renamed/removed a magic keyword — update MAGIC_KEYWORDS.
 * (Additions can't be auto-detected; add new keywords to the list when OMP ships
 * them.)
 */
import { describe, expect, it } from 'bun:test';
import { hasMagicKeyword as ompHasMagicKeyword } from '@oh-my-pi/pi-coding-agent/modes/magic-keywords';
import { MAGIC_KEYWORDS, hasMagicKeyword, findMagicKeywordRanges, segmentMagicKeywords } from '../magic-keywords.js';

describe('magic-keywords sync with OMP', () => {
  it('every keyword we highlight is still recognized by the OMP detector', () => {
    for (const kw of MAGIC_KEYWORDS) {
      expect(ompHasMagicKeyword(`please ${kw} this`)).toBe(true);
    }
  });

  it('our detector agrees with OMP on standalone prose', () => {
    const yes = ['workflowz this migration', 'let us orchestrate the work', 'ultrathink about it'];
    const no = ['deploy the workflowzed build', 'run workflowz.ts', 'just do it'];
    for (const text of yes) {
      expect(hasMagicKeyword(text)).toBe(true);
      expect(ompHasMagicKeyword(text)).toBe(true);
    }
    for (const text of no) {
      expect(hasMagicKeyword(text)).toBe(false);
    }
  });

  it('finds ranges for standalone keywords only (whitespace/edge-bounded)', () => {
    // Note: OMP semantics require whitespace/edge boundaries, so a trailing
    // comma/period suppresses the match (e.g. "workflowz," does NOT trigger).
    const text = 'orchestrate then workflowz here but not workflowzed';
    const ranges = findMagicKeywordRanges(text);
    expect(ranges.map((r) => r.keyword)).toEqual(['orchestrate', 'workflowz']);
    for (const r of ranges) expect(text.slice(r.start, r.end)).toBe(r.keyword);
  });

  it('segments text into plain/keyword parts', () => {
    const parts = segmentMagicKeywords('go orchestrate now');
    expect(parts).toEqual([{ text: 'go ' }, { text: 'orchestrate', keyword: 'orchestrate' }, { text: ' now' }]);
  });
});
