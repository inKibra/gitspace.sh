import { describe, expect, it } from 'bun:test';
import {
  guideLineAnnotations,
  lineRangeLabel,
  lineTargetFromSelection,
} from '../change-guide-threads.web.js';
import type { ReviewThread, ThreadTarget } from '../../types/review.js';

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

describe('lineRangeLabel', () => {
  it('renders a single line and a range', () => {
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 5, endLine: 5, side: 'RIGHT' })).toBe('L5');
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 5, endLine: 9, side: 'RIGHT' })).toBe('L5–L9');
    expect(lineRangeLabel({ kind: 'line', file: 'a', startLine: 9, endLine: 5, side: 'RIGHT' })).toBe('L5–L9');
  });
});
