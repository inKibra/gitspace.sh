/** @jsxImportSource react */
/**
 * WorkspaceDetailPage — full-screen workspace detail view.
 *
 * Matches the TUI `state.view === 'workspace-detail'` layout:
 * workspace pill bar at top, sidebar + main terminal area.
 * The kanban board is NOT visible — navigation back to the board is via onBack/onClose.
 */

import type { ReactNode } from 'react';
import { WorkspaceDetailPaneWeb } from '../components/WorkspaceDetailPane.web.js';
import type { WorkspaceDetailPaneProps } from '../components/WorkspaceDetailPane.js';

export type WorkspaceDetailPageProps = WorkspaceDetailPaneProps & {
  /** Terminal outlet rendered in the main content area. */
  children?: ReactNode;
};

export function WorkspaceDetailPage({ children, ...props }: WorkspaceDetailPageProps) {
  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
      <WorkspaceDetailPaneWeb {...props}>
        {children}
      </WorkspaceDetailPaneWeb>
    </div>
  );
}
