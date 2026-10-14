import { RRegex, type Class, type Hir } from 'rregex';
import { RuntimeGrepArgumentsSchema } from './tool-arguments.js';

import { compileSearchIgnores, searchPathFilter, type SearchArguments, type SearchFile } from './search-paths.js';
export type { SearchArguments, SearchFile } from './search-paths.js';
export type SearchOutput = { text: string; truncated: boolean; scannedFiles: number };

/** Same HIR newline ban as ripgrep14.1.1 crates/regex/src/ban.rs, not pattern-text guessing. */
function containsBannedNewline(hir: Hir): boolean {
  const kind = hir.kind;
  switch (kind['@variant']) {
    case 'Empty': case 'Look': return false;
    case 'Literal': return kind['@values'][0]['@values'][0].includes(10);
    case 'Class': {
      const characterClass = kind['@values'][0];
      if (characterClass['@variant'] === 'Unicode') {
        const ranges = characterClass['@values'][0].ranges;
        return ranges.reduce((count, range) => count + range.len, 0) === 1 && ranges.some(range => range.start <= '\n' && range.end >= '\n');
      }
      const ranges = characterClass['@values'][0].ranges;
      return ranges.reduce((count, range) => count + range.len, 0) === 1 && ranges.some(range => range.start <= 10 && range.end >= 10);
    }
    case 'Capture': case 'Repetition': return containsBannedNewline(kind['@values'][0].sub);
    case 'Concat': case 'Alternation': return kind['@values'][0].some(containsBannedNewline);
  }
}
/** Rust regex is the matcher, including inline flags, Unicode classes and rejection of lookaround. */
export function createSearchMatcher(input: SearchArguments) {
  const args = RuntimeGrepArgumentsSchema.parse(input);
  const regex = new RRegex(`${args.caseSensitive ? '' : '(?i)'}${args.pattern}`);
  if (!args.multiline && containsBannedNewline(regex.syntax())) {
    regex.free();
    throw new Error('Newline literals require multiline search');
  }
  return { args, regex };
}

/** Lines ripgrep reports for one file, or for one line-aligned piece of it: each line the regex matches, or for
 * multiline patterns each line a match touches. Line numbers are zero-based within `content`. */
export function* searchMatchingLines(regex: RRegex, multiline: boolean, content: string): Generator<{ line: number; text: string }> {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let matchingLines: Set<number> | undefined;
  if (multiline) {
    matchingLines = new Set<number>();
    const encoder = new TextEncoder();
    const starts: number[] = []; let byteOffset = 0;
    for (const line of lines) { starts.push(byteOffset); byteOffset += encoder.encode(line).byteLength + 1; }
    for (const match of regex.findAll(content)) {
      for (let n = 0; n < starts.length; n++) {
        const start = starts[n]!;
        const end = starts[n + 1] ?? byteOffset;
        if (match.start < end && Math.max(match.start + 1, match.end) > start) matchingLines.add(n);
      }
    }
  }
  for (let n = 0; n < lines.length; n++) if (matchingLines ? matchingLines.has(n) : regex.isMatch(lines[n]!)) yield { line: n, text: lines[n]! };
}

/** The JS reference search: files in path order, matches paged in that order. */
function searchOrderedFiles(files: Iterable<SearchFile>, input: SearchArguments, ignoreFiles: readonly SearchFile[] = []): SearchOutput {
  const { args, regex } = createSearchMatcher(input);
  const accepts = searchPathFilter(args, compileSearchIgnores(ignoreFiles));
  const output: string[] = [];
  let matched = 0, scannedFiles = 0, truncated = false;
  try {
    outer: for (const file of files) {
      if (!accepts(file.path) || file.content.includes('\0')) continue;
      scannedFiles++;
      for (const { line, text } of searchMatchingLines(regex, args.multiline, file.content)) {
        if (matched++ < args.offset) continue;
        if (output.length === args.limit) { truncated = true; break outer; }
        output.push(`${file.path}:${line + 1}:${text}`);
      }
    }
    return { text: output.join('\n'), truncated, scannedFiles };
  } finally { regex.free(); }
}

export function searchSnapshotFiles(files: readonly SearchFile[], input: SearchArguments): SearchOutput {
  return searchOrderedFiles([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), input, files);
}

/* Required trigrams, after Russ Cox, "Regular Expression Matching with a Trigram Index" (2012): every match of the
 * regex contains the trigrams of the returned query, so documents without them cannot match. Strings are folded the
 * way SQLite's `trigram case_sensitive 0` tokenizer folds them; only ASCII trigrams are emitted, where that folding
 * and Rust's case-insensitive matching agree (the workerd code search proof checks it), so one case-insensitive index
 * serves both search modes. */
