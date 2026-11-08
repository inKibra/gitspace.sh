// @vitest-environment happy-dom
import type { ChangeGuideSection, ChangeGuideView, ChangeMap, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeGuideSurface } from '../inspector/ChangeGuideSurface.js';
import { SharedGuide } from '../SharedGuide.js';
import { ChangeMapView, READABLE_TEXT } from './ChangeMap.js';
import { tileTint } from './ChangeTreemap.js';
import { narrowExhibit } from './exhibit-segments.js';
import { SECTION_KIND } from './GuideSection.js';
import { ISO_LABEL, placeIsoLabels, projectIsoMap, type FileChange } from './iso-layout.js';
import { AREA_HEIGHT, AREA_WIDTH, layoutChangeMap } from './map-layout.js';
import { SMALLEST_TILE, guideFiles, layoutTreemap, type ChangedFile, type Rect } from './treemap-layout.js';

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
    review={{ threads: [], onOpenFile() {}, onSelectThread() {}, onSelectRange() {} }} onOpenEvidence={() => undefined}
    captures={{ content: () => null, status: () => undefined, error: () => undefined, load() {}, size: () => null, browserCapture: () => ({ poster: null, recording: null }) }}
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

  it('projects the layout onto an isometric plane the same way every time, each box on its package plate and none overlapping', () => {
    const iso = projectIsoMap(layoutChangeMap(map), null);
    expect(projectIsoMap(layoutChangeMap(structuredClone(map)), null)).toEqual(iso);
    expect(iso.boxes.map((box) => box.area.id).sort()).toEqual(map.areas.map((area) => area.id).sort());
    expect(iso.plates.map((plate) => plate.name)).toEqual(['kettle/ui', 'kettle/core', 'kettle/firmware']);
    for (const box of iso.boxes) {
      const plate = iso.plates.find((candidate) => candidate.name === box.area.package)!;
      expect(box.footprint.u).toBeGreaterThanOrEqual(plate.footprint.u);
      expect(box.footprint.v).toBeGreaterThanOrEqual(plate.footprint.v);
      expect(box.footprint.u + box.footprint.w).toBeLessThanOrEqual(plate.footprint.u + plate.footprint.w);
      expect(box.footprint.v + box.footprint.d).toBeLessThanOrEqual(plate.footprint.v + plate.footprint.d);
      for (const other of iso.boxes) {
        if (other === box) continue;
        const apart = other.footprint.u >= box.footprint.u + box.footprint.w || box.footprint.u >= other.footprint.u + other.footprint.w
          || other.footprint.v >= box.footprint.v + box.footprint.d || box.footprint.v >= other.footprint.v + other.footprint.d;
        expect(apart).toBe(true);
      }
    }
    for (const plate of iso.plates) for (const other of iso.plates) if (other !== plate) expect(other.footprint.u >= plate.footprint.u + plate.footprint.w || plate.footprint.u >= other.footprint.u + other.footprint.w).toBe(true);
  });

  it('stands an area taller the more lines its files change, flat with no changed files, and level until counted', () => {
    const height = (changes: ReadonlyMap<string, FileChange> | null) => new Map(projectIsoMap(layoutChangeMap(map), changes).boxes.map((box) => [box.area.id, box.height]));
    const before = height(null);
    expect(new Set(['panel', 'scheduler', 'heater', 'timer'].map((id) => before.get(id))).size).toBe(1);
    expect(before.get('audit')).toBeLessThan(before.get('panel')!);
    const after = height(new Map([['ui/panel.tsx', { additions: 4, deletions: 1 }], ['core/scheduler.ts', { additions: 60, deletions: 20 }], ['firmware/heater.c', { additions: 15, deletions: 5 }]]));
    expect(after.get('panel')).toBeLessThan(after.get('heater')!);
    expect(after.get('heater')).toBeLessThan(after.get('scheduler')!);
    expect(after.get('audit')).toBeLessThan(after.get('panel')!);
    expect(projectIsoMap(layoutChangeMap(map), new Map([['core/scheduler.ts', { additions: 60, deletions: 20 }]])).boxes.find((box) => box.area.id === 'scheduler')?.lines).toBe(80);
  });

  it('opens in the overview unless the map is crowded, and switches to the flow view', async () => {
    const view = () => container.querySelector('[data-map-view]')?.getAttribute('data-map-view');
    await act(async () => root.render(<ChangeMapView map={map} sections={sections} />));
    expect(view()).toBe('overview');
    expect(container.querySelector('svg [data-area="heater"]')).not.toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent?.includes('Flow'))?.click());
    expect(view()).toBe('flow');
    expect(container.querySelector('[data-flow] [data-area="heater"]')).not.toBeNull();
    const extra = (count: number, pkg: (index: number) => string): ChangeMap => ({ ...map, areas: [...map.areas, ...Array.from({ length: count }, (_, index) => ({ id: `extra-${index}`, name: `Extra ${index}`, package: pkg(index), role: '', whatItDoes: '', files: [] }))] });
    await act(async () => root.render(<ChangeMapView key="many-areas" map={extra(8, () => 'kettle/core')} sections={sections} />));
    expect(view()).toBe('flow');
    await act(async () => root.render(<ChangeMapView key="twelve-areas" map={extra(7, () => 'kettle/core')} sections={sections} />));
    expect(view()).toBe('overview');
    await act(async () => root.render(<ChangeMapView key="many-packages" map={extra(3, (index) => `kettle/extra-${index}`)} sections={sections} />));
    expect(view()).toBe('flow');
  });

  it('lights a playing step\'s areas and paths the same in the overview and the flow view', async () => {
    await act(async () => root.render(<ChangeMapView map={map} sections={sections} />));
    const lit = (selector: string) => [...container.querySelectorAll(`${selector}[data-lit="true"]`)].map((node) => node.getAttribute('data-area') ?? node.getAttribute('data-path')).sort();
    await act(async () => button('Next step').click());
    const overview = { areas: lit('svg [data-area]'), paths: lit('svg [data-path]') };
    expect(overview).toEqual({ areas: ['panel', 'scheduler'], paths: ['press'] });
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent?.includes('Flow'))?.click());
    expect({ areas: lit('[data-flow] [data-area]'), paths: lit('[data-flow] [data-path]') }).toEqual(overview);
  });

  it('tells what an area is and what changed in it on hover, and opens the flow view on it when pressed', async () => {
    const changes = new Map([['ui/panel.tsx', { additions: 4, deletions: 1 }]]);
    await act(async () => root.render(<ChangeMapView map={map} sections={sections} changes={changes} />));
    const panel = container.querySelector('svg [data-area="panel"]')!;
    await act(async () => panel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const card = container.querySelector('[data-area-card="panel"]')?.textContent ?? '';
    for (const text of ['Control panel', 'kettle/ui', 'what the person presses', 'Shows the brew button.', '5 lines changed', 'ui/panel.tsx', '+4', '−1']) expect(card).toContain(text);
    await act(async () => panel.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-map-view]')?.getAttribute('data-map-view')).toBe('flow');
    expect(container.querySelector('[data-flow] [data-area="panel"]')?.getAttribute('data-lit')).toBe('true');
    expect(container.querySelector('[data-flow] [data-area="heater"]')?.getAttribute('data-lit')).toBe('false');
  });
});

