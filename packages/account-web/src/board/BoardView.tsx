import { Button, Tooltip, useIcon } from '@gitspace/ui';
import { Columns03 } from '@untitledui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_COLOR, type WorkspaceView } from '../GitSpaceShell.js';
import { ACCENT } from '../sidebar/parts.js';
import { relationsOf, type RowItem, type SidebarFilter, type SidebarGroupBy } from '../sidebar/rows.js';
import { WorkspaceGraph } from '../WorkspaceGraph.js';
import { BoardColumns } from './BoardColumns.js';
import { useInboxCount } from '../inbox/index.js';
import { TodayStrip, type TodayProject } from './TodayStrip.js';

/** The page's width, following the window. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => typeof window === 'undefined' ? 0 : window.innerWidth);
  useEffect(() => {
    const resize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return width;
}

/** The rail's first entry: the Board, with the orange count of what needs the person; active while it is open. */
export function BoardRailButton({ needs, active, onClick }: { needs: number; active: boolean; onClick(): void }) {
  return <Tooltip content={needs ? `Board · ${needs} need you` : 'Board'} side="bottom">
    <button type="button" aria-label={needs ? `Board, ${needs} need you` : 'Board'} aria-current={active ? 'page' : undefined} onClick={onClick} data-rail="board"
      className={`flex h-7 shrink-0 items-center gap-1 rounded-lg pl-1.5 pr-1 hover:bg-hover hover:text-foreground ${active ? 'bg-active text-foreground' : 'text-muted-foreground'}`}>
      <Columns03 width={16} height={16} strokeWidth={1.5} />
      {needs ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums leading-none text-white" style={{ background: STATUS_COLOR.orange }}>{needs}</span> : null}
    </button>
  </Tooltip>;
}

/** The Board entry counting the Inbox's rows (decision 2a), the same count its Needs you column shows; only under the
 * account's `InboxProvider`. */
export function InboxBoardRailButton({ active, onClick }: { active: boolean; onClick(): void }) {
  return <BoardRailButton needs={useInboxCount(null)} active={active} onClick={onClick} />;
}

/** The board's heading beside the rail: how many workspaces in how many projects, and Columns or Graph. At the right,
 * while a drag widens the list past the snap width, what releasing does; on the whole board (no workspace beside it),
 * Sidebar view, the list again (`onSidebarView`). Beside a workspace, that workspace's own sidebar toggle does it. */
export function BoardHeader({ workspaces, projects, reflowing, graph, onGraph, onSidebarView }: { workspaces: number; projects: number; reflowing: boolean; graph: boolean; onGraph: ((graph: boolean) => void) | null; onSidebarView: (() => void) | null }) {
  const PanelLeft = useIcon('panel-left');
  return <>
    <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-foreground"><Columns03 width={15} height={15} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />Board<span className="truncate text-[12px] font-normal text-muted-foreground">· {workspaces} {workspaces === 1 ? 'workspace' : 'workspaces'} in {projects} {projects === 1 ? 'project' : 'projects'}</span></span>
    {onGraph ? <div role="group" aria-label="Board view" className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {[{ graph: false, label: 'Columns' }, { graph: true, label: 'Graph' }].map((option) => <button key={option.label} type="button" aria-pressed={graph === option.graph} onClick={() => onGraph(option.graph)}
        className={`rounded-md px-1.5 py-0.5 ${graph === option.graph ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>{option.label}</button>)}
    </div> : null}
    <span className="flex-1" />
    {reflowing ? <span className="shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-white" style={{ background: ACCENT }}>Release to open the board</span>
      : onSidebarView ? <Tooltip content="Sidebar view" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Sidebar view" onClick={onSidebarView}><PanelLeft /></Button></Tooltip> : null}
  </>;
}

/**
 * The board under its heading: the filters on one line, the Today strip (folded while a workspace is open beside it),
 * and the columns, or the account's workspace graph. While a drag only previews the board (`preview`), the strip waits.
 */
export function BoardBody({ filters, projects, narrowed, machines, groupBy, filter, selectedId, preview, graph, onOpen, onMove, onNewWorkspace, onSetRelations }: {
  filters: ReactNode; projects: readonly TodayProject[]; narrowed: boolean; machines: { online: number; total: number } | null; groupBy: SidebarGroupBy; filter: SidebarFilter;
  selectedId: string | null; preview: boolean; graph: boolean; onOpen(item: RowItem): void; onMove: ((item: RowItem, phase: WorkspaceView['phase']) => void) | null; onNewWorkspace?: (projectId: string) => void;
  onSetRelations: ((item: RowItem, relations: WorkspaceView['relations']) => void) | null;
}) {
  const items = projects.flatMap((project) => project.items);
  return <div className="flex min-h-0 flex-1 flex-col">
    {filters}
    {preview ? <div className="h-1" /> : <TodayStrip key={selectedId ? 'beside' : 'whole'} projects={projects} narrowed={narrowed} machines={machines} defaultOpen={!selectedId} />}
    {graph ? <div className="min-h-0 flex-1 px-2 pb-2">
      <WorkspaceGraph height="100%" selectedId={selectedId} onSelect={(id) => { const target = items.find((item) => item.id === id); if (target) onOpen(target); }}
        onSetRelations={onSetRelations ? (id, relations) => { const target = items.find((item) => item.id === id); if (target) onSetRelations(target, relations); } : undefined}
        workspaces={projects.flatMap((project) => project.items.map((item) => ({
          id: item.id, projectId: project.id, projectName: project.name, name: item.name, branch: item.branch, phase: item.phase, relations: relationsOf(item),
          closedAt: null, holder: item.summary?.holder ?? { kind: 'unknown' }, status: item.summary?.status, freshness: item.summary?.freshness, creation: item.summary?.creation,
        })))} />
    </div> : <BoardColumns projects={projects} groupBy={groupBy} filter={filter} selectedId={selectedId} onOpen={onOpen} onMove={onMove} onNewWorkspace={onNewWorkspace} />}
  </div>;
}
