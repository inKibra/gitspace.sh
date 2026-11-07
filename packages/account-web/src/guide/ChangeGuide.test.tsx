// @vitest-environment happy-dom
import type { ChangeGuideSection, ChangeGuideView, ChangeMap, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeGuideSurface } from '../inspector/ChangeGuideSurface.js';
import { SharedGuide } from '../SharedGuide.js';
import { ChangeMapView } from './ChangeMap.js';
import { narrowExhibit } from './exhibit-segments.js';
import { AREA_HEIGHT, AREA_WIDTH, layoutChangeMap } from './map-layout.js';

const date = '2026-01-01T00:00:00.000Z';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const map: ChangeMap = {
  areas: [
    { id: 'panel', name: 'Control panel', package: 'kettle/ui', role: 'what the person presses', whatItDoes: 'Shows the brew button.', files: ['ui/panel.tsx'] },
    { id: 'scheduler', name: 'Scheduler', package: 'kettle/core', role: 'decides when to heat', whatItDoes: 'Queues brews.', files: ['core/scheduler.ts'] },
    { id: 'heater', name: 'Heater driver', package: 'kettle/firmware', role: 'switches the element', whatItDoes: 'Drives the relay.', files: ['firmware/heater.c'] },
    { id: 'audit', name: 'Audit log', package: 'kettle/core', role: 'records each brew', whatItDoes: 'Appends a line per brew.', files: [], note: 'unchanged' },
    { id: 'timer', name: 'Countdown', package: 'kettle/ui', role: 'the old countdown', whatItDoes: 'Counted down to boiling.', files: ['ui/timer.tsx'] },
  ],
  paths: [
    { id: 'press', from: 'panel', to: 'scheduler', label: 'schedule()', state: 'added' },
    { id: 'heat', from: 'scheduler', to: 'heater', label: 'heat(on)', state: 'same' },
    { id: 'record', from: 'scheduler', to: 'audit', label: 'brewed', state: 'added' },
    { id: 'countdown', from: 'timer', to: 'heater', label: 'countdown', state: 'removed' },
    { id: 'reading', from: 'heater', to: 'scheduler', label: 'temperature', state: 'same' },
  ],
  steps: [
    { paths: ['press'], from: 'panel', to: 'scheduler', caption: 'A press schedules a brew.', sectionId: 'schedule' },
    { paths: ['heat'], from: 'scheduler', to: 'heater', caption: 'The scheduler switches the heater on.', sectionId: 'heat' },
  ],
};
const panelPatch = [
  'diff --git a/ui/panel.tsx b/ui/panel.tsx', '--- a/ui/panel.tsx', '+++ b/ui/panel.tsx',
  '@@ -1,12 +1,13 @@',
  ' line one', ' line two', ' line three', '-oldButton()', '+brewButton()', ' line five', ' line six', ' line seven', ' line eight', ' line nine', ' line ten', '-oldLabel', '+brewLabel', '+brewHint', ' line thirteen', '',
].join('\n');
const sections: ChangeGuideSection[] = [
  {
    id: 'schedule', title: 'Pressing brew schedules it', kind: 'behavior', explanation: 'The panel asks the scheduler.', why: '', requirementIds: ['r-schedule', 'r-quiet'],
    summary: 'Brews are scheduled, not started.', readersGuide: 'Check that the button never heats directly.',
    exhibits: [{ path: 'ui/panel.tsx', blobId: null, note: '', slowRead: false, ranges: [{ start: 4, end: 4, note: 'The button now schedules.' }, { start: 11, end: 12, note: 'Its label says so.' }] }],
    evidence: [{ kind: 'command', runId: 'run-1', command: 'npm test', exitCode: 0, artifactUrl: null, artifactHash: null, generation: 1, label: 'unit tests' }],
    asks: ['Show the queued brew on the lock screen'],
  },
  { id: 'heat', title: 'The heater follows the schedule', kind: 'decision', explanation: 'The driver is unchanged.', why: 'The relay was already safe.', requirementIds: [], exhibits: [{ path: 'firmware/heater.c', blobId: null, note: 'Only the call site moved.', slowRead: false }] },
];
const guide: ChangeGuideView = {
  projectId: 'project', spaceId: 'space', revision: 3, headCommit: head, baseRef: 'main', baseCommit: base, title: 'Brew on a schedule',
  reviewerStates: [], createdAt: date, createdBy: 'agent', intro: 'The kettle now **schedules** brews.', map, sections,
};
const goal: GoalRecordView = {
  projectId: 'project', spaceId: 'space', id: 'goal', revision: 2, title: 'Scheduled brewing', summary: '', phase: 'review', createdAt: date, updatedAt: date, updatedBy: 'agent',
  requirements: [
    { id: 'r-schedule', title: 'A press schedules a brew', description: '', required: true, status: 'review', workflowNodeId: null, criterionId: null, evidence: [] },
    { id: 'r-quiet', title: 'Night brews are quiet', description: '', required: true, status: 'accepted', workflowNodeId: null, criterionId: null, evidence: [], acceptedBy: 'device', acceptedAt: date },
  ],
};
function diffFor(path: string): RepositoryDiffView {
  const patch = path === 'ui/panel.tsx' ? panelPatch : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-heat()\n+heat(on)\n`;
  return { spaceId: 'space', generation: 1, mode: 'base', path, baseCommit: base, headCommit: head, patch, files: [{ path, oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, oldBlobId: 'c'.repeat(40), newBlobId: 'd'.repeat(40) }] };
}
const unavailable = async (): Promise<never> => { throw new Error('Unexpected action'); };

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: unknown[]) => void) {} observe() { this.callback([{ isIntersecting: true }]); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); });

function button(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button, [role="checkbox"]')].find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
  if (!found) throw new Error(`No control ${label}`);
  return found;
}
async function surface(overrides: Partial<Parameters<typeof ChangeGuideSurface>[0]> = {}) {
  await act(async () => root.render(<ChangeGuideSurface guide={guide} reviewerId="reviewer" goal={goal} workspaces={[]}
    review={{ threads: [], onOpenFile() {}, onSelectThread() {}, onSelectRange() {} }} onOpenEvidence={() => undefined} captures={{ content: () => null, load() {} }}
    onLoadDiff={async (path) => diffFor(path)} onMarkRead={unavailable} {...overrides} />));
}

describe('change map layout', () => {
  it('places every area once, in package columns ordered along the paths, the same way every time', () => {
    const layout = layoutChangeMap(map);
    expect(layoutChangeMap(structuredClone(map))).toEqual(layout);
    expect(layout.areas.map(({ area }) => area.id)).toEqual(map.areas.map((area) => area.id));
    expect(layout.paths.map(({ path }) => path.id)).toEqual(map.paths.map((path) => path.id));
    // The cycle back from the heater does not stop the panel coming first and the firmware last.
    expect(layout.packages.map((pkg) => pkg.name)).toEqual(['kettle/ui', 'kettle/core', 'kettle/firmware']);
    const at = new Map(layout.areas.map((placed) => [placed.area.id, placed]));
    expect(at.get('scheduler')!.y).toBeLessThan(at.get('audit')!.y);
    for (const placed of layout.areas) {
      const frame = layout.packages.find((pkg) => pkg.name === placed.area.package)!;
      expect(placed.x).toBeGreaterThanOrEqual(frame.x);
      expect(placed.x + AREA_WIDTH).toBeLessThanOrEqual(frame.x + frame.width);
      expect(placed.y + AREA_HEIGHT).toBeLessThanOrEqual(frame.y + frame.height);
      for (const other of layout.areas) if (other !== placed) expect(Math.abs(other.x - placed.x) >= AREA_WIDTH || Math.abs(other.y - placed.y) >= AREA_HEIGHT).toBe(true);
    }
    expect(layout.paths.find(({ path }) => path.id === 'press')).toMatchObject({ from: 'right', to: 'left' });
    expect(layout.paths.find(({ path }) => path.id === 'record')).toMatchObject({ from: 'bottom', to: 'top' });
  });

  it('draws every area and every path, coloured by its state', () => {
    const html = renderToStaticMarkup(<ChangeMapView map={map} sections={sections} />);
    for (const area of map.areas) expect(html).toContain(`data-area="${area.id}"`);
    for (const path of map.paths) expect(html).toContain(`data-path="${path.id}" data-state="${path.state}"`);
  });
});

describe('Change Guide tab', () => {
  it('lights a step\'s path on the map, marks its section, and opens that section from the step', async () => {
    await surface();
    const lit = () => [...container.querySelectorAll('[data-path][data-lit="true"]')].map((node) => node.getAttribute('data-path'));
    expect(lit()).toEqual([]);
    await act(async () => button('Next step').click());
    await act(async () => button('Next step').click());
    expect(lit()).toEqual(['heat']);
    expect(container.querySelector('[data-area="heater"]')?.getAttribute('data-lit')).toBe('true');
    expect(container.querySelector('[data-area="panel"]')?.getAttribute('data-lit')).toBe('false');
    expect(container.querySelector('[data-map-now]')?.getAttribute('data-section')).toBe('heat');
    const heat = container.querySelector('[data-section="heat"] button[aria-expanded]');
    expect(heat?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => button('Read §2 The heater follows the schedule').click());
    expect(heat?.getAttribute('aria-expanded')).toBe('true');
  });

  it('accepts and reopens a section\'s requirements through the person\'s acceptance', async () => {
    const setAcceptance = vi.fn(async () => {});
    await surface({ onSetAcceptance: setAcceptance });
    expect(button('A press schedules a brew').getAttribute('aria-checked')).toBe('false');
    expect(button('Night brews are quiet').getAttribute('aria-checked')).toBe('true');
    await act(async () => button('A press schedules a brew').click());
    await act(async () => button('Night brews are quiet').click());
    expect(setAcceptance.mock.calls).toEqual([['r-schedule', true], ['r-quiet', false]]);
  });

  it('puts each range\'s note above its own lines, and only those lines under it', async () => {
    await surface();
    await vi.waitFor(() => expect(container.querySelectorAll('[data-range-lines]').length).toBe(2));
    const order = [...container.querySelectorAll('[data-range-note], [data-range-lines]')].map((node) => node.getAttribute('data-range-note') ? `note ${node.getAttribute('data-range-note')}` : `lines ${node.getAttribute('data-range-lines')}`);
    expect(order).toEqual(['note 4-4', 'lines 4-4', 'note 11-12', 'lines 11-12']);
    expect(container.querySelector('[data-range-note="4-4"]')?.textContent).toContain('The button now schedules.');
    const drawn = (range: string) => container.querySelector(`[data-range-lines="${range}"] diffs-container`)?.shadowRoot?.textContent ?? '';
    await vi.waitFor(() => expect(drawn('11-12')).toContain('brewLabel'));
    expect(drawn('4-4')).toContain('brewButton');
    expect(drawn('4-4')).not.toContain('brewLabel');
    expect(drawn('11-12')).not.toContain('brewButton');
  });
});

describe('narrowExhibit', () => {
  it('keeps the file\'s line numbers and never shows a line twice', () => {
    const { segments, otherChanges } = narrowExhibit(panelPatch, [{ start: 4, end: 4 }, { start: 11, end: 12 }]);
    expect(segments.map((segment) => segment.patch?.split('\n').find((line) => line.startsWith('@@')))).toEqual(['@@ -1,7 +1,7 @@', '@@ -8,5 +8,6 @@']);
    expect(segments[1]!.lines.head.has(12)).toBe(true);
    expect([...segments[0]!.lines.head].some((line) => segments[1]!.lines.head.has(line))).toBe(false);
    expect(otherChanges).toBe(0);
  });
});

describe('shared Change Guide', () => {
  it('shows the guide, its map and its sections read-only', async () => {
    const shared = { repository: 'example/kettle', title: guide.title, baseRef: 'main', baseCommit: base, headCommit: head, sections, sharedAt: date, intro: guide.intro, map };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/diff?') ? diffFor(decodeURIComponent(url.split('path=')[1]!)) : shared)));
    await act(async () => root.render(<SharedGuide />));
    await vi.waitFor(() => expect(container.textContent).toContain('Brew on a schedule'));
    expect(container.textContent).toContain('The kettle now schedules brews.');
    expect(container.querySelector('[data-area="heater"]')).not.toBeNull();
    expect(container.textContent).toContain('Pressing brew schedules it');
    expect(container.textContent).toContain('Show the queued brew on the lock screen');
    expect(container.textContent).toContain('unit tests');
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    for (const label of ['Mark read and continue →', 'File an issue', 'Message the agent', 'Relate a workspace', 'unit tests · exit 0']) expect([...container.querySelectorAll('button')].some((node) => node.textContent === label)).toBe(false);
    expect(container.textContent).not.toContain('Requirements this section shows');
    expect(container.textContent).not.toContain('sections read');
  });
});