type TrigramQuery = { kind: 'all' } | { kind: 'gram'; gram: string } | { kind: 'and' | 'or'; parts: TrigramQuery[] };
/** `exact`, when known, is every string the expression matches; otherwise `prefix`/`suffix` bound how matches begin and end. */
type LiteralInfo = { emptyable: boolean; exact: Set<string> | null; prefix: Set<string>; suffix: Set<string>; match: TrigramQuery };
const ALL: TrigramQuery = { kind: 'all' };
const MAX_EXACT = 7, MAX_SET = 20, MAX_CLASS = 8, MAX_QUERY_TRIGRAMS = 24;

function both(parts: TrigramQuery[]): TrigramQuery {
  const unique = new Map<string, TrigramQuery>();
  for (const part of parts) for (const item of part.kind === 'and' ? part.parts : part.kind === 'all' ? [] : [part]) unique.set(JSON.stringify(item), item);
  const values = [...unique.values()];
  return values.length === 0 ? ALL : values.length === 1 ? values[0]! : { kind: 'and', parts: values };
}
function either(parts: TrigramQuery[]): TrigramQuery {
  if (parts.length === 0 || parts.some(part => part.kind === 'all')) return ALL;
  const unique = new Map<string, TrigramQuery>();
  for (const part of parts) for (const item of part.kind === 'or' ? part.parts : [part]) unique.set(JSON.stringify(item), item);
  const values = [...unique.values()];
  return values.length === 1 ? values[0]! : { kind: 'or', parts: values };
}
/** Rust's simple case folding maps exactly these non-ASCII characters onto ASCII letters, and SQLite folds them alike. */
function fold(character: string): string {
  if (character === '\u212A') return 'k';
  if (character === '\u017F') return 's';
  return character >= 'A' && character <= 'Z' ? character.toLowerCase() : character;
}
function stringTrigrams(value: string): TrigramQuery {
  const characters = [...value];
  const grams: TrigramQuery[] = [];
  for (let n = 0; n + 3 <= characters.length; n++) {
    const gram = characters.slice(n, n + 3).join('');
    if (/^[\x01-\x7f]{3}$/u.test(gram)) grams.push({ kind: 'gram', gram });
  }
  return both(grams);
}
const setTrigrams = (values: Set<string>) => either([...values].map(stringTrigrams));
const union = (left: Set<string>, right: Set<string>) => new Set([...left, ...right]);
function cross(left: Set<string>, right: Set<string>): Set<string> {
  const product = new Set<string>();
  for (const head of left) for (const tail of right) product.add(head + tail);
  return product;
}
function trim(values: Set<string>, length: number, side: 'prefix' | 'suffix'): Set<string> {
  return new Set([...values].map(value => { const characters = [...value]; return (side === 'prefix' ? characters.slice(0, length) : characters.slice(Math.max(0, characters.length - length))).join(''); }));
}
const exactly = (values: string[]): LiteralInfo => ({ emptyable: values.includes(''), exact: new Set(values), prefix: new Set(), suffix: new Set(), match: ALL });
const anyCharacter = (): LiteralInfo => ({ emptyable: false, exact: null, prefix: new Set(['']), suffix: new Set(['']), match: ALL });
const withExact = (info: LiteralInfo) => info.exact ? both([info.match, setTrigrams(info.exact)]) : info.match;

