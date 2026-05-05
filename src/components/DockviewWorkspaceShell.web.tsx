/** @jsxImportSource react */

import { useCallback, useRef, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';

type PanelParams = {
  content: 'workspace' | 'terminal';
  renderWorkspace: () => ReactNode;
  renderTerminal: () => ReactNode;
};

function DockPanel(props: IDockviewPanelProps<PanelParams>) {
  const { content, renderWorkspace, renderTerminal } = props.params;
  return (
    <div className="h-full min-h-0 bg-[var(--gs-bg)] overflow-hidden">
      {content === 'terminal' ? renderTerminal() : renderWorkspace()}
    </div>
  );
}

export interface DockviewWorkspaceShellProps {
  backendKey: string;
  workspaceId: string;
  showTerminal: boolean;
  renderWorkspace: () => ReactNode;
  renderTerminal: () => ReactNode;
}

export function DockviewWorkspaceShell({
  backendKey,
  workspaceId,
  showTerminal,
  renderWorkspace,
  renderTerminal,
}: DockviewWorkspaceShellProps) {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;


    if (!event.api.getPanel('workspace')) {
      event.api.addPanel({
        id: 'workspace',
        component: 'panel',
        title: 'Workspace',
        params: { content: 'workspace', renderWorkspace, renderTerminal },
      });
    }

    if (showTerminal && !event.api.getPanel('terminal')) {
      event.api.addPanel({
        id: 'terminal',
        component: 'panel',
        title: 'Terminal',
        params: { content: 'terminal', renderWorkspace, renderTerminal },
        position: { direction: 'right', referencePanel: 'workspace' },
      });
    }

  }, [renderTerminal, renderWorkspace, showTerminal]);

  return (
    <div key={`${backendKey}:${workspaceId}`} className="h-screen w-screen min-h-0 dockview-theme-dark bg-[var(--gs-bg)]">
      <DockviewReact
        className="dockview-theme-dark"
        components={{ panel: DockPanel }}
        onReady={onReady}
      />
    </div>
  );
}
