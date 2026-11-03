import type { EvidenceReference } from '@gitspace/protocol';
import type { InspectorView } from '@gitspace/protocol/rpc-contract';
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger,
  InputField, InputGroup, MenuItem, Select, SelectContent, SelectItem, SelectTrigger, TabsSubtle, TabsSubtleItem, Tooltip, useShape,
} from '@gitspace/ui';
import {
  Camera01, ChevronRight, Copy01, DotsVertical, Download01, File02, FileCode02, Folder, Grid01, Image01, List, MusicNote01, SearchMd, Trash01,
  Upload01, VideoRecorder, XClose,
} from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { ArtifactActions, type ArtifactActionsHandlers } from './ArtifactActions.js';
import { ArtifactUploadList, type ArtifactUploads } from './ArtifactUploads.js';
import { DRIVE_FILE_MAX_BYTES } from '@gitspace/protocol';
import { formatBytes } from './artifact-upload.js';

type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;
export type DriveFileView = InspectorView['artifacts'][number];

/** The drives a space sees and the one it writes: a workspace writes its own and reads the project's; the project
 * page writes the project drive. */
export interface InspectorDrive {
  files: readonly DriveFileView[];
  own: 'base' | 'workspace';
  /** Names of the writable drive's captures by id, when its session listed them. */
  captures: ReadonlyMap<string, { name: string; browser: string | null }>;
  remove(urls: readonly string[]): Promise<void>;
}

const CAPTURES = 'browser/captures/';
type Kind = 'all' | 'images' | 'captures' | 'documents' | 'media' | 'other';
type Sort = 'name' | 'added' | 'size';
interface Capture { folder: string; name: string; detail: string; files: readonly DriveFileView[]; primary: DriveFileView | null; thumbnail: DriveFileView | null; writtenAt: string | null; size: number }
type Item =
  | { kind: 'folder'; path: string; name: string; count: number }
  | { kind: 'capture'; path: string; name: string; capture: Capture }
  | { kind: 'file'; path: string; name: string; file: DriveFileView };

const KINDS: readonly { id: Kind; label: string }[] = [
  { id: 'all', label: 'All types' }, { id: 'images', label: 'Images' }, { id: 'captures', label: 'Captures' },
  { id: 'documents', label: 'Documents' }, { id: 'media', label: 'Audio & video' }, { id: 'other', label: 'Other' },
];
const SORTS: readonly { id: Sort; label: string }[] = [{ id: 'name', label: 'Name' }, { id: 'added', label: 'Recently added' }, { id: 'size', label: 'Size' }];
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html', json: 'application/json', pdf: 'application/pdf',
};
const DownloadGlyph = glyph(Download01);
const CopyGlyph = glyph(Copy01);
const TrashGlyph = glyph(Trash01);
const SearchGlyph = glyph(SearchMd);
const OpenGlyph = glyph(ChevronRight);

