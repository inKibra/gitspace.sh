import { describe, expect, it } from 'bun:test';
import {
  guideLineAnnotations,
  lineAnchor,
  lineRangeLabel,
  lineTargetFromSelection,
  withDraftAnnotation,
} from '../change-guide-threads.web.js';
import type { LineTarget, ReviewThread, ThreadTarget } from '../../types/review.js';

/**
 * Part B of review-comments-in-the-guide: line-anchored threads ride the
 * @pierre/diffs annotation API. These cover the two mappings that sit between
 * the review model and the renderer — get either wrong and comments land on the
 * wrong line (or silently vanish).
 */

function thread(id: string, target: ThreadTarget, over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    target,
    resolved: false,
    comments: [{ id: `${id}-c1`, threadId: id, body: 'note', author: 'local', createdAt: '2026-07-16T00:00:00.000Z' }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...over,
  };
}

const lineTarget = (file: string, startLine: number, endLine: number, side: 'LEFT' | 'RIGHT'): ThreadTarget =>
  ({ kind: 'line', file, startLine, endLine, side });

describe('lineTargetFromSelection (PatchDiff selection -> LineTarget)', () => {
  it('builds a 1-based line range on the RIGHT/new side by default', () => {
    expect(lineTargetFromSelection({ start: 12, end: 18, side: 'additions' }, 'src/a.ts')).toEqual({
      kind: 'line', file: 'src/a.ts', startLine: 12, endLine: 18, side: 'RIGHT',
    });
  });

  it("maps the renderer's 'deletions' side to LEFT", () => {
    expect(lineTargetFromSelection({ start: 4, end: 4, side: 'deletions' }, 'src/a.ts')).toEqual({
      kind: 'line', file: 'src/a.ts', startLine: 4, endLine: 4, side: 'LEFT',
    });
  });

  it('normalizes an upward drag (end before start) to startLine <= endLine', () => {
    const target = lineTargetFromSelection({ start: 30, end: 11, side: 'additions' }, 'src/a.ts');
    expect(target.startLine).toBe(11);
    expect(target.endLine).toBe(30);
  });

  it('defaults to RIGHT when the renderer reports no side', () => {
    expect(lineTargetFromSelection({ start: 2, end: 2 }, 'src/a.ts').side).toBe('RIGHT');
  });
});

