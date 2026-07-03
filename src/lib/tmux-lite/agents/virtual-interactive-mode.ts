/**
 * Runs oh-my-pi's InteractiveMode on a VirtualTerminal instead of ProcessTerminal.
 *
 * InteractiveMode constructor reads the global `settings` singleton directly,
 * so virtual startup must ensure `Settings.init()` ran in this process before
 * constructing it. SDK session creation usually does this already, but we make
 * it explicit here so coordinator-driven attach stays correct even after future
 * SDK changes.
 */

import type { VirtualTerminal } from './virtual-terminal.js';
import type { OmpAgentSession } from './omp-types.js';

interface InteractiveModeInstance {
  ui: any;
  init(): Promise<void>;
  getUserInput(): Promise<{ text: string; images?: unknown[]; cancelled: boolean; started: boolean }>;
  shutdown(): Promise<void>;
  isInitialized: boolean;
  renderInitialMessages?(): void;
}

interface SubmitInteractiveInputFn {
  (mode: InteractiveModeInstance, session: OmpAgentSession, input: any): Promise<void>;
}

export interface VirtualInteractiveModeHandle {
  mode: InteractiveModeInstance;
  stop(): Promise<void>;
  readonly running: boolean;
}

export const CANCELLED_INPUT_BACKOFF_MS = 50;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VirtualInteractiveInputLoopController {
  isRunning: () => boolean;
  stop: () => void;
}

export interface RunVirtualInteractiveInputLoopOptions {
  controller: VirtualInteractiveInputLoopController;
  onCrash: (error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  cancelledInputBackoffMs?: number;
}

function resolveCancelledInputBackoffMs(value: number | undefined): number {
  if (value === undefined) return CANCELLED_INPUT_BACKOFF_MS;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('cancelledInputBackoffMs must be a positive finite number');
  }
  return Math.floor(value);
}

export async function runVirtualInteractiveInputLoop(
  mode: InteractiveModeInstance,
  session: OmpAgentSession,
  submitInteractiveInput: SubmitInteractiveInputFn,
  options: RunVirtualInteractiveInputLoopOptions,
): Promise<void> {
  const sleep = options.sleep ?? sleepMs;
  const cancelledInputBackoffMs = resolveCancelledInputBackoffMs(options.cancelledInputBackoffMs);

  try {
    while (options.controller.isRunning() && mode.isInitialized) {
      const input = await mode.getUserInput();
      if (!options.controller.isRunning()) break;
      if (input.cancelled) {
        await sleep(cancelledInputBackoffMs);
        continue;
      }
      await submitInteractiveInput(mode, session, input);
    }
  } catch (error) {
    if (options.controller.isRunning()) {
      options.controller.stop();
      options.onCrash(error);
    }
  }
}

export async function startVirtualInteractiveMode(
  session: OmpAgentSession,
  virtualTerminal: VirtualTerminal,
  options?: {
    version?: string;
    changelogMarkdown?: string;
    cwd?: string;
    agentDir?: string;
  },
): Promise<VirtualInteractiveModeHandle> {
  // load when actually starting an interactive mode session.
  const { InteractiveMode } = await import('@oh-my-pi/pi-coding-agent/modes/interactive-mode');
  const { submitInteractiveInput } = await import('@oh-my-pi/pi-coding-agent/main');
  const { Settings } = await import('@oh-my-pi/pi-coding-agent/config/settings');
  const { initTheme } = await import('@oh-my-pi/pi-coding-agent/modes/theme/theme');
  const { VERSION: OMP_VERSION } = await import('@oh-my-pi/pi-utils');
  const { initializeWithSettings } = await import('@oh-my-pi/pi-coding-agent/discovery');
  const { TUI } = await import('@oh-my-pi/pi-tui');

  const sessionSettings = (session as any).settings;
  const cwd = options?.cwd ?? (session as any).sessionManager?.getCwd?.() ?? process.cwd();
  const agentDir = options?.agentDir ?? process.env.PI_CODING_AGENT_DIR;

  // InteractiveMode constructor uses multiple global singletons established by
  // the CLI/main bootstrap path: Settings, discovery/provider settings, and theme.
  // 16.x's settings.get throws on unknown/removed paths (15.x returned undefined),
  // so read the loosely-typed session settings defensively — keys come and go
  // across SDK versions (e.g. clearOnShrink was removed in 16.x).
  const safeGet = (s: any, path: string): unknown => {
    try {
      return s?.get?.(path);
    } catch {
      return undefined;
    }
  };

  const activeSettings = await Settings.init({ cwd, agentDir });
  initializeWithSettings(activeSettings);
  await initTheme(
    false,
    activeSettings.get('symbolPreset'),
    activeSettings.get('colorBlindMode'),
    activeSettings.get('theme.dark'),
    activeSettings.get('theme.light'),
  );

  const version = options?.version ?? OMP_VERSION ?? 'unknown';
  const changelog = options?.changelogMarkdown;

  const mode = new InteractiveMode(session as any, version, changelog) as any as InteractiveModeInstance;

  const showHardwareCursor = (safeGet(sessionSettings, 'showHardwareCursor') as boolean | undefined) ?? false;
  mode.ui = new TUI(virtualTerminal, showHardwareCursor);

  const clearOnShrink = (safeGet(sessionSettings, 'clearOnShrink') as boolean | undefined) ?? false;
  if (typeof mode.ui.setClearOnShrink === 'function') {
    mode.ui.setClearOnShrink(clearOnShrink);
  }

  await mode.init();

  // Render historical conversation messages from the session file so resumed
  // sessions show prior messages, matching the Pi CLI behavior.
  if (typeof mode.renderInitialMessages === 'function') {
    mode.renderInitialMessages();
  }

  let running = true;
  const loopPromise = runVirtualInteractiveInputLoop(
    mode,
    session,
    submitInteractiveInput as any,
    {
      controller: {
        isRunning: () => running,
        stop: () => {
          running = false;
        },
      },
      onCrash: (error) => {
        console.error('[virtual-interactive-mode] Input loop crashed:', error);
      },
    },
  );

  return {
    mode,
    get running() {
      return running;
    },
    async stop() {
      running = false;
      // Pi SDK's InteractiveMode.shutdown() can trigger module-level postmortem
      // signal handlers that call process.exit(), killing the entire tmux-lite
      // server. Guard against both thrown errors and synchronous exit.
      const originalExit = process.exit;
      try {
        process.exit = ((code?: number) => {
          console.error(`[virtual-interactive-mode] Blocked process.exit(${code}) during shutdown`);
        }) as never;
        await mode.shutdown();
      } catch (err) {
        console.warn('[virtual-interactive-mode] Shutdown error (may be already stopped):', err);
      } finally {
        process.exit = originalExit;
      }
      await Promise.race([
        loopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };
}
