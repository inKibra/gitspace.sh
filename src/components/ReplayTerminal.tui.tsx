import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extend, useKeyboard } from '@opentui/react';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayTimeline,
} from '../lib/tmux-lite/replay/index.js';
import type { ReplayInfo } from './SpacesBrowser.js';
import {
  PLAYBACK_SPEEDS,
  DEFAULT_PLAYBACK_SPEED_INDEX,
  FAST_SCRUB_STEP_COUNT,
  formatReplayTime,
  clamp,
  targetKey,
  toFrameTarget,
  applyReplayFrame,
  frameCheckpointId,
  frameLastSeq,
} from './replay-utils.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#1a1f2e',
  title: '#58a6ff',
  textDim: '#6e7681',
  textMuted: '#8b949e',
  error: '#ff7b72',
  crashed: '#ffa198',
  loading: '#d29922',
  playing: '#3fb950',
};

const INITIAL_ANSI = Buffer.from('\x1b[2J\x1b[H\x1b[2;37mLoading replay...\x1b[0m');

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

function padLabel(value: string, width: number): string {
  return value.padStart(width, ' ');
}

export interface ReplayTerminalProps {
  replay: ReplayInfo;
  loadReplayFrame: (replayId: string, target?: ReplayFrameTarget) => Promise<ReplayFrame>;
  loadReplayTimeline: (replayId: string) => Promise<ReplayTimeline>;
  onBack: () => void;
  onDismiss?: (replayId: string) => boolean | void | Promise<boolean | void>;
  onCleanup?: () => void;
}