/** Move what large string sets know into the trigram query, then keep only short boundary strings. */
function simplify(info: LiteralInfo): LiteralInfo {
  if (info.exact && info.exact.size > MAX_EXACT) {
    const exact = info.exact;
    info = { emptyable: info.emptyable, exact: null, match: both([info.match, setTrigrams(exact)]), prefix: trim(exact, 2, 'prefix'), suffix: trim(exact, 2, 'suffix') };
  }
  if (info.exact) return info;
  const shorten = (values: Set<string>, side: 'prefix' | 'suffix') => {
    let length = 2, shortened = trim(values, length, side);
    while (shortened.size > MAX_SET && length > 0) shortened = trim(values, --length, side);
    return shortened;
  };
  return { ...info, match: both([info.match, setTrigrams(info.prefix), setTrigrams(info.suffix)]), prefix: shorten(info.prefix, 'prefix'), suffix: shorten(info.suffix, 'suffix') };
}
function concat(x: LiteralInfo, y: LiteralInfo): LiteralInfo {
  const out: LiteralInfo = { emptyable: x.emptyable && y.emptyable, exact: null, prefix: new Set(), suffix: new Set(), match: both([x.match, y.match]) };
  if (x.exact && y.exact) out.exact = cross(x.exact, y.exact);
  else {
    const xSuffix = x.exact ?? x.suffix, yPrefix = y.exact ?? y.prefix;
    out.prefix = x.exact ? cross(x.exact, yPrefix) : x.emptyable ? union(x.prefix, yPrefix) : x.prefix;
    out.suffix = y.exact ? cross(xSuffix, y.exact) : y.emptyable ? union(y.suffix, xSuffix) : y.suffix;
    // Strings spanning the boundary carry trigrams neither side records alone.
    if (!x.exact && !y.exact && x.suffix.size <= MAX_SET && y.prefix.size <= MAX_SET) out.match = both([out.match, setTrigrams(cross(x.suffix, y.prefix))]);
  }
  return simplify(out);
}
function alternate(x: LiteralInfo, y: LiteralInfo): LiteralInfo {
  if (x.exact && y.exact) return simplify({ emptyable: x.emptyable || y.emptyable, exact: union(x.exact, y.exact), prefix: new Set(), suffix: new Set(), match: either([x.match, y.match]) });
  return simplify({
    emptyable: x.emptyable || y.emptyable, exact: null,
    prefix: union(x.exact ?? x.prefix, y.exact ?? y.prefix), suffix: union(x.exact ?? x.suffix, y.exact ?? y.suffix),
    match: either([withExact(x), withExact(y)]),
  });
}
function characterClass(characterClass: Class): LiteralInfo {
  const characters = new Set<string>();
  let size = 0;
  if (characterClass['@variant'] === 'Unicode') {
    for (const range of characterClass['@values'][0].ranges) {
      const start = range.start.codePointAt(0) ?? 0, end = range.end.codePointAt(0) ?? 0;
      size += end - start + 1;
      if (size > MAX_CLASS) return anyCharacter();
      for (let code = start; code <= end; code++) characters.add(fold(String.fromCodePoint(code)));
    }
  } else {
    for (const range of characterClass['@values'][0].ranges) {
      size += range.end - range.start + 1;
      // A non-ASCII byte may be part of any UTF-8 sequence.
      if (size > MAX_CLASS || range.end >= 0x80) return anyCharacter();
      for (let code = range.start; code <= range.end; code++) characters.add(fold(String.fromCharCode(code)));
    }
  }
  return characters.size ? exactly([...characters]) : anyCharacter();
}
function analyze(hir: Hir): LiteralInfo {
  const kind = hir.kind;
  switch (kind['@variant']) {
    case 'Empty': case 'Look': return exactly(['']);
    case 'Literal': return exactly([[...new TextDecoder().decode(kind['@values'][0]['@values'][0])].map(fold).join('')]);
    case 'Class': return characterClass(kind['@values'][0]);
    case 'Capture': return analyze(kind['@values'][0].sub);
    case 'Repetition': {
      const { min, max, sub } = kind['@values'][0];
      if (min === 0) return max === 1 ? alternate(analyze(sub), exactly([''])) : { emptyable: true, exact: null, prefix: new Set(['']), suffix: new Set(['']), match: ALL };
      // x{n,} with n ≥ 1 begins and ends like x, and contains x's trigrams.
      const info = analyze(sub);
      return info.exact ? simplify({ ...info, exact: null, prefix: info.exact, suffix: info.exact }) : info;
    }
    case 'Concat': return kind['@values'][0].map(analyze).reduce(concat);
    case 'Alternation': return kind['@values'][0].map(analyze).reduce(alternate);
  }
}
function render(query: TrigramQuery, budget: { left: number }): string | null {
  switch (query.kind) {
    case 'all': return null;
    case 'gram':
      if (budget.left === 0) return null;
      budget.left--;
      return `"${query.gram.replaceAll('"', '""')}"`;
    case 'and': {
      // Any subset of a conjunction is still implied by every match.
      const parts = query.parts.map(part => render(part, budget)).filter(part => part !== null);
      return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
    }
    case 'or': {
      const left = budget.left, parts: string[] = [];
      for (const part of query.parts) {
        const rendered = render(part, budget);
        // One unconstrained alternative leaves the whole disjunction unconstrained.
        if (rendered === null) { budget.left = left; return null; }
        parts.push(rendered);
      }
      return `(${parts.join(' OR ')})`;
    }
  }
}
/** An FTS5 MATCH expression over separate trigram tokens (`detail=none` rejects phrases), or null when the regex
 * requires no 3-character literal and every document is a candidate. */
export function searchTrigramQuery(hir: Hir): string | null {
  const info = analyze(hir);
  return render(both([withExact(info), info.exact ? ALL : both([setTrigrams(info.prefix), setTrigrams(info.suffix)])]), { left: MAX_QUERY_TRIGRAMS });
}
