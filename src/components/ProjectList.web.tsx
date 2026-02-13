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

export function ProjectListWeb(props: UseProjectListReturn) {
  const {
    items,
    isEmpty,
    selectIndex,
    selectProject,
    createNew,
    deleteSelected,
    refresh,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <Header onRefresh={refresh} onCreateNew={createNew} />
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
          <div className="text-lg mb-2">No projects</div>
          <button
            onClick={createNew}
            className="text-blue-400 hover:text-blue-300"
          >
            Create your first project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      <Header onRefresh={refresh} onCreateNew={createNew} />

      <div className="flex-1 overflow-y-auto">
        {items.map((project) => (
          <div
            key={project.name}
            onClick={() => {
              selectIndex(project.index);
              selectProject();
            }}
            className={`
              px-4 py-3 cursor-pointer border-b border-gray-800 flex items-center justify-between
              ${project.isSelected ? 'bg-gray-700 border-l-4 border-l-blue-500' : 'hover:bg-gray-800'}
            `}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-gray-700 flex items-center justify-center text-lg">
                📁
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium">{project.name}</span>
                  {project.isCurrent && (
                    <span className="text-xs px-2 py-0.5 rounded bg-yellow-900 text-yellow-300">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  {getShortRepoName(project.repository)} · {formatWorkspaceCount(project.workspaceCount)}
                </div>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                selectIndex(project.index);
                deleteSelected();
              }}
              className="text-gray-600 hover:text-red-400 p-2"
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
}: {
  onRefresh: () => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="bg-gray-800 px-4 py-3 flex items-center justify-between border-b border-gray-700">
      <div className="text-white font-medium">Projects</div>
      <div className="flex gap-2">
        <button
          onClick={onRefresh}
          className="text-sm text-gray-400 hover:text-white px-2 py-1"
        >
          Refresh
        </button>
        <button
          onClick={onCreateNew}
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded"
        >
          + New Project
        </button>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="bg-gray-800 px-4 py-2 border-t border-gray-700 text-xs text-gray-500 flex gap-4">
      <span>↑↓ Navigate</span>
      <span>Enter Select</span>
      <span>n New</span>
      <span>d Delete</span>
      <span>r Refresh</span>
      <span>Esc Back</span>
    </div>
  );
}