export function ReplayTerminal({
  replay,
  loadReplayFrame,
  loadReplayTimeline,
  onBack,
  onDismiss,
  onCleanup,
}: ReplayTerminalProps) {
  const latestFallbackTarget = useMemo<ReplayFrameTarget>(() => ({
    atMs: replay.durationMs,
    atSeq: replay.lastSeq,
  }), [replay.durationMs, replay.lastSeq]);

  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [termSize, setTermSize] = useState(getTerminalSize);
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [erroredTargetKey, setErroredTargetKey] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [frameLoading, setFrameLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeedIndex, setPlaybackSpeedIndex] = useState(DEFAULT_PLAYBACK_SPEED_INDEX);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const terminalRef = useRef<GhosttyTerminalRenderable | null>(null);
  const frameRequestIdRef = useRef(0);
  const currentCheckpointIdRef = useRef<string | null>(null);
  const currentSeqRef = useRef(0);
  const hasContentRef = useRef(false);

  const feedTerminal = useCallback((data: string | Uint8Array) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (typeof data === 'string') {
      terminal.feed(Buffer.from(data, 'utf-8'));
    } else {
      terminal.feed(Buffer.from(data));
    }
  }, []);

  const currentStep = timeline && currentStepIndex >= 0
    ? timeline.steps[currentStepIndex] ?? null
    : null;
  const currentTarget = useMemo(
    () => toFrameTarget(currentStep, latestFallbackTarget),
    [currentStep, latestFallbackTarget],
  );
  const currentTargetKey = targetKey(currentTarget);
  const playbackSpeed = PLAYBACK_SPEEDS[playbackSpeedIndex] ?? 1;

  const loadFrame = useCallback(async (
    target: ReplayFrameTarget,
  ): Promise<void> => {
    const requestId = ++frameRequestIdRef.current;
    setFrameLoading(true);
    setError(null);

    try {
      const frame = await loadReplayFrame(replay.replayId, target);
      if (frameRequestIdRef.current !== requestId) {
        return;
      }

      if (frame.events.length === 0 && !frame.checkpoint) {
        feedTerminal('\x1b[2J\x1b[H\x1b[2;37m(empty replay)\x1b[0m');
      } else {
        applyReplayFrame(
          frame,
          feedTerminal,
          currentCheckpointIdRef.current,
          currentSeqRef.current,
        );
      }

      currentCheckpointIdRef.current = frameCheckpointId(frame);
      currentSeqRef.current = frameLastSeq(frame);
      setLoadedTargetKey(targetKey(target));
      setErroredTargetKey(null);
      hasContentRef.current = true;
      setError(null);
    } catch (loadError) {
      if (frameRequestIdRef.current !== requestId) {
        return;
      }

      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      setErroredTargetKey(targetKey(target));

      if (!hasContentRef.current) {
        feedTerminal(`\x1b[2J\x1b[H\x1b[31mFailed to load replay\x1b[0m\r\n\r\n${message}`);
      }
    } finally {
      if (frameRequestIdRef.current === requestId) {
        setFrameLoading(false);
      }
    }
  }, [feedTerminal, loadReplayFrame, replay.replayId]);

  useEffect(() => {
    if (!terminalMounted) {
      return;
    }

    let cancelled = false;
    frameRequestIdRef.current += 1;
    currentCheckpointIdRef.current = null;
    currentSeqRef.current = 0;
    setIsPlaying(false);
    setPlaybackSpeedIndex(DEFAULT_PLAYBACK_SPEED_INDEX);
    setTimeline(null);
    setCurrentStepIndex(-1);
    setLoadedTargetKey(null);
    setErroredTargetKey(null);
    setError(null);
    hasContentRef.current = false;
    setTimelineLoading(true);
    setFrameLoading(true);

    void (async () => {
      let nextTimeline: ReplayTimeline | null = null;

      try {
        nextTimeline = await loadReplayTimeline(replay.replayId);
      } catch (timelineError) {
        if (cancelled) {
          return;
        }
        setError(timelineError instanceof Error ? timelineError.message : String(timelineError));
      }

      if (cancelled) {
        return;
      }

      const initialStepIndex = nextTimeline && nextTimeline.steps.length > 0
        ? nextTimeline.steps.length - 1
        : -1;
      const initialStep = nextTimeline && initialStepIndex >= 0
        ? nextTimeline.steps[initialStepIndex] ?? null
        : null;

      await loadFrame(toFrameTarget(initialStep, latestFallbackTarget));
      if (cancelled) {
        return;
      }

      setTimeline(nextTimeline);
      setCurrentStepIndex(initialStepIndex);
      setTimelineLoading(false);
    })();

    return () => {
      cancelled = true;
      frameRequestIdRef.current += 1;
      onCleanup?.();
    };
  }, [latestFallbackTarget, loadFrame, loadReplayTimeline, onCleanup, reloadKey, replay.replayId, terminalMounted]);

  useEffect(() => {
    if (!timeline || currentStepIndex < 0 || currentTargetKey === loadedTargetKey || frameLoading || currentTargetKey === erroredTargetKey) {
      return;
    }

    void loadFrame(currentTarget);
  }, [currentStepIndex, currentTarget, currentTargetKey, erroredTargetKey, frameLoading, loadFrame, loadedTargetKey, timeline]);

  useEffect(() => {
    const handleResize = () => setTermSize(getTerminalSize());
    process.on('SIGWINCH', handleResize);
    return () => { process.removeListener('SIGWINCH', handleResize); };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    if (!timeline || timeline.steps.length === 0) {
      setIsPlaying(false);
      return;
    }

    if (currentStepIndex < 0) {
      return;
    }

    if (currentStepIndex >= timeline.steps.length - 1) {
      setIsPlaying(false);
      return;
    }

    if (timelineLoading || frameLoading || currentTargetKey !== loadedTargetKey) {
      return;
    }

    const current = timeline.steps[currentStepIndex];
    const next = timeline.steps[currentStepIndex + 1];
    if (!current || !next) {
      setIsPlaying(false);
      return;
    }

    const delayMs = Math.max(0, Math.round((next.timeMs - current.timeMs) / playbackSpeed));
    const timer = setTimeout(() => {
      setCurrentStepIndex((index) => {
        if (!timeline) {
          return index;
        }
        return clamp(index + 1, 0, timeline.steps.length - 1);
      });
    }, delayMs);

    return () => clearTimeout(timer);
  }, [
    currentStepIndex,
    currentTargetKey,
    frameLoading,
    isPlaying,
    loadedTargetKey,
    playbackSpeed,
    timeline,
    timelineLoading,
  ]);

  const handleDismiss = useCallback(async () => {
    const shouldGoBack = await onDismiss?.(replay.replayId);
    if (shouldGoBack !== false) {
      onBack();
    }
  }, [onDismiss, onBack, replay.replayId]);

  /** Invalidate any in-flight frame load so its completion is discarded. */
  const invalidatePendingFrameLoad = useCallback(() => {
    frameRequestIdRef.current += 1;
    setFrameLoading(false);
  }, []);

  const stepReplay = useCallback((direction: -1 | 1, count = 1) => {
    if (!timeline || timeline.steps.length === 0) {
      return;
    }

    invalidatePendingFrameLoad();
    setIsPlaying(false);
    setCurrentStepIndex((index) => {
      const resolvedIndex = index < 0 ? timeline.steps.length - 1 : index;
      return clamp(resolvedIndex + (direction * count), 0, timeline.steps.length - 1);
    });
  }, [invalidatePendingFrameLoad, timeline]);

  const adjustPlaybackSpeed = useCallback((direction: -1 | 1, count = 1) => {
    setPlaybackSpeedIndex((index) => clamp(index + (direction * count), 0, PLAYBACK_SPEEDS.length - 1));
  }, []);

  const togglePlayback = useCallback(() => {
    if (!timeline || timeline.steps.length === 0) {
      return;
    }

    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    // When restarting from the end, invalidate so the old frame load is discarded
    invalidatePendingFrameLoad();
    currentCheckpointIdRef.current = null;
    currentSeqRef.current = 0;
    setCurrentStepIndex((index) => index >= timeline.steps.length - 1 ? 0 : Math.max(0, index));
    setIsPlaying(true);
  }, [invalidatePendingFrameLoad, isPlaying, timeline]);

  const jumpToBoundary = useCallback((direction: 'start' | 'end') => {
    if (!timeline || timeline.steps.length === 0) {
      return;
    }

    invalidatePendingFrameLoad();
    setIsPlaying(false);
    // Reset checkpoint tracking on jump so we get a full frame
    currentCheckpointIdRef.current = null;
    currentSeqRef.current = 0;
    setCurrentStepIndex(direction === 'start' ? 0 : timeline.steps.length - 1);
  }, [invalidatePendingFrameLoad, timeline]);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.raw === 'q') {
      onBack();
      return;
    }
    if (key.raw === 'r') {
      setReloadKey((value) => value + 1);
      return;
    }
    if (key.raw === 'd' && onDismiss) {
      void handleDismiss();
      return;
    }
    if (key.raw === ' ' || key.name === 'space') {
      togglePlayback();
      return;
    }
    if (key.name === 'home') {
      jumpToBoundary('start');
      return;
    }
    if (key.name === 'end') {
      jumpToBoundary('end');
      return;
    }
    if (key.name === 'left') {
      if (isPlaying) {
        adjustPlaybackSpeed(-1, key.shift ? 2 : 1);
      } else {
        stepReplay(-1, key.shift ? FAST_SCRUB_STEP_COUNT : 1);
      }
      return;
    }
    if (key.name === 'right') {
      if (isPlaying) {
        adjustPlaybackSpeed(1, key.shift ? 2 : 1);
      } else {
        stepReplay(1, key.shift ? FAST_SCRUB_STEP_COUNT : 1);
      }
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
  const totalTimeMs = timeline?.latestTimeMs ?? replay.durationMs;
  const activeTimeMs = currentTarget.atMs ?? totalTimeMs;
  const totalSteps = timeline ? Math.max(0, timeline.steps.length - 1) : 0;
  const visibleStepIndex = timeline && currentStepIndex >= 0
    ? clamp(currentStepIndex, 0, Math.max(0, timeline.steps.length - 1))
    : totalSteps;
  const transportHint = isPlaying
    ? '[Space] Pause  [←/→] Speed  [Shift+←/→] More  [Home/End] Jump'
    : '[Space] Play  [←/→] Step  [Shift+←/→] Skip  [Home/End] Jump';
  const speedLabel = `${playbackSpeed.toFixed(playbackSpeed < 1 ? 2 : 1)}x`;
  const timeWidth = Math.max(formatReplayTime(totalTimeMs).length, formatReplayTime(0).length);
  const timeLabel = `${padLabel(formatReplayTime(activeTimeMs), timeWidth)}/${formatReplayTime(totalTimeMs)}`;
  const stepWidth = String(Math.max(0, totalSteps)).length;
  const stepLabel = `${String(visibleStepIndex).padStart(stepWidth, ' ')}/${totalSteps}`;
  const speedWidth = Math.max(...PLAYBACK_SPEEDS.map((value) => `${value.toFixed(value < 1 ? 2 : 1)}x`.length));
  const paddedSpeedLabel = speedLabel.padStart(speedWidth, ' ');

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
          <text fg={COLORS.textDim}>  {timeLabel}</text>
          <text fg={COLORS.textDim}>  {stepLabel}</text>
          <text fg={isPlaying ? COLORS.playing : COLORS.textMuted}>  {isPlaying ? '[playing]' : '[paused]'}</text>
          <text fg={COLORS.loading}>  {paddedSpeedLabel}</text>
          {(timelineLoading || frameLoading) && <text fg={COLORS.loading}> [loading]</text>}
          {error && <text fg={COLORS.error}> [error]</text>}
        </box>
        <text fg={COLORS.textDim}>
          {transportHint}  [r] Reload  {onDismiss ? `[d] ${replay.dismissedAt ? 'Restore' : 'Dismiss'}  ` : ''}[Esc/q] Back
        </text>
      </box>
      <scrollbox flexGrow={1} stickyStart="bottom">
        <ghostty-terminal
          ref={(el: GhosttyTerminalRenderable | null) => {
            const wasNull = terminalRef.current === null;
            terminalRef.current = el;
            if (el && wasNull) {
              queueMicrotask(() => setTerminalMounted(true));
            }
          }}
          persistent={true}
          showCursor={false}
          cols={termSize.cols}
          rows={termSize.rows}
          ansi={INITIAL_ANSI}
        />
      </scrollbox>
    </box>
  );
}
