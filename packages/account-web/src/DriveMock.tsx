// Throwaway design mock: the Inspector's Drive tab as a folder browser with a name filter. Folders open in place with
// breadcrumbs; a browser capture (its image, thumbnail and record) is one item; the filter matches names and paths
// across the drive; selected files are downloaded, copied to the project, or deleted; a file opens as an Inspector
// document tab with Preview and Source. Only a space's own drive is writable from it: the project drive is read-only
// from a workspace, a workspace's from the project page.
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger,
  IconProvider, InputField, InputGroup, MenuItem, Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, SizeProvider, TabsSubtle,
  TabsSubtleItem, Tooltip, TooltipProvider, untitledIcons, useShape,
} from '@gitspace/ui';
import {
  Camera01, ChevronRight, Copy01, DotsVertical, Download01, File02, FileCode02, Folder, Grid01, Image01, List, MessagePlusSquare, MusicNote01,
  SearchMd, Share07, Trash01, Upload01, VideoRecorder, XClose,
} from '@untitledui/icons';
import { StrictMode, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { EmptyState } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

interface DriveFile { path: string; size: number; mediaType: string; added: string | null }
interface Capture { folder: string; title: string; browser: string; added: string; size: number }
type Item =
  | { kind: 'folder'; path: string; name: string; count: number }
  | { kind: 'capture'; path: string; name: string; capture: Capture }
  | { kind: 'file'; path: string; name: string; file: DriveFile };
type Page = 'workspace' | 'project';
type Kind = 'all' | 'images' | 'captures' | 'documents' | 'media' | 'other';
type Sort = 'name' | 'size' | 'added';
type CaptureRow = [id: string, title: string, browser: string, added: string];
/** A file or capture open as an Inspector document tab. */
interface OpenDocument { id: string; item: Exclude<Item, { kind: 'folder' }>; root: string; address: string; writable: boolean }

const CAPTURES = 'browser/captures';
const captureFiles = (rows: readonly CaptureRow[]): DriveFile[] => rows.flatMap(([id, , , added]) => [
  { path: `${CAPTURES}/${id}/image.jpg`, size: 104_000 + id.length * 911, mediaType: 'image/jpeg', added },
  { path: `${CAPTURES}/${id}/thumbnail.jpg`, size: 18_200, mediaType: 'image/jpeg', added },
  { path: `${CAPTURES}/${id}/capture.json`, size: 1_400, mediaType: 'application/json', added },
]);
const PROJECT_CAPTURES: CaptureRow[] = [
  ['bb28688f', 'Option A – Control tab', 'Cloud browser', '2 h ago'],
  ['f223c958', 'Option A – Scenarios tab', 'Cloud browser', '2 h ago'],
  ['b42f3170', 'DocuSign · step 11', 'Chrome · Studio desktop', 'yesterday'],
  ['d85bd456', 'Upload with your phone', 'Chrome · Studio desktop', 'yesterday'],
  ['4e0755ae', 'Remote and demo side by side', 'Cloud browser', '3 days ago'],
  ['5dc9009d', 'Golconda demo – landing', 'Cloud browser', '3 days ago'],
];
const WORKSPACE_CAPTURES: CaptureRow[] = [
  ['a1c09e77', 'Lockout after 3 attempts', 'Cloud browser', '20 min ago'],
  ['c7d2e011', 'Verification settings', 'Cloud browser', '25 min ago'],
];
const DRIVES: Record<string, { label: string; files: DriveFile[]; captures: CaptureRow[] }> = {
  project: {
    label: 'Project drive',
    captures: PROJECT_CAPTURES,
    files: [
      ...captureFiles(PROJECT_CAPTURES),
      { path: 'browser/downloads/2026-11-01/enrollment-export.csv', size: 48_200, mediaType: 'text/csv', added: 'yesterday' },
      { path: 'browser/downloads/2026-11-01/Signed agreement.pdf', size: 612_000, mediaType: 'application/pdf', added: 'yesterday' },
      { path: 'browser/debug/7f1e2a90.cpuprofile', size: 2_310_000, mediaType: 'application/json', added: '3 days ago' },
      { path: 'plans/remote-control-ux.md', size: 9_800, mediaType: 'text/markdown', added: '2 h ago' },
      { path: 'plans/enrollment-flow.md', size: 14_100, mediaType: 'text/markdown', added: null },
      { path: 'uploads/brand-guidelines.pdf', size: 3_400_000, mediaType: 'application/pdf', added: null },
      { path: 'uploads/golconda-logo.svg', size: 6_100, mediaType: 'image/svg+xml', added: null },
      { path: 'uploads/walkthrough.mp4', size: 48_000_000, mediaType: 'video/mp4', added: '4 days ago' },
      { path: 'reference.txt', size: 824, mediaType: 'text/plain', added: null },
    ],
  },
  'remote-control-ux': {
    label: 'remote-control-ux',
    captures: WORKSPACE_CAPTURES,
    files: [
      ...captureFiles(WORKSPACE_CAPTURES),
      { path: 'uploads/call-notes.m4a', size: 5_600_000, mediaType: 'audio/mp4', added: '1 h ago' },
      { path: 'uploads/spec-comments.pdf', size: 920_000, mediaType: 'application/pdf', added: '1 h ago' },
      { path: 'report/lockout-review.md', size: 4_200, mediaType: 'text/markdown', added: '15 min ago' },
    ],
  },
  'docusign-flow': {
    label: 'docusign-flow',
    captures: [],
    files: [{ path: 'notes/envelope-fields.md', size: 2_900, mediaType: 'text/markdown', added: 'yesterday' }],
  },
};
const MARKDOWN = '# Remote control UX\n\nTwo windows: the demo tab and a remote.\n\n- **Control:** fill buttons for the current screen\n- **Scenarios:** one button per applicant choice\n- **Design:** alternate skins\n\nAttempts before lockout default to 3.';

const FolderGlyph = glyph(Folder);
const DownloadGlyph = glyph(Download01);
const TrashGlyph = glyph(Trash01);
const CopyGlyph = glyph(Copy01);
const ShareGlyph = glyph(Share07);
const ChatGlyph = glyph(MessagePlusSquare);
const SearchGlyph = glyph(SearchMd);
const OpenGlyph = glyph(ChevronRight);

const KINDS: readonly { id: Kind; label: string }[] = [
  { id: 'all', label: 'All types' }, { id: 'images', label: 'Images' }, { id: 'captures', label: 'Captures' },
  { id: 'documents', label: 'Documents' }, { id: 'media', label: 'Audio & video' }, { id: 'other', label: 'Other' },
];
const SORTS: readonly { id: Sort; label: string }[] = [{ id: 'name', label: 'Name' }, { id: 'added', label: 'Recently added' }, { id: 'size', label: 'Size' }];
const PERMANENT_TABS = ['Overview', 'Environment', 'Browser', 'Goal', 'Agent setup', 'Files', 'Drive', 'Services'];
const DRIVE_TAB = PERMANENT_TABS.indexOf('Drive');

function bytes(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function kindOf(item: Item): Kind {
  if (item.kind === 'capture') return 'captures';
  if (item.kind === 'folder') return 'all';
  const type = item.file.mediaType;
  if (type.startsWith('image/')) return 'images';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (type.startsWith('text/') || type === 'application/pdf' || type === 'application/json') return 'documents';
  return 'other';
}
function FileIcon({ item, size = 16 }: { item: Item; size?: number }) {
  const props = { width: size, height: size, strokeWidth: 1.5, className: 'shrink-0 text-muted-foreground' };
  if (item.kind === 'folder') return <Folder {...props} />;
  if (item.kind === 'capture') return <Camera01 {...props} />;
  const type = item.file.mediaType;
  if (type.startsWith('image/')) return <Image01 {...props} />;
  if (type.startsWith('video/')) return <VideoRecorder {...props} />;
  if (type.startsWith('audio/')) return <MusicNote01 {...props} />;
  if (type === 'application/json' || type === 'text/markdown') return <FileCode02 {...props} />;
  return <File02 {...props} />;
}
function captureFolders(files: readonly DriveFile[], rows: readonly CaptureRow[]): Map<string, Capture> {
  return new Map(rows.filter(([id]) => files.some(file => file.path.startsWith(`${CAPTURES}/${id}/`))).map(([id, title, browser, added]) => {
    const folder = `${CAPTURES}/${id}`;
    return [folder, { folder, title, browser, added, size: files.find(file => file.path === `${folder}/image.jpg`)?.size ?? 0 }];
  }));
}
/** What a folder holds: its subfolders (with how many items each holds, a capture counted once) and files, a capture
 * folder as one capture. */
function listFolder(files: readonly DriveFile[], folders: Map<string, Capture>, folder: string): Item[] {
  const prefix = folder ? `${folder}/` : '';
  const items = new Map<string, Item>();
  const units = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const [head, ...tail] = file.path.slice(prefix.length).split('/');
    if (!head) continue;
    const path = `${prefix}${head}`;
    const capture = folders.get(path);
    if (capture) items.set(path, { kind: 'capture', path, name: capture.title, capture });
    else if (tail.length) {
      const unit = [...folders.keys()].find(captured => file.path.startsWith(`${captured}/`)) ?? file.path;
      const held = units.get(path) ?? new Set<string>();
      held.add(unit);
      units.set(path, held);
      items.set(path, { kind: 'folder', path, name: head, count: held.size });
    } else items.set(path, { kind: 'file', path, name: head, file });
  }
  return [...items.values()];
}
/** Every capture and every file outside a capture folder whose name or path holds the filter. */
function filterDrive(files: readonly DriveFile[], folders: Map<string, Capture>, query: string): Item[] {
  const needle = query.toLowerCase();
  const items: Item[] = [...folders.values()].filter(capture => capture.title.toLowerCase().includes(needle) || capture.folder.includes(needle))
    .map(capture => ({ kind: 'capture', path: capture.folder, name: capture.title, capture }));
  for (const file of files) {
    if ([...folders.keys()].some(folder => file.path.startsWith(`${folder}/`))) continue;
    if (file.path.toLowerCase().includes(needle)) items.push({ kind: 'file', path: file.path, name: file.path.split('/').at(-1) ?? file.path, file });
  }
  return items;
}
function added(item: Item): string | null {
  return item.kind === 'file' ? item.file.added : item.kind === 'capture' ? item.capture.added : null;
}
function size(item: Item): number {
  return item.kind === 'file' ? item.file.size : item.kind === 'capture' ? item.capture.size : 0;
}
const AGE: Record<string, number> = { 'just now': 0, '15 min ago': 1, '20 min ago': 2, '25 min ago': 3, '1 h ago': 4, '2 h ago': 5, yesterday: 6, '3 days ago': 7, '4 days ago': 8 };
function sorted(items: Item[], sort: Sort): Item[] {
  const folders = items.filter(item => item.kind === 'folder').sort((left, right) => left.name.localeCompare(right.name));
  const rest = items.filter(item => item.kind !== 'folder').sort((left, right) => {
    if (sort === 'size') return size(right) - size(left);
    if (sort === 'added') return (AGE[added(left) ?? ''] ?? 99) - (AGE[added(right) ?? ''] ?? 99);
    return left.name.localeCompare(right.name);
  });
  return [...folders, ...rest];
}
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-[#fde68a] text-inherit">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}
function Thumb({ item, height }: { item: Item; height: number }) {
  const shape = useShape();
  const hue = [220, 150, 275][item.path.length % 3] ?? 220;
  const visual = item.kind === 'capture' || (item.kind === 'file' && item.file.mediaType.startsWith('image/'));
  return <div className={`flex w-full items-center justify-center ${shape.container} ${visual ? '' : 'bg-surface-1'}`} style={{ height, ...(visual ? { background: `linear-gradient(135deg, hsl(${hue} 70% 85%), hsl(${hue + 30} 60% 92%))` } : {}) }}><FileIcon item={item} size={height > 120 ? 28 : 22} /></div>;
}

function RowMenu({ item, writable, onOpen, onDelete }: { item: Item; writable: boolean; onOpen(): void; onDelete(): void }) {
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="ghost" size="icon-compact" aria-label={`Actions for ${item.name}`} onClick={event => event.stopPropagation()}><DotsVertical width={16} height={16} strokeWidth={1.5} /></Button>} />
    <DropdownContent className="w-[220px]" align="end" sideOffset={4}>
      <MenuItem index={index++} icon={OpenGlyph} label="Open" onSelect={onOpen} />
      <MenuItem index={index++} icon={ChatGlyph} label="Insert in chat" onSelect={() => undefined} />
      <MenuItem index={index++} icon={CopyGlyph} label="Copy address" onSelect={() => undefined} />
      <MenuItem index={index++} icon={DownloadGlyph} label="Download" onSelect={() => undefined} />
      <MenuItem index={index++} icon={ShareGlyph} label="Share link…" onSelect={() => undefined} />
      {writable ? <MenuItem index={index++} icon={TrashGlyph} label="Delete…" onSelect={onDelete} /> : null}
    </DropdownContent>
  </DropdownMenu>;
}

/** Drop files here or browse for them; they go to the open folder. Large while the drive is empty, a strip otherwise. */
function Dropzone({ target, dragging, empty, onFiles }: { target: string; dragging: boolean; empty: boolean; onFiles(names: string[]): void }) {
  const shape = useShape();
  const input = useRef<HTMLInputElement>(null);
  return <button type="button" onClick={() => input.current?.click()}
    className={`flex w-full items-center justify-center gap-2 border border-dashed text-caption transition-colors ${shape.container} ${empty ? 'flex-col py-10' : 'py-2.5'} ${dragging ? 'border-[#6B97FF] bg-[#6B97FF]/10 text-foreground' : 'border-border text-muted-foreground hover:bg-surface-1'}`}>
    <Upload01 width={empty ? 22 : 14} height={empty ? 22 : 14} strokeWidth={1.5} />
    <span>{dragging ? `Drop to upload to ${target}` : <>Drop files here or <span className="text-foreground underline">browse</span> · they go to <span className="font-mono">{target}</span></>}</span>
    {empty && !dragging ? <span>Up to 5 GiB each. Agents save browser captures, downloads and files they write here too.</span> : null}
    <input ref={input} type="file" multiple hidden onChange={event => { onFiles([...(event.target.files ?? [])].map(file => file.name)); event.target.value = ''; }} />
  </button>;
}

function DriveTab({ page, files, notice, onDismissNotice, onUpload, onOpen, onDelete }: {
  page: Page;
  files: Readonly<Record<string, DriveFile[]>>;
  notice: string | null;
  onDismissNotice(): void;
  onUpload(root: string, folder: string, names: string[]): void;
  onOpen(document: OpenDocument): void;
  onDelete(root: string, paths: readonly string[]): void;
}) {
  const shape = useShape();
  const own = page === 'project' ? 'project' : 'remote-control-ux';
  const roots = page === 'project' ? ['project', 'remote-control-ux', 'docusign-flow'] : ['remote-control-ux', 'project'];
  const [root, setRoot] = useState(own);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const writable = root === own;
  const mount = root === 'project' ? 'base' : root === own ? 'workspace' : `workspaces/${root}`;
  const drive = files[root] ?? [];
  const label = DRIVES[root]?.label ?? root;
  const folders = useMemo(() => captureFolders(drive, DRIVES[root]?.captures ?? []), [drive, root]);
  const items = useMemo(() => {
    const listed = query ? filterDrive(drive, folders, query) : listFolder(drive, folders, folder);
    return sorted(listed.filter(item => kind === 'all' || (item.kind === 'folder' && !query) || kindOf(item) === kind), sort);
  }, [drive, folders, folder, query, kind, sort]);
  const switchRoot = (next: string) => { setRoot(next); setFolder(''); setSelected(new Set()); setQuery(''); };
  const toggle = (path: string) => setSelected(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const open = (item: Item) => {
    if (item.kind === 'folder') { setFolder(item.path); setSelected(new Set()); return; }
    onOpen({ id: `${root}:${item.path}`, item, root, writable, address: `drive://${mount}/${item.kind === 'capture' ? `${item.path}/image.jpg` : item.path}` });
  };
  const remove = (paths: readonly string[]) => { onDelete(root, paths); setSelected(new Set()); };
  const crumbs = folder ? folder.split('/') : [];
  const target = folder ? `${folder}/` : `${label}/`;
  return <div
    className="relative flex min-h-0 flex-1 flex-col"
    onDragOver={writable ? (event) => { event.preventDefault(); setDragging(true); } : undefined}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }}
    onDrop={writable ? (event) => { event.preventDefault(); setDragging(false); onUpload(root, folder, [...event.dataTransfer.files].map(file => file.name)); } : undefined}
  >
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-2">
      <div className="flex items-center gap-2">
        <TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={roots.indexOf(root)} onSelect={index => switchRoot(roots[index] ?? own)} idPrefix="drive-root" aria-label="Drive">
          {roots.map((id, index) => <TabsSubtleItem key={id} index={index} label={id === own ? (page === 'project' ? 'Project drive' : 'This workspace') : DRIVES[id]?.label ?? id} />)}
        </TabsSubtle>
        {writable ? null : <Tooltip content={page === 'project' ? 'A workspace’s drive is changed from that workspace' : 'The project drive is changed from the project page'} side="bottom"><span><Badge size="compact" color="gray">Read only</Badge></span></Tooltip>}
      </div>
      <div className="flex items-center gap-2">
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Filter by name" labelHidden placeholder={`Filter ${label} by name or path`} icon={SearchGlyph} value={query} onChange={value => { setQuery(value); setSelected(new Set()); }} /></InputGroup>
        <div className="w-36"><Select size="compact" value={kind} onValueChange={value => setKind(KINDS.find(option => option.id === value)?.id ?? 'all')}><SelectTrigger aria-label="Type" /><SelectContent>{KINDS.map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="flex min-h-8 items-center gap-1 text-caption">
        {query ? <span className="text-muted-foreground">{items.length} {items.length === 1 ? 'match' : 'matches'} in {label} <Button variant="ghost" size="compact" onClick={() => setQuery('')}>Clear</Button></span> : <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          <Button variant="ghost" size="compact" onClick={() => setFolder('')}>{label}</Button>
          {crumbs.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-0.5"><ChevronRight width={12} height={12} className="text-muted-foreground" /><Button variant="ghost" size="compact" onClick={() => setFolder(crumbs.slice(0, index + 1).join('/'))}>{part}</Button></span>)}
        </nav>}
        <span className="ml-auto flex items-center gap-1">
          <div className="w-36"><Select size="compact" value={sort} onValueChange={value => setSort(SORTS.find(option => option.id === value)?.id ?? 'name')}><SelectTrigger aria-label="Sort" /><SelectContent>{SORTS.map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}</SelectContent></Select></div>
          <Tooltip content="List" side="bottom"><Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon-compact" aria-pressed={view === 'list'} aria-label="List view" onClick={() => setView('list')}><List width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
          <Tooltip content="Thumbnails" side="bottom"><Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon-compact" aria-pressed={view === 'grid'} aria-label="Thumbnail view" onClick={() => setView('grid')}><Grid01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        </span>
      </div>
      {selected.size ? <div className={`flex flex-wrap items-center gap-1 bg-surface-1 px-2 py-1 ${shape.container}`}>
        <span className="px-1 text-caption font-medium tabular-nums">{selected.size} selected</span>
        <Button variant="ghost" size="compact" leadingIcon={DownloadGlyph}>Download</Button>
        {page === 'workspace' && writable ? <Button variant="ghost" size="compact" leadingIcon={FolderGlyph}>Copy to project</Button> : null}
        <Button variant="ghost" size="compact" leadingIcon={CopyGlyph}>Copy addresses</Button>
        {writable ? <Button variant="ghost" size="compact" leadingIcon={TrashGlyph} onClick={() => remove([...selected])}>Delete</Button> : null}
        <Button variant="ghost" size="icon-compact" className="ml-auto" aria-label="Clear selection" onClick={() => setSelected(new Set())}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
      </div> : null}
      {notice ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><span className="min-w-0 flex-1 truncate">{notice}</span><Button variant="ghost" size="icon-compact" aria-label="Dismiss" onClick={onDismissNotice}><XClose width={14} height={14} strokeWidth={1.5} /></Button></div> : null}
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-6">
      {writable && !query ? <Dropzone target={target} dragging={dragging} empty={!drive.length} onFiles={names => onUpload(root, folder, names)} /> : null}
      {!drive.length ? (writable ? null : <EmptyState icon={<Folder width={22} height={22} strokeWidth={1.5} />} title="Nothing in this drive yet" description="Files appear here once that space saves some." />)
        : !items.length ? <EmptyState icon={<SearchMd width={22} height={22} strokeWidth={1.5} />} title={query ? `Nothing named “${query}”` : 'No files of this type here'} description={query ? 'The filter matches file and folder names and capture titles, not what is inside files.' : 'Choose All types, or open another folder.'} />
        : view === 'list' ? <ul className="flex flex-col" aria-label="Files">
          {items.map(item => <li key={item.path} className={`flex min-h-11 items-center gap-2 border-b border-border px-1 ${selected.has(item.path) ? 'bg-surface-1' : 'hover:bg-surface-1'}`}>
            {item.kind === 'folder' ? <span className="w-4 shrink-0" /> : <input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.path)} onChange={() => toggle(item.path)} className="size-4 shrink-0 accent-[#6B97FF]" />}
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" onClick={() => open(item)}>
              <FileIcon item={item} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body"><Highlight text={item.name} query={query} /></span>
                {query ? <span className="truncate font-mono text-caption text-muted-foreground"><Highlight text={item.path} query={query} /></span>
                  : item.kind === 'capture' ? <span className="truncate text-caption text-muted-foreground">{item.capture.browser}</span> : null}
              </span>
            </button>
            <span className="w-20 shrink-0 text-left text-caption tabular-nums text-muted-foreground">{item.kind === 'folder' ? `${item.count} ${item.count === 1 ? 'item' : 'items'}` : bytes(size(item))}</span>
            <span className="hidden w-20 shrink-0 text-left text-caption text-muted-foreground sm:block">{item.kind === 'folder' ? '' : added(item) ?? '—'}</span>
            {item.kind === 'folder' ? <span className="flex size-8 shrink-0 items-center justify-center"><ChevronRight width={16} height={16} strokeWidth={1.5} className="text-muted-foreground" /></span> : <RowMenu item={item} writable={writable} onOpen={() => open(item)} onDelete={() => remove([item.path])} />}
          </li>)}
        </ul>
        : <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }} aria-label="Files">
          {items.map(item => <div key={item.path} className={`relative flex flex-col gap-1.5 border p-2 ${shape.container} ${selected.has(item.path) ? 'border-[#6B97FF]' : 'border-border'}`}>
            <button type="button" className="flex flex-col gap-1.5 text-left" onClick={() => open(item)}>
              <Thumb item={item} height={96} />
              <span className="truncate text-caption font-medium"><Highlight text={item.name} query={query} /></span>
              <span className="truncate text-caption tabular-nums text-muted-foreground">{item.kind === 'folder' ? `${item.count} ${item.count === 1 ? 'item' : 'items'}` : item.kind === 'capture' ? `${item.capture.browser.replace('Chrome · ', '')} · ${item.capture.added}` : bytes(size(item))}</span>
            </button>
            {item.kind === 'folder' ? null : <input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.path)} onChange={() => toggle(item.path)} className="absolute left-3 top-3 size-4 accent-[#6B97FF]" />}
          </div>)}
        </div>}
    </div>
    {dragging ? <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-[#6B97FF] bg-surface-2/80 text-body">Drop to upload to {target}</div> : null}
  </div>;
}

/** An open drive file as an Inspector document: its name and address, its actions, Preview or Source. */
function DocumentTab({ document, onShowInDrive, onDelete }: { document: OpenDocument; onShowInDrive(): void; onDelete(): void }) {
  const shape = useShape();
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const { item } = document;
  const mediaType = item.kind === 'file' ? item.file.mediaType : 'image/jpeg';
  const textual = mediaType.startsWith('text/') || mediaType === 'application/json';
  const source = item.kind === 'capture'
    ? JSON.stringify({ version: 2, captureId: item.path.split('/').at(-1), name: item.name, by: 'agent', browser: item.capture.browser, page: { url: 'https://demo--golconda-ppva-enro-170ed69a.gssh.dev/', title: 'Golconda PPVA demo' }, tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, null, 2)
    : mediaType === 'text/markdown' ? MARKDOWN : textual ? 'quarter,total\nq3,42\nq4,57\n' : null;
  const action = (label: string, icon: ReactNode, onClick?: () => void) => <Tooltip content={label} side="bottom"><Button variant="ghost" size="icon-compact" aria-label={label} onClick={onClick}>{icon}</Button></Tooltip>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
      <div className="flex min-w-0 flex-col">
        <strong className="truncate text-body font-medium text-foreground">{item.name}</strong>
        <span className="truncate font-mono text-caption text-muted-foreground">{document.address} · {bytes(size(item))}{item.kind === 'capture' ? ` · ${item.capture.browser}` : ''}</span>
      </div>
      <div className="flex shrink-0 items-center">
        {action('Show in Drive', <Folder width={16} height={16} strokeWidth={1.5} />, onShowInDrive)}
        {action('Insert in chat', <MessagePlusSquare width={16} height={16} strokeWidth={1.5} />)}
        {action('Copy address', <Copy01 width={16} height={16} strokeWidth={1.5} />)}
        {action('Download', <Download01 width={16} height={16} strokeWidth={1.5} />)}
        {action('Share link', <Share07 width={16} height={16} strokeWidth={1.5} />)}
        {document.writable ? action('Delete', <Trash01 width={16} height={16} strokeWidth={1.5} />, onDelete) : null}
      </div>
    </header>
    <div className="flex items-center gap-2 px-4 pb-2">
      <span className="text-caption font-medium uppercase tracking-wide text-muted-foreground">View</span>
      <TabsSubtle size="compact" selectedIndex={mode === 'preview' ? 0 : 1} onSelect={index => setMode(index === 0 ? 'preview' : 'source')} idPrefix={`doc-${document.id}`} aria-label="Artifact view mode">
        <TabsSubtleItem index={0} label="preview" /><TabsSubtleItem index={1} label="source" />
      </TabsSubtle>
    </div>
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      {mode === 'source'
        ? source !== null ? <pre className="min-h-0 flex-1 overflow-auto bg-surface-1 p-4 font-mono text-caption">{source}</pre>
          : <div className="flex flex-1 items-center justify-center p-6"><EmptyState icon={<File02 width={22} height={22} strokeWidth={1.5} />} title="Source is unavailable" description="This binary file has no text source." /></div>
        : mediaType.startsWith('image/') ? <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-3 p-4"><div className={`w-full max-w-[560px] shadow-surface-1 ${shape.container}`}><Thumb item={item} height={315} /></div></div>
        : mediaType === 'text/markdown' ? <article className="min-h-0 flex-1 overflow-auto p-5 text-body"><h1 className="mb-3 text-title font-semibold">Remote control UX</h1><p className="mb-2">Two windows: the demo tab and a remote.</p><ul className="mb-2 list-disc pl-5"><li><strong>Control:</strong> fill buttons for the current screen</li><li><strong>Scenarios:</strong> one button per applicant choice</li><li><strong>Design:</strong> alternate skins</li></ul><p>Attempts before lockout default to 3.</p></article>
        : mediaType.startsWith('video/') || mediaType.startsWith('audio/') ? <div className="flex flex-1 items-center justify-center bg-surface-3 p-4 text-caption text-muted-foreground">{mediaType.startsWith('video/') ? 'Video player' : 'Audio player'}</div>
        : source !== null ? <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-caption">{source}</pre>
        : <div className="flex flex-1 items-center justify-center bg-surface-3 p-4 text-caption text-muted-foreground">PDF viewer</div>}
    </div>
  </div>;
}

function InspectorPanel({ page, empty }: { page: Page; empty: boolean }) {
  const own = page === 'project' ? 'project' : 'remote-control-ux';
  const [files, setFiles] = useState<Record<string, DriveFile[]>>(() => Object.fromEntries(Object.entries(DRIVES).map(([id, drive]) => [id, empty && id === own ? [] : drive.files])));
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ root: string; paths: readonly string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openDocument = (document: OpenDocument) => {
    setDocuments(current => current.some(candidate => candidate.id === document.id) ? current : [...current, document]);
    setActive(document.id);
  };
  const closeDocument = (id: string) => {
    const next = documents.filter(document => document.id !== id);
    setDocuments(next);
    if (active === id) setActive(next.at(-1)?.id ?? null);
  };
  const upload = (root: string, folder: string, names: string[]) => {
    const added = names.map(name => ({ path: folder ? `${folder}/${name}` : name, size: 212_000, mediaType: name.endsWith('.png') || name.endsWith('.jpg') ? 'image/png' : 'text/plain', added: 'just now' }));
    setFiles(current => ({ ...current, [root]: [...(current[root] ?? []).filter(file => !added.some(next => next.path === file.path)), ...added] }));
    setNotice(`Uploaded ${names.length === 1 ? names[0] : `${names.length} files`} to ${folder ? `${folder}/` : DRIVES[root]?.label}`);
  };
  const remove = () => {
    if (!deleting) return;
    const { root, paths } = deleting;
    setFiles(current => ({ ...current, [root]: (current[root] ?? []).filter(file => !paths.some(path => file.path === path || file.path.startsWith(`${path}/`))) }));
    const gone = documents.filter(document => document.root === root && paths.includes(document.item.path)).map(document => document.id);
    const next = documents.filter(document => !gone.includes(document.id));
    setDocuments(next);
    if (active && gone.includes(active)) setActive(null);
    setNotice(`Deleted ${paths.length} ${paths.length === 1 ? 'item' : 'items'} from ${DRIVES[root]?.label}.`);
    setDeleting(null);
  };
  const activeDocument = documents.find(document => document.id === active) ?? null;
  const deletingCount = deleting?.paths.length ?? 0;
  const deletingCapture = deleting?.paths.some(path => path.startsWith(`${CAPTURES}/`)) ?? false;
  return <div className="flex w-full min-w-0 flex-col bg-surface-2 lg:w-[640px]">
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
      <TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={activeDocument ? -1 : DRIVE_TAB} onSelect={index => { if (index === DRIVE_TAB) setActive(null); }} idPrefix="mock-inspector" aria-label="Inspector views">
        {PERMANENT_TABS.map((label, index) => <TabsSubtleItem index={index} label={label} key={label} />)}
      </TabsSubtle>
    </div>
    {documents.length ? <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1">
      <span className="px-1 text-caption font-medium uppercase tracking-wide text-muted-foreground">Open</span>
      {documents.map(document => <span className="flex shrink-0 items-center" key={document.id}>
        <Button variant="ghost" size="compact" active={active === document.id} onClick={() => setActive(document.id)}><FileIcon item={document.item} size={14} /><span className="max-w-40 truncate">{document.item.name}</span></Button>
        <Button variant="ghost" size="icon-compact" aria-label={`Close ${document.item.name}`} onClick={() => closeDocument(document.id)}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
      </span>)}
    </div> : null}
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className={activeDocument ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <DriveTab page={page} files={files} notice={notice} onDismissNotice={() => setNotice(null)} onUpload={upload} onOpen={openDocument} onDelete={(root, paths) => setDeleting({ root, paths })} />
      </div>
      {activeDocument ? <DocumentTab key={activeDocument.id} document={activeDocument} onShowInDrive={() => setActive(null)} onDelete={() => setDeleting({ root: activeDocument.root, paths: [activeDocument.item.path] })} /> : null}
    </div>
    <Dialog open={deleting !== null} onOpenChange={next => { if (!next) setDeleting(null); }}><DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Delete {deletingCount === 1 ? `“${deleting?.paths[0]?.split('/').at(-1)}”` : `${deletingCount} items`}?</DialogTitle>
        <DialogDescription>They leave {deleting ? DRIVES[deleting.root]?.label : 'the drive'} now. Links to them in conversations stop opening, and agents can no longer read them. This cannot be undone.</DialogDescription>
      </DialogHeader>
      {deletingCapture ? <p className="text-caption text-muted-foreground">A capture is deleted with its image, thumbnail and record.</p> : null}
      <DialogFooter><Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="primary" onClick={remove}>Delete</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

function Note({ children }: { children: ReactNode }) {
  return <li className="text-caption text-muted-foreground">{children}</li>;
}

function DriveMock() {
  const params = new URLSearchParams(location.search);
  const [page, setPage] = useState<Page>(params.get('page') === 'project' ? 'project' : 'workspace');
  const [empty, setEmpty] = useState(params.get('state') === 'empty');
  return <div className="flex h-dvh flex-col bg-background">
    <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border bg-surface-1 px-6 py-3">
      <Folder width={18} height={18} /><span className="text-body font-semibold">Drive · Inspector mock</span>
      <TabsSubtle selectedIndex={page === 'workspace' ? 0 : 1} onSelect={index => setPage(index === 0 ? 'workspace' : 'project')} idPrefix="mock-page" aria-label="Page">
        <TabsSubtleItem index={0} label="Workspace page" /><TabsSubtleItem index={1} label="Project page" />
      </TabsSubtle>
      <TabsSubtle selectedIndex={empty ? 1 : 0} onSelect={index => setEmpty(index === 1)} idPrefix="mock-state" aria-label="State">
        <TabsSubtleItem index={0} label="With files" /><TabsSubtleItem index={1} label="Empty drive" />
      </TabsSubtle>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="hidden min-w-0 flex-1 flex-col gap-3 border-r border-border p-6 lg:flex">
        <span className="text-caption text-muted-foreground">{page === 'project' ? 'Golconda PPVA Enrollment · project agent' : 'Golconda PPVA Enrollment / remote-control-ux · workspace agent'}</span>
        <div className="max-w-xl rounded-xl bg-surface-2 p-3 text-body">Here are both options side by side. Option A puts the fill buttons on the Control tab… <span className="text-[#6B97FF] underline">Option A – Control tab</span></div>
        <ul className="mt-4 flex max-w-xl list-disc flex-col gap-1.5 pl-5">
          <Note>The filter matches names, paths and capture titles across the whole drive, as you type; it does not search inside files.</Note>
          <Note>Folders open in place; a browser capture is one item (its image, thumbnail and record), titled by the capture.</Note>
          <Note>Only this space’s own drive is changed here: on a workspace page the project drive is read only (Copy to project moves files there); on the project page, each workspace’s drive is.</Note>
          <Note>The dropzone at the top of the folder uploads to that folder; drop anywhere on the panel, or click it to browse.</Note>
          <Note>A file opens as an Inspector document tab, as today: Preview or Source, with its actions in the header; Show in Drive goes back to its folder.</Note>
          <Note>Delete asks first; a deleted capture takes its three files.</Note>
          <Note>“Recently added” needs a time recorded with each file; files saved before that show “—”.</Note>
        </ul>
      </div>
      <InspectorPanel key={`${page}-${empty}`} page={page} empty={empty} />
    </div>
  </div>;
}

restoreAppearance();
const container = document.getElementById('root');
if (!container) throw new Error('root missing');
// Hot updates re-run this module; keep the one React root.
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<StrictMode><ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider><DriveMock /></TooltipProvider></IconProvider></SizeProvider></ShapeProvider></StrictMode>);
