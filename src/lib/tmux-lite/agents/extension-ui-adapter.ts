/**
 * Adapts GitSpace's host-UI bridge to the OMP SDK's full `ExtensionUIContext`.
 *
 * The SDK's extension runtime is initialized ONCE per session with a single
 * `uiContext` object (see `modes/runtime-init.ts`), and the runner keeps that
 * reference for the session's lifetime — there is no setter. The host, however,
 * learns whether a client UI is watching only when `enableUI()` runs, which can
 * happen after boot. So this adapter is a stable façade: the runner holds it
 * forever, and every call re-reads the current delegate.
 *
 * Members the native surface cannot honor are NOT silently swallowed:
 *   - `custom` renders a pi-tui component — rejects, so an extension awaiting
 *     it fails loudly instead of hanging forever.
 *   - `onTerminalInput` needs a real terminal — returns a no-op unsubscribe and
 *     warns once, because throwing during extension load would kill the whole
 *     extension over an opportunistic subscription.
 *   - Theme/footer/header/editor-component/tool-expansion are terminal chrome
 *     with no native equivalent; they no-op like the SDK's own RPC mode.
 */

import type {
  ExtensionUIContext,
  TerminalInputHandler,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import type { OmpDialogOptions, OmpHostUIContext } from './omp-types.js';

/** Resolves the live native-surface bridge, or null when no client UI is attached. */
export type HostUIContextResolver = () => OmpHostUIContext | null;

/** The SDK's `ExtensionUIDialogOptions` is structurally the host shim's
 *  `OmpDialogOptions`, and `select` is declared `string[]` on the shim even
 *  though the SDK passes `{label, description}` objects (the bridge normalizes
 *  both). Both casts are load-bearing, not cosmetic. */

export function createExtensionUIContext(resolve: HostUIContextResolver): ExtensionUIContext {
  let warnedTerminalInput = false;

  return {
    select: async (title, options, dialogOptions) => {
      const ui = resolve();
      if (!ui) return undefined;
      return ui.select(title, options as unknown as string[], dialogOptions as OmpDialogOptions | undefined);
    },

    confirm: async (title, message, dialogOptions) => {
      const ui = resolve();
      if (!ui) return false;
      return ui.confirm(title, message, dialogOptions as OmpDialogOptions | undefined);
    },

    input: async (title, placeholder, dialogOptions) => {
      const ui = resolve();
      if (!ui) return undefined;
      return ui.input(title, placeholder, dialogOptions as OmpDialogOptions | undefined);
    },

    editor: async (title, prefill) => {
      const ui = resolve();
      if (!ui) return undefined;
      return ui.editor(title, prefill);
    },

    notify: (message, type) => {
      resolve()?.notify(message, type);
    },

    setStatus: (key, text) => {
      resolve()?.setStatus(key, text);
    },

    setWorkingMessage: (message) => {
      resolve()?.setWorkingMessage(message);
    },

    setWidget: (key, content) => {
      // Component factories need a TUI to render into; only line content crosses
      // to the native surface. A factory clears any previous lines for the key.
      resolve()?.setWidget(key, Array.isArray(content) ? content : undefined);
    },

    setTitle: (title) => {
      resolve()?.setTitle(title);
    },

    setEditorText: (text) => {
      resolve()?.setEditorText(text);
    },

    pasteToEditor: (text) => {
      resolve()?.pasteToEditor(text);
    },

    getEditorText: () => resolve()?.getEditorText() ?? '',

    onTerminalInput: (_handler: TerminalInputHandler) => {
      if (!warnedTerminalInput) {
        warnedTerminalInput = true;
        console.warn('[extension-ui] onTerminalInput is unavailable: hosted sessions have no terminal.');
      }
      return () => {};
    },

    custom: <T>(): Promise<T> => Promise.reject(
      new Error('Extension custom UI components require a terminal; hosted sessions render the native surface.'),
    ),

    // Terminal chrome with no native equivalent — the SDK's RPC mode stubs these too.
    setFooter: () => {},
    setHeader: () => {},
    setEditorComponent: () => {},
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    get theme() {
      return undefined as unknown as ExtensionUIContext['theme'];
    },
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({ success: false, error: 'Theme switching is unavailable for hosted sessions' }),
  };
}
