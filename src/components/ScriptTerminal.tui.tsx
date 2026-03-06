/**
 * ScriptTerminal - read-only terminal for workspace script output.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import { extend, useKeyboard, useRenderer } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import { toast } from '@opentui-ui/toast';
import type { WorkspaceScriptPhase } from '../types/script-phase.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { shouldConsumePageNavigationInScrollbox } from './session-terminal-page-navigation.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

type ScriptPhase = WorkspaceScriptPhase | 'remove';

type PhaseStatus = 'running' | 'complete' | 'failed';

interface PhaseTerminalState {
  id: string;
  phase: ScriptPhase;
  status: PhaseStatus;
  error?: string;
  exitCode?: number;
  outputChunks: Buffer[];
  target: GhosttyTerminalRenderable | null;
}

export interface ScriptTerminalProps {
  phase: ScriptPhase;
  workspaceName: string;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  modalOpen?: boolean;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
}

const COLORS = {
  statusBar: '#333333',
  phase: '#00FF88',
  phaseActive: '#00AAFF',
  textDim: '#888888',
  runningHint: '#FFAA00',
  error: '#FF4444',
  success: '#00FF88',
};

const PHASE_NAMES: Record<ScriptPhase, string> = {
  pre: 'Pre',
  setup: 'Setup',
  select: 'Select',
  remove: 'Remove',
};

function getTerminalSize(reservedRows: number) {
  let cols = process.stdout.columns || 0;
  let rows = process.stdout.rows || 0;
  if (cols <= 0 || rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      cols = size[0];
      rows = size[1];
    }
  }
  return {
    cols: cols > 0 ? cols : 80,
    rows: Math.max(1, (rows > 0 ? rows : 24) - reservedRows),
  };
}

function toPhaseStatus(isRunning: boolean, error?: string): PhaseStatus {
  if (isRunning) {
    return 'running';
  }
  if (error) {
    return 'failed';
  }
  return 'complete';
}

function createPhaseEntry(
  phase: ScriptPhase,
  isRunning: boolean,
  error?: string,
  exitCode?: number
): PhaseTerminalState {
  return {
    id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    phase,
    status: toPhaseStatus(isRunning, error),
    error,
    exitCode,
    outputChunks: [],
    target: null,
  };
}

function getPhaseMarker(status: PhaseStatus): string {
  switch (status) {
    case 'complete':
      return ' ok';
    case 'failed':
      return ' x';
    case 'running':
    default:
      return ' ...';
  }
}

const PHASE_BANNER_REGEX = /==>\s*(pre|setup|select|remove)\s+scripts\.\.\./gi;
const PHASE_BANNER_SCAN_LIMIT = 256;

function findLatestPhaseBanner(text: string): ScriptPhase | null {
  let latest: ScriptPhase | null = null;
  PHASE_BANNER_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PHASE_BANNER_REGEX.exec(text)) !== null) {
    const phase = match[1];
    if (phase === 'pre' || phase === 'setup' || phase === 'select' || phase === 'remove') {
      latest = phase;
    }
  }

  return latest;
}

export function ScriptTerminal({
  phase,
  workspaceName,
  isRunning,
  error,
  exitCode,
  modalOpen = false,
  setWriteCallback,
}: ScriptTerminalProps) {
  const renderer = useRenderer();

  const [phaseEntries, setPhaseEntries] = useState<PhaseTerminalState[]>(() => [
    createPhaseEntry(phase, isRunning, error, exitCode),
  ]);
  const phaseEntriesRef = useRef<PhaseTerminalState[]>(phaseEntries);
  const phaseBannerCarryRef = useRef('');
  const previousPhaseRef = useRef<ScriptPhase>(phase);
  const previousRunningRef = useRef<boolean>(isRunning);
  const [activePhaseIndex, setActivePhaseIndex] = useState(0);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);

  const latestPhaseIndex = Math.max(0, phaseEntries.length - 1);
  const displayPhaseIndex = isRunning ? latestPhaseIndex : activePhaseIndex;
  const activeEntry = phaseEntries[displayPhaseIndex] ?? phaseEntries[latestPhaseIndex];
  const activeError = activeEntry?.status === 'failed' ? activeEntry.error : undefined;
  const showWaitingOutput = isRunning && !!activeEntry && activeEntry.outputChunks.length === 0;

  const showErrorBanner = !!activeError && !isRunning;
  const reservedRows = 3 + (showErrorBanner ? 1 : 0) + (showWaitingOutput ? 1 : 0);
  const [termSize, setTermSize] = useState(() => getTerminalSize(reservedRows));

  useEffect(() => {
    phaseEntriesRef.current = phaseEntries;
  }, [phaseEntries]);

  useEffect(() => {
    const onResize = () => {
      setTermSize(getTerminalSize(reservedRows));
    };
    setTermSize(getTerminalSize(reservedRows));
    process.on('SIGWINCH', onResize);
    return () => {
      process.removeListener('SIGWINCH', onResize);
    };
  }, [reservedRows]);

  useEffect(() => {
    const switchedPhase = previousPhaseRef.current !== phase;
    previousPhaseRef.current = phase;

    setPhaseEntries((prev) => {
      if (prev.length === 0) {
        return [createPhaseEntry(phase, isRunning, error, exitCode)];
      }

      const last = prev[prev.length - 1];
      if (last.phase === phase) {
        const next = [...prev];
        next[next.length - 1] = {
          ...last,
          status: toPhaseStatus(isRunning, error),
          error,
          exitCode,
        };
        return next;
      }

      const next = [...prev];
      if (next.length > 0 && next[next.length - 1]?.status === 'running') {
        next[next.length - 1] = {
          ...next[next.length - 1],
          status: 'complete',
        };
      }
      next.push(createPhaseEntry(phase, isRunning, error, exitCode));
      return next;
    });

    if (switchedPhase) {
      setActivePhaseIndex(Math.max(0, phaseEntriesRef.current.length - 1));
    }
  }, [phase, isRunning, error, exitCode]);

  useEffect(() => {
    const transitionedToStopped = previousRunningRef.current && !isRunning;
    previousRunningRef.current = isRunning;
    if (transitionedToStopped) {
      setActivePhaseIndex(Math.max(0, phaseEntriesRef.current.length - 1));
    }
  }, [isRunning]);

  useEffect(() => {
    setActivePhaseIndex((current) => {
      const maxIndex = phaseEntries.length - 1;
      if (maxIndex < 0) {
        return 0;
      }
      if (current > maxIndex) {
        return maxIndex;
      }
      if (current < 0) {
        return 0;
      }
      return current;
    });
  }, [phaseEntries.length]);

  useEffect(() => {
    const entries = phaseEntriesRef.current;
    for (let index = 0; index < entries.length; index += 1) {
      if (index !== displayPhaseIndex) {
        entries[index]!.target = null;
      }
    }
  }, [displayPhaseIndex, phaseEntries.length]);

  const handleMouseUp = useCallback(async () => {
    const text = renderer.getSelection()?.getSelectedText();
    if (!text || text.length === 0) {
      return;
    }

    try {
      await copyToClipboard(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }

    renderer.clearSelection();
  }, [renderer]);

  useKeyboard((key) => {
    if (modalOpen) {
      return;
    }

    if (!isRunning && (key.name === 'left' || key.raw === '[')) {
      setActivePhaseIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (!isRunning && (key.name === 'right' || key.raw === ']')) {
      setActivePhaseIndex((current) => Math.min(phaseEntriesRef.current.length - 1, current + 1));
      return;
    }

    const scrollBox = scrollBoxRef.current;
    if (!scrollBox) {
      return;
    }

    if (key.name === 'up' || key.raw === 'k') {
      scrollBox.scrollBy(-1);
      return;
    }

    if (key.name === 'down' || key.raw === 'j') {
      scrollBox.scrollBy(1);
      return;
    }

    if (
      key.name === 'pageup' &&
      shouldConsumePageNavigationInScrollbox({
        direction: 'up',
        scrollTop: scrollBox.scrollTop,
        scrollHeight: scrollBox.scrollHeight,
        viewportHeight: scrollBox.viewport.height,
      })
    ) {
      scrollBox.scrollBy(-1, 'viewport');
      return;
    }

    if (
      key.name === 'pagedown' &&
      shouldConsumePageNavigationInScrollbox({
        direction: 'down',
        scrollTop: scrollBox.scrollTop,
        scrollHeight: scrollBox.scrollHeight,
        viewportHeight: scrollBox.viewport.height,
      })
    ) {
      scrollBox.scrollBy(1, 'viewport');
    }
  });

  const feed = useCallback((data: Uint8Array) => {
    const entries = phaseEntriesRef.current;
    if (entries.length === 0) {
      return;
    }

    const chunk = Buffer.from(data);
    const scanWindow = `${phaseBannerCarryRef.current}${chunk.toString('utf-8')}`;
    phaseBannerCarryRef.current = scanWindow.slice(-PHASE_BANNER_SCAN_LIMIT);

    const streamPhase = findLatestPhaseBanner(scanWindow);
    if (streamPhase) {
      const currentEntries = phaseEntriesRef.current;
      const lastEntry = currentEntries[currentEntries.length - 1];

      if (!lastEntry || lastEntry.phase !== streamPhase) {
        const nextEntries = [...currentEntries];
        const currentLast = nextEntries[nextEntries.length - 1];
        if (currentLast?.status === 'running') {
          nextEntries[nextEntries.length - 1] = {
            ...currentLast,
            status: 'complete',
          };
        }

        const createdEntry = createPhaseEntry(streamPhase, true);
        nextEntries.push(createdEntry);
        phaseEntriesRef.current = nextEntries;
        setPhaseEntries(nextEntries);
        setActivePhaseIndex(nextEntries.length - 1);
      }
    }

    const current = phaseEntriesRef.current[phaseEntriesRef.current.length - 1];
    if (!current) {
      return;
    }

    current.outputChunks.push(chunk);
    current.target?.feed(chunk);
  }, []);

  const setActiveTerminalRef = useCallback((el: GhosttyTerminalRenderable | null) => {
    if (!activeEntry) {
      return;
    }

    const justMounted = activeEntry.target === null && el !== null;
    activeEntry.target = el;

    if (!justMounted || !el || activeEntry.outputChunks.length === 0) {
      return;
    }

    el.feed(Buffer.concat(activeEntry.outputChunks));
  }, [activeEntry]);

  useEffect(() => {
    setWriteCallback(feed);
    return () => {
      setWriteCallback(null);
    };
  }, [feed, setWriteCallback]);

  const statusText = isRunning
    ? 'Running...'
    : error
      ? `Failed${typeof exitCode === 'number' ? ` (exit ${exitCode})` : ''}`
      : 'Complete';

  const statusColor = isRunning
    ? COLORS.runningHint
    : error
      ? COLORS.error
      : COLORS.success;
  const waitingPhaseName = activeEntry ? PHASE_NAMES[activeEntry.phase] : 'script';

  const stickyToBottom = isRunning && displayPhaseIndex === latestPhaseIndex;
  const phaseHint = isRunning
    ? '[c] Cancel  [mouse] Select+copy'
    : activeError
      ? '[[/]] Phase  [↑/↓ PgUp/PgDn] Scroll  [a] Attach anyway  [mouse] Select+copy'
      : '[[/]] Phase  [↑/↓ PgUp/PgDn] Scroll  [mouse] Select+copy';
  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        height={1}
        width="100%"
        backgroundColor={COLORS.statusBar}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexGrow={1} flexDirection="row">
          {phaseEntries.map((entry, index) => {
            const isActive = index === displayPhaseIndex;
            const color = isActive ? COLORS.phaseActive : COLORS.phase;
            return (
              <text key={entry.id} fg={color}>
                {index > 0 ? ' ' : ''}[{PHASE_NAMES[entry.phase]}{getPhaseMarker(entry.status)}]
              </text>
            );
          })}
          <text fg={COLORS.textDim}> - {workspaceName}</text>
        </box>
        <text fg={statusColor}>{statusText}</text>
      </box>

      <box height={1} width="100%" backgroundColor="#222222" paddingLeft={1}>
        <text fg={COLORS.textDim}>{phaseHint}</text>
      </box>

      {showWaitingOutput && (
        <box height={1} width="100%" backgroundColor="#1a1a1a" paddingLeft={1}>
          <text fg={COLORS.textDim}>Waiting for {waitingPhaseName} script output...</text>
        </box>
      )}

      <scrollbox
        ref={(el: ScrollBoxRenderable | null) => {
          scrollBoxRef.current = el;
        }}
        flexGrow={1}
        viewportCulling={true}
        stickyScroll={stickyToBottom}
        stickyStart="bottom"
        onMouseUp={handleMouseUp}
      >
        <ghostty-terminal
          key={activeEntry?.id ?? 'script-terminal-empty'}
          ref={setActiveTerminalRef}
          persistent={true}
          showCursor={false}
          cols={termSize.cols}
          rows={termSize.rows}
        />
      </scrollbox>

      {activeError && !isRunning && (
        <box height={1} width="100%" backgroundColor="#331111" paddingLeft={1}>
          <text fg={COLORS.error}>{activeError}</text>
        </box>
      )}
    </box>
  );
}
