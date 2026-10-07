import { RRegex, type Hir } from 'rregex';
import { RuntimeGrepArgumentsSchema } from './tool-arguments.js';

import { searchPathFilter, type SearchArguments, type SearchFile } from './search-paths.js';
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

/** A conservative index hint: no hint is better than a false-negative regex optimization. */
export function searchLiteralTrigrams(input: SearchArguments): string[] {
  const args = RuntimeGrepArgumentsSchema.parse(input);
  if (!args.caseSensitive || /[\\^$.*+?()[\]{}|]/u.test(args.pattern)) return [];
  return contentTrigrams(args.pattern);
}

export function contentTrigrams(content: string, limit = Number.POSITIVE_INFINITY): string[] {
  const trigrams = new Set<string>();
  let first = '', second = '';
  for (const character of content) {
    if (first && second) trigrams.add(first + second + character);
    first = second; second = character;
    if (trigrams.size > limit) break;
  }
  return [...trigrams];
}


/** Input must be path-ordered; index callers stream candidates without materializing every file. */
export function searchOrderedFiles(files: Iterable<SearchFile>, input: SearchArguments, ignoreFiles: readonly SearchFile[] = []): SearchOutput {
  const { args, regex } = createSearchMatcher(input);
  const accepts = searchPathFilter(args, ignoreFiles);
  const output: string[] = [];
  let matched = 0, scannedFiles = 0, truncated = false;
  try {
    outer: for (const file of files) {
      if (!accepts(file.path) || file.content.includes('\0')) continue;
      scannedFiles++;
      const lines = file.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      let matchingLines: Set<number> | undefined;
      if (args.multiline) {
        matchingLines = new Set<number>();
        const starts: number[] = []; let byteOffset = 0;
        for (const line of lines) { starts.push(byteOffset); byteOffset += new TextEncoder().encode(line).byteLength + 1; }
        for (const match of regex.findAll(file.content)) {
          for (let n = 0; n < starts.length; n++) {
            const start = starts[n]!;
            const end = starts[n + 1] ?? byteOffset;
            if (match.start < end && Math.max(match.start + 1, match.end) > start) matchingLines.add(n);
          }
        }
      }
      for (let n = 0; n < lines.length; n++) {
        if (!(matchingLines ? matchingLines.has(n) : regex.isMatch(lines[n]!))) continue;
        if (matched++ < args.offset) continue;
        if (output.length === args.limit) { truncated = true; break outer; }
        output.push(`${file.path}:${n + 1}:${lines[n]}`);
      }
    }
    return { text: output.join('\n'), truncated, scannedFiles };
  } finally { regex.free(); }
}

export function searchSnapshotFiles(files: readonly SearchFile[], input: SearchArguments): SearchOutput {
  return searchOrderedFiles([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), input, files);
}
