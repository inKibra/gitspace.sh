/** @jsxImportSource react */
import type { ReactElement } from 'react';
import type { WorkspacePhase } from '../types/config.js';

/**
 * Global chrome bar (mock App.tsx .topbar + ActivityStrip): brand + project
 * crumb + open-workspace chips (status dot · mono name · STAGE) + inbox/⌘K.
 * Rendered above both the board and the workspace shell.
 */

export interface ChromeWorkspaceChip {
  key: string;
  name: string;
  phase: WorkspacePhase;
  /** Status dot color (resolved --gs-* value or css color). */
  statusColor: string;
  statusLabel?: string;
}

export function GlobalChromeBar({ projectName, workspaces, activeKey, boardActive, onBoard, onProject, onSelectWorkspace, inboxCount = 0, onOpenInbox, onOpenPalette, onReportProblem, rightExtra }: {
  projectName?: string;
  workspaces: ChromeWorkspaceChip[];
  activeKey?: string | null;
  boardActive?: boolean;
  onBoard: () => void;
  onProject?: () => void;
  onSelectWorkspace: (key: string) => void;
  inboxCount?: number;
  onOpenInbox?: () => void;
  onOpenPalette?: () => void;
  onReportProblem?: () => void;
  rightExtra?: ReactElement | null;
}): ReactElement {
  return (
    <div className="gs-ui flex h-[42px] flex-shrink-0 items-center gap-3.5 border-b border-[var(--gs-border)] bg-[#050505] px-4">
      <button type="button" onClick={onBoard} className="text-[13px] font-semibold tracking-[.01em] text-[var(--gs-text)]">GitSpace</button>
      {projectName && (
        <button type="button" onClick={onProject} disabled={!onProject} className="text-[12px] text-[var(--gs-text-muted)]">
          <b className="font-medium text-[var(--gs-text)]">{projectName}</b>
        </button>
      )}
      {/* activity strip — board chip + workspace chips */}
      <div className="ml-1.5 flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto">
        <button
          type="button"
          onClick={onBoard}
          className={`flex items-center gap-1.5 whitespace-nowrap border-l border-[var(--gs-border)] px-[11px] text-[11.5px] transition-colors ${boardActive ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`}
        >
          ⊞ board
        </button>
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
