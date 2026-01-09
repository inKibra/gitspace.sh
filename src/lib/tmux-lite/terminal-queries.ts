import type { Terminal as XTerminal } from "@xterm/headless";

export type PtyWriter = (data: string | Buffer) => void;

/**
 * Install a minimal DSR -> CPR responder.
 *
 * Some TUIs send a cursor position query (DSR: CSI 6 n / ESC[6n) and expect the
 * terminal emulator to respond on stdin with a cursor position report
 * (CPR: CSI {row};{col} R / ESC[{row};{col}R).
 *
 * In Spaces, our clients are mostly render-only, so we emulate the terminal-side
 * response server-side using xterm-headless' cursor position.
 */
export function installDsrCprResponder(xterm: XTerminal, writeToPty: PtyWriter): () => void {
  const disposables: Array<{ dispose: () => void }> = [];

  const register = (id: { prefix?: string; final: string }) => {
    const d = xterm.parser.registerCsiHandler(id as any, (params: any[]) => {
      // CSI Ps n
      const ps = Array.isArray(params?.[0]) ? params?.[0]?.[0] : params?.[0];
      if (ps !== 6) return false;

      // xterm cursorX/cursorY are 0-based; CPR is 1-based.
      const row = xterm.buffer.active.cursorY + 1;
      const col = xterm.buffer.active.cursorX + 1;
      try {
        writeToPty(Buffer.from(`\x1b[${row};${col}R`));
      } catch {
        // ignore
      }
      return true;
    });
    disposables.push(d as any);
  };

  // Plain DSR (CSI 6 n)
  register({ final: "n" });
  // Some implementations use DEC private prefix (CSI ? Ps n)
  register({ prefix: "?", final: "n" });

  return () => {
    for (const d of disposables) {
      try { d.dispose(); } catch {}
    }
  };
}


