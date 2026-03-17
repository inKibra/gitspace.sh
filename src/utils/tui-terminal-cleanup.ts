const TUI_RESET_SEQUENCES = [
  '\x1b[?1000l',
  '\x1b[?1002l',
  '\x1b[?1003l',
  '\x1b[?1004l',
  '\x1b[?1006l',
  '\x1b[?1015l',
  '\x1b[?2004l',
  '\x1b[?25h',
  '\x1b[?1049l',
  '\x1b[0m',
] as const;

export interface TuiTerminalCleanupOptions {
  stdout?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> | null;
  stdin?: Pick<NodeJS.ReadStream, 'isTTY'> & { setRawMode?: (mode: boolean) => void } | null;
}

export function restoreTuiTerminalState(options: TuiTerminalCleanupOptions = {}): void {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;

  if (stdin?.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      // Best effort only.
    }
  }

  if (!stdout?.isTTY) {
    return;
  }

  for (const sequence of TUI_RESET_SEQUENCES) {
    try {
      stdout.write(sequence);
    } catch {
      // Best effort only.
    }
  }
}

export { TUI_RESET_SEQUENCES };
