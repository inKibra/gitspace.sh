/** @jsxImportSource react */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';

type PanelParams = {
  renderTerminal: () => ReactNode;
};

function DockPanel(props: IDockviewPanelProps<PanelParams>) {
  const { renderTerminal } = props.params;
  return <div className="h-full min-h-0 bg-[var(--gs-bg)] overflow-hidden">{renderTerminal()}</div>;
}

export interface DockviewWorkspaceShellProps {
  backendKey: string;
  workspaceId: string;
  showTerminal: boolean;
  renderTerminal: () => ReactNode;
}

export function DockviewWorkspaceShell({
  backendKey,
  workspaceId,
  showTerminal,
  renderTerminal,
}: DockviewWorkspaceShellProps) {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);

  const syncPanels = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;

    const terminalParams: PanelParams = { renderTerminal };
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
        });
      }
    } else if (terminalPanel) {
      api.removePanel(terminalPanel);
    }
  }, [renderTerminal, showTerminal]);


  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    syncPanels();
  }, [syncPanels]);

  useEffect(() => {
    syncPanels();
  }, [syncPanels]);

  return (
    <div key={`${backendKey}:${workspaceId}`} className="h-full w-full min-h-0 dockview-theme-dark bg-[var(--gs-bg)]">
      <DockviewReact
        className="dockview-theme-dark"
        components={{ panel: DockPanel }}
        onReady={onReady}
      />
    </div>
  );
}
