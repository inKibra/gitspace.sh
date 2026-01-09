/**
 * ProjectList - Shared Hook
 *
 * Hook that manages project list state and actions.
 * Used by both web and TUI renderers.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Project info from local config */
export interface ProjectInfo {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
  lastAccessed?: Date;
}

/** Project item with selection state */
export interface ProjectListItem extends ProjectInfo {
  isSelected: boolean;
  index: number;
}

/** Props for useProjectList hook */
export interface UseProjectListProps {
  projects: ProjectInfo[];
  onSelect: (project: ProjectInfo) => void;
  onCreateNew: () => void;
  onDelete: (project: ProjectInfo) => void;
  onRefresh: () => void;
}

/** Return type of useProjectList hook */
export interface UseProjectListReturn {
  // Display data
  items: ProjectListItem[];
  selectedIndex: number;
  selectedProject: ProjectInfo | null;

  // Computed flags
  isEmpty: boolean;

  // Actions
  moveUp: () => void;
  moveDown: () => void;
  selectIndex: (index: number) => void;
  selectProject: () => void;
  createNew: () => void;
  deleteSelected: () => void;
  refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useProjectList(props: UseProjectListProps): UseProjectListReturn {
  const {
    projects,
    onSelect,
    onCreateNew,
    onDelete,
    onRefresh,
  } = props;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(() => {
    // Default to current project
    const currentIdx = projects.findIndex(p => p.isCurrent);
    return currentIdx >= 0 ? currentIdx : 0;
  });

  // Build items with selection state
  const items = useMemo(
    () =>
      projects.map((project, index) => ({
        ...project,
        isSelected: index === selectedIndex,
        index,
      })),
    [projects, selectedIndex]
  );

  // Selected project
  const selectedProject = projects[selectedIndex] ?? null;

  // Computed
  const isEmpty = projects.length === 0;

  // Clamp selection when list changes
  useEffect(() => {
    if (selectedIndex >= projects.length && projects.length > 0) {
      setSelectedIndex(projects.length - 1);
    }
  }, [projects.length, selectedIndex]);

  // Actions
  const moveUp = useCallback(() => {
    setSelectedIndex(i => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex(i => Math.min(projects.length - 1, i + 1));
  }, [projects.length]);

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(index, projects.length - 1)));
  }, [projects.length]);

  const selectProject = useCallback(() => {
    if (selectedProject) {
      onSelect(selectedProject);
    }
  }, [selectedProject, onSelect]);

  const createNew = useCallback(() => {
    onCreateNew();
  }, [onCreateNew]);

  const deleteSelected = useCallback(() => {
    if (selectedProject) {
      onDelete(selectedProject);
    }
  }, [selectedProject, onDelete]);

  const refresh = useCallback(() => {
    console.log("[ProjectList] refresh() called");
    onRefresh();
  }, [onRefresh]);

  return {
    // Display data
    items,
    selectedIndex,
    selectedProject,

    // Computed flags
    isEmpty,

    // Actions
    moveUp,
    moveDown,
    selectIndex,
    selectProject,
    createNew,
    deleteSelected,
    refresh,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/** Get display name for project */
export function getProjectDisplayName(project: ProjectInfo): string {
  return project.name;
}

/** Get short repository name from full repo string */
export function getShortRepoName(repository: string): string {
  const parts = repository.split('/');
  return parts[parts.length - 1] || repository;
}

/** Format workspace count for display */
export function formatWorkspaceCount(count: number): string {
  if (count === 0) return 'No workspaces';
  if (count === 1) return '1 workspace';
  return `${count} workspaces`;
}
