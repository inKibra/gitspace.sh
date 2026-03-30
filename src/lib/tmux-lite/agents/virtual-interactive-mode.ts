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

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
const OMP_DISCOVERY_PACKAGE = '@oh-my-pi/pi-coding-agent/discovery';
const PI_TUI_PACKAGE = '@oh-my-pi/pi-tui';

interface InteractiveModeInstance {
  ui: any;
  init(): Promise<void>;
  getUserInput(): Promise<{ text: string; images?: unknown[]; cancelled: boolean; started: boolean }>;
  shutdown(): Promise<void>;
  isInitialized: boolean;
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
  const ompModule = await import(OMP_PACKAGE) as any;
  const discoveryModule = await import(OMP_DISCOVERY_PACKAGE) as any;
  const tuiModule = await import(PI_TUI_PACKAGE) as any;

  const { InteractiveMode, submitInteractiveInput, Settings, initTheme } = ompModule;
  const { initializeWithSettings } = discoveryModule;
  const { TUI } = tuiModule;

  if (!InteractiveMode || !TUI || !Settings || !initializeWithSettings || !initTheme) {
    throw new Error('Failed to import InteractiveMode/TUI/settings bootstrap from oh-my-pi packages');
  }

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

  const version = options?.version ?? ompModule.VERSION ?? 'unknown';
  const changelog = options?.changelogMarkdown;

  const mode: InteractiveModeInstance = new InteractiveMode(session, version, changelog);

  const showHardwareCursor = sessionSettings?.get?.('showHardwareCursor') ?? false;
  mode.ui = new TUI(virtualTerminal, showHardwareCursor);

  const clearOnShrink = sessionSettings?.get?.('clearOnShrink') ?? false;
  if (typeof mode.ui.setClearOnShrink === 'function') {
    mode.ui.setClearOnShrink(clearOnShrink);
  }

  await mode.init();

  let running = true;
  const loopPromise = (async () => {
    try {
      while (running && mode.isInitialized) {
        const input = await mode.getUserInput();
        if (!running) break;
        if (input.cancelled) continue;
        await (submitInteractiveInput as SubmitInteractiveInputFn)(mode, session, input);
      }
    } catch (error) {
      if (running) {
        console.error('[virtual-interactive-mode] Input loop error:', error);
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
      } catch {
        // ignore already-stopped shutdown failures
      }
      await Promise.race([
        loopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };
}
