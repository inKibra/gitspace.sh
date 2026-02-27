export const VT_KITTY_KEYBOARD_CONFIG = {
  disambiguate: false,
  alternateKeys: false,
  events: false,
  allKeysAsEscapes: false,
  reportText: false,
} as const;

export const KITTY_KEYBOARD_DISABLE_SEQUENCE = '\x1b[>4;0m';
export const KITTY_KEYBOARD_ENABLE_SEQUENCE = '\x1b[>4;1m';

export interface KittyKeyboardRenderer {
  useKittyKeyboard: boolean;
  disableKittyKeyboard: () => void;
  enableKittyKeyboard: () => void;
}

type TerminalWrite = (chunk: string) => void;

function writeToStdout(chunk: string): void {
  process.stdout.write(chunk);
}

export function forceDisableKittyKeyboard(
  renderer: KittyKeyboardRenderer,
  write: TerminalWrite = writeToStdout
): void {
  renderer.useKittyKeyboard = false;
  renderer.disableKittyKeyboard();
  write(KITTY_KEYBOARD_DISABLE_SEQUENCE);
}

export function restoreKittyKeyboard(
  renderer: KittyKeyboardRenderer,
  previousKittyMode: boolean,
  write: TerminalWrite = writeToStdout
): void {
  renderer.useKittyKeyboard = previousKittyMode;
  if (previousKittyMode) {
    renderer.enableKittyKeyboard();
    write(KITTY_KEYBOARD_ENABLE_SEQUENCE);
    return;
  }

  renderer.disableKittyKeyboard();
  write(KITTY_KEYBOARD_DISABLE_SEQUENCE);
}
