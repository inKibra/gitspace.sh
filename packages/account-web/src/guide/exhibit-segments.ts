// An exhibit's diff narrowed to the lines its ranges name: one patch per range, holding the range's changed lines and
// up to three lines around them, so each range's note can sit above its own lines. Line numbers stay the file's, so a
// comment on a narrowed line anchors where it would on the whole diff.
import type { ChangeGuideSection } from '@gitspace/protocol';

const CONTEXT = 3;

export type ExhibitRange = NonNullable<ChangeGuideSection['exhibits'][number]['ranges']>[number];
interface DiffLine { kind: ' ' | '+' | '-'; text: string; oldNo: number; newNo: number }
export interface ExhibitSegment {
  range: ExhibitRange;
  /** The range's lines as a patch of their own; null when the diff does not change or show those lines. */
  patch: string | null;
  /** The line numbers the segment shows on each side, for the comments that belong under it. */
  lines: Record<'base' | 'head', ReadonlySet<number>>;
}
export interface NarrowedExhibit {
  segments: ExhibitSegment[];
  /** Changed lines of the file that no range's segment shows. */
  otherChanges: number;
}

/** The patch's file header and hunks; `oldNo`/`newNo` are where each line sits on its side (for an added line, the
 * old side's next line, and the reverse). */
function parsePatch(patch: string): { header: string[]; hunks: DiffLine[][] } {
  const header: string[] = [];
  const hunks: DiffLine[][] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (start) {
      oldNo = Number(start[1]);
      newNo = Number(start[2]);
      // A side with no lines in the hunk names the line before it.
      if (/^@@ -\d+,0 /u.test(raw)) oldNo += 1;
      if (/^@@ -\d+(?:,\d+)? \+\d+,0 @@/u.test(raw)) newNo += 1;
      hunks.push([]);
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) { if (raw) header.push(raw); continue; }
    const kind = raw[0];
    if (kind !== ' ' && kind !== '+' && kind !== '-') continue;
    hunk.push({ kind, text: raw.slice(1), oldNo, newNo });
    if (kind !== '+') oldNo += 1;
    if (kind !== '-') newNo += 1;
  }
  return { header, hunks };
}

/** One run of a hunk's lines as a hunk of its own. */
function hunkText(lines: readonly DiffLine[]): string {
  const first = lines[0]!;
  const oldCount = lines.filter((line) => line.kind !== '+').length;
  const newCount = lines.filter((line) => line.kind !== '-').length;
  const side = (start: number, count: number): string => `${count ? start : start - 1},${count}`;
  return [`@@ -${side(first.oldNo, oldCount)} +${side(first.newNo, newCount)} @@`, ...lines.map((line) => `${line.kind}${line.text}`)].join('\n');
}

/** Splits a file's patch by the exhibit's ranges, which name lines of the new file. A removed line belongs to a range
 * when the new line it sits before does. Segments never repeat a line: a range's context stops where the previous
 * range's segment ends. */
export function narrowExhibit(patch: string, ranges: readonly ExhibitRange[]): NarrowedExhibit {
  const { header, hunks } = parsePatch(patch);
  const shown = hunks.map(() => new Set<number>());
  const segments = ranges.map((range): ExhibitSegment => {
    const runs: DiffLine[][] = [];
    hunks.forEach((hunk, hunkIndex) => {
      const used = shown[hunkIndex]!;
      const hit = hunk.flatMap((line, index) => line.newNo >= range.start && line.newNo <= range.end ? [index] : []);
      if (!hit.length) return;
      const take: number[] = [];
      for (let index = Math.max(0, hit[0]! - CONTEXT); index <= Math.min(hunk.length - 1, hit.at(-1)! + CONTEXT); index += 1) if (!used.has(index)) take.push(index);
      for (const index of take) used.add(index);
      let run: DiffLine[] = [];
      take.forEach((index, position) => {
        if (position > 0 && take[position - 1] !== index - 1) { runs.push(run); run = []; }
        run.push(hunk[index]!);
      });
      if (run.length) runs.push(run);
    });
    const shownLines = runs.flat();
    return {
      range,
      patch: runs.length ? [...header, ...runs.map(hunkText)].join('\n') + '\n' : null,
      lines: { base: new Set(shownLines.flatMap((line) => line.kind === '+' ? [] : [line.oldNo])), head: new Set(shownLines.flatMap((line) => line.kind === '-' ? [] : [line.newNo])) },
    };
  });
  const otherChanges = hunks.reduce((sum, hunk, hunkIndex) => sum + hunk.filter((line, index) => line.kind !== ' ' && !shown[hunkIndex]!.has(index)).length, 0);
  return { segments, otherChanges };
}
