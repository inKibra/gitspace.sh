import { expect, test } from 'bun:test';
import { createSearchMatcher, searchSnapshotFiles } from './search.js';

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
