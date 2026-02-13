import { useCallback, useEffect, useMemo, useState } from 'react';

export interface UseUserActivityOptions {
  /**
   * Whether the UI is currently in a mode where user activity should be tracked.
   * If false, user is treated as active.
   */
  isActivityTracked: boolean;
  /** Duration window for considering the user active. */
  holdWhenIdleMs: number;
  /** Interval for re-evaluating active/idle state. */
  tickIntervalMs?: number;
}

export interface UseUserActivityResult {
  /** Last activity timestamp in ms since epoch. */
  lastActivityAt: number;
  /** Whether user is currently active. */
  isUserActive: boolean;
  /** Mark activity (call on keypress/terminal input/etc). */
  markActivity: () => void;
}

/**
 * Shared user-activity helper used by web and TUI notification logic.
 */
export function useUserActivity(options: UseUserActivityOptions): UseUserActivityResult {
  const {
    isActivityTracked,
    holdWhenIdleMs,
    tickIntervalMs = 1000,
  } = options;

  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const [activityTick, setActivityTick] = useState(0);

  const markActivity = useCallback(() => {
    setLastActivityAt(Date.now());
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setActivityTick((t) => t + 1);
    }, tickIntervalMs);

    return () => clearInterval(interval);
  }, [tickIntervalMs]);

  const isUserActive = useMemo(() => {
    if (!isActivityTracked) {
      return true;
    }
    return Date.now() - lastActivityAt < holdWhenIdleMs;
  }, [isActivityTracked, lastActivityAt, holdWhenIdleMs, activityTick]);

  return {
    lastActivityAt,
    isUserActive,
    markActivity,
  };
}
