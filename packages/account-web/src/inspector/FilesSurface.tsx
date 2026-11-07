import { DIFFS_TAG_NAME, FileDiff, getLineAnnotationName, parsePatchFiles, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange, type ThemeTypes } from '@pierre/diffs';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import { Badge, Button, Select, SelectTrigger, TabsSubtle, TabsSubtleItem, useShape } from '@gitspace/ui';
import type { RepositoryFileView, RepositoryMode, RepositoryTreeEntry, ReviewThreadView } from '@gitspace/protocol';
import type { GitLfsHeldBack } from '@gitspace/protocol-workspace';
import { File02, FileCode02, MessageSquare01 } from '@untitledui/icons';
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useDarkScheme } from '../appearance.js';
import { EmptyState } from '../GitSpaceShell.js';
import { syncRepositoryTreePaths } from './repository-tree-paths.js';
import { selectOptions, type ThreadSelection, type ThreadIdentities, repositoryModes, ic, Padded } from './inspector-shared.js';
import { PreviewFrame } from './ArtifactDocuments.js';

/** Repository files the Files tab renders instead of showing their bytes as text. */
export const REPOSITORY_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

/** A PDF in the browser's viewer; a browser set to download PDFs shows a download link instead of navigating away. */
export function PdfPreview({ url, name }: { url: string; name: string }) {
  const shape = useShape();
  return <PreviewFrame><object data={url} type="application/pdf" aria-label={name} className={`${shape.container} h-full min-h-90 w-full bg-surface-3 shadow-surface-1`}>
    <a href={url} download={name} className="text-body text-primary underline">Download {name}</a>
  </object></PreviewFrame>;
}

/** A PDF in the browser's viewer, an image as an image, any other binary file as a download. */
export function RepositoryBinaryFile({ file }: { file: RepositoryFileView }) {
  const shape = useShape();
  const name = file.path.split('/').at(-1) ?? file.path;
  const mediaType = REPOSITORY_FILE_TYPES[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
  const url = useMemo(() => {
    const bytes = file.encoding === 'base64' ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)) : new TextEncoder().encode(file.content);
    return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  }, [file.content, file.encoding, mediaType]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  if (mediaType === 'application/pdf') return <PdfPreview url={url} name={name} />;
  if (mediaType.startsWith('image/')) return <PreviewFrame><img src={url} alt={name} className={`${shape.container} max-h-full max-w-full bg-surface-3 object-contain shadow-surface-1`} /></PreviewFrame>;
  return <Padded><EmptyState icon={ic(File02, 22)} title="Binary file" description="This file has no inline preview." action={<a href={url} download={name} className="text-body text-primary underline">Download {name}</a>} /></Padded>;
}

export function repositoryPatch(file: RepositoryFileView): string {
  const lines = file.content.split('\n');
  return `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((line) => ` ${line}`).join('\n')}\n`;
}
interface ThreadAnnotation { thread: ReviewThreadView }
/** Pierre's gutter slot: pinned to the hovered row's gutter, as its React wrapper places it. */
const gutterSlotStyle = { position: 'absolute', top: 0, bottom: 0, textAlign: 'center', whiteSpace: 'normal', touchAction: 'none' } satisfies CSSProperties;
/** Without `onSelectRange` the diff is read-only: no line selection starts a thread. Without `identities` no thread
 * anchors to it. `lineNumbers: false` hides the gutter's numbers, for a patch whose hunks do not know their file lines. */
