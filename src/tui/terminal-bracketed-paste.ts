/**
 * Bracketed paste mode tracking (DECSET 2004).
 *
 * Remote programs can enable bracketed paste by emitting CSI ? 2004 h and
 * disable it with CSI ? 2004 l. When enabled, pasted content should be wrapped
 * in ESC[200~ ... ESC[201~ so shells/editors can treat it as a paste.
 */

const ENABLE = Buffer.from("\x1b[?2004h");
const DISABLE = Buffer.from("\x1b[?2004l");

export class BracketedPasteModeTracker {
  private enabled = false;
  private tail = Buffer.alloc(0);

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Update mode based on an output chunk from the remote PTY.
   * Handles sequences split across chunks by keeping a short tail.
   */
  update(chunk: Buffer): void {
    if (chunk.length === 0) return;

    const scanBuf = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;

    const lastEnable = scanBuf.lastIndexOf(ENABLE);
    const lastDisable = scanBuf.lastIndexOf(DISABLE);
    if (lastEnable !== -1 || lastDisable !== -1) {
      this.enabled = lastEnable > lastDisable;
    }

    const keep = Math.max(ENABLE.length, DISABLE.length) - 1;
    this.tail = scanBuf.length > keep
      ? Buffer.from(scanBuf.subarray(scanBuf.length - keep))
      : Buffer.from(scanBuf);
  }
}

export function wrapPaste(text: string, bracketedPasteEnabled: boolean): string {
  if (!bracketedPasteEnabled) return text;
  return `\x1b[200~${text}\x1b[201~`;
}


