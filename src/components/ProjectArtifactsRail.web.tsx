/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import { KIND_ICON, KIND_LABEL, KIND_ORDER, classifyArtifact, goalPrefixOf, toGoalRelative, type ArtifactKind } from './artifact-kinds.js';

/**
 * The project artifacts rail — one component, two homes.
 *
 * Project home and the workspace detail rail must show project artifacts the
 * same way; a second implementation is how the two surfaces start disagreeing
 * about grouping, icons, favourites and what an LFS pointer looks like. So this
 * owns the presentation and the caller owns the data and the verbs.
 *
 * Opening is delegated on purpose: project home routes into its own tab system,
 * the workspace rail opens a dock pane. Both land on the same viewer
 * (`ArtifactPanel`), so the difference is routing, not rendering.
 */

/**
 * GOAL FILTER: a client-only sibling of the source WorkspaceCombo. It does NOT
 * change the artifact source — it focuses one already-loaded rolled-up goal
 * within `main`. Same look as WorkspaceCombo (chain-grouped dropdown) plus an
 * "All goals" sentinel and a dimmed goal-id secondary on each row.
 */
/** The goal SECTION HEADER doubles as the goal picker: the title you're reading
 *  IS the control. One goal is shown at a time; clicking the header (when >1
 *  goal is rolled up) drops a chain-grouped menu to switch which one. No "all
 *  goals" — the view is always one goal + the Project section. */