export function PierreViewer({ path, identities, patch, threads = [], onSelectThread, onSelectRange, lineNumbers = true }: { path: string; identities?: ThreadIdentities; patch: string; threads?: readonly ReviewThreadView[]; onSelectThread?: (thread: ReviewThreadView) => void; onSelectRange?: (selection: ThreadSelection) => void; lineNumbers?: boolean }) {
  const fileDiff = useMemo(() => parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0] ?? null, [patch]);
  const container = useRef<HTMLElement>(null);
  const instance = useRef<FileDiff<ThreadAnnotation> | null>(null);
  const selectLine = (side: 'base' | 'head', startLine: number, endLine: number): void => { if (identities) onSelectRange?.({ path, identity: identities[side], side, startLine, endLine }); };
  const selectLineRef = useRef(selectLine);
  selectLineRef.current = selectLine;
  const selectable = !!onSelectRange && !!identities;
  const identityKey = JSON.stringify(identities);
  // Pierre holds both GitHub themes and shows the one for the page's scheme; a scheme change switches it in place.
  const themeType: ThemeTypes = useDarkScheme() ? 'dark' : 'light';
  const { annotations, outdatedThreads } = useMemo(() => {
    const matches = (thread: ReviewThreadView): boolean => {
      if (!identities || thread.anchor.kind !== 'line' || thread.anchor.path !== path) return false;
      const identity = identities[thread.anchor.side];
      return thread.anchorState !== 'stale' && thread.anchor.generation === identity.generation && thread.anchor.baseCommit === identity.baseCommit && thread.anchor.headCommit === identity.headCommit && !!identity.blobId && thread.anchor.blobId === identity.blobId;
    };
    return {
      annotations: threads.flatMap((thread): DiffLineAnnotation<ThreadAnnotation>[] => thread.anchor.kind === 'line' && matches(thread) ? [{ side: thread.anchor.side === 'head' ? 'additions' : 'deletions', lineNumber: thread.anchor.startLine, metadata: { thread } }] : []),
      outdatedThreads: threads.filter((thread) => thread.anchor.kind === 'line' && thread.anchor.path === path && !matches(thread)),
    };
  }, [threads, path, identityKey]);
  const options = useMemo<FileDiffOptions<ThreadAnnotation>>(() => ({
    diffStyle: 'unified', theme: { dark: 'github-dark', light: 'github-light' }, disableFileHeader: true, disableLineNumbers: !lineNumbers, hunkSeparators: 'line-info', enableHoverUtility: selectable, enableLineSelection: selectable,
    onLineSelectionEnd: (range: SelectedLineRange | null) => { if (range) selectLineRef.current(range.side === 'deletions' ? 'base' : 'head', Math.min(range.start, range.end), Math.max(range.start, range.end)); },
    // The gutter's button is the slotted React child below; Pierre only needs to know there is one.
    ...(selectable ? { renderGutterUtility: () => null } : {}),
  }), [selectable, lineNumbers]);
  // One instance per mount, drawn into the container this component owns. Cleanup also empties what it drew from the
  // container's shadow root, which outlives the instance: React's StrictMode remounts on the same node, and a second
  // instance that finds the first one's <pre> takes it for server-rendered HTML and never draws the file.
  useLayoutEffect(() => {
    const fileContainer = container.current;
    if (!fileContainer || !fileDiff) return;
    const created = new FileDiff<ThreadAnnotation>(options, undefined, true);
    created.hydrate({ fileDiff, fileContainer, lineAnnotations: annotations });
    instance.current = created;
    return () => {
      created.cleanUp();
      fileContainer.shadowRoot?.replaceChildren();
      if (instance.current === created) instance.current = null;
    };
  }, [fileDiff, options]);
  useLayoutEffect(() => { instance.current?.render({ fileDiff: fileDiff ?? undefined, lineAnnotations: annotations }); }, [annotations]);
  // Runs after each new instance too, which starts on the OS scheme.
  useLayoutEffect(() => { instance.current?.setThemeType(themeType); }, [themeType, fileDiff, options]);
  if (!fileDiff) return <Padded><EmptyState icon={ic(FileCode02, 22)} title="No parseable content" description={`The selected ${path} view did not contain a text patch Pierre can render.`} /></Padded>;
  // FLUID-GAP: diff viewer — @pierre/diffs renders the patch with its own theme.
  return <div className="min-h-0 flex-1 overflow-auto bg-surface-3">
    {outdatedThreads.length ? <div className="flex flex-wrap items-center gap-2 p-3"><span className="text-caption text-muted-foreground">Comments on other or unverified content:</span>{outdatedThreads.map((thread) => <Button key={thread.id} variant="tertiary" size="compact" type="button" onClick={() => onSelectThread?.(thread)}>{ic(MessageSquare01, 14)}{thread.anchor.kind === 'line' ? `Lines ${thread.anchor.startLine}–${thread.anchor.endLine}` : 'Thread'}</Button>)}</div> : null}
    {createElement(DIFFS_TAG_NAME, { ref: container },
      annotations.map((annotation, index) => <div key={index} slot={getLineAnnotationName(annotation)}><Button variant="tertiary" size="compact" type="button" onClick={() => onSelectThread?.(annotation.metadata.thread)}>{ic(MessageSquare01, 14)}<span className="tabular-nums">{annotation.metadata.thread.messages.length}</span></Button></div>),
      selectable ? <div slot="gutter-utility-slot" style={gutterSlotStyle}><Button variant="tertiary" size="icon-compact" type="button" aria-label="Add line comment" onMouseDown={(event) => { event.preventDefault(); const line = instance.current?.getHoveredLine(); if (line) selectLine(line.side === 'deletions' ? 'base' : 'head', line.lineNumber, line.lineNumber); }}>+</Button></div> : null)}
  </div>;
}

