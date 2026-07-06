/** @jsxImportSource react */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview-react';
import { terminalMemoryDebugDecrement, terminalMemoryDebugGauge, terminalMemoryDebugIncrement } from '../utils/terminal-memory-debug.js';

export interface DockviewTerminalPanel {
  id: string;
  title: string;
  version?: string;
  render: () => ReactNode;
  onClose?: () => void;
  /** Pulsing green dot on the tab while the pane's agent/process runs (mock wdot). */
  running?: boolean;
}

type PanelParams = {
  version?: string;
  render: () => ReactNode;
  onClose?: () => void;
  running?: boolean;
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
    <div className="gs-ui flex items-center gap-2 min-w-0 max-w-full px-1">
      {props.params.running && <span className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-[var(--gs-accent)]" />}
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

function DockHeaderActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="flex h-full items-center pr-1">
      <button
        type="button"
        onClick={() => {
          const active = props.group.activePanel;
          if (active && props.group.panels.length > 1) active.api.moveTo({ position: 'right' });
        }}
        title="Split the active tab into a right pane"
        className="px-1.5 text-[10.5px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]"
      >
        ⇆ Split
      </button>
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
  const panelVersionsRef = useRef(new Map<string, { title: string; version?: string }>());
  onLayoutChangeRef.current = onLayoutChange;
  const onApiChangeRef = useRef(onApiChange);
  onApiChangeRef.current = onApiChange;


  useEffect(() => {
    terminalMemoryDebugIncrement('dockview.shell.mounted');
    terminalMemoryDebugIncrement('dockview.shell.active', isActiveRef.current ? 1 : 0);
    return () => {
      terminalMemoryDebugIncrement('dockview.shell.unmounted');
      terminalMemoryDebugDecrement('dockview.shell.active', isActiveRef.current ? 1 : 0);
    };
  }, []);

  const saveLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api || restoringLayoutRef.current || !isActiveRef.current) return;
    onLayoutChangeRef.current?.(api.toJSON());
    terminalMemoryDebugIncrement('dockview.toJSON.saveLayout');
  }, []);

  const syncPanels = useCallback((force = false) => {
    terminalMemoryDebugIncrement(force ? 'dockview.syncPanels.forced' : 'dockview.syncPanels');
    terminalMemoryDebugGauge('dockview.syncPanels.panelCount', panels.length);
    const api = apiRef.current;
    if (!api) return;
    if (!force && !isActiveRef.current) return;

    const nextPanelIds = new Set(panels.map((panel) => panel.id));
    for (const existingPanel of [...api.panels]) {
      if (!nextPanelIds.has(existingPanel.id)) {
        api.removePanel(existingPanel);
        terminalMemoryDebugIncrement('dockview.panel.remove');
        panelVersionsRef.current.delete(existingPanel.id);
      }
    }

    for (const panel of panels) {
      const params: PanelParams = { version: panel.version, render: panel.render, onClose: panel.onClose, running: panel.running };
      const existingPanel = api.getPanel(panel.id);
      if (existingPanel) {
        const previous = panelVersionsRef.current.get(panel.id);
        if (previous?.title !== panel.title) {
          existingPanel.setTitle(panel.title);
        }
        if (force || previous?.version !== panel.version || previous?.title !== panel.title) {
          terminalMemoryDebugIncrement('dockview.panel.updateParameters');
          existingPanel.api.updateParameters(params);
          panelVersionsRef.current.set(panel.id, { title: panel.title, version: panel.version });
        } else {
          terminalMemoryDebugIncrement('dockview.panel.updateParameters.skipped');
        }
        continue;
      }
      terminalMemoryDebugIncrement('dockview.panel.add');
      panelVersionsRef.current.set(panel.id, { title: panel.title, version: panel.version });
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
    terminalMemoryDebugIncrement('dockview.restoreLayout.attempt');
    try {
      api.fromJSON(layout as never, { reuseExistingPanels: true });
      terminalMemoryDebugIncrement('dockview.fromJSON');
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
      terminalMemoryDebugIncrement('dockview.relayout.called');
      if (!isActiveRef.current) {
        terminalMemoryDebugIncrement('dockview.relayout.whileInactive');
      }
      const api = apiRef.current;
      if (!api) return;
      const rect = container.getBoundingClientRect();
      if (!isActiveRef.current) return;
      if (rect.width > 0 && rect.height > 0) {
        api.layout(rect.width, rect.height);
        terminalMemoryDebugGauge('dockview.relayout.width', rect.width);
        terminalMemoryDebugGauge('dockview.relayout.height', rect.height);
      }
    };
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(relayout);
      terminalMemoryDebugIncrement('dockview.resizeObserver');
    });
    observer.observe(container);
    requestAnimationFrame(relayout);
    return () => observer.disconnect();
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    onApiChangeRef.current?.(event.api);
    terminalMemoryDebugIncrement('dockview.ready');
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
      terminalMemoryDebugIncrement('dockview.toJSON.deactivate');
      return;
    }

    if (isActive && !wasActive) {
      terminalMemoryDebugIncrement('dockview.activate');
      syncPanels();
      requestAnimationFrame(() => {
        const container = containerRef.current;
        const activeApi = apiRef.current;
        if (!container || !activeApi || !isActiveRef.current) return;
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          activeApi.layout(rect.width, rect.height);
          terminalMemoryDebugIncrement('dockview.relayout.onActivate');
          terminalMemoryDebugGauge('dockview.relayout.width', rect.width);
          terminalMemoryDebugGauge('dockview.relayout.height', rect.height);
        }
      });
    }
  }, [isActive, syncPanels]);

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
        rightHeaderActionsComponent={DockHeaderActions}
        onReady={onReady}
      />
    </div>
  );
}
