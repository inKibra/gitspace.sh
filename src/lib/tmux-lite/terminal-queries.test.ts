import { describe, expect, test } from "bun:test";
import { Terminal as XTerminal } from "@xterm/headless";
import { installDsrCprResponder } from "./terminal-queries";

function writeAsync(term: XTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("tmux-lite terminal queries", () => {
  test("responds to DSR (CSI 6 n) with CPR using current cursor position", async () => {
    const xterm = new XTerminal({ cols: 80, rows: 24, allowProposedApi: true });

    const writes: Buffer[] = [];
    const dispose = installDsrCprResponder(xterm, (data) => {
      writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    try {
      // Move cursor by writing text
      await writeAsync(xterm, "abc");

      // DSR query: request cursor position
      await writeAsync(xterm, "\x1b[6n");

      expect(writes.length).toBe(1);
      // cursorX=3 => col=4, cursorY=0 => row=1
      expect(writes[0]?.toString("utf-8")).toBe("\x1b[1;4R");
    } finally {
      dispose();
      xterm.dispose();
    }
  });

  test("also responds to DEC private DSR prefix variant (CSI ? 6 n)", async () => {
    const xterm = new XTerminal({ cols: 80, rows: 24, allowProposedApi: true });

    const writes: string[] = [];
    const dispose = installDsrCprResponder(xterm, (data) => {
      writes.push((Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf-8"));
    });

    try {
      await writeAsync(xterm, "x");
      await writeAsync(xterm, "\x1b[?6n");

      expect(writes).toEqual(["\x1b[1;2R"]);
    } finally {
      dispose();
      xterm.dispose();
    }
  });
});