export function GoalHeaderPicker({ goalId, title, rating, options, onChange }: {
  goalId: string;
  title: string;
  rating?: number;
  options: Array<{ value: string; label: string; chain: string }>;
  onChange: (value: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const switchable = options.length > 1;
  const ql = q.trim().toLowerCase();
  const filtered = options.filter((o) => `${o.chain} ${o.label} ${o.value}`.toLowerCase().includes(ql));
  const chains = [...new Set(filtered.map((o) => o.chain))];
  return (
    <div className="relative border-b border-[var(--gs-border-muted)]">
      <button
        type="button"
        disabled={!switchable}
        onClick={() => { setOpen((o) => !o); setQ(''); }}
        title={switchable ? `goals/${goalId}/ — click to switch goal` : `goals/${goalId}/`}
        className={`flex w-full items-baseline gap-1.5 px-3 pb-[5px] pt-[11px] text-left ${switchable ? 'hover:bg-[var(--gs-bg-hover)]' : ''}`}
      >
        <span className="min-w-0 truncate text-[11.5px] font-medium text-[var(--gs-text)]">{title}</span>
        {rating !== undefined && (
          <span title={`rated ${rating}/5 at roll-up`} className="flex-none text-[10px] tracking-[.08em] text-[var(--gs-warning)]">
            {'★'.repeat(Math.max(1, Math.min(5, Math.round(rating))))}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 flex-shrink truncate font-[family-name:var(--gs-font)] text-[9.5px] text-[var(--gs-text-ghost)]">{goalId}</span>
          {switchable && <span className="flex-none text-[10px] text-[var(--gs-text-dim)]">▾</span>}
        </span>
      </button>
      {open && switchable && (
        <div className="absolute inset-x-2 top-[34px] z-30 max-h-[280px] overflow-auto border border-[var(--gs-border-active)] bg-[var(--gs-bg-overlay)] shadow-[0_8px_24px_rgba(0,0,0,.6)]">
          {/* Type-to-search over the rolled-up goals. Autofocus anchors the
              picker's focus here — its blur (deferred so an option mousedown
              lands first) is what closes the menu. */}
          <input
            autoFocus
            value={q}
            placeholder="search goals…"
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => setTimeout(() => setOpen(false), 130)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
            className="sticky top-0 w-full border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[9px] py-1.5 font-[family-name:var(--gs-font)] text-[11px] text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)]"
          />
          {chains.map((chain) => (
            <div key={chain}>
              <div className="px-[9px] pb-[3px] pt-[7px] text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-dim)]">{chain}</div>
              {filtered.filter((o) => o.chain === chain).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onMouseDown={() => { onChange(o.value); setOpen(false); }}
                  className={`flex w-full items-baseline gap-2 px-[9px] py-1.5 text-left font-[family-name:var(--gs-font)] text-[11px] ${o.value === goalId ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)]'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="flex-none font-[family-name:var(--gs-font)] text-[9.5px] text-[var(--gs-text-ghost)]">{o.value}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && <div className="px-[9px] py-2 text-[11px] text-[var(--gs-text-dim)]">no matches</div>}
        </div>
      )}
    </div>
  );
}

export interface ProjectArtifactEntry {
  path: string;
  size: number;
  pointer: boolean;
}

/**
 * Goal-picker inputs. Supplying this makes the rail show ONE goal at a time with
 * a switcher; omitting it stacks every goal. Layout is identical either way —
 * only the control differs — so the two surfaces cannot drift into different
 * shapes the way they did when each hand-rolled its own branch.
 */
export interface ProjectArtifactsGoalPicker {
  selectedGoalId: string | null;
  onSelectGoal: (goalId: string) => void;
  titles: Record<string, string>;
  ratings: Record<string, number | undefined>;
  options: Array<{ value: string; label: string; chain: string }>;
}

export interface ProjectArtifactsRailProps {
  entries: ProjectArtifactEntry[];
  error?: string | null;
  view: 'sel' | 'fav';
  favorites: ReadonlySet<string>;
  onOpen: (entry: ProjectArtifactEntry, kind: ArtifactKind) => void;
  /** Omitted on read-only surfaces — the row then renders no star and no share. */
  onToggleFavorite?: (path: string) => void;
  onShare?: (path: string) => void;
  /** Omitted for a flat listing (a workspace rail, or a non-main source). */
  picker?: ProjectArtifactsGoalPicker;
  /** Copy for the empty state — differs by surface. */
  emptyHint?: string;
}

interface GoalSection {
  goalId: string;
  kindGroups: Array<readonly [ArtifactKind, ProjectArtifactEntry[]]>;
}

/**
 * Artifacts live under `goals/<id>/` (docs/ARTIFACTS-FS.md), so the rail groups
 * BY GOAL first and by kind within it. The project-root section (goalId '')
 * sorts last: it is the residue, not the headline.
 */
export function groupArtifactsByGoal(entries: ProjectArtifactEntry[]): GoalSection[] {
  const byGoal = new Map<string, ProjectArtifactEntry[]>();
  for (const e of entries) {
    const prefix = goalPrefixOf(e.path);
    const id = prefix ? prefix.slice('goals/'.length, -1) : '';
    (byGoal.get(id) ?? byGoal.set(id, []).get(id)!).push(e);
  }
  const sections = [...byGoal.entries()].map(([goalId, list]) => {
    const byKind = new Map<ArtifactKind, ProjectArtifactEntry[]>();
    for (const e of list) {
      const k = classifyArtifact(e.path);
      (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(e);
    }
    return {
      goalId,
      kindGroups: KIND_ORDER.map((k) => [k, byKind.get(k) ?? []] as const).filter(([, a]) => a.length > 0),
    };
  });
  sections.sort((a, b) => (a.goalId === '' ? 1 : b.goalId === '' ? -1 : a.goalId.localeCompare(b.goalId)));
  return sections;
}

export function ProjectArtifactsRail({
  entries,
  error,
  view,
  favorites,
  onOpen,
  onToggleFavorite,
  onShare,
  picker,
  emptyHint,
}: ProjectArtifactsRailProps): ReactElement {
  const sections = groupArtifactsByGoal(entries);
  const realGoalSections = sections.filter((s) => s.goalId !== '');
  const projectSection = sections.find((s) => s.goalId === '') ?? null;


  const row = (e: ProjectArtifactEntry, displayName?: string): ReactElement => {
    const kind = classifyArtifact(e.path);
    const name = displayName ?? (e.path.split('/').pop() ?? e.path);
    return (
      <div
        key={e.path}
        onClick={() => onOpen(e, kind)}
        title={e.path}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-[11.5px] text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]"
      >
        <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">{KIND_ICON[kind]}</span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {e.pointer && <span className="flex-shrink-0 rounded-full border border-[#2a2413] px-1 text-[9px] text-[var(--gs-warning)]">lfs</span>}
        {onShare && (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onShare(e.path); }}
            title="Share — copy a public link to this artifact (requires serve)"
            className="flex-shrink-0 px-0.5 text-[12px] text-[var(--gs-text-dim)] hover:text-[var(--gs-accent)]"
          >
            ↗
          </button>
        )}
        {onToggleFavorite && (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onToggleFavorite(e.path); }}
            title="favorite"
            className={`flex-shrink-0 px-0.5 text-[12px] ${favorites.has(e.path) ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)]'}`}
          >
            ★
          </button>
        )}
      </div>
    );
  };

  const kindGroup = (kind: ArtifactKind, files: ProjectArtifactEntry[], goalRelative: boolean): ReactElement => (
    <div key={kind}>
      <div className="px-3 pb-[3px] pt-[9px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{KIND_LABEL[kind]}</div>
      {files.map((e) => row(e, goalRelative ? toGoalRelative(e.path) : undefined))}
    </div>
  );

  if (error) {
    return <div className="px-3 py-3 text-[11px] text-[var(--gs-danger)]">{error}</div>;
  }

  if (view === 'fav') {
    const favEntries = entries.filter((e) => favorites.has(e.path));
    return favEntries.length === 0
      ? <div className="px-3 py-[18px] text-[12px] text-[var(--gs-text-dim)]">No favorites yet — ★ an artifact to pin it across the project.</div>
      : <>{favEntries.map((e) => row(e))}</>;
  }

  if (sections.length === 0) {
    return (
      <div className="px-3 py-[18px] text-[12px] text-[var(--gs-text-dim)]">
        No artifacts in this source yet.
        {emptyHint && <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">{emptyHint}</div>}
      </div>
    );
  }

  // ONE layout. Goal sections are headed by the picker when the surface supplies
  // one and by a plain title when it does not; the project-root section is always
  // headed "Project". Previously these were two hand-written branches, so the
  // same artifacts gained or lost a section header depending on whether a
  // rolled-up goal happened to exist elsewhere in the listing.
  const goalSectionsToShow = picker
    ? realGoalSections.filter((s) => s.goalId === (picker.selectedGoalId ?? realGoalSections[0]?.goalId))
    : realGoalSections;

  return (
    <>
      {goalSectionsToShow.map((sec) => (
        <div key={sec.goalId}>
          {picker ? (
            <GoalHeaderPicker
              goalId={sec.goalId}
              title={picker.titles[sec.goalId] ?? sec.goalId}
              rating={picker.ratings[sec.goalId]}
              options={picker.options}
              onChange={picker.onSelectGoal}
            />
          ) : (
            <div className="mt-1.5 flex items-baseline border-b border-[var(--gs-border-muted)] px-3 pb-[5px] pt-[11px]">
              <span className="min-w-0 truncate text-[11.5px] font-medium text-[var(--gs-text)]" title={`goals/${sec.goalId}/`}>
                {sec.goalId}
              </span>
            </div>
          )}
          {sec.kindGroups.map(([kind, files]) => kindGroup(kind, files, true))}
        </div>
      ))}
      {projectSection && (
        <div key="·project">
          <div className="mt-1.5 flex items-baseline border-b border-[var(--gs-border-muted)] px-3 pb-[5px] pt-[11px]">
            <span className="text-[11.5px] font-medium text-[var(--gs-text)]" title="project-root artifacts">Project</span>
          </div>
          {projectSection.kindGroups.map(([kind, files]) => kindGroup(kind, files, false))}
        </div>
      )}
    </>
  );
}
