/**
 * ProjectList - TUI Display Component
 *
 * Dumb presentational component for OpenTUI.
 * Receives all state and actions from useProjectList hook.
 */

import type { UseProjectListReturn } from './ProjectList.js';
import { formatWorkspaceCount } from './ProjectList.js';

// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  current: '#FFAA00',
  repository: '#888888',
};

// ============================================================================
// Props
// ============================================================================

interface ProjectListTUIProps extends UseProjectListReturn {
  focused?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function ProjectListTUI(props: ProjectListTUIProps) {
  const {
    items,
    isEmpty,
    focused = true,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={focused ? COLORS.borderFocused : COLORS.border}
      >
        <text fg={COLORS.title} paddingLeft={1}>
          {' '}Projects{' '}
        </text>
        <box
          flexDirection="column"
          paddingLeft={1}
          paddingTop={1}
          flexGrow={1}
          justifyContent="center"
          alignItems="center"
        >
          <text fg={COLORS.textDim}>No projects</text>
          <text fg={COLORS.textDim} paddingTop={1}>
            Press [n] to add one
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? COLORS.borderFocused : COLORS.border}
    >
      <text fg={COLORS.title} paddingLeft={1}>
        {' '}Projects{' '}
      </text>
      <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} overflow="scroll">
        {items.map((project) => {
          const isSelected = project.isSelected && focused;
          const prefix = isSelected ? '>' : ' ';
          const currentIndicator = project.isCurrent ? '*' : '';

          return (
            <box key={project.name} flexDirection="column" height={2}>
              <text
                fg={isSelected ? COLORS.selected : project.isCurrent ? COLORS.current : COLORS.text}
                height={1}
              >
                {prefix} {project.name} {currentIndicator}
              </text>
              <text fg={COLORS.repository} height={1}>
                {'  '}{project.repository} ({formatWorkspaceCount(project.workspaceCount)})
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
}
