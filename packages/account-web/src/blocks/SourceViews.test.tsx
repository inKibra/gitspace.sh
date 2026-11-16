// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeSetBlock, commandRunBlock, excerptBlock, testReportBlock } from '@gitspace/protocol/block-builders';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { ResourceNavigation, type ResourceRequest } from '../ResourceNavigation.js';

let container: HTMLDivElement;
let root: Root;
let opened: ResourceRequest[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  opened = [];
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Draws a builder's fence as an agent pastes it, in a surface that opens resources in the Inspector. */
async function draw(fence: string): Promise<string> {
  await act(async () => root.render(<ResourceNavigation.Provider value={(request) => { opened.push(request); }}><GitSpaceMarkdown>{`Here it is.\n\n${fence}\n`}</GitSpaceMarkdown></ResourceNavigation.Provider>));
  for (let attempt = 0; attempt < 100 && container.querySelector('[data-gitspace-block="gitspace-ui"] figure') === null; attempt += 1) {
    await act(async () => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 20); await promise; });
  }
  const text = container.textContent ?? '';
  expect(text).not.toContain('could not be drawn');
  return text;
}

async function click(text: string): Promise<void> {
  const target = [...container.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent?.trim() === text);
  if (!target) throw new Error(`no button reads "${text}"; the page reads: ${container.textContent ?? ''}`);
  await act(async () => { target.click(); });
}

const COMMIT = 'a'.repeat(40);

describe('builder blocks', () => {
  it('draws a CodeExcerpt with its line numbers and marks, and opens the file at its first line', async () => {
    const built = excerptBlock({ path: 'src/parse.ts', text: 'one\nconst at = line.indexOf("=");\nreturn at;\nfour\n', start: 2, end: 3, commit: COMMIT, highlight: [3], note: 'Splits at the first "=".' });
    const text = await draw(built.fence);
    expect(text).toContain('const at = line.indexOf("=");');
    expect(text).toContain('Splits at the first "=".');
    expect([...container.querySelectorAll('[data-line]')].map((line) => line.getAttribute('data-line'))).toEqual(['2', '3']);
    expect(container.querySelector<HTMLElement>('[data-line="3"]')?.style.boxShadow).not.toBe('');
    expect(container.querySelector<HTMLElement>('[data-line="2"]')?.style.boxShadow).toBe('');
    await click('src/parse.ts:2–3');
    expect(opened).toEqual([{ uri: `repo://src/parse.ts@${COMMIT}:2-` }]);
  });

  it('draws a CommandRun with its status and duration, its output folded until opened', async () => {
    const built = commandRunBlock({ command: 'bun test', exitCode: 1, durationMs: 2500, output: 'first line\n(fail) parse > quoted\n', cut: false, jobId: 'job:7', cwd: 'packages/parse' });
    const text = await draw(built.fence);
    expect(text).toContain('failed · exit 1');
    expect(text).toContain('bun test');
    expect(text).toContain('2.5 s');
    expect(text).toContain('in packages/parse · job:7');
    expect(text).not.toContain('(fail) parse > quoted');
    await click('Show output (2 lines)');
    expect(container.querySelector('pre')?.textContent).toBe('first line\n(fail) parse > quoted');
  });

  it('draws a TestReport\'s counts, failures and note, and a dash for a count the output never stated', async () => {
    const report = testReportBlock(' 4 pass\n 1 skip\n 1 fail\nRan 6 tests across 1 file. [2.40s]\n\nparse.test.ts:\nerror: expected 3\n(fail) parse > reads a quoted value\n', false);
    const text = await draw(report.fence);
    expect(text).toContain('4passed');
    expect(text).toContain('1failed');
    expect(text).toContain('1skipped');
    expect(text).toContain('bun test · 2.4 s');
    expect(text).toContain('parse > reads a quoted value');
    expect(text).toContain('expected 3');
    const unknown = testReportBlock('3 passing\n', false);
    const drawn = await draw(unknown.fence);
    expect(drawn).toContain('3passed');
    expect(drawn).toContain('—failed');
    expect(drawn).toContain('Unrecognised test output');
  });

  it('draws a ChangeSet grouped by area with +/- counts, and opens a file\'s diff', async () => {
    const built = changeSetBlock({
      base: 'main (merge base 1a2b3c4)', head: '5d6e7f8', packages: new Set(['packages/config']),
      files: [
        { path: 'packages/config/src/parse.ts', added: 2, removed: 1, status: 'modified' },
        { path: 'packages/config/src/trim.ts', added: 1, removed: 0, status: 'added' },
        { path: 'README.md', added: 2, removed: 0, status: 'modified' },
      ],
    });
    const text = await draw(built.fence);
    expect(text).toContain('3 files+5−1');
    expect(text).toContain('main (merge base 1a2b3c4) → 5d6e7f8');
    expect([...container.querySelectorAll('h4')].map((heading) => heading.textContent)).toEqual(['packages/config+3 −1', '(root)+2 −0']);
    await click('packages/config/src/trim.ts');
    expect(opened).toEqual([{ uri: 'repo://packages/config/src/trim.ts', diff: true }]);
  });
});