describe('change map views at a narrow width', () => {
  it('keeps the flow view\'s text readable in a narrow box, scrolling sideways instead of shrinking it further', async () => {
    let width = 320;
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {}
      observe() { this.callback([{ contentRect: { width, height: 400 } }]); }
      unobserve() {}
      disconnect() {}
    });
    const drawn = async (key: string) => {
      await act(async () => root.render(<ChangeMapView key={key} map={map} sections={sections} />));
      await act(async () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent?.includes('Flow'))?.click());
      const flow = container.querySelector<HTMLElement>('[data-flow]')!;
      const scale = Number(flow.querySelector('[data-flow-scale]')?.getAttribute('data-flow-scale'));
      const sizes = [...flow.querySelectorAll('[style]')].flatMap((node) => {
        const size = /font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/u.exec(node.getAttribute('style') ?? '');
        return size ? [Number(size[1])] : [];
      });
      return { scale, sizes, width: Number.parseFloat(flow.querySelector<HTMLElement>(':scope > div')?.style.width ?? '0') };
    };
    const narrow = await drawn('narrow');
    expect(narrow.sizes.length).toBeGreaterThan(map.areas.length);
    for (const size of narrow.sizes) expect(size * narrow.scale).toBeGreaterThanOrEqual(READABLE_TEXT);
    // Wider than its box, it scrolls.
    expect(narrow.width).toBeGreaterThan(320);
    width = 4000;
    // A wide box shows it at its natural size, not enlarged.
    expect((await drawn('wide')).scale).toBe(1);
  });

  it('moves or hides overview labels that would cover each other in a narrow box, and keeps them their size on screen', () => {
    const iso = projectIsoMap(layoutChangeMap(map), null);
    expect(placeIsoLabels(iso, 1).every((label) => label.shown)).toBe(true);
    const scale = 0.3;
    const shown = placeIsoLabels(iso, scale).filter((label) => label.shown);
    expect(shown.length).toBeGreaterThan(0);
    const boxes = shown.map((label) => {
      expect(label.size * scale).toBeCloseTo(ISO_LABEL[label.kind].size);
      const half = (label.text.length * ISO_LABEL[label.kind].char) / scale / 2;
      return { left: label.x - half, right: label.x + half, top: label.y - label.size, bottom: label.y + label.size * 0.2 };
    });
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) expect(box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top).toBe(true);
    }
  });
});

