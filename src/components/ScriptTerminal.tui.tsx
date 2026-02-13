/**
 * ScriptTerminal - read-only terminal for workspace script output.
 */

import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { extend, useRenderer } from '@opentui/react';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import { toast } from '@opentui-ui/toast';
import type { ScriptOutputResponse } from '../lib/remote-session/protocol.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { ScriptTerminalBuffer } from './script-terminal-buffer.tui.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

type ScriptPhase = ScriptOutputResponse['phase'];

export interface ScriptTerminalProps {
  phase: ScriptPhase;
  workspaceName: string;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
}

export interface ScriptTerminalHandle {
  feed: (data: Uint8Array) => void;
}

const COLORS = {
  statusBar: '#333333',
  phase: '#00FF88',
  textDim: '#888888',
  runningHint: '#FFAA00',
  error: '#FF4444',
  success: '#00FF88',
};

const PHASE_NAMES: Record<ScriptPhase, string> = {
  pre: 'Pre Scripts',
  setup: 'Setup Scripts',
  select: 'Select Scripts',
  remove: 'Remove Scripts',
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

export const ScriptTerminal = forwardRef<ScriptTerminalHandle, ScriptTerminalProps>(
  function ScriptTerminal({ phase, workspaceName, isRunning, error, exitCode }, ref) {
    const showErrorBanner = !!error && !isRunning;
    const reservedRows = 2 + (showErrorBanner ? 1 : 0);
    const [termSize, setTermSize] = useState(() => getTerminalSize(reservedRows));
    const renderer = useRenderer();

    const bufferRef = useRef<ScriptTerminalBuffer>(new ScriptTerminalBuffer());

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

    const feed = useCallback((data: Uint8Array) => {
      bufferRef.current.feed(data);
    }, []);

    const setTerminalRef = useCallback((el: GhosttyTerminalRenderable | null) => {
      bufferRef.current.setTarget(el);
    }, []);

    useImperativeHandle(ref, () => ({ feed }), [feed]);

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
            <text fg={COLORS.phase}>{PHASE_NAMES[phase]}</text>
            <text fg={COLORS.textDim}> - {workspaceName}</text>
          </box>
          <text fg={statusColor}>{statusText}</text>
        </box>

        <scrollbox
          flexGrow={1}
          viewportCulling={true}
          stickyScroll={true}
          stickyStart="bottom"
          onMouseUp={handleMouseUp}
        >
          <ghostty-terminal
            ref={setTerminalRef}
            persistent={true}
            showCursor={false}
            cols={termSize.cols}
            rows={termSize.rows}
          />
        </scrollbox>

        {error && !isRunning && (
          <box height={1} width="100%" backgroundColor="#331111" paddingLeft={1}>
            <text fg={COLORS.error}>{error}</text>
          </box>
        )}
      </box>
    );
  }
);
