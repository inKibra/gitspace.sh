import { useCallback, useEffect, useMemo, useState } from 'react';
import { extend, useKeyboard } from '@opentui/react';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import type { ReplayInfo } from './SpacesBrowser.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#333333',
  title: '#00AAFF',
  textDim: '#888888',
  error: '#FF6666',
};

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
  loadReplayText: (replayId: string) => Promise<string>;
  onBack: () => void;
}

export function ReplayTerminal({ replay, loadReplayText, onBack }: ReplayTerminalProps) {
  const [content, setContent] = useState<Buffer>(() => Buffer.from('Loading replay...'));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [termSize, setTermSize] = useState(getTerminalSize);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setContent(Buffer.from('Loading replay...'));

    void loadReplayText(replay.replayId)
      .then((text) => {
        if (cancelled) {
          return;
        }
        setContent(Buffer.from(text.length > 0 ? text : '(empty replay)'));
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        setContent(Buffer.from(`Failed to load replay\n\n${message}`));
      });

    return () => {
      cancelled = true;
    };
  }, [loadReplayText, reloadKey, replay.replayId]);

  useEffect(() => {
    const handleResize = () => {
      setTermSize(getTerminalSize());
    };

    process.on('SIGWINCH', handleResize);
    return () => {
      process.removeListener('SIGWINCH', handleResize);
    };
  }, []);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.raw === 'q') {
      onBack();
      return;
    }

    if (key.raw === 'r') {
      setReloadKey((current) => current + 1);
    }
  });

  const statusLabel = useMemo(() => {
    const state = replay.status === 'crashed' ? 'crashed' : 'closed';
    return `${replay.sessionName} (${state})`;
  }, [replay.sessionName, replay.status]);

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
          <text fg={COLORS.title}>{statusLabel}</text>
          <text fg={COLORS.textDim}> (replay)</text>
          {error && <text fg={COLORS.error}> [load error]</text>}
        </box>
        <text fg={COLORS.textDim}>[r] Reload  [Esc/q] Back</text>
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
