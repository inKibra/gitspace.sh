import { Button, Elevated, InputField, InputGroup, ScrollArea, TabsSubtle, TabsSubtleItem, TabsSubtlePanel, useIcons, useShape } from '@gitspace/ui';
import { XClose } from '@untitledui/icons';
import { useEffect, useRef, useState } from 'react';
import type { SessionHistoryEntry, SessionHistoryPage, SessionHistoryPageRequest } from '@gitspace/protocol-agent';

export interface SessionTreeExplorerProps {
  historyAnchorId: string | null;
  onNavigate(entryId: string): Promise<void>;
  onClose(): void;
  onReadHistory(request: SessionHistoryPageRequest, signal: AbortSignal): Promise<SessionHistoryPage>;
}

function EntryRow({ entry, selected, disabled, onInspect, onBranches }: {
  entry: SessionHistoryEntry;
  selected: boolean;
  disabled: boolean;
  onInspect(entryId: string): void;
  onBranches(entryId: string): void;
}) {
  const icons = useIcons();
  const Dot = entry.current ? icons.check : icons.circle;
  return <li className="flex min-w-0 items-center gap-1">
    <Button
      variant="ghost"
      size="compact"
      active={selected}
      aria-pressed={selected}
      aria-current={entry.current ? 'true' : undefined}
      data-history-anchor={selected || undefined}
      disabled={disabled}
      className="min-h-10 min-w-0 flex-1 justify-start gap-2 text-left"
      onClick={() => onInspect(entry.id)}
      title={entry.preview || undefined}
    >
      <Dot size={12} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
      <span className="shrink-0 tabular-nums text-caption text-muted-foreground">#{entry.sequence}</span>
      <span className="w-12 shrink-0 text-caption text-muted-foreground">{entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Agent' : 'Branch'}</span>
      <span className="min-w-0 truncate">{entry.preview || (entry.role === 'branch' ? 'Branch point' : entry.tools ? `${entry.tools} tool calls` : '(empty message)')}</span>
      {entry.current ? <span className="ml-auto shrink-0 text-caption text-muted-foreground">Current</span> : null}
    </Button>
    {entry.childCount > 1 ? <Button variant="ghost" size="compact" className="min-h-10 shrink-0 tabular-nums" disabled={disabled} aria-label={`Show ${entry.childCount} branches after entry ${entry.sequence}`} onClick={() => onBranches(entry.id)}>{entry.childCount} branches</Button> : null}
  </li>;
}

export function SessionTreeExplorer({ historyAnchorId, onNavigate, onClose, onReadHistory }: SessionTreeExplorerProps) {
  const shape = useShape();
  const [tab, setTab] = useState(0);
  const [filter, setFilter] = useState('');
  // Capture the opening leaf. Live controls must not move an inspected window.
  const [request, setRequest] = useState<SessionHistoryPageRequest>(() => ({ anchorId: historyAnchorId, direction: 'around', cursor: null }));
  const [page, setPage] = useState<{ request: SessionHistoryPageRequest; value: SessionHistoryPage | null; error: string | null } | null>(null);
  const [resuming, setResuming] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const reader = useRef(onReadHistory);
  reader.current = onReadHistory;
  const mounted = useRef(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const read = reader.current;
    setPage(null);
    void (async () => {
      try {
        const value = await read(request, controller.signal);
        if (!controller.signal.aborted) setPage({ request, value, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setPage({ request, value: null, error: cause instanceof Error ? cause.message : 'Unable to read session history' });
      }
    })();
    return () => controller.abort();
  }, [request]);
  // Never show the previous window's rows, counts, or cursors while replacing it.
  const result = page?.request === request ? page : null;
  const value = result?.value ?? null;
  const loading = result === null;
  const branches = request.direction === 'children' || request.anchorId === null;
  const selected = !branches ? value?.entries.find(entry => entry.id === value.anchorId) : undefined;
  const query = filter.trim().toLowerCase();
  const entries = tab === 1 ? value?.entries.filter(entry => entry.role === 'user' && entry.preview.toLowerCase().includes(query)) ?? [] : value?.entries ?? [];
  useEffect(() => {
    if (!value) return;
    const viewport = scrollArea.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const anchor = viewport.querySelector<HTMLElement>('[data-history-anchor]');
    if (anchor) {
      // Scroll this panel only, never the live transcript underneath it.
      viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (viewport.clientHeight - anchor.offsetHeight) / 2;
    } else {
      viewport.scrollTop = request.direction === 'before' ? viewport.scrollHeight : 0;
    }
  }, [value, request]);
  const browse = (next: SessionHistoryPageRequest): void => {
    setNavigationError(null);
    setRequest(next);
  };
  const inspect = (anchorId: string): void => browse({ anchorId, direction: 'around', cursor: null });
  const showBranches = (anchorId: string | null): void => {
    setTab(0);
    browse({ anchorId, direction: 'children', cursor: null });
  };
  const resume = async (): Promise<void> => {
    if (!selected || resuming) return;
    setResuming(true);
    setNavigationError(null);
    try {
      await onNavigate(selected.id);
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setNavigationError(cause instanceof Error ? cause.message : 'Unable to resume from this entry');
    } finally {
      if (mounted.current) setResuming(false);
    }
  };
  const rows = <ScrollArea ref={scrollArea} className="h-[min(36vh,22rem)] min-h-0 flex-initial">
    <ul aria-label={branches ? 'Branch choices' : 'Loaded session history'} className="flex flex-col">{entries.map(entry => <EntryRow key={entry.id} entry={entry} selected={entry.id === selected?.id} disabled={resuming} onInspect={inspect} onBranches={showBranches} />)}</ul>
    {value && !entries.length ? <p className="px-3 py-4 text-caption text-muted-foreground">{tab === 1 ? 'No matching prompts in this window.' : branches ? 'No branch choices in this window.' : 'No messages in this window.'}</p> : null}
  </ScrollArea>;
  return <Elevated offset={1} className={`${shape.container} flex max-h-[min(70vh,38rem)] flex-col gap-2 p-2`}>
    <div className="flex shrink-0 items-center gap-1">
      <TabsSubtle idPrefix="session-tree" selectedIndex={tab} onSelect={setTab} className="min-w-0 flex-1">
        <TabsSubtleItem index={0} label="Tree" />
        <TabsSubtleItem index={1} label="History" />
      </TabsSubtle>
      <Button variant="ghost" size="compact" className="min-h-10" disabled={resuming} onClick={() => showBranches(null)}>Root branches</Button>
      <Button variant="ghost" size="icon-compact" className="min-h-10 min-w-10" aria-label="Close session history" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button>
    </div>
    <p className="px-2 text-caption text-muted-foreground">{branches ? (request.anchorId === null ? 'Root branches · choose one to inspect' : 'Branch choices · choose one to inspect') : 'Browsing a history window · select an entry to inspect'}</p>
    <TabsSubtlePanel idPrefix="session-tree" index={0} selectedIndex={tab} className={`${tab === 0 ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden`}>{tab === 0 ? rows : null}</TabsSubtlePanel>
    <TabsSubtlePanel idPrefix="session-tree" index={1} selectedIndex={tab} className={`${tab === 1 ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden`}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <InputGroup size="compact"><InputField index={0} label="Filter prompts in this window" labelHidden value={filter} onChange={text => setFilter(text.slice(0, 512))} placeholder="Filter prompts in this window…" /></InputGroup>
        <p className="px-2 text-caption text-muted-foreground">Only loaded prompts are filtered, not the full session.</p>
        {tab === 1 ? rows : null}
      </div>
    </TabsSubtlePanel>
    {loading ? <p role="status" className="px-2 text-caption text-muted-foreground">Loading session history…</p> : null}
    {result?.error ? <div role="alert" className="px-2 text-caption text-destructive">{result.error}<Button variant="ghost" size="compact" className="min-h-10" onClick={() => browse({ ...request })}>Retry history</Button></div> : null}
    <div className="flex shrink-0 items-center justify-between gap-2">
      <Button variant="ghost" size="compact" className="min-h-10" disabled={resuming || loading || !value?.beforeCursor} onClick={() => { if (value?.beforeCursor) browse({ anchorId: value.anchorId, direction: branches ? 'children' : 'before', cursor: value.beforeCursor }); }}>{branches ? 'Previous branches' : 'Older history'}</Button>
      <span className="text-caption text-muted-foreground tabular-nums">{value ? `${entries.length} ${tab === 1 ? 'prompts' : 'entries'} in window` : ''}</span>
      <Button variant="ghost" size="compact" className="min-h-10" disabled={resuming || loading || !value?.afterCursor} onClick={() => { if (value?.afterCursor) browse({ anchorId: value.anchorId, direction: branches ? 'children' : 'after', cursor: value.afterCursor }); }}>{branches ? 'More branches' : 'Newer history'}</Button>
    </div>
    {selected ? <div className="flex shrink-0 items-center justify-between gap-2 px-2">
      <span className="min-w-0 truncate text-caption text-muted-foreground tabular-nums">Viewing #{selected.sequence}{selected.current ? ' · current' : ''}</span>
      <Button variant="tertiary" size="compact" className="min-h-10 shrink-0" disabled={resuming || selected.current} onClick={() => void resume()}>{resuming ? 'Resuming…' : 'Resume from here'}</Button>
    </div> : null}
    {navigationError ? <p role="alert" className="px-2 text-caption text-destructive">{navigationError}</p> : null}
  </Elevated>;
}
