import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extend, useKeyboard } from '@opentui/react';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import type { ReplayInfo } from './SpacesBrowser.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#1a1f2e',
  title: '#58a6ff',
  textDim: '#6e7681',
  textMuted: '#8b949e',
  error: '#ff7b72',
  crashed: '#ffa198',
};

function formatAge(timestamp: number): string {
  const age = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
}

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

  return {
    cols: cols > 0 ? cols : 80,
    rows: Math.max(1, (rows > 0 ? rows : 24) - 1),
  };
}

export interface ReplayTerminalProps {
  replay: ReplayInfo;
  /** Load replay as ANSI bytes (styled, for Ghostty rendering) */
  loadReplayAnsi: (replayId: string) => Promise<Buffer>;
  onBack: () => void;
  onDismiss?: (replayId: string) => boolean | void | Promise<boolean | void>;
}

export function ReplayTerminal({ replay, loadReplayAnsi, onBack, onDismiss }: ReplayTerminalProps) {
  const [content, setContent] = useState<Buffer>(() => Buffer.from('\x1b[2J\x1b[HLoading replay...'));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [termSize, setTermSize] = useState(getTerminalSize);
  const loadingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadingRef.current = true;
    setError(null);
    setContent(Buffer.from('\x1b[2J\x1b[H\x1b[2;37mLoading replay...\x1b[0m'));

    void loadReplayAnsi(replay.replayId)
      .then((bytes) => {
        if (cancelled) return;
        loadingRef.current = false;
        setContent(bytes.length > 0 ? bytes : Buffer.from('\x1b[2J\x1b[H\x1b[2;37m(empty replay)\x1b[0m'));
      })
      .catch((loadError) => {
        if (cancelled) return;
        loadingRef.current = false;
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        setContent(Buffer.from(`\x1b[2J\x1b[H\x1b[31mFailed to load replay\x1b[0m\r\n\r\n${message}`));
      });

    return () => {
      cancelled = true;
    };
  }, [loadReplayAnsi, reloadKey, replay.replayId]);

  useEffect(() => {
    const handleResize = () => setTermSize(getTerminalSize());
    process.on('SIGWINCH', handleResize);
    return () => { process.removeListener('SIGWINCH', handleResize); };
  }, []);

  const handleDismiss = useCallback(async () => {
    const shouldGoBack = await onDismiss?.(replay.replayId);
    if (shouldGoBack !== false) {
      onBack();
    }
  }, [onDismiss, onBack, replay.replayId]);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.raw === 'q') {
      onBack();
      return;
    }
    if (key.raw === 'r') {
      setReloadKey((k) => k + 1);
    }
    if (key.raw === 'd' && onDismiss) {
      void handleDismiss();
    }
  });

  const statusLabel = useMemo(() => {
    const state = replay.status === 'crashed'
      ? 'crashed'
      : replay.status === 'running'
        ? 'running'
        : 'closed';
    const workspace = replay.workspaceName
      ? ` · ${replay.projectName}/${replay.workspaceName}`
      : replay.projectName
        ? ` · ${replay.projectName}`
        : '';
    const age = replay.endedAt ? `  ${formatAge(replay.endedAt)}` : '';
    return { name: replay.sessionName, state, workspace, age };
  }, [replay]);

  const statusColor = replay.status === 'crashed' ? COLORS.crashed : COLORS.title;

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
          <text fg={statusColor}>{statusLabel.name}</text>
          <text fg={COLORS.textMuted}>{statusLabel.workspace}</text>
          <text fg={COLORS.textDim}> ({statusLabel.state}){statusLabel.age}</text>
          {error && <text fg={COLORS.error}> [error]</text>}
        </box>
        <text fg={COLORS.textDim}>
          [r] Reload  {onDismiss ? `[d] ${replay.dismissedAt ? 'Restore' : 'Dismiss'}  ` : ''}[Esc/q] Back
        </text>
      </box>
      <scrollbox flexGrow={1} stickyStart="bottom">
        <ghostty-terminal
          persistent={true}
          showCursor={false}
          cols={termSize.cols}
          rows={termSize.rows}
          ansi={content}
        />
      </scrollbox>
    </box>
  );
}
