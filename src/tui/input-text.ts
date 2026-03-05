export interface KeyboardLikeInput {
  name?: string | null;
  raw?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Remove control characters and line breaks from pasted/typed text.
 */
export function normalizeInputText(text: string): string {
  return text
    .replace(/\r\n?/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Extract printable keyboard text chunk for text-entry fields.
 */
export function getKeyboardInputChunk(key: KeyboardLikeInput): string | null {
  if (!key.raw || key.ctrl || key.meta) {
    return null;
  }

  const normalized = normalizeInputText(key.raw);
  if (!normalized) {
    return null;
  }

  return normalized;
}

/**
 * Extract numeric-only text chunk (for numeric inputs).
 */
export function getNumericInputChunk(text: string): string {
  return text.replace(/[^0-9]/g, '');
}
