// Where the change is: a treemap of the files the guide shows, grouped by package, each as large as the lines it changes
// and coloured by the kind of the first section that shows it (tests paler). Pressing a file opens its section; a tile
// that several small files share lists them below. Until the guide's diffs are read, every file stands as large and
// the tiles wait, uncounted. The reader can leave tests out.
import type { ChangeGuideSection, ChangeMap } from '@gitspace/protocol';
import { TabsSubtle, TabsSubtleItem, badgeColors, useShape } from '@gitspace/ui';
import { useMemo, useRef, useState } from 'react';
import { Lightbox } from '../Lightbox.js';
import { useBoxSize } from '../use-box-size.js';
import { Source } from './Authorship.js';
import { SECTION_KIND } from './GuideSection.js';
import type { FileChange } from './iso-layout.js';
import { TREEMAP_HEADER, guideFiles, layoutTreemap, type ChangedFile, type GuideFile, type TreemapTile } from './treemap-layout.js';

/** The width laid out before the browser measures the box, and how tall the box stands for its width. */
const UNMEASURED_WIDTH = 720;
const ASPECT = 0.45;
const MIN_HEIGHT = 260;
const MAX_HEIGHT = 440;
/** The smallest tile that names its file, the height below which it does so on one tight line, and the smallest tile
 * that also counts its lines and section. */
const NAMED = { w: 40, h: 16 };
const TIGHT = 26;
const COUNTED = { w: 92, h: 42 };
const KINDS: readonly ChangeGuideSection['kind'][] = ['decision', 'behavior', 'risk', 'mechanical'];
/** How strongly a file's tile takes its section's colour; a test's tile is paler. */
const TINT = { code: 34, test: 16 };

function tileKey(tile: TreemapTile): string {
  return tile.files.map((file) => file.path).join('\n');
}

function Counts({ change }: { change: FileChange }) {
  return <span className="tabular-nums"><span style={{ color: badgeColors.green }}>+{change.additions}</span> <span style={{ color: badgeColors.red }}>−{change.deletions}</span></span>;
}

/** A tile's colour: its file's section kind, paler for a test; neutral for a tile several files share, as they may
 * belong to sections of different kinds. */
export function tileTint(tile: TreemapTile): string {
  const [file, ...others] = tile.files;
  if (!file || others.length) return 'var(--surface-3)';
  return `color-mix(in oklab, ${SECTION_KIND[file.section.kind].color} ${file.test ? TINT.test : TINT.code}%, var(--surface-3))`;
}

/** The tiles, laid out in the box's measured size: its width, and either a height that follows it or, with `fill`,
 * the height of the box it fills. `counted` is false while the files stand in at one line each. */