describe('where it changed', () => {
  const changed = (path: string, pkg: string | null, lines: number): ChangedFile => ({ path, package: pkg, section: { id: 'schedule', index: 0, title: 'Pressing brew schedules it', kind: 'behavior' }, test: false, additions: lines, deletions: 0 });
  const area = (rect: Rect) => rect.w * rect.h;

  it('gives each package and each file room in proportion to the lines it changes', () => {
    const files = [changed('ui/panel.tsx', 'kettle/ui', 300), changed('ui/dial.tsx', 'kettle/ui', 100), changed('core/queue.ts', 'kettle/core', 200), changed('core/clock.ts', 'kettle/core', 250), changed('firmware/relay.c', 'kettle/firmware', 150)];
    const packages = layoutTreemap(files, 800, 400);
    expect(packages.flatMap((pkg) => pkg.tiles.flatMap((tile) => tile.files.map((file) => file.path))).sort()).toEqual(files.map((file) => file.path).sort());
    for (const pkg of packages) {
      expect(area(pkg.rect) / (pkg.additions + pkg.deletions)).toBeCloseTo((800 * 400) / 1000, 3);
      const [first, ...rest] = pkg.tiles.map((tile) => area(tile.rect) / (tile.additions + tile.deletions));
      for (const perLine of rest) expect(perLine / first!).toBeCloseTo(1, 5);
    }
  });

  it('gathers a package\'s files too small to read into one tile that says how many', () => {
    const small = Array.from({ length: 6 }, (_, index) => changed(`core/step-${index}.ts`, 'kettle/core', 4));
    const core = layoutTreemap([changed('core/scheduler.ts', 'kettle/core', 900), ...small, changed('ui/panel.tsx', 'kettle/ui', 300)], 600, 300).find((pkg) => pkg.name === 'kettle/core')!;
    const shared = core.tiles.filter((tile) => tile.files.length > 1);
    expect(shared.map((tile) => tile.files.map((file) => file.path).sort())).toEqual([small.map((file) => file.path)]);
    for (const tile of core.tiles) expect(area(tile.rect)).toBeGreaterThanOrEqual(SMALLEST_TILE);
  });

  it('puts a file no map area lists in the package of a mapped file beside it, else in none', () => {
    const shown = (paths: string[]): ChangeGuideSection => ({ ...sections[0]!, exhibits: paths.map((path) => ({ path, blobId: null, note: '', slowRead: false })) });
    const nested: ChangeMap = { ...map, areas: [...map.areas, { id: 'api', name: 'Brew route', package: 'kettle/api', role: '', whatItDoes: '', files: ['services/api/src/brew.ts'] }] };
    const files = guideFiles([shown(['ui/panel.tsx', 'ui/panel.test.tsx', 'services/api/test/brew.test.ts', 'services/web/src/page.ts', 'NOTES.md'])], nested);
    expect(Object.fromEntries(files.map((file) => [file.path, file.package]))).toEqual({
      'ui/panel.tsx': 'kettle/ui', 'ui/panel.test.tsx': 'kettle/ui', 'services/api/test/brew.test.ts': 'kettle/api', 'services/web/src/page.ts': null, 'NOTES.md': null,
    });
  });

  it('colours each file by the kind of the section that shows it, a test paler, and a tile several files share neutral', () => {
    const decision: ChangedFile['section'] = { id: 'heat', index: 1, title: 'The heater follows the schedule', kind: 'decision' };
    const files = [changed('ui/panel.tsx', 'kettle/ui', 300), { ...changed('firmware/heater.c', 'kettle/firmware', 300), section: decision }, { ...changed('firmware/heater.test.ts', 'kettle/firmware', 200), section: decision, test: true },
      changed('core/scheduler.ts', 'kettle/core', 900), ...Array.from({ length: 6 }, (_, index) => changed(`core/step-${index}.ts`, 'kettle/core', 4))];
    const tiles = layoutTreemap(files, 600, 300).flatMap((pkg) => pkg.tiles);
    const tint = (path: string) => tileTint(tiles.find((candidate) => candidate.files.some((file) => file.path === path))!);
    const strength = (path: string) => Number(/ (\d+)%/u.exec(tint(path))?.[1]);
    expect(tint('ui/panel.tsx')).toContain(SECTION_KIND.behavior.color);
    expect(tint('firmware/heater.c')).toContain(SECTION_KIND.decision.color);
    expect(tint('firmware/heater.test.ts')).toContain(SECTION_KIND.decision.color);
    expect(strength('firmware/heater.test.ts')).toBeLessThan(strength('firmware/heater.c'));
    for (const kind of Object.values(SECTION_KIND)) expect(tint('core/step-0.ts')).not.toContain(kind.color);
  });

  const tile = (path: string) => container.querySelector<HTMLElement>(`[data-tile="${path}"]`);

  it('opens the section that shows a file when its tile is pressed', async () => {
    // Another space, so the sections it opens stay out of the surface's cache for the guide the other tests read.
    await surface({ guide: { ...guide, spaceId: 'treemap-space' } });
    await vi.waitFor(() => expect(container.querySelector('[aria-busy="false"] [data-tile="firmware/heater.c"]')).not.toBeNull());
    const heat = container.querySelector('[data-section="heat"] button[aria-expanded]');
    expect(heat?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => tile('firmware/heater.c')?.click());
    expect(heat?.getAttribute('aria-expanded')).toBe('true');
  });

  it('stands every file in place until the diffs are read, then sizes each by its lines', async () => {
    const read = Promise.withResolvers<void>();
    await surface({ onLoadDiff: async (path) => { await read.promise; return diffFor(path); } });
    expect(container.querySelector('[aria-busy="true"] [data-tile="ui/panel.tsx"]')).not.toBeNull();
    expect(container.textContent).toContain('Reading the diffs of 2 files');
    await act(async () => read.resolve());
    await vi.waitFor(() => expect(container.querySelector('[aria-busy="false"] [data-tile="ui/panel.tsx"]')).not.toBeNull());
    expect(tile('ui/panel.tsx')?.getAttribute('aria-label')).toContain('+1 −1');
  });

  it('leaves tests out when the reader picks production code', async () => {
    const [schedule, heat] = sections as [ChangeGuideSection, ChangeGuideSection];
    await surface({ guide: { ...guide, sections: [schedule, { ...heat, exhibits: [...heat.exhibits, { path: 'firmware/heater.test.ts', blobId: null, note: '', slowRead: false }] }] } });
    await vi.waitFor(() => expect(tile('firmware/heater.test.ts')).not.toBeNull());
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent?.includes('Production code'))?.click());
    expect(tile('firmware/heater.test.ts')).toBeNull();
    expect(tile('firmware/heater.c')).not.toBeNull();
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

  it('measures each mapped file the guide shows from the diff its exhibit reads, once per file', async () => {
    const loadDiff = vi.fn(async (path: string) => diffFor(path));
    await surface({ onLoadDiff: loadDiff });
    await vi.waitFor(() => expect(container.querySelector('svg [data-area="panel"]')?.getAttribute('data-lines')).toBe('2'));
    expect(container.querySelector('svg [data-area="heater"]')?.getAttribute('data-lines')).toBe('2');
    // The scheduler's file is not one the guide shows, so it is not measured.
    expect(container.querySelector('svg [data-area="scheduler"]')?.hasAttribute('data-lines')).toBe(false);
    await vi.waitFor(() => expect(container.querySelectorAll('[data-range-lines]').length).toBe(2));
    expect(loadDiff.mock.calls.filter(([path]) => path === 'ui/panel.tsx')).toHaveLength(1);
  });
});

