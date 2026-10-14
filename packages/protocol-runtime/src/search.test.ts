import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RRegex } from 'rregex';
import { createSearchMatcher, searchSnapshotFiles, searchTrigramQuery } from './search.js';

const files = [
  { path: '.gitignore', content: 'ignored/\n*.log\n!keep.log\n' },
  { path: 'src/a.ts', content: 'Needle\nαβ\nstart\nend\n' },
  { path: 'src/b.md', content: 'needle\nneedle again\n' },
  { path: '.hidden', content: 'needle\n' },
  { path: 'ignored/a.ts', content: 'needle\n' },
  { path: 'x.log', content: 'needle\n' },
  { path: 'keep.log', content: 'needle\n' },
  { path: 'binary', content: 'needle\u0000\n' },
];

test('shared Rust matcher preserves flags Unicode multiline ignore paths and bounded paging', () => {
  expect(searchSnapshotFiles(files, { pattern: '(?i)needle', path: 'src', glob: '*.ts' }).text).toBe('src/a.ts:1:Needle');
  expect(searchSnapshotFiles(files, { pattern: '\\p{Greek}+', path: '.' }).text).toBe('src/a.ts:2:αβ');
  expect(searchSnapshotFiles(files, { pattern: 'start\\nend', path: '.', multiline: true }).text).toBe('src/a.ts:3:start\nsrc/a.ts:4:end');
  expect(searchSnapshotFiles(files, { pattern: 'needle', path: '.' }).text).toBe('keep.log:1:needle\nsrc/b.md:1:needle\nsrc/b.md:2:needle again');
  expect(searchSnapshotFiles(files, { pattern: 'needle', path: '.', offset: 1, limit: 1 })).toMatchObject({ text: 'src/b.md:1:needle', truncated: true });
  expect(searchSnapshotFiles(files, { pattern: 'needle', path: '.', hidden: true, gitignore: false }).text).toContain('ignored/a.ts:1:needle');
  expect(() => createSearchMatcher({ pattern: '(?=needle)', path: '.' })).toThrow();
});

test('single-line search rejects newline-consuming Rust literals but permits escaped backslash and broad classes', () => {
  for (const pattern of ['start\\nend', 'start\nend', '\\x0A', '\\u{A}']) {
    expect(() => searchSnapshotFiles(files, { pattern, path: '.' })).toThrow();
  }
  expect(searchSnapshotFiles([{ path: 'literal.txt', content: 'start\\nend\n' }], { pattern: 'start\\\\nend', path: '.' }).text).toBe('literal.txt:1:start\\nend');
  expect(searchSnapshotFiles([{ path: 'space.txt', content: ' \n' }], { pattern: '\\s', path: '.' }).text).toBe('space.txt:1: ');
});

test('multiline literal spans emit every covered line and never fall back to per-line matching', () => {
  const source = [{ path: 'span.txt', content: 'start\nend\nother\n' }];
  expect(searchSnapshotFiles(source, { pattern: 'start\nend', path: '.', multiline: true }).text).toBe('span.txt:1:start\nspan.txt:2:end');
  expect(searchSnapshotFiles(source, { pattern: '\\Aend', path: '.', multiline: true }).text).toBe('');
});

test('required trigrams never exclude a line the regex matches, and literals narrow the candidates', () => {
  const lines = [
    'export async function searchOrderedFiles(files) {', 'export function plain() {}', 'const Needle = 1;', 'NEEDLE shouting', 'temperature in \u212Aelvin',
    'the mi\u017F\u017Fion', 'colour and color', 'foobarqux foobazbazqux', 'a"quoted"b', 'x123-abc', 'import { Foo } from "bar"', 'ünïcödé needle', 'tab\tseparated\tvalues',
  ];
  const index = new Database(':memory:');
  index.run("CREATE VIRTUAL TABLE lines USING fts5(body, tokenize='trigram case_sensitive 0', content='', contentless_delete=1, detail=none)");
  lines.forEach((line, row) => index.run('INSERT INTO lines(rowid, body) VALUES(?, ?)', [row, line]));
  const narrowed: Record<string, number[]> = {
    searchOrderedFiles: [0], '(?i)needle': [2, 3, 11], 'colou?r': [6], 'foo(bar|baz)+qux': [7], 'a"quoted"': [8], '[0-9]{3}-abc': [9],
    'import \\{ [A-Z]\\w+ \\}': [10], '^export (async )?function': [0, 1], 'tab\\tsep': [12], '(?i)kelvin': [4], '(?i)MISSION': [5],
  };
  for (const pattern of [...Object.keys(narrowed), 'ünïcödé', '\\w+\\(', 'e', '(?s).+']) {
    const regex = new RRegex(pattern);
    try {
      const query = searchTrigramQuery(regex.syntax());
      const matching = lines.flatMap((line, row) => regex.isMatch(line) ? [row] : []);
      expect(matching.length, pattern).toBeGreaterThan(0);
      if (query === null) { expect(narrowed[pattern], pattern).toBeUndefined(); continue; }
      const candidates = index.query<{ rowid: number }, [string]>('SELECT rowid FROM lines WHERE lines MATCH ?').all(query).map(row => row.rowid);
      for (const row of matching) expect(candidates, `${pattern} → ${query}`).toContain(row);
      expect(candidates, `${pattern} → ${query}`).toEqual(narrowed[pattern] ?? candidates);
    } finally { regex.free(); }
  }
});
