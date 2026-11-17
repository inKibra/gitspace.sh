// @vitest-environment happy-dom
import type { ChangeGuideSection, GoalRequirement } from '@gitspace/protocol';
import type { CommentAnchor } from '@gitspace/protocol-runtime/comments';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequirementBlock } from '../goal/RequirementsSection.js';
import { GuideDocument } from '../guide/GuideDocument.js';
import type { CommentNote } from './context.js';
import { entityQuote, entitySection, goalNotes, guideNotes } from './document-notes.js';

const section = (id: string, contentHash: string): ChangeGuideSection => ({ id, title: `Section ${id}`, kind: 'behavior', explanation: 'What changed.', why: '', requirementIds: [], contentHash, summary: `Summary of ${id}.`, exhibits: [{ path: 'src/parse.ts', blobId: null, note: '', slowRead: false }] });
const note = (id: string, anchor: CommentAnchor): CommentNote => ({ id, anchor, note: 'Why?', state: 'sent', replies: [] });

describe('Guide comments across revisions', () => {
  it('carries a comment forward when its section\'s contentHash is unchanged, and shows it outdated when it changed or is gone', () => {
    const earlier = [section('kept', 'aaaaaaaaaaaa'), section('changed', 'bbbbbbbbbbbb'), section('gone', 'cccccccccccc')];
    const latest = [section('kept', 'aaaaaaaaaaaa'), section('changed', 'dddddddddddd')];
    const on = (entity: string): CommentAnchor => ({ document: { kind: 'guide', revision: 1 }, target: { kind: 'entity', ref: entity }, quote: entity });
    const lines: CommentAnchor = { document: { kind: 'guide', revision: 1 }, target: { kind: 'lines', exhibit: 'exhibit:kept:src/parse.ts', side: 'head', start: 3, end: 4, blobId: null }, quote: 'parse()' };
    const shown = guideNotes([note('a', on('section:kept')), note('b', on('section:changed')), note('c', on('section:gone')), note('d', lines)], 2, latest, new Map([[1, earlier]]));
    expect(shown.map(({ id, outdated, revision }) => ({ id, outdated, revision }))).toEqual([
      { id: 'a', outdated: false, revision: 1 }, { id: 'b', outdated: true, revision: 1 }, { id: 'c', outdated: true, revision: 1 }, { id: 'd', outdated: false, revision: 1 },
    ]);
    // Not yet loaded, an earlier revision's comments wait; a later revision's do not show on an earlier one.
    expect(guideNotes([note('a', on('section:kept'))], 2, latest, new Map())).toEqual([]);
    expect(guideNotes([note('a', { ...on('section:kept'), document: { kind: 'guide', revision: 3 } })], 2, latest, new Map([[1, earlier]]))).toEqual([]);
  });

  it('shows a Goal requirement comment outdated once a later revision changed the requirement\'s text', () => {
    const anchor: CommentAnchor = { document: { kind: 'goal', revision: 2 }, target: { kind: 'entity', ref: 'requirement:parses' }, quote: entityQuote('Parses every sample', 'All of them.') };
    const same = new Map([['requirement:parses', entityQuote('Parses every sample', 'All of them.')]]);
    const reworded = new Map([['requirement:parses', entityQuote('Parses every sample', 'All but the empty file.')]]);
    expect(goalNotes([note('a', anchor)], 3, same)[0]?.outdated).toBe(false);
    expect(goalNotes([note('a', anchor)], 3, reworded)[0]?.outdated).toBe(true);
    expect(goalNotes([note('a', anchor)], 2, reworded)[0]?.outdated).toBe(false);
    expect(goalNotes([note('a', anchor)], 3, new Map())[0]?.outdated).toBe(true);
  });

  it('finds the section of an exhibit entity whose section id or path contains `:`, and none for an exhibit no section has', () => {
    const store = { ...section('store', 'aaaaaaaaaaaa'), exhibits: [{ path: 'v2:src/store.ts', blobId: null, note: '', slowRead: false }] };
    const storeV2 = { ...section('store:v2', 'bbbbbbbbbbbb'), exhibits: [{ path: 'src/cache.ts', blobId: null, note: '', slowRead: false }] };
    expect(entitySection('exhibit:store:v2:src/store.ts', [store, storeV2])?.id).toBe('store');
    expect(entitySection('exhibit:store:v2:src/cache.ts', [store, storeV2])?.id).toBe('store:v2');
    expect(entitySection('section:store:v2', [store, storeV2])?.id).toBe('store:v2');
    expect(entitySection('exhibit:store:v2:src/gone.ts', [store, storeV2])).toBeUndefined();
  });
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('typed blocks', () => {
  it('draws a Requirement from its record with its anchor id, its Markdown block keeping its element id, and its Evidence', async () => {
    const card = '```gitspace-ui\n{"root":"c","elements":{"c":{"type":"Card","id":"samples","props":{"title":"Samples"},"children":[]}}}\n```';
    const requirement: GoalRequirement = { id: 'parses', title: 'Parses every sample', description: `All of them.\n\n${card}`, required: true, status: 'review', workflowNodeId: null, criterionId: null, evidence: [{ kind: 'command', runId: 'run-1', command: 'bun test', exitCode: 0, artifactUrl: null, artifactHash: null, generation: 1, label: 'unit tests' }] };
    await act(async () => root.render(<ul><RequirementBlock requirement={requirement} sections={[{ id: 's1', number: 1 }]} viewerId="me" pending={false} onOpenEvidence={() => undefined} onOpenGuideSection={() => undefined} /></ul>));
    const block = container.querySelector('[data-block-type="Requirement"]');
    expect(block?.querySelector('[data-comment-target="requirement:parses"]')?.textContent).toContain('Parses every sample');
    expect(block?.querySelector('[data-comment-block="requirement:parses#samples"]')).not.toBeNull();
    expect(block?.querySelector('[data-block-type="Evidence"]')?.textContent).toContain('unit tests');
    expect(block?.textContent).toContain('Guide §1');
    expect(block?.textContent).toContain('evidence to check');
  });

  it('draws each Guide section and exhibit with its anchor id', async () => {
    const guide = { title: 'Parse v2', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), sections: [section('reader', 'aaaaaaaaaaaa')] };
    await act(async () => root.render(<GuideDocument guide={guide} kicker="Guide" workspace={null} captures={null} onLoadDiff={() => Promise.withResolvers<never>().promise} />));
    expect(container.querySelector('[data-block-type="GuideSection"] [data-comment-target="section:reader"]')).not.toBeNull();
    expect(container.querySelector('[data-block-type="Exhibit"] [data-comment-target="exhibit:reader:src/parse.ts"]')).not.toBeNull();
  });
});

describe('Change Guide walkthrough', () => {
  it('plays a walkthrough built from the sections\' summaries for a guide written without one', async () => {
    const guide = { title: 'Parse v2', baseRef: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), sections: [section('reader', 'aaaaaaaaaaaa'), section('writer', 'bbbbbbbbbbbb')] };
    await act(async () => root.render(<GuideDocument guide={guide} kicker="Guide" workspace={null} captures={null} onLoadDiff={() => Promise.withResolvers<never>().promise} />));
    const play = document.querySelector<HTMLButtonElement>('button[aria-label="Play the walkthrough"]');
    expect(play?.dataset.walkthrough).toBe('built');
    await act(async () => play?.click());
    const player = document.querySelector<HTMLElement>('[aria-roledescription="walkthrough"]');
    expect(player?.dataset.sequencePlaying).toBe('true');
    expect(document.body.textContent).toContain('Section 1: Section reader. Summary of reader.'.split('.')[0]);
  });
});
