/** @jsxImportSource react */
/**
 * ProjectList - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useProjectList hook.
 */

import { useEffect, useRef } from 'react';
import type { UseProjectListReturn } from './ProjectList.js';
import { formatWorkspaceCount, getShortRepoName } from './ProjectList.js';

// ============================================================================
// Component
// ============================================================================

export interface ProjectListWebProps extends UseProjectListReturn {
  embedded?: boolean;
  title?: string;
}

export function ProjectListWeb(props: ProjectListWebProps) {
  const {
    items,
    isEmpty,
    activateIndex,
    deleteIndex,
    createNew,
    refresh,
    embedded = false,
    title = 'Projects',
  } = props;
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [items]);

  const shellClassName = embedded
    ? 'h-full flex flex-col bg-[#0d1117]'
    : 'h-screen flex flex-col bg-[#0d1117]';

  // Empty state
  if (isEmpty) {
    return (
      <div className={shellClassName}>
        <Header title={title} onRefresh={refresh} onCreateNew={createNew} />
        <div className="flex-1 flex flex-col items-center justify-center text-[#8b949e] px-4">
          <div className="text-lg mb-2 text-center">No projects</div>
          <button
            onClick={createNew}
            className="mt-3 px-4 py-3 rounded-lg bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium min-h-[48px] shadow-glow"
          >
            Create your first project
          </button>
        </div>
        {!embedded && <Footer />}
      </div>
    );
  }

  return (
    <div className={shellClassName}>
      <Header title={title} onRefresh={refresh} onCreateNew={createNew} />

      <div className="flex-1 overflow-y-auto min-h-0">
        {items.map((project) => (
          <div
            key={project.name}
            ref={project.isSelected ? selectedRowRef : null}
            onClick={() => activateIndex(project.index)}
            className={`
              px-4 py-3 cursor-pointer border-b border-[#30363d] flex items-center justify-between gap-3 min-h-[56px]
              ${project.isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
            `}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded bg-[#21262d] border border-[#30363d] flex items-center justify-center text-lg flex-shrink-0">
                📁
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[#e6edf3] font-medium truncate">{project.name}</span>
                </div>
                <div className="text-xs text-[#8b949e] truncate">
                  {getShortRepoName(project.repository)} · {formatWorkspaceCount(project.workspaceCount)}
                </div>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteIndex(project.index);
              }}
              className="text-[#6e7681] hover:text-[#ff7b72] p-2 rounded min-h-[40px] min-w-[40px]"
              title="Delete project"
            >
              🗑️
            </button>
          </div>
        ))}
      </div>

      {!embedded && <Footer />}
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function Header({
  title,
  onRefresh,
  onCreateNew,
}: {
  title: string;
  onRefresh: () => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d] gap-3">
      <div className="text-[#e6edf3] font-medium truncate">{title}</div>
      <div className="flex gap-2">
        <button
          onClick={onRefresh}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] px-2 py-1 min-h-[40px]"
        >
          Refresh
        </button>
        <button
          onClick={onCreateNew}
          className="text-sm bg-[#22c55e] hover:bg-[#16a34a] text-[#0d1117] px-3 py-1 rounded min-h-[40px] font-medium"
        >
          + New Project
        </button>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="bg-[#161b22] px-4 py-2 border-t border-[#30363d] text-xs text-[#6e7681] flex gap-4">
      <span>↑↓ Navigate</span>
      <span>Enter Select</span>
      <span>n New</span>
      <span>d Delete</span>
      <span>r Refresh</span>
      <span>Esc Back</span>
    </div>
  );
}