describe('guideLineAnnotations (threads -> DiffLineAnnotation[])', () => {
  it('anchors a line thread at its startLine on its own side', () => {
    const annotations = guideLineAnnotations(
      [thread('t1', lineTarget('src/a.ts', 12, 18, 'RIGHT'))],
      'src/a.ts',
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.side).toBe('additions');
    expect(annotations[0]!.lineNumber).toBe(12);
    expect(annotations[0]!.metadata.threads.map((t) => t.id)).toEqual(['t1']);
  });

  it('ignores threads for other files and non-line targets', () => {
    const annotations = guideLineAnnotations([
      thread('t1', lineTarget('src/a.ts', 3, 3, 'RIGHT')),
      thread('other-file', lineTarget('src/b.ts', 3, 3, 'RIGHT')),
      thread('hunk', { kind: 'hunk', file: 'src/a.ts', hunkHeader: '@@ -1,2 +1,2 @@' }),
      thread('file', { kind: 'file', file: 'src/a.ts' }),
      thread('ws', { kind: 'workspace' }),
    ], 'src/a.ts');
    expect(annotations.map((a) => a.metadata.threads.map((t) => t.id))).toEqual([['t1']]);
  });

  it('matches a renamed file via its previous path', () => {
    const annotations = guideLineAnnotations(
      [thread('t1', lineTarget('old/name.ts', 5, 5, 'LEFT'))],
      'new/name.ts',
      'old/name.ts',
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.side).toBe('deletions');
  });

  it('stacks threads sharing an anchor into one annotation (renderer allots one slot per line)', () => {
    const annotations = guideLineAnnotations([
      thread('second', lineTarget('src/a.ts', 7, 7, 'RIGHT'), { createdAt: '2026-07-16T02:00:00.000Z' }),
      thread('first', lineTarget('src/a.ts', 7, 7, 'RIGHT'), { createdAt: '2026-07-16T01:00:00.000Z' }),
    ], 'src/a.ts');
    expect(annotations).toHaveLength(1);
    // Oldest first — a stable, creation-ordered read.
    expect(annotations[0]!.metadata.threads.map((t) => t.id)).toEqual(['first', 'second']);
  });

  it('keeps same-line threads on opposite sides separate', () => {
    const annotations = guideLineAnnotations([
      thread('right', lineTarget('src/a.ts', 7, 7, 'RIGHT')),
      thread('left', lineTarget('src/a.ts', 7, 7, 'LEFT')),
    ], 'src/a.ts');
    expect(annotations).toHaveLength(2);
    // Deterministic order: deletions before additions.
    expect(annotations.map((a) => a.side)).toEqual(['deletions', 'additions']);
  });

  it('orders annotations by line so re-renders do not reshuffle the DOM', () => {
    const annotations = guideLineAnnotations([
      thread('c', lineTarget('src/a.ts', 30, 30, 'RIGHT')),
      thread('a', lineTarget('src/a.ts', 4, 4, 'RIGHT')),
      thread('b', lineTarget('src/a.ts', 12, 12, 'RIGHT')),
    ], 'src/a.ts');
    expect(annotations.map((a) => a.lineNumber)).toEqual([4, 12, 30]);
  });

  it('anchors an inverted range at its lowest line and never below line 1', () => {
    const annotations = guideLineAnnotations(
      [thread('t1', lineTarget('src/a.ts', 18, 12, 'RIGHT')), thread('t2', lineTarget('src/a.ts', 0, 0, 'RIGHT'))],
      'src/a.ts',
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([1, 12]);
  });

  it('keeps resolved threads anchored (they stay visible, greyed, in the diff)', () => {
    const annotations = guideLineAnnotations(
      [thread('t1', lineTarget('src/a.ts', 9, 9, 'RIGHT'), { resolved: true })],
      'src/a.ts',
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.metadata.threads[0]!.resolved).toBe(true);
  });
});

describe('withDraftAnnotation (pending composer -> DiffLineAnnotation[])', () => {
  const draft = (file: string, startLine: number, endLine: number, side: 'LEFT' | 'RIGHT'): LineTarget =>
    ({ kind: 'line', file, startLine, endLine, side });

  it('anchors the composer at the selected line, on the selected side', () => {
    const annotations = withDraftAnnotation([], draft('src/a.ts', 5, 5, 'RIGHT'), 'src/a.ts');
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.side).toBe('additions');
    expect(annotations[0]!.lineNumber).toBe(5);
    expect(annotations[0]!.metadata.draft).toEqual(draft('src/a.ts', 5, 5, 'RIGHT'));
    // No thread anchors here yet — the slot exists only to host the composer.
    expect(annotations[0]!.metadata.threads).toEqual([]);
  });

  it('anchors the composer where the resulting thread will live (same anchor mapping)', () => {
    const target = draft('src/a.ts', 12, 18, 'RIGHT');
    const composer = withDraftAnnotation([], target, 'src/a.ts')[0]!;
    const settled = guideLineAnnotations([thread('t1', target)], 'src/a.ts')[0]!;
    expect({ side: composer.side, lineNumber: composer.lineNumber })
      .toEqual({ side: settled.side, lineNumber: settled.lineNumber });
  });

  it('shares the slot when a thread already anchors there (one annotation per line)', () => {
    const existing = guideLineAnnotations([thread('t1', lineTarget('src/a.ts', 7, 7, 'RIGHT'))], 'src/a.ts');
    const annotations = withDraftAnnotation(existing, draft('src/a.ts', 7, 7, 'RIGHT'), 'src/a.ts');
    // A second annotation at this anchor would collide on the renderer's
    // `annotation-additions-7` slot and be dropped — so it merges instead.
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.metadata.threads.map((t) => t.id)).toEqual(['t1']);
    expect(annotations[0]!.metadata.draft).toBeDefined();
  });

  it('keeps a draft opposite an existing same-line thread on its own side', () => {
    const existing = guideLineAnnotations([thread('t1', lineTarget('src/a.ts', 7, 7, 'RIGHT'))], 'src/a.ts');
    const annotations = withDraftAnnotation(existing, draft('src/a.ts', 7, 7, 'LEFT'), 'src/a.ts');
    expect(annotations.map((a) => a.side)).toEqual(['deletions', 'additions']);
    expect(annotations[0]!.metadata.draft).toBeDefined();
    expect(annotations[1]!.metadata.draft).toBeUndefined();
  });

  it('inserts the draft in anchor order so re-renders do not reshuffle the DOM', () => {
    const existing = guideLineAnnotations([
      thread('a', lineTarget('src/a.ts', 4, 4, 'RIGHT')),
      thread('c', lineTarget('src/a.ts', 30, 30, 'RIGHT')),
    ], 'src/a.ts');
    const annotations = withDraftAnnotation(existing, draft('src/a.ts', 12, 12, 'RIGHT'), 'src/a.ts');
    expect(annotations.map((a) => a.lineNumber)).toEqual([4, 12, 30]);
  });

  it('anchors an inverted drag at its lowest line and never below line 1', () => {
    expect(withDraftAnnotation([], draft('src/a.ts', 18, 12, 'RIGHT'), 'src/a.ts')[0]!.lineNumber).toBe(12);
    expect(withDraftAnnotation([], draft('src/a.ts', 0, 0, 'RIGHT'), 'src/a.ts')[0]!.lineNumber).toBe(1);
  });

  it('matches a renamed file via its previous path', () => {
    const annotations = withDraftAnnotation([], draft('old/name.ts', 5, 5, 'LEFT'), 'new/name.ts', 'old/name.ts');
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.side).toBe('deletions');
  });

  it('ignores a draft targeting another file', () => {
    expect(withDraftAnnotation([], draft('src/b.ts', 5, 5, 'RIGHT'), 'src/a.ts')).toEqual([]);
  });

  it('returns the annotations UNCHANGED with no draft (keeps the memo stable)', () => {
    const existing = guideLineAnnotations([thread('t1', lineTarget('src/a.ts', 7, 7, 'RIGHT'))], 'src/a.ts');
    expect(withDraftAnnotation(existing, null, 'src/a.ts')).toBe(existing);
    expect(withDraftAnnotation(existing, undefined, 'src/a.ts')).toBe(existing);
  });

  it('never mutates the memoized thread annotations it overlays', () => {
    const existing = guideLineAnnotations([thread('t1', lineTarget('src/a.ts', 7, 7, 'RIGHT'))], 'src/a.ts');
    const snapshot = structuredClone(existing);
    withDraftAnnotation(existing, draft('src/a.ts', 7, 7, 'RIGHT'), 'src/a.ts');
    withDraftAnnotation(existing, draft('src/a.ts', 9, 9, 'RIGHT'), 'src/a.ts');
    expect(existing).toEqual(snapshot);
  });
});

describe('lineAnchor', () => {
  it('maps a target to its (side, line) slot — first line, clamped, side-mapped', () => {
    expect(lineAnchor({ kind: 'line', file: 'a', startLine: 18, endLine: 12, side: 'RIGHT' }))
      .toEqual({ side: 'additions', lineNumber: 12 });
    expect(lineAnchor({ kind: 'line', file: 'a', startLine: 0, endLine: 0, side: 'LEFT' }))
      .toEqual({ side: 'deletions', lineNumber: 1 });
  });
});

describe('lineRangeLabel', () => {
  it('renders a single line and a range', () => {
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 5, endLine: 5, side: 'RIGHT' })).toBe('L5');
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 5, endLine: 9, side: 'RIGHT' })).toBe('L5–L9');
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 9, endLine: 5, side: 'RIGHT' })).toBe('L5–L9');
  });
});
