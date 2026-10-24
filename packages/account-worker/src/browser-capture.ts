import { z } from 'zod';
import { BROWSER_DRIVE_PREFIX, RuntimeBrowserCaptureSchema, type RuntimeBrowserCapture, type RuntimeBrowserCaptureView } from '@gitspace/protocol-runtime';
import { CAPTURE_MAX_MS, CAPTURE_SCREENCAST, ScreencastRecorder } from '@gitspace/runtime-machine/browser-screencast';
import type { CdpBrowserShim, CdpShimClient } from './browser-shim.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/** The workspace drive as captures use it. */
export type CaptureDrive = Pick<WorkspaceDrive, 'write' | 'list' | 'read' | 'url'>;
/** Files a capture's folder may hold beside `capture.json`. */
export const CAPTURE_FILES = { 'image.jpg': 'image/jpeg', 'video.webm': 'video/webm', 'frames.bin': 'application/octet-stream', 'frames.json': 'application/json', 'thumbnail.jpg': 'image/jpeg' } as const;
export type CaptureFile = keyof typeof CAPTURE_FILES;
const encoder = new TextEncoder();

export function captureFolder(captureId: string): string { return `${BROWSER_DRIVE_PREFIX.captures}${captureId}/`; }

/** A capture's default name: the page's title and when it started (UTC, to the minute). */
export function captureName(title: string, startedAt: string): string {
  return `${(title.trim() || 'Untitled page').slice(0, 170)} · ${startedAt.slice(0, 10)} ${startedAt.slice(11, 16)} UTC`;
}

export async function writeCapture(drive: CaptureDrive, capture: RuntimeBrowserCapture): Promise<RuntimeBrowserCapture> {
  const parsed = RuntimeBrowserCaptureSchema.parse(capture);
  await drive.write(`${captureFolder(parsed.captureId)}capture.json`, 'application/json', encoder.encode(JSON.stringify(parsed)));
  return parsed;
}

export async function readCapture(drive: CaptureDrive, captureId: string): Promise<RuntimeBrowserCapture | null> {
  const bytes = await drive.read(`${captureFolder(captureId)}capture.json`);
  return bytes ? RuntimeBrowserCaptureSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) : null;
}

/** A capture with sealed `/files/` links for the media in its folder (`capture.json` itself is the record). */
export async function captureView(drive: CaptureDrive, capture: RuntimeBrowserCapture, names?: string[]): Promise<RuntimeBrowserCaptureView> {
  const folder = captureFolder(capture.captureId);
  const files = names ?? (await drive.list(folder)).map(entry => entry.path.slice(folder.length)).filter(name => name && !name.includes('/'));
  return { capture, files: Object.fromEntries(await Promise.all(files.filter(name => name !== 'capture.json').map(async name => [name, await drive.url(`${folder}${name}`)] as const))) };
}

/** The workspace's captures, newest first: every folder under `browser/captures/` with a valid `capture.json`. */
export async function captureViews(drive: CaptureDrive): Promise<RuntimeBrowserCaptureView[]> {
  const folders = new Map<string, string[]>();
  for (const entry of await drive.list(BROWSER_DRIVE_PREFIX.captures)) {
    const [captureId, name, ...deeper] = entry.path.slice(BROWSER_DRIVE_PREFIX.captures.length).split('/');
    if (!captureId || !name || deeper.length) continue;
    folders.set(captureId, [...folders.get(captureId) ?? [], name]);
  }
  const captures: { capture: RuntimeBrowserCapture; names: string[] }[] = [];
  for (const [captureId, names] of folders) {
    if (!names.includes('capture.json')) continue;
    const bytes = await drive.read(`${captureFolder(captureId)}capture.json`);
    const parsed = bytes ? RuntimeBrowserCaptureSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes))) : null;
    if (parsed?.success && parsed.data.captureId === captureId) captures.push({ capture: parsed.data, names });
  }
  captures.sort((left, right) => right.capture.startedAt.localeCompare(left.capture.startedAt));
  return Promise.all(captures.slice(0, 500).map(({ capture, names }) => captureView(drive, capture, names)));
}

const TargetInfo = z.object({ targetInfo: z.object({ url: z.string(), title: z.string() }) });
type Recording = { capture: RuntimeBrowserCapture; drive: CaptureDrive; client: CdpShimClient; sessionId: string; recorder: ScreencastRecorder; frames: WritableStreamDefaultWriter<Uint8Array>; stored: Promise<unknown>; stopping?: Promise<RuntimeBrowserCapture> };

/**
 * The cloud browser's captures (docs/APERTURE-DESIGN.md §11): each records one tab's screencast through a shim client
 * of its own. Frames stream into `frames.bin` in the workspace's drive as they are kept; `frames.json`, a thumbnail and
 * the saved `capture.json` are written at the stop. A capture stops itself at 30 minutes or 1 GiB.
 */