/** The file's media type, or the one its extension names when it was stored without one. */
function typeOf(file: DriveFileView): string {
  return file.mediaType ?? EXTENSION_TYPES[file.path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
function kindOf(item: Item): Kind {
  if (item.kind === 'capture') return 'captures';
  if (item.kind === 'folder') return 'all';
  const type = typeOf(item.file);
  if (type.startsWith('image/')) return 'images';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (type.startsWith('text/') || type === 'application/pdf' || type === 'application/json') return 'documents';
  return 'other';
}
function writtenAt(item: Item): string | null {
  return item.kind === 'file' ? item.file.writtenAt : item.kind === 'capture' ? item.capture.writtenAt : null;
}
function sizeOf(item: Item): number {
  return item.kind === 'file' ? item.file.size : item.kind === 'capture' ? item.capture.size : 0;
}
/** How long ago, in the words a file list uses. */
function ago(iso: string | null, now: number): string {
  if (!iso) return '—';
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'yesterday';
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} days ago`;
  return new Date(iso).toLocaleDateString();
}

/** Every capture folder (`browser/captures/<id>/`) as one item: named from the session's capture list, else by what
 * it holds and when. */
function captureFolders(files: readonly DriveFileView[], names: InspectorDrive['captures']): Map<string, Capture> {
  const grouped = new Map<string, DriveFileView[]>();
  for (const file of files) {
    if (!file.path.startsWith(CAPTURES)) continue;
    const id = file.path.slice(CAPTURES.length).split('/')[0];
    if (!id || file.path === `${CAPTURES}${id}`) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), file]);
  }
  const captures = new Map<string, Capture>();
  for (const [id, held] of grouped) {
    const folder = `${CAPTURES}${id}`;
    const named = (name: string) => held.find((file) => file.path === `${folder}/${name}`) ?? null;
    const video = named('video.webm');
    const image = named('image.jpg');
    const latest = held.reduce<string | null>((max, file) => file.writtenAt && (!max || file.writtenAt > max) ? file.writtenAt : max, null);
    const known = names.get(id);
    const type = video ? 'Recording' : image ? 'Screenshot' : 'Capture';
    captures.set(folder, {
      folder, files: held, primary: video ?? image ?? held.find((file) => !file.path.endsWith('.json')) ?? null, thumbnail: named('thumbnail.jpg') ?? image,
      name: known?.name ?? (latest ? `${type} · ${new Date(latest).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : type),
      detail: known ? [type, known.browser].filter(Boolean).join(' · ') : type, writtenAt: latest, size: held.reduce((total, file) => total + file.size, 0),
    });
  }
  return captures;
}
/** What a folder holds: its subfolders (with how many items each holds, a capture counted once) and files, a capture
 * folder as one capture. */
function listFolder(files: readonly DriveFileView[], captures: Map<string, Capture>, folder: string): Item[] {
  const prefix = folder ? `${folder}/` : '';
  const items = new Map<string, Item>();
  const units = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const [head, ...tail] = file.path.slice(prefix.length).split('/');
    if (!head) continue;
    const path = `${prefix}${head}`;
    const capture = captures.get(path);
    if (capture) items.set(path, { kind: 'capture', path, name: capture.name, capture });
    else if (tail.length) {
      const unit = [...captures.keys()].find((captured) => file.path.startsWith(`${captured}/`)) ?? file.path;
      const held = units.get(path) ?? new Set<string>();
      held.add(unit);
      units.set(path, held);
      items.set(path, { kind: 'folder', path, name: head, count: held.size });
    } else items.set(path, { kind: 'file', path, name: head, file });
  }
  return [...items.values()];
}
/** Every capture and every file outside a capture folder whose name or path holds the filter. */
function filterDrive(files: readonly DriveFileView[], captures: Map<string, Capture>, query: string): Item[] {
  const needle = query.toLowerCase();
  const items: Item[] = [...captures.values()].filter((capture) => capture.name.toLowerCase().includes(needle) || capture.folder.toLowerCase().includes(needle))
    .map((capture) => ({ kind: 'capture', path: capture.folder, name: capture.name, capture }));
  for (const file of files) {
    if (file.path.startsWith(CAPTURES) && captures.has(file.path.split('/').slice(0, 3).join('/'))) continue;
    if (file.path.toLowerCase().includes(needle)) items.push({ kind: 'file', path: file.path, name: file.path.split('/').at(-1) ?? file.path, file });
  }
  return items;
}
function sorted(items: Item[], sort: Sort): Item[] {
  const folders = items.filter((item) => item.kind === 'folder').sort((left, right) => left.name.localeCompare(right.name));
  const rest = items.filter((item) => item.kind !== 'folder').sort((left, right) => {
    if (sort === 'size') return sizeOf(right) - sizeOf(left);
    if (sort === 'added') return (writtenAt(right) ?? '').localeCompare(writtenAt(left) ?? '');
    return left.name.localeCompare(right.name);
  });
  return [...folders, ...rest];
}
/** The files an item stands for: a capture's whole folder. */
function filesOf(item: Item): readonly DriveFileView[] {
  return item.kind === 'file' ? [item.file] : item.kind === 'capture' ? item.capture.files : [];
}

