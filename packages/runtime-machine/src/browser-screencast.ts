// Import-free (types only): the Chrome extension bundles this file into its service worker.
import type { RuntimeBrowserFramesIndex } from '@gitspace/protocol-runtime';

/** The screencast every capture records (docs/APERTURE-DESIGN.md §11): JPEG frames at most 1280 px on a side. */
export const CAPTURE_SCREENCAST = { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 } as const;
/** At most one frame is kept per this long (5 a second); a frame arriving sooner waits as the newest and is kept then. */
export const CAPTURE_FRAME_MS = 200;
/** A capture stops at 30 minutes or 1 GiB of frames, whichever comes first. */
export const CAPTURE_MAX_MS = 30 * 60_000;
export const CAPTURE_MAX_BYTES = 1024 * 1024 * 1024;

type Frame = { data: string; sessionId: number; width: number | undefined; height: number | undefined };
/** A `Page.screencastFrame` event's params, or null for anything else. */
function screencastFrame(params: unknown): Frame | null {
  if (!params || typeof params !== 'object' || !('data' in params) || !('sessionId' in params) || typeof params.data !== 'string' || typeof params.sessionId !== 'number') return null;
  const metadata = 'metadata' in params && params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
  const width = 'deviceWidth' in metadata && typeof metadata.deviceWidth === 'number' ? metadata.deviceWidth : undefined;
  const height = 'deviceHeight' in metadata && typeof metadata.deviceHeight === 'number' ? metadata.deviceHeight : undefined;
  return { data: params.data, sessionId: params.sessionId, width, height };
}
type Kept = { data: Uint8Array; width: number; height: number };
/** What a stopped recording kept: `index` is `frames.json`, `thumbnail` its first frame. */
export type ScreencastFrames = { count: number; width: number; height: number; durationMs: number; index: RuntimeBrowserFramesIndex; thumbnail: Uint8Array | null };

/** A JPEG's pixel size from its frame header, or null when there is none. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) { offset++; continue; }
    // Start-of-frame markers (C0–CF except DHT C4, JPG C8 and DAC CC) carry the height, then the width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width && height ? { width, height } : null;
    }
    offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
  }
  return null;
}

/**
 * Records one tab's `Page.screencastFrame` events into the frames container: each kept JPEG is appended to
 * `frames.bin` (through `append`) as it arrives, and its time and place in the file make `frames.json` at the end.
 * Every frame is acknowledged at once, so Chrome keeps sending them. The owner starts and stops the screencast and
 * stops the recording when `limit` reports that it reached 1 GiB or 30 minutes.
 */
export class ScreencastRecorder {
  private readonly frames: RuntimeBrowserFramesIndex['frames'] = [];
  private bytes = 0;
  private width = 0;
  private height = 0;
  private last = Number.NEGATIVE_INFINITY;
  private held: Kept | undefined;
  private thumbnail: Uint8Array | null = null;
  private stopped = false;
  private written: Promise<void> = Promise.resolve();
  private failure: unknown;
  constructor(private readonly options: { startedAt: number; append(bytes: Uint8Array): Promise<void>; ack(frameSessionId: number): Promise<unknown>; limit(reason: string): void }) {}

  /** One `Page.screencastFrame` event's params. */
  frame(params: unknown): void {
    const parsed = screencastFrame(params);
    if (!parsed) return;
    void this.options.ack(parsed.sessionId).catch(() => {});
    if (this.stopped) return;
    const data = Uint8Array.from(atob(parsed.data), character => character.charCodeAt(0));
    if (!data.byteLength) return;
    const size = jpegSize(data) ?? { width: Math.max(1, Math.round(parsed.width ?? 1)), height: Math.max(1, Math.round(parsed.height ?? 1)) };
    const frame = { data, ...size }, now = Date.now();
    // A frame kept now makes any held one stale: the newest frame is the page as it is.
    if (now - this.last >= CAPTURE_FRAME_MS) { this.held = undefined; this.keep(frame); return; }
    const waiting = this.held, kept = this.frames.length;
    this.held = frame;
    // Kept when 200 ms have passed since the last kept frame, unless a newer frame was kept meanwhile.
    if (!waiting) setTimeout(() => { const next = this.held; if (!next || this.stopped || this.frames.length !== kept) return; this.held = undefined; this.keep(next); }, this.last + CAPTURE_FRAME_MS - now);
  }

  private keep(frame: Kept): void {
    const t = Date.now() - this.options.startedAt;
    if (t >= CAPTURE_MAX_MS) { this.end('The capture reached 30 minutes'); return; }
    if (this.bytes + frame.data.byteLength > CAPTURE_MAX_BYTES) { this.end('The capture reached 1 GiB'); return; }
    this.last = Date.now();
    this.frames.push({ t, offset: this.bytes, length: frame.data.byteLength });
    this.bytes += frame.data.byteLength;
    this.width = Math.max(this.width, frame.width);
    this.height = Math.max(this.height, frame.height);
    this.thumbnail ??= frame.data;
    this.written = this.written.then(() => this.failure === undefined ? this.options.append(frame.data) : undefined).catch((error: unknown) => { this.failure ??= error; });
  }

  private end(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.limit(reason);
  }

  /** Stops keeping frames (a held one is kept first) and returns once every kept frame was appended. */
  async stop(): Promise<ScreencastFrames> {
    const next = this.held;
    this.held = undefined;
    if (next && !this.stopped) this.keep(next);
    this.stopped = true;
    await this.written;
    if (this.failure !== undefined) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    return { count: this.frames.length, width: this.width, height: this.height, durationMs: Date.now() - this.options.startedAt, index: { version: 1, frames: this.frames }, thumbnail: this.thumbnail };
  }
}
