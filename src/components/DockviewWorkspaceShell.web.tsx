/** @jsxImportSource react */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
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

  const syncPanels = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;

    const workspaceParams: PanelParams = { content: 'workspace', renderWorkspace, renderTerminal };
    const terminalParams: PanelParams = { content: 'terminal', renderWorkspace, renderTerminal };

    const workspacePanel = api.getPanel('workspace');
    if (workspacePanel) {
      workspacePanel.api.updateParameters(workspaceParams);
    } else {
      api.addPanel({
        id: 'workspace',
        component: 'panel',
        title: 'Workspace',
        params: workspaceParams,
      });
    }

    const terminalPanel = api.getPanel('terminal');
    if (showTerminal) {
      if (terminalPanel) {
        terminalPanel.api.updateParameters(terminalParams);
      } else {
        api.addPanel({
          id: 'terminal',
          component: 'panel',
          title: 'Terminal',
          params: terminalParams,
          position: { direction: 'right', referencePanel: 'workspace' },
        });
      }
    } else if (terminalPanel) {
      api.removePanel(terminalPanel);
    }
  }, [renderTerminal, renderWorkspace, showTerminal]);


  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    syncPanels();
  }, [syncPanels]);

  useEffect(() => {
    syncPanels();
  }, [syncPanels]);

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
