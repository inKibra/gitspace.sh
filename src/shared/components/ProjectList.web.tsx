/** @jsxImportSource react */
/**
 * ProjectList - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useProjectList hook.
 */

import type { UseProjectListReturn } from './ProjectList.js';
import { formatWorkspaceCount, getShortRepoName } from './ProjectList.js';

// ============================================================================
// Component
// ============================================================================

export function ProjectListWeb(props: UseProjectListReturn & { onClose?: () => void }) {
  const {
    items,
    isEmpty,
    selectProjectAtIndex,
    createNew,
    deleteAtIndex,
    refresh,
    onClose,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-full flex flex-col bg-[#0d1117]">
        <Header onRefresh={refresh} onCreateNew={createNew} onClose={onClose} />
        <div className="flex-1 flex flex-col items-center justify-center text-[#8b949e]">
          <div className="text-lg mb-2">No projects</div>
          <button
            onClick={createNew}
            className="text-sm text-[#58a6ff] hover:text-[#79c0ff]"
          >
            Create your first project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0d1117]">
      <Header onRefresh={refresh} onCreateNew={createNew} onClose={onClose} />

      <div className="flex-1 overflow-y-auto">
        {items.map((project) => (
          <div
            key={project.name}
            onClick={() => {
              selectProjectAtIndex(project.index);
            }}
            className={
              `
              px-4 py-3 cursor-pointer border-b border-[#30363d] flex items-center justify-between
              ${project.isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22]'}
            `
            }
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded bg-[#21262d] border border-[#30363d] flex items-center justify-center text-lg">
                📁
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[#e6edf3] font-medium truncate">{project.name}</span>
                  {project.isCurrent && (
                    <span className="text-xs px-2 py-0.5 rounded bg-[#238636] text-[#e6edf3]">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#6e7681] truncate">
                  {getShortRepoName(project.repository)} · {formatWorkspaceCount(project.workspaceCount)}
                </div>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteAtIndex(project.index);
              }}
              className="text-[#6e7681] hover:text-[#f85149] p-2"
              title="Delete project"
            >
              🗑️
            </button>
          </div>
        ))}
      </div>

      <Footer />
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function Header({
  onRefresh,
  onCreateNew,
  onClose,
}: {
  onRefresh: () => void;
  onCreateNew: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d]">
      <div className="flex items-center gap-2">
        {onClose && (
          <button
            onClick={onClose}
            className="text-sm text-[#8b949e] hover:text-[#e6edf3] px-2 py-1"
          >
            ←
          </button>
        )}
        <div className="text-[#e6edf3] font-medium">Projects</div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onRefresh}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] px-2 py-1"
        >
          Refresh
        </button>
        <button
          onClick={onCreateNew}
          className="text-sm bg-[#1f6feb] hover:bg-[#388bfd] text-[#e6edf3] px-3 py-1 rounded"
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
