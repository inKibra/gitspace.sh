import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GitSpaceEngine } from './engine/engine.js';
import type { GitSpaceConfig, PlatformAdapters } from './engine/types.js';
import type { MultiMachineState } from '../machine/multi/types.js';

export interface GitSpaceContextValue {
  engine: GitSpaceEngine;
  state: MultiMachineState;
}

const GitSpaceContext = createContext<GitSpaceContextValue | null>(null);

export interface GitSpaceProviderProps {
  platform: PlatformAdapters;
  relay?: GitSpaceConfig['relay'];
  identity?: GitSpaceConfig['identity'];
  children: React.ReactNode;
}

export function GitSpaceProvider({ platform, relay, identity, children }: GitSpaceProviderProps) {
  // Create engine once on mount — platform is structural, not expected to change
  const engineRef = useRef<GitSpaceEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new GitSpaceEngine({ platform, relay, identity });
  }
  const engine = engineRef.current;

  // Start engine on mount, destroy on unmount
  useEffect(() => {
    engine.start().catch((err) => {
      console.error('[GitSpaceProvider] Engine start failed:', err);
    });
    return () => { engine.destroy().catch(() => {}); };
  }, [engine]);

  // Sync relay/identity config changes, but skip the first render since
  // the engine was already constructed with the initial config values.
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    engine.updateConfig({ relay, identity }).catch(() => {});
  }, [engine, relay?.url, identity?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to state
  const [state, setState] = useState<MultiMachineState>(() => engine.getState());
  useEffect(() => {
    // Sync initial state in case start() already produced changes before subscription
    setState(engine.getState());
    return engine.subscribe(setState);
  }, [engine]);

  const contextValue = useMemo<GitSpaceContextValue>(
    () => ({ engine, state }),
    [engine, state]
  );

  return (
    <GitSpaceContext.Provider value={contextValue}>
      {children}
    </GitSpaceContext.Provider>
  );
}

/** Access the GitSpace engine and reactive state from within a GitSpaceProvider. */
export function useGitSpace(): GitSpaceContextValue {
  const ctx = useContext(GitSpaceContext);
  if (!ctx) throw new Error('useGitSpace must be used within a GitSpaceProvider');
  return ctx;
}

/** Access only the GitSpace engine (for action calls without state subscription). */
export function useGitSpaceEngine(): GitSpaceEngine {
  return useGitSpace().engine;
}
