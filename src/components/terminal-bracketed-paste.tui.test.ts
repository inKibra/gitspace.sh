import { describe, expect, test } from "bun:test";
import { BracketedPasteModeTracker, wrapPaste } from "./terminal-bracketed-paste.tui";

describe("BracketedPasteModeTracker", () => {
  test("defaults to disabled", () => {
    const t = new BracketedPasteModeTracker();
    expect(t.isEnabled).toBe(false);
  });

  test("enables on CSI ? 2004 h and disables on CSI ? 2004 l", () => {
    const t = new BracketedPasteModeTracker();
    t.update(Buffer.from("\x1b[?2004h"));
    expect(t.isEnabled).toBe(true);
    t.update(Buffer.from("\x1b[?2004l"));
    expect(t.isEnabled).toBe(false);
  });

  test("handles sequences split across chunks", () => {
    const t = new BracketedPasteModeTracker();
    t.update(Buffer.from("\x1b[?20"));
    expect(t.isEnabled).toBe(false);
    t.update(Buffer.from("04h"));
    expect(t.isEnabled).toBe(true);
  });

  test("last occurrence wins when both appear", () => {
    const t = new BracketedPasteModeTracker();
    t.update(Buffer.from("\x1b[?2004h...\x1b[?2004l"));
    expect(t.isEnabled).toBe(false);
    t.update(Buffer.from("\x1b[?2004l...\x1b[?2004h"));
    expect(t.isEnabled).toBe(true);
  });
});

describe("wrapPaste", () => {
  test("wraps when enabled", () => {
    expect(wrapPaste("hi", true)).toBe("\x1b[200~hi\x1b[201~");
  });

  test("passes through when disabled", () => {
    expect(wrapPaste("hi", false)).toBe("hi");
  });
});