function TreemapCanvas({ files, counted, fill, active, onActive, onOpenSection }: {
  files: readonly ChangedFile[];
  counted: boolean;
  fill: boolean;
  active: string | null;
  onActive(tile: TreemapTile | null, pin: boolean): void;
  onOpenSection(sectionId: string): void;
}) {
  const shape = useShape();
  const host = useRef<HTMLDivElement>(null);
  const size = useBoxSize(host);
  const width = size?.width || UNMEASURED_WIDTH;
  const height = fill && size?.height ? size.height : Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, width * ASPECT)));
  const packages = useMemo(() => layoutTreemap(files, width, height), [files, width, height]);
  return <div ref={host} role="group" aria-label={counted ? 'Changed lines by package and file' : 'The files by package, waiting for their changed lines'} aria-busy={!counted}
    className={`relative w-full overflow-hidden border border-border bg-surface-1 ${fill ? 'h-full min-h-[320px]' : ''} ${shape.container}`} style={fill ? undefined : { height }}>
    {packages.map((pkg) => <div key={pkg.name ?? ''} data-package={pkg.name ?? ''}>
      <div className="pointer-events-none absolute border border-border" style={{ left: pkg.rect.x, top: pkg.rect.y, width: pkg.rect.w, height: pkg.rect.h }} />
      {pkg.header ? <div className="absolute flex items-center justify-between gap-2 px-2 text-[12px]" style={{ left: pkg.rect.x, top: pkg.rect.y, width: pkg.rect.w, height: TREEMAP_HEADER }}>
        <span className="truncate font-mono font-medium text-foreground">{pkg.name ?? 'Not on the map'}</span>
        {counted ? <span className="shrink-0 tabular-nums text-muted-foreground">{pkg.additions + pkg.deletions}</span> : null}
      </div> : null}
      {pkg.tiles.map((tile) => {
        const key = tileKey(tile);
        const [first] = tile.files;
        const single = tile.files.length === 1 && first ? first : null;
        const kind = single?.section.kind ?? null;
        const tint = tileTint(tile);
        const others = pkg.tiles.length > 1;
        const name = single ? single.path.slice(single.path.lastIndexOf('/') + 1) : `${tile.files.length} ${others ? 'more' : 'files'}`;
        const where = pkg.name ?? 'files not on the map';
        const label = single
          ? `${single.path}${counted ? `: +${tile.additions} −${tile.deletions}` : ''}. Open section ${single.section.index + 1}, ${single.section.title}`
          : `${tile.files.length} smaller files in ${where}${counted ? `: +${tile.additions} −${tile.deletions}` : ''}. List them`;
        return <button key={key} type="button" data-tile={single ? single.path : 'shared'} data-kind={kind ?? 'shared'} data-files={tile.files.length} aria-label={label}
          aria-pressed={single ? undefined : active === key}
          className={`absolute flex flex-col items-start overflow-hidden rounded-[5px] text-left outline-offset-[-2px] transition-[filter] hover:brightness-95 focus-visible:outline-2 ${tile.rect.h < TIGHT ? 'justify-center px-1.5' : 'justify-between p-1.5'} ${counted ? '' : 'animate-pulse'} ${single ? '' : 'border border-dashed border-border'}`}
          style={{ left: tile.rect.x + 1, top: tile.rect.y + 1, width: Math.max(0, tile.rect.w - 2), height: Math.max(0, tile.rect.h - 2), background: tint, outline: active === key ? `2px solid ${badgeColors.blue}` : undefined }}
          onMouseEnter={() => onActive(tile, false)} onFocus={() => onActive(tile, false)} onMouseLeave={() => onActive(null, false)}
          onClick={() => { if (single) onOpenSection(single.section.id); else onActive(tile, true); }}>
          {tile.rect.w >= NAMED.w && tile.rect.h >= NAMED.h ? <span className="w-full truncate text-[11px] font-medium leading-tight text-foreground">{name}</span> : null}
          {counted && tile.rect.w >= COUNTED.w && tile.rect.h >= COUNTED.h ? <span className="flex w-full items-end justify-between gap-1 text-[11px] text-muted-foreground">
            <Counts change={tile} />{single ? <span className="tabular-nums">§{single.section.index + 1}</span> : null}
          </span> : null}
        </button>;
      })}
    </div>)}
  </div>;
}

/** What the tile under the pointer, or the shared tile pressed, holds; else the totals. */
function TreemapDetail({ tile, files, counted, pending, onOpenSection }: { tile: TreemapTile | null; files: readonly ChangedFile[]; counted: boolean; pending: string; onOpenSection(sectionId: string): void }) {
  if (!counted) return <p className="min-h-9 text-caption text-muted-foreground" aria-live="polite">{pending}</p>;
  if (tile && tile.files.length > 1) return <div className="flex min-h-9 flex-col gap-1 text-caption">
    <span className="text-muted-foreground">{tile.files.length} smaller files · <Counts change={tile} /></span>
    <ul className="flex flex-col gap-0.5">{tile.files.map((file) => <li key={file.path} className="flex flex-wrap items-center gap-x-3">
      <span className="font-mono">{file.path}</span><Counts change={file} /><SectionLink file={file} onOpenSection={onOpenSection} />
    </li>)}</ul>
  </div>;
  const [file] = tile?.files ?? [];
  if (file) return <p className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-caption">
    <span className="font-mono">{file.path}</span><Counts change={file} /><SectionLink file={file} onOpenSection={onOpenSection} />
    {file.test ? <span className="text-muted-foreground">test</span> : null}
  </p>;
  const lines = files.reduce((sum, entry) => sum + entry.additions + entry.deletions, 0);
  const packages = new Set(files.map((entry) => entry.package)).size;
  return <p className="min-h-9 text-caption tabular-nums text-muted-foreground">{lines} line{lines === 1 ? '' : 's'} changed in {files.length} file{files.length === 1 ? '' : 's'} across {packages} package{packages === 1 ? '' : 's'}. Point at a file to see it; press it to read its section.</p>;
}

