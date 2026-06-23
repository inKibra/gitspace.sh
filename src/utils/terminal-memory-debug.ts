type CounterMap = Record<string, number>;

export interface TerminalMemoryDebugState {
  counters: CounterMap;
  max: CounterMap;
  gauges: CounterMap;
  inc(name: string, delta?: number): number;
  dec(name: string, delta?: number): number;
  gauge(name: string, value: number): number;
  maxValue(name: string, value: number): number;
  snapshot(): { counters: CounterMap; max: CounterMap; gauges: CounterMap };
  reset(): void;
}

declare global {
  // Debug-only browser console hook for diagnosing Dockview/Ghostty lifecycle churn.
  // eslint-disable-next-line no-var
  var __GITSPACE_TERMINAL_MEMORY_DEBUG__: TerminalMemoryDebugState | undefined;
}

function cloneCounters(value: CounterMap): CounterMap {
  return { ...value };
}

function createState(): TerminalMemoryDebugState {
  const counters: CounterMap = {};
  const max: CounterMap = {};
  const gauges: CounterMap = {};

  const state: TerminalMemoryDebugState = {
    counters,
    max,
    gauges,
    inc(name: string, delta = 1): number {
      counters[name] = (counters[name] ?? 0) + delta;
      return counters[name];
    },
    dec(name: string, delta = 1): number {
      counters[name] = (counters[name] ?? 0) - delta;
      return counters[name];
    },
    gauge(name: string, value: number): number {
      gauges[name] = value;
      return value;
    },
    maxValue(name: string, value: number): number {
      max[name] = Math.max(max[name] ?? 0, value);
      return max[name];
    },
    snapshot() {
      return {
        counters: cloneCounters(counters),
        max: cloneCounters(max),
        gauges: cloneCounters(gauges),
      };
    },
    reset(): void {
      for (const key of Object.keys(counters)) delete counters[key];
      for (const key of Object.keys(max)) delete max[key];
      for (const key of Object.keys(gauges)) delete gauges[key];
    },
  };

  return state;
}

export function getTerminalMemoryDebug(): TerminalMemoryDebugState {
  const existing = globalThis.__GITSPACE_TERMINAL_MEMORY_DEBUG__;
  if (existing) return existing;

  const state = createState();
  globalThis.__GITSPACE_TERMINAL_MEMORY_DEBUG__ = state;
  return state;
}

export function terminalMemoryDebugIncrement(name: string, delta = 1): void {
  getTerminalMemoryDebug().inc(name, delta);
}

export function terminalMemoryDebugDecrement(name: string, delta = 1): void {
  getTerminalMemoryDebug().dec(name, delta);
}

export function terminalMemoryDebugGauge(name: string, value: number): void {
  getTerminalMemoryDebug().gauge(name, value);
}

export function terminalMemoryDebugMax(name: string, value: number): void {
  getTerminalMemoryDebug().maxValue(name, value);
}