export class CloudCaptures {
  private readonly live = new Map<string, Recording>();
  get recording(): boolean { return this.live.size > 0; }

  async start(shim: CdpBrowserShim, drive: CaptureDrive, input: { captureId: string; groupId: string; targetId: string }): Promise<RuntimeBrowserCapture> {
    let recorder: ScreencastRecorder | undefined, sessionId: string | undefined;
    const client = shim.client(event => {
      if (event.method === 'Page.screencastFrame' && event.sessionId === sessionId) recorder?.frame(event.params);
      // The tab closed: what was recorded is kept.
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId) void this.stop(input.captureId).catch(() => {});
    });
    try {
      sessionId = z.object({ sessionId: z.string() }).parse(await client.send('Target.attachToTarget', { targetId: input.targetId, flatten: true })).sessionId;
      const page = TargetInfo.parse(await client.send('Target.getTargetInfo', { targetId: input.targetId })).targetInfo;
      const startedAt = new Date().toISOString();
      const capture = await writeCapture(drive, {
        version: 1, captureId: input.captureId, name: captureName(page.title, startedAt), by: 'you', source: 'headless', browser: 'Cloud browser',
        target: { groupId: input.groupId, targetId: input.targetId }, page: { url: page.url.slice(0, 8192), title: page.title.slice(0, 500) },
        startedAt, endedAt: null, state: 'recording', reason: null, tracks: {},
      });
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const frames = writable.getWriter();
      const stored = drive.write(`${captureFolder(input.captureId)}frames.bin`, CAPTURE_FILES['frames.bin'], readable);
      stored.catch(() => {});
      const session = sessionId;
      recorder = new ScreencastRecorder({
        startedAt: Date.parse(startedAt),
        append: bytes => frames.write(bytes),
        ack: frameSessionId => client.send('Page.screencastFrameAck', { sessionId: frameSessionId }, session),
        limit: reason => { void this.stop(input.captureId, reason).catch(() => {}); },
      });
      this.live.set(input.captureId, { capture, drive, client, sessionId, recorder, frames, stored });
      setTimeout(() => { void this.stop(input.captureId, 'The capture reached 30 minutes').catch(() => {}); }, CAPTURE_MAX_MS);
      await client.send('Page.startScreencast', CAPTURE_SCREENCAST, sessionId);
      return capture;
    } catch (error) {
      if (this.live.has(input.captureId)) await this.stop(input.captureId, error instanceof Error ? error.message : String(error)).catch(() => {});
      else await client.close();
      throw error;
    }
  }

  /** Stops a capture and saves it; one that is not recording here is read back, and one whose recording was lost (its
   * browser closed or the session restarted) is saved as failed. `ended` says why it stopped by itself. */
  async stop(captureId: string, ended?: string, drive?: CaptureDrive): Promise<RuntimeBrowserCapture> {
    const recording = this.live.get(captureId);
    if (!recording) {
      if (!drive) throw new Error('This capture is not recording');
      const capture = await readCapture(drive, captureId);
      if (!capture) throw new Error('Unknown capture');
      if (capture.state !== 'recording') return capture;
      return writeCapture(drive, { ...capture, endedAt: new Date().toISOString(), state: 'failed', reason: 'The cloud browser closed while recording' });
    }
    recording.stopping ??= this.save(recording, ended);
    return recording.stopping;
  }

  /** Stops every capture, as the browser closes. */
  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.live.keys()].map(captureId => this.stop(captureId, reason).catch(() => {})));
  }

  private async save(recording: Recording, ended: string | undefined): Promise<RuntimeBrowserCapture> {
    const { capture, drive, client, sessionId } = recording, folder = captureFolder(capture.captureId);
    try {
      await client.send('Page.stopScreencast', {}, sessionId).catch(() => {});
      const frames = await recording.recorder.stop().finally(() => recording.frames.close().catch(() => {}));
      const endedAt = new Date().toISOString();
      if (!frames.count) { await recording.stored.catch(() => {}); return await writeCapture(drive, { ...capture, endedAt, state: 'failed', reason: ended ?? 'The tab showed nothing to record' }); }
      await recording.stored;
      await drive.write(`${folder}frames.json`, CAPTURE_FILES['frames.json'], encoder.encode(JSON.stringify(frames.index)));
      if (frames.thumbnail) await drive.write(`${folder}thumbnail.jpg`, CAPTURE_FILES['thumbnail.jpg'], frames.thumbnail);
      return await writeCapture(drive, { ...capture, endedAt, state: 'saved', reason: ended ?? null, tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: frames.count, width: frames.width, height: frames.height } } });
    } catch (error) {
      await recording.frames.abort(error).catch(() => {});
      return writeCapture(drive, { ...capture, endedAt: new Date().toISOString(), state: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
    } finally {
      this.live.delete(capture.captureId);
      await client.close().catch(() => {});
    }
  }
}