function RepositoryTree({ entries, changedOnly, onOpen }: { entries: readonly RepositoryTreeEntry[]; changedOnly: boolean; onOpen: (entry: RepositoryTreeEntry) => void }) {
  const shown = useMemo(() => entries.filter((entry) => entry.kind === 'file' && (!changedOnly || entry.status !== 'clean')), [changedOnly, entries]);
  const paths = useMemo(() => shown.map((entry) => entry.path), [shown]);
  const status = useMemo<GitStatusEntry[]>(() => shown.filter((entry) => entry.status !== 'clean').map((entry) => ({ path: entry.path, status: entry.status === 'untracked' ? 'untracked' : entry.status === 'clean' ? 'modified' : entry.status } as GitStatusEntry)), [shown]);
  const entriesRef = useRef(shown); entriesRef.current = shown;
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const { model } = useFileTree({ paths, gitStatus: status, initialExpandedPaths: [...new Set(paths.map((path) => path.split('/')[0]!).filter(Boolean))], density: 'compact', onSelectionChange: (selected) => { const entry = entriesRef.current.find((candidate) => selected.includes(candidate.path)); if (entry) openRef.current(entry); } });
  const loadedPaths = useRef(paths);
  useEffect(() => { syncRepositoryTreePaths(model, loadedPaths.current, paths); loadedPaths.current = paths; }, [model, paths]);
  useEffect(() => { model.setGitStatus(status); }, [model, status]);
  // FLUID-GAP: file tree — @pierre/trees renders the repository tree with its own theme.
  return <FileTree model={model} className="h-full" />;
}

export function FilesSurface({ entries, heldBack, mode, onModeChange, changedOnly, setChangedOnly, onOpen, onOpenHeldBack }: { entries: readonly RepositoryTreeEntry[]; heldBack: readonly GitLfsHeldBack[]; mode: RepositoryMode; onModeChange: (mode: RepositoryMode) => void; changedOnly: boolean; setChangedOnly: (value: boolean) => void; onOpen: (entry: RepositoryTreeEntry) => void; onOpenHeldBack(path: string): void }) {
  const changed = new Set([...entries.filter((entry) => entry.kind === 'file' && entry.status !== 'clean').map(entry => entry.path), ...heldBack.map(item => item.path)]).size;
  const ordinaryEntries = entries.filter(entry => !heldBack.some(item => item.path === entry.path));
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-2 px-4 pb-2 pt-4">
      <div className="flex items-center justify-between gap-2"><strong className="text-body font-medium text-foreground">Repository</strong><span className="text-caption text-muted-foreground tabular-nums">{entries[0] ? `generation ${entries[0].generation}` : heldBack.length ? 'Saved LFS changes' : 'No checkout'}</span></div>
      <Select value={mode} onValueChange={(value) => onModeChange(value as RepositoryMode)} size="compact"><SelectTrigger aria-label="Repository comparison" />{selectOptions(repositoryModes.map(({ id, label }) => ({ value: id, label })))}</Select>
      <TabsSubtle size="compact" selectedIndex={changedOnly ? 1 : 0} onSelect={(index) => setChangedOnly(index === 1)} aria-label="Repository filter"><TabsSubtleItem index={0} label="All" /><TabsSubtleItem index={1} label={`Changed · ${changed}`} /></TabsSubtle>
      <p className="text-caption text-muted-foreground">Choose any file from All, or focus the tree to paths changed in this workspace.</p>
    </header>
    {heldBack.length ? <section className="flex flex-col gap-2 px-4 pb-3" aria-label="Machine-local LFS changes"><p className="text-caption text-muted-foreground">LFS changes leave this machine only after a commit</p><ul className="flex max-h-60 flex-col gap-1 overflow-auto">{heldBack.map(item => <li key={item.path} className="flex items-center justify-between gap-2"><Button variant="ghost" size="compact" className="min-w-0 justify-start" onClick={() => onOpenHeldBack(item.path)}><span className="truncate font-mono">{item.path}</span></Button><Badge color="amber">Only on this machine</Badge></li>)}</ul></section> : null}
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">{ordinaryEntries.length ? <RepositoryTree entries={ordinaryEntries} changedOnly={changedOnly} onOpen={onOpen} /> : heldBack.length ? null : <EmptyState icon={ic(File02, 20)} title="Repository unavailable" description="The current workspace generation has no repository tree." />}</div>
  </div>;
}
