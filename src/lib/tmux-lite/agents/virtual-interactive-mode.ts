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
  // Dynamic imports: oh-my-pi packages have module-level side effects (postmortem
  // signal handlers that call process.exit, provider registration, etc.) that
  // conflict with OpenTUI's terminal management. Keep these lazy so they only
  // load when actually starting an interactive mode session.
  const { InteractiveMode, submitInteractiveInput, Settings, initTheme, VERSION: OMP_VERSION } = await import('@oh-my-pi/pi-coding-agent');
  const { initializeWithSettings } = await import('@oh-my-pi/pi-coding-agent/discovery');
  const { TUI } = await import('@oh-my-pi/pi-tui');

  const sessionSettings = (session as any).settings;
  const cwd = options?.cwd ?? (session as any).sessionManager?.getCwd?.() ?? process.cwd();
  const agentDir = options?.agentDir ?? process.env.PI_CODING_AGENT_DIR;

  // InteractiveMode constructor uses multiple global singletons established by
  // the CLI/main bootstrap path: Settings, discovery/provider settings, and theme.
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

  const showHardwareCursor = sessionSettings?.get?.('showHardwareCursor') ?? false;
  mode.ui = new TUI(virtualTerminal, showHardwareCursor);

  const clearOnShrink = sessionSettings?.get?.('clearOnShrink') ?? false;
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
  const loopPromise = (async () => {
    try {
      while (running && mode.isInitialized) {
        const input = await mode.getUserInput();
        if (!running) break;
        if (input.cancelled) continue;
        await (submitInteractiveInput as any)(mode, session, input);
      }
    } catch (error) {
      if (running) {
        running = false;
        console.error('[virtual-interactive-mode] Input loop crashed:', error);
      }
    }
  })();

  return {
    mode,
    get running() {
      return running;
    },
    async stop() {
      running = false;
      try {
        await mode.shutdown();
      } catch (err) {
        console.warn('[virtual-interactive-mode] Shutdown error (may be already stopped):', err);
      }
      await Promise.race([
        loopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };
}