describe('Change Guide revisions', () => {
  const quiet: ChangeGuideSection = { id: 'quiet', title: 'Night brews stay quiet', kind: 'behavior', explanation: 'The fan waits.', why: '', requirementIds: [], exhibits: [] };
  const legacy: ChangeGuideSection = { id: 'legacy', title: 'Legacy start button', kind: 'mechanical', explanation: 'Removed later.', why: '', requirementIds: [], exhibits: [] };
  const [schedule, heat] = sections as [ChangeGuideSection, ChangeGuideSection];
  const latest: ChangeGuideView = { ...guide, sections: [schedule, { ...heat, contentHash: 'aaaaaaaaaaaa' }, quiet] };
  const second: ChangeGuideView = { ...guide, revision: 2, headCommit: 'e'.repeat(40), title: 'Brew on a schedule, draft', map: undefined, sections: [{ ...schedule, explanation: 'The panel starts the heater.' }, { ...heat, explanation: 'Old words', contentHash: 'aaaaaaaaaaaa' }, legacy] };
  const first: ChangeGuideView = { ...guide, revision: 1, headCommit: 'f'.repeat(40), map: undefined, sections: [schedule, { ...heat, contentHash: 'bbbbbbbbbbbb' }] };
  const views = new Map([[2, second], [1, first]]);
  const handlers = (read: readonly number[]) => ({
    list: async () => [latest, second, first].map((view) => ({
      revision: view.revision, headCommit: view.headCommit, baseRef: view.baseRef, baseCommit: view.baseCommit, title: view.title, createdAt: date, createdBy: view.createdBy,
      sectionCount: view.sections.length, readerIds: read.includes(view.revision) ? ['reviewer'] : [],
    })),
    get: async (revision: number) => views.get(revision)!,
  });
  const badges = () => Object.fromEntries([...container.querySelectorAll('[data-section]')].map((node) => [node.getAttribute('data-section'), node.querySelector('[data-section-change]')?.getAttribute('data-section-change') ?? null]));
  async function choose(control: string, prefix: string): Promise<void> {
    await act(async () => button(control).click());
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.startsWith(prefix));
    if (!option) throw new Error(`No option ${prefix}`);
    await act(async () => option.click());
  }

  it('compares with the newest earlier revision the reader read in, badging each section and listing those removed', async () => {
    const loadDiff = vi.fn(async (path: string) => diffFor(path));
    await surface({ guide: latest, revisions: handlers([1, 2]), onLoadDiff: loadDiff });
    await vi.waitFor(() => expect(container.querySelector('[data-comparison]')?.getAttribute('data-comparison')).toBe('2'));
    expect(button('Changes since').textContent).toContain('r2');
    expect(badges()).toEqual({ schedule: 'changed', heat: 'unchanged', quiet: 'new' });
    expect(container.querySelector('[data-removed-since="2"]')?.textContent).toContain('Legacy start button');
    // A changed section's file shows its code since the compared revision's head.
    await vi.waitFor(() => expect(button('Since r2')).toBeDefined());
    await act(async () => button('Since r2').click());
    expect(loadDiff).toHaveBeenLastCalledWith('ui/panel.tsx', { revision: 3, sinceRevision: 2 });

    await choose('Changes since', 'r1 ');
    await vi.waitFor(() => expect(container.querySelector('[data-comparison]')?.getAttribute('data-comparison')).toBe('1'));
    expect(badges()).toEqual({ schedule: 'unchanged', heat: 'changed', quiet: 'new' });
    expect(container.querySelector('[data-removed-since]')).toBeNull();

    await choose('Changes since', 'No comparison');
    expect(container.querySelector('[data-comparison]')).toBeNull();
    expect(badges()).toEqual({ schedule: null, heat: null, quiet: null });
  });

  it('compares with nothing when the reader has read no earlier revision', async () => {
    await surface({ guide: latest, revisions: handlers([3]) });
    await vi.waitFor(() => expect(button('Guide revision')).toBeDefined());
    expect(button('Changes since').textContent).toContain('No comparison');
    expect(container.querySelector('[data-comparison]')).toBeNull();
    expect(badges()).toEqual({ schedule: null, heat: null, quiet: null });
  });

  it('shows a picked older revision read-only under a banner, and goes back to the latest', async () => {
    const setAcceptance = vi.fn(async () => {});
    const loadDiff = vi.fn(async (path: string) => diffFor(path));
    await surface({ guide: latest, revisions: handlers([]), onSetAcceptance: setAcceptance, onLoadDiff: loadDiff });
    await vi.waitFor(() => expect(button('Guide revision')).toBeDefined());
    expect(container.querySelector('[role="status"]')).toBeNull();
    await choose('Guide revision', 'r2 ');
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toContain('Viewing r2 of 3'));
    expect(container.textContent).toContain('Brew on a schedule, draft');
    expect(container.textContent).toContain('Legacy start button');
    expect(container.textContent).toContain('The panel starts the heater.');
    expect(button('A press schedules a brew').getAttribute('aria-disabled')).toBe('true');
    await act(async () => button('A press schedules a brew').click());
    expect(setAcceptance).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Mark read and continue →')).toBe(false);
    await vi.waitFor(() => expect(loadDiff).toHaveBeenCalledWith('ui/panel.tsx', { revision: 2 }));

    await act(async () => button('Back to latest').click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('Legacy start button');
    expect(button('A press schedules a brew').getAttribute('aria-disabled')).toBeNull();
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Mark read and continue →')).toBe(true);
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
