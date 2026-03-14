/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayFrameTarget, ReplayInfo, ReplayTimeline, ReplayTimelineStep } from '../lib/tmux-lite/replay/index.js';
import { SessionTerminal } from './SessionTerminal.web';

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
const DEFAULT_PLAYBACK_SPEED_INDEX = 2;
const FAST_SCRUB_STEP_COUNT = 5;

function encodeAnsi(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const LOADING_REPLAY_ANSI = encodeAnsi('\x1b[2J\x1b[H\x1b[2;37mLoading replay...\x1b[0m');
const EMPTY_REPLAY_ANSI = encodeAnsi('\x1b[2J\x1b[H\x1b[2;37m(empty replay)\x1b[0m');

function formatReplayTime(timeMs: number): string {
  const totalSeconds = Math.max(0, timeMs) / 1000;
  if (totalSeconds < 59.95) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const wholeSeconds = Math.round(totalSeconds);
  const seconds = wholeSeconds % 60;
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const hours = Math.floor(wholeSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function targetKey(target: ReplayFrameTarget | ReplayTimelineStep | null): string | null {
  if (!target) {
    return null;
  }

  const timeMs = 'timeMs' in target ? target.timeMs : target.atMs;
  const seq = 'seq' in target ? target.seq : target.atSeq;
  return `${timeMs ?? -1}:${seq ?? -1}`;
}

function toFrameTarget(step: ReplayTimelineStep | null, fallback: ReplayFrameTarget): ReplayFrameTarget {
  if (!step) {
    return fallback;
  }

  return { atMs: step.timeMs, atSeq: step.seq };
}

export interface ReplayTerminalWebProps {
  replay: ReplayInfo;
  machineLabel?: string;
  loadReplayAnsi: (replayId: string, target?: ReplayFrameTarget) => Promise<Uint8Array>;
  loadReplayTimeline: (replayId: string) => Promise<ReplayTimeline>;
  onBack: () => void;
  onDismiss?: (replayId: string) => boolean | void | Promise<boolean | void>;
}

export function ReplayTerminalWeb({
  replay,
  machineLabel,
  loadReplayAnsi,
  loadReplayTimeline,
  onBack,
  onDismiss,
}: ReplayTerminalWebProps) {
  const latestFallbackTarget = useMemo<ReplayFrameTarget>(() => ({
    atMs: replay.durationMs,
    atSeq: replay.lastSeq,
  }), [replay.durationMs, replay.lastSeq]);

  const [content, setContent] = useState<Uint8Array | null>(null);
  const [writer, setWriter] = useState<((data: Uint8Array) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [frameLoading, setFrameLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeedIndex, setPlaybackSpeedIndex] = useState(DEFAULT_PLAYBACK_SPEED_INDEX);
  const contentRef = useRef<Uint8Array | null>(null);
  const frameRequestIdRef = useRef(0);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (!writer || !content) {
      return;
    }
    writer(content);
  }, [content, writer]);

  const setWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    setWriter(() => fn);
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
    options: { preserveContent: boolean },
  ): Promise<void> => {
    const requestId = ++frameRequestIdRef.current;
    setFrameLoading(true);
    setError(null);

    if (!options.preserveContent && !contentRef.current) {
      setContent(LOADING_REPLAY_ANSI);
    }

    try {
      const bytes = await loadReplayAnsi(replay.replayId, target);
      if (frameRequestIdRef.current !== requestId) {
        return;
      }

      setContent(bytes.length > 0 ? new Uint8Array(bytes) : EMPTY_REPLAY_ANSI);
      setLoadedTargetKey(targetKey(target));
      setError(null);
    } catch (loadError) {
      if (frameRequestIdRef.current !== requestId) {
        return;
      }

      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);

      if (!contentRef.current || !options.preserveContent) {
        setContent(encodeAnsi(`\x1b[2J\x1b[H\x1b[31mFailed to load replay\x1b[0m\r\n\r\n${message}`));
      }
    } finally {
      if (frameRequestIdRef.current === requestId) {
        setFrameLoading(false);
      }
    }
  }, [loadReplayAnsi, replay.replayId]);

  useEffect(() => {
    let cancelled = false;
    frameRequestIdRef.current += 1;
    setIsPlaying(false);
    setPlaybackSpeedIndex(DEFAULT_PLAYBACK_SPEED_INDEX);
    setTimeline(null);
    setCurrentStepIndex(-1);
    setLoadedTargetKey(null);
    setError(null);
    setContent(null);
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

      await loadFrame(toFrameTarget(initialStep, latestFallbackTarget), { preserveContent: false });
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
    };
  }, [latestFallbackTarget, loadFrame, loadReplayTimeline, reloadKey, replay.replayId]);

  useEffect(() => {
    if (!timeline || currentStepIndex < 0 || currentTargetKey === loadedTargetKey) {
      return;
    }

    void loadFrame(currentTarget, { preserveContent: true });
  }, [currentStepIndex, currentTarget, currentTargetKey, loadFrame, loadedTargetKey, timeline]);

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
    const timer = window.setTimeout(() => {
      setCurrentStepIndex((index) => {
        if (!timeline) {
          return index;
        }
        return clamp(index + 1, 0, timeline.steps.length - 1);
      });
    }, delayMs);

    return () => window.clearTimeout(timer);
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

  const stepReplay = useCallback((direction: -1 | 1, count = 1) => {
    if (!timeline || timeline.steps.length === 0) {
      return;
    }

    setIsPlaying(false);
    setCurrentStepIndex((index) => {
      const resolvedIndex = index < 0 ? timeline.steps.length - 1 : index;
      return clamp(resolvedIndex + (direction * count), 0, timeline.steps.length - 1);
    });
  }, [timeline]);

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

    setCurrentStepIndex((index) => index >= timeline.steps.length - 1 ? 0 : Math.max(0, index));
    setIsPlaying(true);
  }, [isPlaying, timeline]);

  const jumpToBoundary = useCallback((direction: 'start' | 'end') => {
    if (!timeline || timeline.steps.length === 0) {
      return;
    }

    setIsPlaying(false);
    setCurrentStepIndex(direction === 'start' ? 0 : timeline.steps.length - 1);
  }, [timeline]);

  const handleDismiss = useCallback(async () => {
    const shouldGoBack = await onDismiss?.(replay.replayId);
    if (shouldGoBack !== false) {
      onBack();
    }
  }, [onBack, onDismiss, replay.replayId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (event.key === 'Escape' || event.key === 'q') {
        event.preventDefault();
        onBack();
        return;
      }

      if (event.key === 'd' && onDismiss) {
        event.preventDefault();
        void handleDismiss();
        return;
      }

      if (event.key === 'r') {
        event.preventDefault();
        setReloadKey((value) => value + 1);
        return;
      }

      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        togglePlayback();
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        jumpToBoundary('start');
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        jumpToBoundary('end');
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (isPlaying) {
          adjustPlaybackSpeed(-1, event.shiftKey ? 2 : 1);
        } else {
          stepReplay(-1, event.shiftKey ? FAST_SCRUB_STEP_COUNT : 1);
        }
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (isPlaying) {
          adjustPlaybackSpeed(1, event.shiftKey ? 2 : 1);
        } else {
          stepReplay(1, event.shiftKey ? FAST_SCRUB_STEP_COUNT : 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [adjustPlaybackSpeed, handleDismiss, isPlaying, jumpToBoundary, onBack, onDismiss, stepReplay, togglePlayback]);

  const totalTimeMs = timeline?.latestTimeMs ?? replay.durationMs;
  const activeTimeMs = currentTarget.atMs ?? totalTimeMs;
  const totalSteps = timeline ? Math.max(0, timeline.steps.length - 1) : 0;
  const visibleStepIndex = timeline && currentStepIndex >= 0
    ? clamp(currentStepIndex, 0, Math.max(0, timeline.steps.length - 1))
    : totalSteps;
  const speedLabel = `${playbackSpeed.toFixed(playbackSpeed < 1 ? 2 : 1)}x`;
  const activeTimeLabel = formatReplayTime(activeTimeMs);
  const totalTimeLabel = formatReplayTime(totalTimeMs);
  const stepLabel = `${visibleStepIndex}/${totalSteps}`;
  const transportHint = isPlaying
    ? '[Space] Pause  [←/→] Speed  [Shift+←/→] More'
    : '[Space] Play  [←/→] Step  [Shift+←/→] Skip';

  return (
    <div className="w-screen h-screen flex flex-col bg-[#0d1117] overflow-hidden">
      <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1 overflow-hidden">
          <button
            onClick={onBack}
            className="text-sm text-[#8b949e] hover:text-[#e6edf3] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
          >
            ← <span className="hidden sm:inline ml-1">Workspaces</span>
          </button>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="text-sm text-[#8b949e] truncate">
              <span className={replay.status === 'crashed' ? 'text-[#ff7b72]' : 'text-[#79c0ff]'}>↺</span>{' '}
              {machineLabel && <span className="hidden sm:inline">{machineLabel}</span>}
              {machineLabel && <span className="hidden sm:inline text-[#6e7681] mx-1">/</span>}
              <span className="text-[#e6edf3]">{replay.sessionName}</span>
              {replay.workspaceName && <span className="text-[#6e7681]"> · {replay.workspaceName}</span>}
            </div>
            <div className="text-xs text-[#8b949e] font-mono tabular-nums flex items-center gap-3 overflow-x-auto whitespace-nowrap">
              <span className="inline-flex min-w-[14ch] justify-end">
                <span className="inline-block min-w-[6ch] text-right">{activeTimeLabel}</span>
                <span>/</span>
                <span>{totalTimeLabel}</span>
              </span>
              <span className="inline-flex min-w-[7ch] justify-end">{stepLabel}</span>
              <span className={`inline-flex min-w-[9ch] justify-end ${isPlaying ? 'text-[#3fb950]' : 'text-[#8b949e]'}`}>
                {isPlaying ? '[playing]' : '[paused]'}
              </span>
              <span className="inline-flex min-w-[6ch] justify-end text-[#d29922]">{speedLabel}</span>
              {(timelineLoading || frameLoading) && <span className="text-[#d29922]">[loading]</span>}
              {error && <span className="text-[#ff7b72] truncate">[error] {error}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="hidden md:flex items-center gap-1">
            <button
              onClick={() => stepReplay(-1)}
              className="px-2 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[40px] border border-[#30363d]"
              aria-label="Previous replay step"
            >
              ←
            </button>
            <button
              onClick={togglePlayback}
              className="px-3 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[40px] border border-[#30363d]"
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => stepReplay(1)}
              className="px-2 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[40px] border border-[#30363d]"
              aria-label="Next replay step"
            >
              →
            </button>
            <button
              onClick={() => adjustPlaybackSpeed(-1)}
              className="px-2 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[40px] border border-[#30363d]"
              aria-label="Slower playback"
            >
              -
            </button>
            <button
              onClick={() => adjustPlaybackSpeed(1)}
              className="px-2 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[40px] border border-[#30363d]"
              aria-label="Faster playback"
            >
              +
            </button>
          </div>
          <div className="hidden lg:block text-xs text-[#6e7681] font-mono whitespace-nowrap">{transportHint}</div>
          {onDismiss && (
            <button
              onClick={() => void handleDismiss()}
              className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
            >
              {replay.dismissedAt ? 'Restore' : 'Dismiss'}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <SessionTerminal
          onData={() => {}}
          setWriteCallback={setWriteCallback}
          readOnly={true}
          allowTapFocus={false}
          allowTouchScroll={true}
        />
      </div>
    </div>
  );
}
