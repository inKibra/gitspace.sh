import { randomUUID } from 'node:crypto';

export const BROWSER_TEXT_BYTES = 32_768;
export const BROWSER_IMAGE_BYTES = 512_000;
export const BROWSER_ARTIFACT_BYTES = 2_000_000;
export function boundedText(value: string, bytes = 2048): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= bytes) return value;
  if (bytes < 3) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, bytes - 3), { stream: true }) + '…';
}
/** Memory-only, finite, expiring output. Restart intentionally revokes all references. */
export class BrowserOutputStore {
  private entries = new Map<string, { scope: string; machineId: string; bytes: Buffer; mediaType: string; expires: number }>();
  private sweep() { for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id); }
  put(scope: string, value: string, machineId: string, mediaType = 'application/json') {
    this.sweep();
    const bytes = Buffer.from(value);
    if (bytes.length > BROWSER_ARTIFACT_BYTES) throw new Error('Browser output exceeds artifact limit');
    while (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID(), expires = Date.now() + 10 * 60_000;
    this.entries.set(id, { scope, machineId, bytes, mediaType, expires });
    return { id, url: `browser-artifact://${encodeURIComponent(machineId)}/${encodeURIComponent(id)}`, mediaType, bytes: bytes.length, expiresAt: new Date(expires).toISOString() };
  }
  read(scope: string, id: string, offset = 0, limit = BROWSER_TEXT_BYTES) {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry || entry.scope !== scope) throw new Error('Browser artifact expired or outside scope');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.bytes.length || !Number.isSafeInteger(limit) || limit < 1 || limit > BROWSER_TEXT_BYTES) throw new Error('Invalid browser artifact read range');
    const end = Math.min(entry.bytes.length, offset + limit);
    return { artifact: { id, url: `browser-artifact://${encodeURIComponent(entry.machineId)}/${encodeURIComponent(id)}`, bytes: entry.bytes.length, mediaType: entry.mediaType, expiresAt: new Date(entry.expires).toISOString() }, offset, nextOffset: end < entry.bytes.length ? end : null, data: entry.bytes.subarray(offset, end).toString('base64') };
  }
  clear() { this.entries.clear(); }
}
