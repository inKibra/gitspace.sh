import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, FolderClosed } from '@untitledui/icons';
import { STATUS_COLOR } from '../GitSpaceShell.js';
import { FILTERS, GROUP_BYS, matches, type RowItem, type SidebarFilter, type SidebarGroupBy } from './rows.js';

/** The Project filter beside Group by: All projects, or any set of them, each with how many of its open workspaces pass
 * the state filter. Picking every project is All projects. */
function ProjectFilter({ projects, items, filter, picked, onPick }: { projects: readonly { id: string; name: string }[]; items: readonly RowItem[]; filter: SidebarFilter; picked: readonly string[]; onPick(next: readonly string[]): void }) {
  const names = projects.filter((project) => picked.includes(project.id)).map((project) => project.name);
  const label = names.length === 0 ? 'All projects' : names.length === 1 ? names[0] : `${names.length} projects`;
  const toggle = (id: string): void => {
    const next = picked.includes(id) ? picked.filter((other) => other !== id) : [...picked, id];
    onPick(next.length === projects.length ? [] : next);
  };
  const option = (key: string, text: string, checked: boolean, count: number, onSelect: () => void) => <button key={key} type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onSelect}
    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-foreground hover:bg-hover">
    <span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] ${checked ? 'bg-foreground text-background' : 'shadow-[inset_0_0_0_1px_var(--border)]'}`}>{checked ? <Check width={11} height={11} strokeWidth={2.5} /> : null}</span>
    <span className="min-w-0 flex-1 truncate">{text}</span>
    <span className="min-w-4 rounded-full bg-muted px-1 text-center text-[10.5px] leading-4 tabular-nums text-muted-foreground">{count}</span>
  </button>;
  return <Popover.Root modal={false}>
    <Popover.Trigger aria-label={`Project filter: ${label}`} data-project-filter=""
      className={`inline-flex max-w-44 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50 data-[popup-open]:bg-active ${names.length ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>
      <FolderClosed width={12} height={12} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{label}</span><ChevronDown width={12} height={12} className="shrink-0 opacity-70" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
        <Popover.Popup role="menu" aria-label="Projects" className="w-[220px] rounded-xl border border-border bg-background p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] outline-none">
          {option('all', 'All projects', !picked.length, items.filter((item) => matches(item, filter)).length, () => onPick([]))}
          <div aria-hidden className="mx-2 my-1 h-px bg-border" />
          {projects.map((project) => option(project.id, project.name, picked.includes(project.id), items.filter((item) => item.workspace.projectId === project.id && matches(item, filter)).length, () => toggle(project.id)))}
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">Counts follow the state filter · remembered in this browser</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/**
 * The filters with their counts, Group by and the Project filter, over the list and the board. `items`: the open
 * workspaces of the projects shown, for the filters' counts; `everyItem`: those of every active project, for the Project
 * filter's. On the board (`inline`) they sit on one line. While the list is a picker they rest (`resting`).
 */
export function FilterBar({ projects, items, everyItem, filter, onFilter, groupBy, onGroupBy, picked, onPick, inline, resting }: {
  projects: readonly { id: string; name: string }[]; items: readonly RowItem[]; everyItem: readonly RowItem[]; filter: SidebarFilter; onFilter(filter: SidebarFilter): void;
  groupBy: SidebarGroupBy; onGroupBy(groupBy: SidebarGroupBy): void; picked: readonly string[]; onPick(next: readonly string[]): void; inline: boolean; resting: boolean;
}) {
  return <div className={`flex gap-1.5 pb-1 pt-1 transition-opacity duration-200 ${inline ? 'flex-row flex-wrap items-center gap-x-4' : 'flex-col'} ${resting ? 'pointer-events-none opacity-35' : ''}`}>
    <div role="group" aria-label="Filter workspaces" className="flex flex-wrap items-center gap-1 px-2">
      {FILTERS.map((option) => {
        const pressed = option.id === filter;
        const tone = option.id === 'needs-you' ? STATUS_COLOR.orange : option.id === 'running' ? STATUS_COLOR.green : null;
        return <button type="button" key={option.id} aria-pressed={pressed} onClick={() => onFilter(option.id)}
          className={`inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors duration-150 ${pressed ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>
          {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
          {option.label}
          <span className={`min-w-4 rounded-full px-1 text-center text-[10.5px] leading-4 tabular-nums ${pressed ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground'}`}>{items.filter((item) => matches(item, option.id)).length}</span>
        </button>;
      })}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px] text-muted-foreground">
      <div role="group" aria-label="Group by" className="flex items-center gap-1">
        Group by
        {GROUP_BYS.map((option) => <button type="button" key={option.id} aria-pressed={groupBy === option.id} onClick={() => onGroupBy(option.id)}
          className={`rounded-md px-1.5 py-0.5 ${groupBy === option.id ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>{option.label}</button>)}
      </div>
      {projects.length > 1 ? <ProjectFilter projects={projects} items={everyItem} filter={filter} picked={picked} onPick={onPick} /> : null}
    </div>
  </div>;
}
