/** One side of a file diff: its Git blob identity and its text, or null text when the content is binary. */
export interface PatchSide {
  oid: string;
  mode: string;
  text: string | null;
}

export interface FilePatch {
  patch: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

const CONTEXT = 3;
const NO_NEWLINE = '\\ No newline at end of file';
const FORWARD_UNSET = -1;
const BACKWARD_UNSET = 0x7fffffff;
/** xdiff's floor for the edit cost searched before a split settles for the furthest-reaching diagonal. */
const MIN_SEARCH_COST = 256;

interface Lines {
  lines: string[];
  missingNewline: boolean;
}

function splitLines(text: string): Lines {
  if (text === '') return { lines: [], missingNewline: false };
  const lines = text.split('\n');
  const missingNewline = lines.at(-1) !== '';
  if (!missingNewline) lines.pop();
  return { lines, missingNewline };
}

/** Line identities shared by both sides; a final line without a newline never equals one with it, as in Git. */
function lineIds(before: Lines, after: Lines): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const encode = ({ lines, missingNewline }: Lines) => {
    const encoded = new Int32Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
      // Diffed text never contains NUL: such content is binary.
      const key = missingNewline && index === lines.length - 1 ? `\0${lines[index]}` : lines[index]!;
      let id = ids.get(key);
      if (id === undefined) { id = ids.size; ids.set(key, id); }
      encoded[index] = id;
    }
    return encoded;
  };
  return [encode(before), encode(after)];
}

/**
 * xdiff's divide step (xdl_split): Myers' middle snake in linear space. Past the cost limit it splits at the
 * furthest-reaching diagonal instead, bounding time on large unrelated inputs at the price of minimality.
 */
function split(
  a: Int32Array, off1: number, lim1: number, b: Int32Array, off2: number, lim2: number,
  forward: Int32Array, backward: Int32Array, offset: number, minimal: boolean, maxCost: number,
): [number, number, boolean, boolean] {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = ((fmid - bmid) & 1) !== 0;
  let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
  forward[offset + fmid] = off1;
  backward[offset + bmid] = lim1;
  for (let cost = 1; ; cost += 1) {
    if (fmin > dmin) forward[offset + --fmin - 1] = FORWARD_UNSET; else ++fmin;
    if (fmax < dmax) forward[offset + ++fmax + 1] = FORWARD_UNSET; else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = forward[offset + d - 1]! >= forward[offset + d + 1]! ? forward[offset + d - 1]! + 1 : forward[offset + d + 1]!;
      let i2 = i1 - d;
      while (i1 < lim1 && i2 < lim2 && a[i1] === b[i2]) { i1 += 1; i2 += 1; }
      forward[offset + d] = i1;
      if (odd && bmin <= d && d <= bmax && backward[offset + d]! <= i1) return [i1, i2, true, true];
    }
    if (bmin > dmin) backward[offset + --bmin - 1] = BACKWARD_UNSET; else ++bmin;
    if (bmax < dmax) backward[offset + ++bmax + 1] = BACKWARD_UNSET; else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = backward[offset + d - 1]! < backward[offset + d + 1]! ? backward[offset + d - 1]! : backward[offset + d + 1]! - 1;
      let i2 = i1 - d;
      while (i1 > off1 && i2 > off2 && a[i1 - 1] === b[i2 - 1]) { i1 -= 1; i2 -= 1; }
      backward[offset + d] = i1;
      if (!odd && fmin <= d && d <= fmax && i1 <= forward[offset + d]!) return [i1, i2, true, true];
    }
    if (minimal || cost < maxCost) continue;
    let forwardBest = -1, forwardI1 = -1;
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = Math.min(forward[offset + d]!, lim1);
      let i2 = i1 - d;
      if (lim2 < i2) { i1 = lim2 + d; i2 = lim2; }
      if (forwardBest < i1 + i2) { forwardBest = i1 + i2; forwardI1 = i1; }
    }
    let backwardBest = BACKWARD_UNSET, backwardI1 = BACKWARD_UNSET;
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = Math.max(off1, backward[offset + d]!);
      let i2 = i1 - d;
      if (i2 < off2) { i1 = off2 + d; i2 = off2; }
      if (i1 + i2 < backwardBest) { backwardBest = i1 + i2; backwardI1 = i1; }
    }
    return (lim1 + lim2) - backwardBest < forwardBest - (off1 + off2)
      ? [forwardI1, forwardBest - forwardI1, true, false]
      : [backwardI1, backwardBest - backwardI1, false, true];
  }
}

/** Marks each removed line of `a` and added line of `b`, as xdiff's xdl_recs_cmp does, without recursion. */
function markChanges(a: Int32Array, b: Int32Array): { removed: Uint8Array; added: Uint8Array } {
  const removed = new Uint8Array(a.length);
  const added = new Uint8Array(b.length);
  const diagonals = a.length + b.length + 3;
  const forward = new Int32Array(diagonals);
  const backward = new Int32Array(diagonals);
  const offset = b.length + 1;
  const maxCost = Math.max(MIN_SEARCH_COST, Math.ceil(Math.sqrt(diagonals)));
  const pending: Array<[number, number, number, number, boolean]> = [[0, a.length, 0, b.length, false]];
  for (let range = pending.pop(); range; range = pending.pop()) {
    let [off1, lim1, off2, lim2] = range;
    while (off1 < lim1 && off2 < lim2 && a[off1] === b[off2]) { off1 += 1; off2 += 1; }
    while (off1 < lim1 && off2 < lim2 && a[lim1 - 1] === b[lim2 - 1]) { lim1 -= 1; lim2 -= 1; }
    if (off1 === lim1) added.fill(1, off2, lim2);
    else if (off2 === lim2) removed.fill(1, off1, lim1);
    else {
      const [i1, i2, minimalLow, minimalHigh] = split(a, off1, lim1, b, off2, lim2, forward, backward, offset, range[4], maxCost);
      pending.push([off1, i1, off2, i2, minimalLow], [i1, lim1, i2, lim2, minimalHigh]);
    }
  }
  return { removed, added };
}

