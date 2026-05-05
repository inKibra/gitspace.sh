/** @jsxImportSource react */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';

export interface DockviewTerminalPanel {
  id: string;
  title: string;
  render: () => ReactNode;
}

type PanelParams = {
  render: () => ReactNode;
};

function DockPanel(props: IDockviewPanelProps<PanelParams>) {
  const { render } = props.params;
  return <div className="h-full min-h-0 bg-[var(--gs-bg)] overflow-hidden flex flex-col">{render()}</div>;
}

export interface DockviewWorkspaceShellProps {
  backendKey: string;
  workspaceId: string;
  panels: DockviewTerminalPanel[];
}

export function DockviewWorkspaceShell({
  backendKey,
  workspaceId,
  panels,
}: DockviewWorkspaceShellProps) {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);

  const syncPanels = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;

    const nextPanelIds = new Set(panels.map((panel) => panel.id));
    for (const existingPanel of [...api.panels]) {
      if (!nextPanelIds.has(existingPanel.id)) {
        api.removePanel(existingPanel);
      }
    }

    for (const panel of panels) {
      const params: PanelParams = { render: panel.render };
      const existingPanel = api.getPanel(panel.id);
      if (existingPanel) {
        existingPanel.setTitle(panel.title);
        existingPanel.api.updateParameters(params);
        continue;
      }
      api.addPanel({
        id: panel.id,
        component: 'panel',
        title: panel.title,
        params,
      });
    }
  }, [panels]);


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
