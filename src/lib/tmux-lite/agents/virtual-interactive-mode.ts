/**
 * Runs oh-my-pi's InteractiveMode on a VirtualTerminal instead of ProcessTerminal.
 *
 * This module bridges the SDK's InteractiveMode (which normally owns a real
 * terminal via ProcessTerminal) to a VirtualTerminal that feeds xterm-headless
 * in the tmux-lite session pipeline.
 *
 * The approach:
 * 1. Construct InteractiveMode normally (it creates ProcessTerminal internally)
 * 2. Replace `mode.ui` with a new TUI backed by our VirtualTerminal BEFORE init()
 * 3. Call mode.init() — TUI starts on VirtualTerminal, ProcessTerminal is never started
 * 4. Run the input loop — keystrokes arrive via VirtualTerminal.injectInput()
 */
import type { VirtualTerminal } from './virtual-terminal.js';
import type { OmpAgentSession } from './omp-types.js';

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
const PI_TUI_PACKAGE = '@oh-my-pi/pi-tui';

interface InteractiveModeInstance {
  ui: any;  // TUI instance
  init(): Promise<void>;
  getUserInput(): Promise<{ text: string; images?: unknown[]; cancelled: boolean; started: boolean }>;
  shutdown(): Promise<void>;
  isInitialized: boolean;
}

interface SubmitInteractiveInputFn {
  (mode: InteractiveModeInstance, session: OmpAgentSession, input: any): Promise<void>;
}

export interface VirtualInteractiveModeHandle {
  /** The InteractiveMode instance, for accessing state like todoPhases, session, etc. */
  mode: InteractiveModeInstance;
  /** Stop the interactive mode loop and clean up. */
  stop(): Promise<void>;
  /** Whether the mode is currently running. */
  readonly running: boolean;
}

/**
 * Start InteractiveMode on a VirtualTerminal.
 *
 * This replaces the terminal before init() so ProcessTerminal is never activated.
 * Then starts the infinite input loop that drives the agent.
 *
 * @param session The SDK agent session (already created in-process)
 * @param virtualTerminal The VirtualTerminal wired to xterm-headless
 * @param options Optional configuration
 */
export async function startVirtualInteractiveMode(
  session: OmpAgentSession,
  virtualTerminal: VirtualTerminal,
  options?: {
    version?: string;
    changelogMarkdown?: string;
    initialMessage?: string;
  },
): Promise<VirtualInteractiveModeHandle> {
  // Dynamic imports — the SDK may not be installed until runtime
  const ompModule = await import(OMP_PACKAGE) as any;
  const tuiModule = await import(PI_TUI_PACKAGE) as any;

  const { InteractiveMode, submitInteractiveInput } = ompModule;
  const { TUI } = tuiModule;

  if (!InteractiveMode || !TUI) {
    throw new Error('Failed to import InteractiveMode or TUI from oh-my-pi packages');
  }

  const version = options?.version ?? ompModule.VERSION ?? 'unknown';
  const changelog = options?.changelogMarkdown;

  // Step 1: Construct InteractiveMode (creates ProcessTerminal + TUI internally)
  const mode: InteractiveModeInstance = new InteractiveMode(
    session,
    version,
    changelog,
  );

  // Step 2: Replace the TUI with one backed by our VirtualTerminal
  // This must happen BEFORE init() which calls ui.start()
  const showHardwareCursor = (session as any).settings?.get?.('showHardwareCursor') ?? false;
  mode.ui = new TUI(virtualTerminal, showHardwareCursor);

  const clearOnShrink = (session as any).settings?.get?.('clearOnShrink') ?? false;
  if (typeof mode.ui.setClearOnShrink === 'function') {
    mode.ui.setClearOnShrink(clearOnShrink);
  }

  // Step 3: Initialize (starts TUI on VirtualTerminal, loads UI components)
  await mode.init();

  // Step 4: Start the input loop
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
        // Unexpected error in the input loop
        console.error('[virtual-interactive-mode] Input loop error:', error);
      }
    }
  })();

  const handle: VirtualInteractiveModeHandle = {
    mode,
    get running() { return running; },
    async stop() {
      running = false;
      try {
        await mode.shutdown();
      } catch {
        // Shutdown may fail if already stopped
      }
      // Wait for the loop to exit (with timeout)
      await Promise.race([
        loopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };

  return handle;
}