function hunkRange(start: number, length: number): string {
  if (length === 1) return `${start + 1}`;
  return `${length === 0 ? start : start + 1},${length}`;
}

/** Unified hunks with Git's three lines of context; changes at most six unchanged lines apart share a hunk. */
function unifiedHunks(before: Lines, after: Lines): { lines: string[]; additions: number; deletions: number } {
  const [a, b] = lineIds(before, after);
  const { removed, added } = markChanges(a, b);
  const runs: Array<[number, number, number, number]> = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if ((i < a.length && removed[i]) || (j < b.length && added[j])) {
      const start1 = i, start2 = j;
      while (i < a.length && removed[i]) i += 1;
      while (j < b.length && added[j]) j += 1;
      runs.push([start1, i, start2, j]);
    } else { i += 1; j += 1; }
  }
  const lines: string[] = [];
  let additions = 0, deletions = 0;
  for (let first = 0; first < runs.length;) {
    let last = first;
    while (last + 1 < runs.length && runs[last + 1]![0] - runs[last]![1] <= 2 * CONTEXT) last += 1;
    const start1 = Math.max(0, runs[first]![0] - CONTEXT);
    const start2 = runs[first]![2] - (runs[first]![0] - start1);
    const end1 = Math.min(a.length, runs[last]![1] + CONTEXT);
    const end2 = runs[last]![3] + (end1 - runs[last]![1]);
    lines.push(`@@ -${hunkRange(start1, end1 - start1)} +${hunkRange(start2, end2 - start2)} @@`);
    for (let i = start1, j = start2; i < end1 || j < end2;) {
      if (i < end1 && removed[i]) {
        lines.push(`-${before.lines[i]}`);
        deletions += 1;
        i += 1;
        if (i === a.length && before.missingNewline) lines.push(NO_NEWLINE);
      } else if (j < end2 && added[j]) {
        lines.push(`+${after.lines[j]}`);
        additions += 1;
        j += 1;
        if (j === b.length && after.missingNewline) lines.push(NO_NEWLINE);
      } else {
        lines.push(` ${before.lines[i]}`);
        i += 1;
        j += 1;
        if (i === a.length && before.missingNewline) lines.push(NO_NEWLINE);
      }
    }
    first = last + 1;
  }
  return { lines, additions, deletions };
}

const QUOTED_ESCAPES: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };

/** Git's default `core.quotePath` quoting of patch header names. */
function quotePath(name: string): string {
  if (!/[\u0000-\u001f"\\\u007f-\uffff]/u.test(name)) return name;
  let quoted = '"';
  for (const byte of new TextEncoder().encode(name)) {
    quoted += QUOTED_ESCAPES[byte] ?? (byte < 0x20 || byte >= 0x7f ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte));
  }
  return `${quoted}"`;
}

/** One file's section of `git diff --full-index` output between two blobs; null sides are absent. */
export function gitFilePatch(path: string, before: PatchSide | null, after: PatchSide | null): FilePatch {
  const source = quotePath(`a/${path}`);
  const destination = quotePath(`b/${path}`);
  const header = [`diff --git ${source} ${destination}`];
  if (!before && !after) return { patch: '', additions: 0, deletions: 0, binary: false };
  if (!before) header.push(`new file mode ${after!.mode}`);
  else if (!after) header.push(`deleted file mode ${before.mode}`);
  else if (before.mode !== after.mode) header.push(`old mode ${before.mode}`, `new mode ${after.mode}`);
  if (before && after && before.oid === after.oid) return { patch: `${header.join('\n')}\n`, additions: 0, deletions: 0, binary: false };
  const absent = '0'.repeat((before ?? after)!.oid.length);
  header.push(`index ${before?.oid ?? absent}..${after?.oid ?? absent}${before && after && before.mode === after.mode ? ` ${before.mode}` : ''}`);
  const from = before ? source : '/dev/null';
  const to = after ? destination : '/dev/null';
  if (before?.text === null || after?.text === null) {
    header.push(`Binary files ${from} and ${to} differ`);
    return { patch: `${header.join('\n')}\n`, additions: null, deletions: null, binary: true };
  }
  const hunks = unifiedHunks(splitLines(before?.text ?? ''), splitLines(after?.text ?? ''));
  // An empty file added or deleted has no hunks and, as in Git, no ---/+++ lines.
  if (hunks.lines.length) header.push(`--- ${from}`, `+++ ${to}`, ...hunks.lines);
  return { patch: `${header.join('\n')}\n`, additions: hunks.additions, deletions: hunks.deletions, binary: false };
}
