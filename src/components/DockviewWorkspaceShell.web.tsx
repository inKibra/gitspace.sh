/** @jsxImportSource react */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview-react';

export interface DockviewTerminalPanel {
  id: string;
  title: string;
  render: () => ReactNode;
  onClose?: () => void;
}

type PanelParams = {
  render: () => ReactNode;
  onClose?: () => void;
};

function DockPanel(props: IDockviewPanelProps<PanelParams>) {
  const { render } = props.params;
  return <div className="h-full min-h-0 bg-[var(--gs-bg)] overflow-hidden flex flex-col">{render()}</div>;
}

function DockTab(props: IDockviewPanelHeaderProps<PanelParams>) {
  const title = props.api.title;
  const onClose = props.params.onClose;
  const stopTabEvent = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div className="flex items-center gap-2 min-w-0 max-w-full px-1">
      <span className="truncate">{title}</span>
      {onClose ? (
        <button
          type="button"
          className="text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] leading-none px-1"
          onMouseDown={stopTabEvent}
          onPointerDown={stopTabEvent}
          onClick={(event) => {
            stopTabEvent(event);
            props.api.close();
            void Promise.resolve(onClose()).catch(() => undefined);
          }}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export interface DockviewWorkspaceShellProps {
  backendKey: string;
  workspaceId: string;
  panels: DockviewTerminalPanel[];
  initialLayout?: unknown;
  onLayoutChange?: (layout: unknown) => void;
  isActive?: boolean;
  onApiChange?: (api: DockviewReadyEvent['api'] | null) => void;
}

export function DockviewWorkspaceShell({
  backendKey,
  workspaceId,
  panels,
  initialLayout,
  onLayoutChange,
  isActive = true,
  onApiChange,
}: DockviewWorkspaceShellProps) {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const restoredLayoutRef = useRef(false);
  const restoringLayoutRef = useRef(false);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const isActiveRef = useRef(isActive);
  onLayoutChangeRef.current = onLayoutChange;
  const onApiChangeRef = useRef(onApiChange);
  onApiChangeRef.current = onApiChange;

  const saveLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api || restoringLayoutRef.current || !isActiveRef.current) return;
    onLayoutChangeRef.current?.(api.toJSON());
  }, []);

  const syncPanels = useCallback((force = false) => {
    const api = apiRef.current;
    if (!api) return;
    if (!force && !isActiveRef.current) return;

    const nextPanelIds = new Set(panels.map((panel) => panel.id));
    for (const existingPanel of [...api.panels]) {
      if (!nextPanelIds.has(existingPanel.id)) {
        api.removePanel(existingPanel);
      }
    }

    for (const panel of panels) {
      const params: PanelParams = { render: panel.render, onClose: panel.onClose };
      const existingPanel = api.getPanel(panel.id);
      if (existingPanel) {
        existingPanel.setTitle(panel.title);
        existingPanel.api.updateParameters(params);
        continue;
      }
      api.addPanel({
        id: panel.id,
        component: 'panel',
        tabComponent: 'terminal-tab',
        title: panel.title,
        params,
      });
    }
  }, [panels]);

  const restoreLayout = useCallback((layout: unknown | undefined) => {
    const api = apiRef.current;
    if (!api || !layout) return;
    restoringLayoutRef.current = true;
    try {
      api.fromJSON(layout as never, { reuseExistingPanels: true });
    } catch {
      // Keep current live layout if restore fails.
    } finally {
      restoringLayoutRef.current = false;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const relayout = () => {
      const api = apiRef.current;
      if (!api) return;
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        api.layout(rect.width, rect.height);
      }
    };
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(relayout);
    });
    observer.observe(container);
    requestAnimationFrame(relayout);
    return () => observer.disconnect();
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    onApiChangeRef.current?.(event.api);
    disposablesRef.current.forEach((disposable) => disposable.dispose());
    disposablesRef.current = [
      event.api.onDidLayoutChange(saveLayout),
      event.api.onDidActivePanelChange(saveLayout),
    ];

    if (initialLayout && !restoredLayoutRef.current) {
      restoredLayoutRef.current = true;
      restoreLayout(initialLayout);
    }
    syncPanels(true);
  }, [initialLayout, restoreLayout, saveLayout, syncPanels]);

  useEffect(() => {
    syncPanels();
  }, [syncPanels]);

  useEffect(() => {
    const api = apiRef.current;
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (!api) return;

    if (!isActive && wasActive) {
      onLayoutChangeRef.current?.(api.toJSON());
      return;
    }

    if (isActive && !wasActive) {
      restoreLayout(initialLayout);
      syncPanels(true);
    }
  }, [initialLayout, isActive, restoreLayout, syncPanels]);

  useEffect(() => {
    return () => {
      saveLayout();
      onApiChangeRef.current?.(null);
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
    };
  }, [saveLayout]);

  return (
    <div ref={containerRef} data-backend-key={backendKey} data-workspace-id={workspaceId} className="h-full w-full min-h-0 dockview-theme-dark bg-[var(--gs-bg)]">
      <DockviewReact
        className="dockview-theme-dark"
        components={{ panel: DockPanel }}
        tabComponents={{ 'terminal-tab': DockTab }}
        onReady={onReady}
      />
    </div>
  );
}