function SectionLink({ file, onOpenSection }: { file: ChangedFile; onOpenSection(sectionId: string): void }) {
  return <button type="button" className="text-left font-medium text-foreground underline-offset-2 hover:underline" onClick={() => onOpenSection(file.section.id)}>§{file.section.index + 1} {file.section.title}</button>;
}

/** The treemap and what it says about the file pointed at. In place, the treemap opens in the lightbox, which draws it
 * again to fill the screen (`fill`) with its own pointer. */
function TreemapPanel({ files, counted, pending, fill, onOpenSection }: { files: readonly ChangedFile[]; counted: boolean; pending: string; fill: boolean; onOpenSection(sectionId: string): void }) {
  const [hovered, setHovered] = useState<TreemapTile | null>(null);
  const [pinned, setPinned] = useState<TreemapTile | null>(null);
  const canvas = <TreemapCanvas files={files} counted={counted} fill={fill} active={pinned ? tileKey(pinned) : null} onOpenSection={onOpenSection}
    onActive={(tile, pin) => { if (pin) setPinned((current) => current && tile && tileKey(current) === tileKey(tile) ? null : tile); else setHovered(tile); }} />;
  return <div className={`flex flex-col gap-2 ${fill ? 'h-full' : ''}`}>
    {fill ? <div className="min-h-0 flex-1">{canvas}</div> : <Lightbox label="Where it changed" mode="fill"
      expanded={(close) => <TreemapPanel files={files} counted={counted} pending={pending} fill onOpenSection={(id) => { close(); onOpenSection(id); }} />}>{canvas}</Lightbox>}
    <TreemapDetail tile={hovered ?? pinned} files={files} counted={counted} pending={pending} onOpenSection={onOpenSection} />
  </div>;
}

export function ChangeTreemap({ sections, map, changes, measuring, onOpenSection }: {
  sections: readonly ChangeGuideSection[];
  map: ChangeMap | undefined;
  /** The lines each file changes, once the guide's diffs are read. */
  changes: ReadonlyMap<string, FileChange> | null;
  /** Whether the diffs are being read; false when they cannot be. */
  measuring: boolean;
  onOpenSection(sectionId: string): void;
}) {
  const [scope, setScope] = useState<'all' | 'code'>('all');
  const all = useMemo(() => guideFiles(sections, map), [sections, map]);
  const code = useMemo(() => all.filter((file) => !file.test), [all]);
  const scoped: readonly GuideFile[] = scope === 'all' ? all : code;
  const files = useMemo((): ChangedFile[] => changes
    ? scoped.flatMap((file) => { const change = changes.get(file.path); return change ? [{ ...file, ...change }] : []; })
    : scoped.map((file) => ({ ...file, additions: 1, deletions: 0 })), [scoped, changes]);
  const counted = changes !== null;
  const unmeasured = counted ? scoped.length - files.length : 0;
  const pending = measuring ? `Reading the diffs of ${scoped.length} file${scoped.length === 1 ? '' : 's'} to measure their changed lines…` : 'The changed lines are measured from the diffs while the workspace can serve them.';
  const kinds = KINDS.filter((kind) => scoped.some((file) => file.section.kind === kind));
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TabsSubtle size="compact" selectedIndex={scope === 'all' ? 0 : 1} onSelect={(index) => setScope(index === 0 ? 'all' : 'code')} idPrefix="change-treemap-scope" aria-label="Files shown">
        <TabsSubtleItem index={0} label={`All changed files · ${all.length}`} />
        <TabsSubtleItem index={1} label={`Production code · ${code.length}`} />
      </TabsSubtle>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        {kinds.map((kind) => <span key={kind} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: SECTION_KIND[kind].color }} />{SECTION_KIND[kind].label}</span>)}
        {scope === 'all' && all.length !== code.length ? <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-border bg-surface-3" />paler: tests</span> : null}
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-dashed border-border bg-surface-3" />several small files</span>
        <Source by="gitspace" what="the size of each file: the lines its diff changes; its colour: the kind of the first section that shows it" />
      </span>
    </div>
    {files.length ? <TreemapPanel files={files} counted={counted} pending={pending} fill={false} onOpenSection={onOpenSection} />
      : <p className="text-caption text-muted-foreground">{counted ? 'No file here changes any lines.' : pending}</p>}
    {unmeasured > 0 ? <p className="text-caption text-muted-foreground">{unmeasured} file{unmeasured === 1 ? '' : 's'} not drawn: {unmeasured === 1 ? 'its diff has' : 'their diffs have'} no line counts (binary, or not read).</p> : null}
  </div>;
}
