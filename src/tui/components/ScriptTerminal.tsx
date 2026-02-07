/**
 * ScriptTerminal - TUI Component for displaying lifecycle script output
 *
 * Shows ANSI output from scripts (pre, setup, select, remove) in a read-only terminal.
 * Uses ghostty-opentui for rendering with mouse selection support.
 */

import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { extend, useRenderer } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import { toast } from '@opentui-ui/toast';
import { copyToClipboard } from '../../utils/clipboard.js';
import type { ScriptPhase } from '../../utils/run-workspace-scripts.js';

// Register the ghostty-terminal component
extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

// ============================================================================
// Types
// ============================================================================

export interface ScriptTerminalProps {
  /** Current phase being executed */
  phase: ScriptPhase | 'remove';
  /** Workspace name (shown in header) */
  workspaceName: string;
  /** Whether scripts are still running */
  isRunning: boolean;
  /** Error message if scripts failed */
  error?: string;
  /** Exit code from failed script */
  exitCode?: number;
}

export interface ScriptTerminalHandle {
  /** Feed output data to the terminal */
  feed: (data: Buffer) => void;
}

// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  statusBar: '#333333',
  phase: '#00FF88',
  textDim: '#888888',
  runningHint: '#FFAA00',
  error: '#FF4444',
  success: '#00FF88',
};

// Phase display names
const PHASE_NAMES: Record<ScriptPhase | 'remove', string> = {
  pre: 'Pre Scripts',
  setup: 'Setup Scripts',
  select: 'Select Scripts',
  remove: 'Remove Scripts',
};

// ============================================================================
// Helper to get terminal size
// ============================================================================

function getTerminalSize() {
  let cols = process.stdout.columns || 0;
  let rows = process.stdout.rows || 0;
  if (cols <= 0 || rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      cols = size[0];
      rows = size[1];
    }
  }
  // Reserve 1 row for header
  return {
    cols: cols > 0 ? cols : 80,
    rows: (rows > 0 ? rows : 24) - 1,
  };
}

// ============================================================================
// ScriptTerminal Component
// ============================================================================

export const ScriptTerminal = forwardRef<ScriptTerminalHandle, ScriptTerminalProps>(
  function ScriptTerminal(
    {
      phase,
      workspaceName,
      isRunning,
      error,
      exitCode,
    },
    ref
  ) {
    const [termSize, setTermSize] = useState(getTerminalSize);
    const renderer = useRenderer();

    const terminalRef = useRef<GhosttyTerminalRenderable | null>(null);
    const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
    const outputBufferRef = useRef<Buffer>(Buffer.alloc(0));

    // Handle window resize
    useEffect(() => {
      const onResize = () => {
        setTermSize(getTerminalSize());
      };
      process.on('SIGWINCH', onResize);
      return () => {
        process.removeListener('SIGWINCH', onResize);
      };
    }, []);

    // Handle mouse-up after drag selection and copy selected text to clipboard
    const handleMouseUp = useCallback(async () => {
      const text = renderer.getSelection()?.getSelectedText();
      if (text && text.length > 0) {
        try {
          await copyToClipboard(text);
          toast.success('Copied to clipboard');
        } catch {
          toast.error('Failed to copy to clipboard');
        }
        renderer.clearSelection();
      }
    }, [renderer]);

    // Feed data to terminal - exposed via ref
    const feed = useCallback((data: Buffer) => {
      outputBufferRef.current = Buffer.concat([outputBufferRef.current, data]);
      // Feed to terminal if mounted
      if (terminalRef.current) {
        terminalRef.current.feed(data);
      }
    }, []);

    // Expose feed method via ref
    useImperativeHandle(ref, () => ({
      feed,
    }), [feed]);

    // Status text
    const statusText = isRunning
      ? 'Running...'
      : error
        ? `Failed (exit ${exitCode})`
        : 'Complete';

    const statusColor = isRunning
      ? COLORS.runningHint
      : error
        ? COLORS.error
        : COLORS.success;

    return (
      <box flexDirection="column" flexGrow={1}>
        {/* Header */}
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

        {/* Terminal output */}
        <scrollbox
          ref={(el: ScrollBoxRenderable | null) => {
            scrollBoxRef.current = el;
          }}
          flexGrow={1}
          viewportCulling={true}
          stickyScroll={true}
          stickyStart="bottom"
          onMouseUp={handleMouseUp}
        >
          <ghostty-terminal
            ref={(el: GhosttyTerminalRenderable | null) => {
              const wasNull = terminalRef.current === null;
              terminalRef.current = el;
              // Feed any buffered output when terminal mounts
              if (el && wasNull && outputBufferRef.current.length > 0) {
                el.feed(outputBufferRef.current);
              }
            }}
            persistent={true}
            showCursor={false}
            cols={termSize.cols}
            rows={termSize.rows}
          />
        </scrollbox>

        {/* Error message if failed */}
        {error && !isRunning && (
          <box height={1} width="100%" backgroundColor="#331111" paddingLeft={1}>
            <text fg={COLORS.error}>{error}</text>
          </box>
        )}
      </box>
    );
  }
);
