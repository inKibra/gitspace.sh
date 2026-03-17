import { describe, expect, it, mock } from 'bun:test';
import { restoreTuiTerminalState, TUI_RESET_SEQUENCES } from './tui-terminal-cleanup';

describe('restoreTuiTerminalState', () => {
  it('restores raw mode and writes terminal reset sequences', () => {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      write: mock((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
    };
    const stdin = {
      isTTY: true,
      setRawMode: mock((_mode: boolean) => {}),
    };

    restoreTuiTerminalState({ stdout, stdin });

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(writes).toEqual([...TUI_RESET_SEQUENCES]);
  });

  it('skips terminal writes when stdout is not a tty', () => {
    const stdout = {
      isTTY: false,
      write: mock((_chunk: string) => true),
    };

    restoreTuiTerminalState({ stdout, stdin: null });

    expect(stdout.write).not.toHaveBeenCalled();
  });
});
