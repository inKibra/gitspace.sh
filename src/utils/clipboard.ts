/**
 * Clipboard utilities for cross-platform clipboard operations.
 * 
 * Uses a multi-layered approach:
 * 1. OSC52 escape sequence - works over SSH, in tmux, remote terminals
 * 2. clipboardy - handles platform-specific clipboard (pbcopy, xclip, etc.)
 */

import clipboard from 'clipboardy';

/**
 * Copy text to clipboard using OSC52 + system clipboard fallback.
 * 
 * OSC52 is written first because it works in remote/SSH sessions where
 * the system clipboard wouldn't be accessible.
 * 
 * @param text - The text to copy to clipboard
 */
export async function copyToClipboard(text: string): Promise<void> {
  // 1. OSC52 escape sequence - works over SSH/remote sessions
  // Format: ESC ] 52 ; c ; <base64-encoded-text> BEL
  const base64 = Buffer.from(text).toString('base64');
  const osc52 = `\x1b]52;c;${base64}\x07`;
  
  // Wrap for tmux compatibility - tmux requires DCS wrapper
  const finalOsc52 = process.env['TMUX']
    ? `\x1bPtmux;\x1b${osc52}\x1b\\`
    : osc52;
  
  process.stdout.write(finalOsc52);

  // 2. Also use clipboardy for local system clipboard
  // This handles pbcopy (macOS), xclip/xsel (Linux), clip.exe (Windows)
  try {
    await clipboard.write(text);
  } catch {
    // OSC52 should have worked for terminal-based copying
    // Silently ignore clipboardy failures (e.g., headless environment)
  }
}

/**
 * Read text from clipboard.
 * 
 * @returns The clipboard text, or undefined if unavailable
 */
export async function readFromClipboard(): Promise<string | undefined> {
  try {
    return await clipboard.read();
  } catch {
    return undefined;
  }
}
