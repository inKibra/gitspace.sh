/** @jsxImportSource react */
import { type ReactElement } from 'react';
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

export interface ProjectArtifactEntry {
  path: string;
  size: number;
  pointer: boolean;
}

/** Goal-picker inputs. Absent on surfaces that show a flat listing. */
export interface ProjectArtifactsGoalPicker {
  selectedGoalId: string | null;
  onSelectGoal: (goalId: string) => void;
  titles: Record<string, string>;
  ratings: Record<string, number | undefined>;
  options: Array<{ value: string; label: string; chain: string }>;
  /** Rendered header — project home supplies its picker control. */
  renderHeader: (args: { goalId: string; title: string; rating: number | undefined }) => ReactElement;
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
  // The picker only makes sense when there is a rolled-up goal to pick.
  const pickerActive = picker != null && realGoalSections.length >= 1;

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

  if (pickerActive && picker) {
    // On main: exactly ONE rolled-up goal (its header IS the picker) + the
    // Project section below. No stacked "all goals".
    const sec = realGoalSections.find((s) => s.goalId === picker.selectedGoalId) ?? realGoalSections[0];
    return (
      <>
        {sec && (
          <div key={sec.goalId}>
            {picker.renderHeader({
              goalId: sec.goalId,
              title: picker.titles[sec.goalId] ?? sec.goalId,
              rating: picker.ratings[sec.goalId],
            })}
            {sec.kindGroups.map(([kind, files]) => kindGroup(kind, files, true))}
          </div>
        )}
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

  // Flat: a non-main source, a workspace rail, or a listing with no goals.
  return (
    <>
      {sections.map((sec) => (
        <div key={sec.goalId || '·project'}>
          {sec.kindGroups.map(([kind, files]) => kindGroup(kind, files, sec.goalId !== ''))}
        </div>
      ))}
    </>
  );
}
