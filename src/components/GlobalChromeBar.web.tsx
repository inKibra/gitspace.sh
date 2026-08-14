/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkspacePhase } from '../types/config.js';

/**
 * Global chrome bar (mock App.tsx .topbar + ActivityStrip): brand + project
 * crumb + open-workspace chips (status dot · mono name · STAGE) + inbox/⌘K.
 * Rendered above both the board and the workspace shell.
 */

export interface ChromeWorkspaceChip {
  key: string;
  name: string;
  /** Owning project — what the switcher filters on. */
  projectName: string;
  phase: WorkspacePhase;
  /** Status dot color (resolved --gs-* value or css color). */
  statusColor: string;
  statusLabel?: string;
}

export function GlobalChromeBar({ projects, currentProjectName, workspaces, activeKey, projectActive, onBoard, onEnterProject, onFilterProject, onSelectWorkspace, inboxCount = 0, onOpenInbox, onOpenPalette, onReportProblem, rightExtra }: {
  /** Every project on the active backend, in board order. */
  projects?: Array<{ name: string }>;
  /** The project in scope: labels the switcher AND filters the chips. */
  currentProjectName?: string | null;
  workspaces: ChromeWorkspaceChip[];
  activeKey?: string | null;
  /** True while that project's own surface is what's showing. */
  projectActive?: boolean;
  /** The brand still goes to the cross-project board. */
  onBoard: () => void;
  /** Clicking the switcher's name enters that project. */
  onEnterProject?: (name: string) => void;
  /** Choosing from the menu scopes the bar (and the chips) to a project;
   *  `null` widens back to every project. */
  onFilterProject?: (name: string | null) => void;
  onSelectWorkspace: (key: string) => void;
  inboxCount?: number;
  onOpenInbox?: () => void;
  onOpenPalette?: () => void;
  onReportProblem?: () => void;
  rightExtra?: ReactElement | null;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // A menu that outlives a click elsewhere is a trap, and Escape is the exit
  // people try first. Listeners only exist while it is open.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const hasProjects = !!projects && projects.length > 0;
  return (
    <div className="gs-ui flex h-[42px] flex-shrink-0 items-center gap-3.5 border-b border-[var(--gs-border)] bg-[#050505] px-4">
      <button type="button" onClick={onBoard} className="text-[13px] font-semibold tracking-[.01em] text-[var(--gs-text)]">GitSpace</button>
      {/* The switcher stands where the board chip used to, but OUTSIDE the chip
       *  scroller below: that scroller is `overflow-x-auto`, which establishes a
       *  clipping context, so a dropdown rendered inside it is cut off at the
       *  42px bar and appears not to open at all. `ml-1.5` keeps it flush where
       *  the strip starts.
       *
       *  Two actions on purpose: the NAME enters the project, the caret scopes
       *  the strip to it. A native <select> can do neither — it has no clickable
       *  label. */}
      {hasProjects && (
        <div ref={menuRef} className="relative ml-1.5 flex items-stretch self-stretch border-l border-[var(--gs-border)]">
          <button
            type="button"
            title={currentProjectName ? `Open ${currentProjectName}` : 'Pick a project'}
            onClick={() => {
              if (currentProjectName && onEnterProject) onEnterProject(currentProjectName);
              else setMenuOpen((v) => !v);
            }}
            className={`flex items-center gap-1.5 whitespace-nowrap pl-[11px] pr-1.5 text-[11.5px] transition-colors ${projectActive ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`}
          >
            ⊞ {currentProjectName ?? 'all projects'}
          </button>
          <button
            type="button"
            aria-label="Switch project"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className={`flex items-center pr-[9px] text-[9px] transition-colors ${projectActive ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text-muted)]' : 'text-[var(--gs-text-dim)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`}
          >
            ▾
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full z-50 min-w-[200px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 shadow-lg">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onFilterProject?.(null); }}
                className={`block w-full px-3 py-1 text-left text-[11.5px] hover:bg-[var(--gs-bg-hover)] ${currentProjectName ? 'text-[var(--gs-text-muted)]' : 'text-[var(--gs-text)]'}`}
              >
                all projects
              </button>
              {projects.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => { setMenuOpen(false); onFilterProject?.(p.name); }}
                  className={`block w-full px-3 py-1 text-left text-[11.5px] hover:bg-[var(--gs-bg-hover)] ${p.name === currentProjectName ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)]'}`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Chip scroller. Kept separate from the switcher above because
       *  `overflow-x-auto` clips absolutely positioned children. */}
      <div className="flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto">
        {workspaces.map((w) => (
          <button
            key={w.key}
            type="button"
            title={w.statusLabel}
            onClick={() => onSelectWorkspace(w.key)}
            className={`flex items-center gap-1.5 whitespace-nowrap border-l border-[var(--gs-border)] px-[11px] text-[11.5px] transition-colors ${w.key === activeKey ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`}
          >
            <span className="h-[6px] w-[6px] flex-none" style={{ background: w.statusColor }} />
            <span className="font-[family-name:var(--gs-font)]">{w.name}</span>
            <span className="text-[10px] uppercase tracking-[.05em] text-[var(--gs-text-dim)]">{w.phase}</span>
          </button>
        ))}
      </div>
      <div className="gs-chrome-actions ml-auto flex flex-shrink-0 items-center gap-2">
        {rightExtra}
        {onReportProblem && (
          <button type="button" onClick={onReportProblem} title="Report a problem" className="px-1 text-[13px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]">
            ⚠
          </button>
        )}
        {onOpenInbox && (
          <button type="button" onClick={onOpenInbox} title="Inbox" className="relative px-1 text-[13px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]">
            ⚑
            {inboxCount > 0 && (
              <span className="absolute -right-1.5 -top-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--gs-info)] px-0.5 text-[9px] font-semibold text-black">{inboxCount}</span>
            )}
          </button>
        )}
        {onOpenPalette && (
          <button type="button" onClick={onOpenPalette} className="border border-[var(--gs-border)] px-1.5 py-px font-[family-name:var(--gs-font)] text-[10px] text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">⌘K</button>
        )}
      </div>
    </div>
  );
}