function FileIcon({ item, size = 16 }: { item: Item; size?: number }) {
  const props = { width: size, height: size, strokeWidth: 1.5, className: 'shrink-0 text-muted-foreground' };
  if (item.kind === 'folder') return <Folder {...props} />;
  if (item.kind === 'capture') return <Camera01 {...props} />;
  const type = typeOf(item.file);
  if (type.startsWith('image/')) return <Image01 {...props} />;
  if (type.startsWith('video/')) return <VideoRecorder {...props} />;
  if (type.startsWith('audio/')) return <MusicNote01 {...props} />;
  if (type === 'application/json' || type === 'text/markdown') return <FileCode02 {...props} />;
  return <File02 {...props} />;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-[#fde68a] text-inherit">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/** A grid tile's picture: an image's or a capture's thumbnail, read when the tile shows; other files show their icon. */
function Thumb({ item, reference, previewUrl, onRequest }: { item: Item; reference: ArtifactReference | null; previewUrl: string | null; onRequest(reference: ArtifactReference): void }) {
  const shape = useShape();
  useEffect(() => { if (reference) onRequest(reference); }, [reference?.url, reference?.hash]);
  return <div className={`flex h-24 w-full items-center justify-center overflow-hidden bg-surface-1 ${shape.container}`}>
    {previewUrl ? <img src={previewUrl} alt="" className="h-full w-full object-cover" /> : <FileIcon item={item} size={22} />}
  </div>;
}

function RowMenu({ item, writable, onOpen, onCopyAddress, onDownload, onDelete }: { item: Item; writable: boolean; onOpen(): void; onCopyAddress(): void; onDownload(): void; onDelete(): void }) {
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="ghost" size="icon-compact" aria-label={`Actions for ${item.name}`} onClick={(event) => event.stopPropagation()}><DotsVertical width={16} height={16} strokeWidth={1.5} /></Button>} />
    <DropdownContent className="w-[220px]" align="end" sideOffset={4}>
      <MenuItem index={index++} icon={OpenGlyph} label="Open" onSelect={onOpen} />
      <MenuItem index={index++} icon={CopyGlyph} label="Copy address" onSelect={onCopyAddress} />
      <MenuItem index={index++} icon={DownloadGlyph} label="Download" onSelect={onDownload} />
      {writable ? <MenuItem index={index++} icon={TrashGlyph} label="Delete…" onSelect={onDelete} /> : null}
    </DropdownContent>
  </DropdownMenu>;
}

/** Drop files here or browse for them; they go to the open folder. Large while the drive is empty, a strip otherwise. */
function Dropzone({ target, dragging, empty, disabledReason, onFiles }: { target: string; dragging: boolean; empty: boolean; disabledReason: string | null; onFiles(files: File[]): void }) {
  const shape = useShape();
  const input = useRef<HTMLInputElement>(null);
  return <button type="button" disabled={disabledReason !== null} onClick={() => input.current?.click()}
    className={`flex w-full items-center justify-center gap-2 border border-dashed text-caption transition-colors disabled:cursor-not-allowed ${shape.container} ${empty ? 'flex-col py-10' : 'py-2.5'} ${dragging ? 'border-[#6B97FF] bg-[#6B97FF]/10 text-foreground' : 'border-border text-muted-foreground hover:bg-surface-1'}`}>
    <Upload01 width={empty ? 22 : 14} height={empty ? 22 : 14} strokeWidth={1.5} />
    <span>{disabledReason ?? (dragging ? `Drop to upload to ${target}` : <>Drop files here or <span className="text-foreground underline">browse</span> · they go to <span className="font-mono">{target}</span></>)}</span>
    {empty && !dragging && disabledReason === null ? <span>Up to {formatBytes(DRIVE_FILE_MAX_BYTES)} each. Agents save browser captures, downloads and files they write here too.</span> : null}
    <input ref={input} type="file" multiple hidden aria-label={`Upload files to ${target}`} onChange={(event) => { const picked = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; if (picked.length) onFiles(picked); }} />
  </button>;
}

/** The Inspector's Drive tab: the space's drives as folders, a name filter across one drive, selection actions, and
 * uploads into the open folder of the drive this space writes. */
export function DriveSurface({ drive, references, uploads, uploadDisabledReason, actions, previewUrl, onRequestPreview, onOpen, onDownload }: {
  drive: InspectorDrive;
  references: readonly ArtifactReference[];
  uploads: ArtifactUploads | null;
  uploadDisabledReason: string | null;
  actions?: ArtifactActionsHandlers;
  previewUrl(reference: ArtifactReference): string | null;
  onRequestPreview(reference: ArtifactReference): void;
  onOpen(reference: ArtifactReference): void;
  onDownload(reference: ArtifactReference): Promise<void>;
}) {
  const shape = useShape();
  const roots: readonly ('workspace' | 'base')[] = drive.own === 'workspace' ? ['workspace', 'base'] : ['base'];
  const [root, setRoot] = useState<'workspace' | 'base'>(drive.own);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<readonly Item[] | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const writable = root === drive.own;
  const label = root === 'base' ? 'Project drive' : 'This workspace';
  const files = useMemo(() => drive.files.filter((file) => file.scope === root), [drive.files, root]);
  const captures = useMemo(() => captureFolders(files, root === drive.own ? drive.captures : new Map()), [files, root, drive.own, drive.captures]);
  const items = useMemo(() => {
    const listed = query ? filterDrive(files, captures, query) : listFolder(files, captures, folder);
    return sorted(listed.filter((item) => kind === 'all' || (item.kind === 'folder' && !query) || kindOf(item) === kind), sort);
  }, [files, captures, folder, query, kind, sort]);
  // A folder emptied by a delete or a change elsewhere falls back to its nearest listed parent.
  useEffect(() => {
    if (folder && !files.some((file) => file.path.startsWith(`${folder}/`))) setFolder(folder.split('/').slice(0, -1).join('/'));
  }, [files, folder]);
  const referenceOf = (file: DriveFileView | null) => file ? references.find((reference) => reference.url === file.url) ?? null : null;
  const selectedItems = items.filter((item) => selected.has(item.path));
  const selectedReferences = selectedItems.flatMap((item) => filesOf(item).map(referenceOf).filter((reference): reference is ArtifactReference => reference !== null));
  const switchRoot = (next: 'workspace' | 'base') => { setRoot(next); setFolder(''); setSelected(new Set()); setQuery(''); };
  const toggle = (path: string) => setSelected((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const open = (item: Item) => {
    if (item.kind === 'folder') { setFolder(item.path); setSelected(new Set()); return; }
    const reference = referenceOf(item.kind === 'capture' ? item.capture.primary : item.file);
    if (reference) onOpen(reference);
  };
  const run = async (action: () => Promise<void>, failure: string) => {
    setError(null);
    setPending(true);
    try { await action(); } catch (cause) { setError(rpcErrorMessage(cause, failure)); } finally { setPending(false); }
  };
  const copyAddresses = (chosen: readonly Item[]) => void run(async () => {
    await navigator.clipboard.writeText(chosen.map((item) => item.kind === 'capture' ? item.capture.primary?.url ?? item.path : item.kind === 'file' ? item.file.url : item.path).join('\n'));
    setNotice(chosen.length === 1 ? 'Address copied' : `${chosen.length} addresses copied`);
  }, 'Copy addresses');
  const download = (chosen: readonly Item[]) => void run(async () => {
    for (const item of chosen) {
      const reference = referenceOf(item.kind === 'capture' ? item.capture.primary : item.kind === 'file' ? item.file : null);
      if (reference) await onDownload(reference);
    }
  }, 'Download');
  const remove = () => {
    if (!deleting) return;
    const urls = deleting.flatMap((item) => filesOf(item).map((file) => file.url));
    void run(async () => {
      await drive.remove(urls);
      setNotice(`Deleted ${deleting.length === 1 ? deleting[0]!.name : `${deleting.length} items`}`);
      setDeleting(null);
      setSelected(new Set());
    }, 'Delete');
  };
  const crumbs = folder ? folder.split('/') : [];
  const target = folder ? `${folder}/` : `${label}/`;
  const canUpload = writable && uploads !== null;
  const deletingCount = deleting?.reduce((total, item) => total + filesOf(item).length, 0) ?? 0;
  return <div
    className="relative flex min-h-0 flex-1 flex-col"
    onDragOver={canUpload && uploadDisabledReason === null ? (event) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); setDragging(true); } : undefined}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }}
    onDrop={canUpload && uploadDisabledReason === null ? (event) => { event.preventDefault(); setDragging(false); uploads.add([...event.dataTransfer.files], folder); } : undefined}
  >
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-2">
      <div className="flex items-center gap-2">
        <TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={roots.indexOf(root)} onSelect={(index) => switchRoot(roots[index] ?? drive.own)} idPrefix="drive-root" aria-label="Drive">
          {roots.map((id, index) => <TabsSubtleItem key={id} index={index} label={id === 'base' ? 'Project drive' : 'This workspace'} />)}
        </TabsSubtle>
        {writable ? null : <Tooltip content="The project drive is changed from the project page" side="bottom"><span><Badge size="compact" color="gray">Read only</Badge></span></Tooltip>}
      </div>
      <div className="flex items-center gap-2">
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Filter by name" labelHidden placeholder={`Filter ${label} by name or path`} icon={SearchGlyph} value={query} onChange={(value) => { setQuery(value); setSelected(new Set()); }} /></InputGroup>
        <div className="w-36"><Select size="compact" value={kind} onValueChange={(value) => setKind(KINDS.find((option) => option.id === value)?.id ?? 'all')}><SelectTrigger aria-label="Type" /><SelectContent>{KINDS.map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="flex min-h-8 items-center gap-1 text-caption">
        {query ? <span className="text-muted-foreground">{items.length} {items.length === 1 ? 'match' : 'matches'} in {label} <Button variant="ghost" size="compact" onClick={() => setQuery('')}>Clear</Button></span> : <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          <Button variant="ghost" size="compact" onClick={() => setFolder('')}>{label}</Button>
          {crumbs.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-0.5"><ChevronRight width={12} height={12} className="text-muted-foreground" /><Button variant="ghost" size="compact" onClick={() => setFolder(crumbs.slice(0, index + 1).join('/'))}>{part}</Button></span>)}
        </nav>}
        <span className="ml-auto flex items-center gap-1">
          <div className="w-36"><Select size="compact" value={sort} onValueChange={(value) => setSort(SORTS.find((option) => option.id === value)?.id ?? 'name')}><SelectTrigger aria-label="Sort" /><SelectContent>{SORTS.map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}</SelectContent></Select></div>
          <Tooltip content="List" side="bottom"><Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon-compact" aria-pressed={view === 'list'} aria-label="List view" onClick={() => setView('list')}><List width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
          <Tooltip content="Thumbnails" side="bottom"><Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon-compact" aria-pressed={view === 'grid'} aria-label="Thumbnail view" onClick={() => setView('grid')}><Grid01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        </span>
      </div>
      {selected.size ? <div className={`flex flex-wrap items-center gap-1 bg-surface-1 px-2 py-1 ${shape.container}`}>
        <span className="px-1 text-caption font-medium tabular-nums">{selected.size} selected</span>
        <Button variant="ghost" size="compact" leadingIcon={DownloadGlyph} disabled={pending} onClick={() => download(selectedItems)}>Download</Button>
        <Button variant="ghost" size="compact" leadingIcon={CopyGlyph} onClick={() => copyAddresses(selectedItems)}>Copy addresses</Button>
        {writable ? <Button variant="ghost" size="compact" leadingIcon={TrashGlyph} onClick={() => setDeleting(selectedItems)}>Delete</Button> : null}
        {actions && writable ? <ArtifactActions selected={selectedReferences} actions={actions} /> : null}
        <Button variant="ghost" size="icon-compact" className="ml-auto" aria-label="Clear selection" onClick={() => setSelected(new Set())}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
      </div> : null}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      {notice ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><span className="min-w-0 flex-1 truncate">{notice}</span><Button variant="ghost" size="icon-compact" aria-label="Dismiss" onClick={() => setNotice(null)}><XClose width={14} height={14} strokeWidth={1.5} /></Button></div> : null}
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-6">
      {canUpload && !query ? <Dropzone target={target} dragging={dragging} empty={!files.length} disabledReason={uploadDisabledReason} onFiles={(picked) => uploads.add(picked, folder)} /> : null}
      {uploads && writable ? <ArtifactUploadList uploads={uploads} /> : null}
      {!files.length ? (canUpload ? null : <EmptyState icon={<Folder width={22} height={22} strokeWidth={1.5} />} title="Nothing in this drive yet" description="Files appear here once that space saves some." />)
        : !items.length ? <EmptyState icon={<SearchMd width={22} height={22} strokeWidth={1.5} />} title={query ? `Nothing named “${query}”` : 'No files of this type here'} description={query ? 'The filter matches file and folder names and capture titles, not what is inside files.' : 'Choose All types, or open another folder.'} />
        : view === 'list' ? <ul className="flex flex-col" aria-label="Files">
          {items.map((item) => {
            const uploaded = item.kind === 'file' && uploads?.highlighted.includes(item.file.url) === true;
            return <li key={item.path} data-artifact-url={item.kind === 'file' ? item.file.url : undefined} {...(uploaded ? { 'data-selected': '' } : {})} className={`flex min-h-11 items-center gap-2 border-b border-border px-1 ${selected.has(item.path) || uploaded ? 'bg-surface-1' : 'hover:bg-surface-1'}`}>
            {item.kind === 'folder' ? <span className="w-4 shrink-0" /> : <input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.path)} onChange={() => toggle(item.path)} className="size-4 shrink-0 accent-[#6B97FF]" />}
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" onClick={() => open(item)}>
              <FileIcon item={item} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body"><Highlight text={item.name} query={query} /></span>
                {query ? <span className="truncate font-mono text-caption text-muted-foreground"><Highlight text={item.path} query={query} /></span>
                  : item.kind === 'capture' ? <span className="truncate text-caption text-muted-foreground">{item.capture.detail}</span> : null}
              </span>
            </button>
            <span className="w-20 shrink-0 text-left text-caption tabular-nums text-muted-foreground">{item.kind === 'folder' ? `${item.count} ${item.count === 1 ? 'item' : 'items'}` : formatBytes(sizeOf(item))}</span>
            <span className="hidden w-24 shrink-0 text-left text-caption text-muted-foreground sm:block">{item.kind === 'folder' ? '' : ago(writtenAt(item), now)}</span>
            {item.kind === 'folder' ? <span className="flex size-8 shrink-0 items-center justify-center"><ChevronRight width={16} height={16} strokeWidth={1.5} className="text-muted-foreground" /></span>
              : <RowMenu item={item} writable={writable} onOpen={() => open(item)} onCopyAddress={() => copyAddresses([item])} onDownload={() => download([item])} onDelete={() => setDeleting([item])} />}
          </li>;
          })}
        </ul>
        : <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }} aria-label="Files">
          {items.map((item) => {
            const pictured = item.kind === 'capture' ? referenceOf(item.capture.thumbnail) : item.kind === 'file' && typeOf(item.file).startsWith('image/') ? referenceOf(item.file) : null;
            return <div key={item.path} className={`relative flex flex-col gap-1.5 border p-2 ${shape.container} ${selected.has(item.path) ? 'border-[#6B97FF]' : 'border-border'}`}>
              <button type="button" className="flex flex-col gap-1.5 text-left" onClick={() => open(item)}>
                <Thumb item={item} reference={pictured} previewUrl={pictured ? previewUrl(pictured) : null} onRequest={onRequestPreview} />
                <span className="truncate text-caption font-medium"><Highlight text={item.name} query={query} /></span>
                <span className="truncate text-caption tabular-nums text-muted-foreground">{item.kind === 'folder' ? `${item.count} ${item.count === 1 ? 'item' : 'items'}` : `${formatBytes(sizeOf(item))} · ${ago(writtenAt(item), now)}`}</span>
              </button>
              {item.kind === 'folder' ? null : <input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.path)} onChange={() => toggle(item.path)} className="absolute left-3 top-3 size-4 accent-[#6B97FF]" />}
            </div>;
          })}
        </div>}
    </div>
    {dragging ? <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-[#6B97FF] bg-surface-2/80 text-body">Drop to upload to {target}</div> : null}
    <Dialog open={deleting !== null} onOpenChange={(next) => { if (!next) setDeleting(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{deleting?.length === 1 ? `Delete ${deleting[0]!.name}?` : `Delete ${deleting?.length ?? 0} items?`}</DialogTitle>
          <DialogDescription>{deletingCount === 1 ? 'The file is' : `${deletingCount} files are`} removed from {label}. Copies in another drive stay, and agents can no longer read {deletingCount === 1 ? 'it' : 'them'} here.</DialogDescription>
        </DialogHeader>
        <DialogFooter><Button variant="secondary" disabled={pending} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="primary" disabled={pending} loading={pending} onClick={remove}>Delete</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
