import { z } from 'zod';
import { parseResourceUri, resourceMediaType } from '@gitspace/protocol/resource-uri';
import { browserUnbase64, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { captureFolder, captureName, writeCapture } from './browser-capture.js';
import type { BrowserDownload, SavedDownload } from './browser-downloads.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/** The browser a run drives, as its files need it: the cloud browser, or your Chrome with its name and extension
 * protocol (read once, when a capture or an upload first needs them). */
export type ScriptRunBrowser =
  | { source: 'headless'; groupId: string }
  | { source: 'relay'; groupId: string; chrome: () => Promise<{ name: string; protocol: number }> };
/** The drive files an upload sets: bytes for Playwright on the cloud browser; on your Chrome sealed `/files/` links,
 * which the extension fetches itself (`GitSpace.setInputFilesFromUrls`), so the bytes never cross the relay. */
export type ScriptUploadFiles =
  | { kind: 'bytes'; files: { name: string; mediaType: string; bytes: Uint8Array }[] }
  | { kind: 'links'; files: { url: string; name: string; mediaType: string; size: number }[] };
/** A download in a run's result: saved at its drive address, still being saved, or not saved and why. */
export type ScriptRunDownload = { file: string; size: number; mediaType: string } | { name: string; saving: true } | { name: string; error: string };
/** A download as a run follows it: unsettled (`outcome` null) until it is saved or fails. */
type FollowedDownload = { name: string; outcome: { saved: SavedDownload } | { error: string } | null };

/** Captures one run may save. */
export const SCRIPT_CAPTURES = 5;
/** One upload sets at most this many files, this many bytes in all: on the cloud browser Playwright carries them in one
 * CDP message. */
const UPLOAD_FILES = 8, UPLOAD_BYTES = 20 * 1024 * 1024;
/** The first extension protocol that sets file inputs from sealed drive links. */
const UPLOAD_PROTOCOL = 4;
/** The largest image side models take (docs/SIMPLIFICATION.md entry 66); a script's capture aims at 1600. */
const IMAGE_PIXELS = 2000;
/** After its script ends, a run's result waits this long for downloads still being saved. */
const DOWNLOAD_WAIT_MS = 30_000;
const Shot = z.object({
  name: z.string().max(1000).nullable(), targetId: z.string().min(1).max(256),
  page: z.object({ url: z.string(), title: z.string() }),
  image: z.string().min(1).max(8_000_000), thumbnail: z.string().max(2_000_000),
});

/** A JPEG's size from its frame header, or null for bytes that are not a JPEG. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) { offset++; continue; }
    // Start-of-frame markers (C0–CF except DHT C4, JPG C8 and DAC CC) hold the height and the width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width && height ? { width, height } : null;
    }
    offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
  }
  return null;
}

/**
 * The files of one script run (docs/APERTURE-DESIGN.md §6.1), in the workspace drive: its captures (`capture()`, at
 * most five), the drive files it sets into pages (`upload()`), and the downloads of the cloud browser while it ran.
 * The sandbox reaches it only through the session's `BrowserSessionFiles` binding for this run, so its input is
 * untrusted and checked here.
 */
export class ScriptRunFiles {
  private readonly captures: { url: string; image: string }[] = [];
  private capturing = 0;
  private readonly downloads: FollowedDownload[] = [];
  private readonly saving: Promise<unknown>[] = [];
  private chrome: Promise<{ name: string; protocol: number }> | undefined;

  constructor(private readonly drive: Pick<WorkspaceDrive, 'write' | 'list' | 'read' | 'url'>, readonly browser: ScriptRunBrowser) {}

  private chromeInfo(browser: Extract<ScriptRunBrowser, { source: 'relay' }>): Promise<{ name: string; protocol: number }> {
    this.chrome ??= browser.chrome();
    return this.chrome;
  }

  /** Saves a screenshot as a capture: `image.jpg`, `thumbnail.jpg` and `capture.json` in `browser/captures/<id>/`. */
  async capture(input: unknown): Promise<{ captureId: string; url: string }> {
    const shot = Shot.parse(input);
    if (this.capturing >= SCRIPT_CAPTURES) throw new Error(`A script saves at most ${SCRIPT_CAPTURES} captures a run`);
    this.capturing++;
    const image = browserUnbase64(shot.image), thumbnail = browserUnbase64(shot.thumbnail);
    const size = jpegSize(image);
    if (!size) throw new Error('The screenshot is not a JPEG');
    if (size.width > IMAGE_PIXELS || size.height > IMAGE_PIXELS) throw new Error(`The screenshot is ${size.width}×${size.height} pixels, over the ${IMAGE_PIXELS} a side models take`);
    const captureId = crypto.randomUUID(), folder = captureFolder(captureId), at = new Date().toISOString();
    const browser = this.browser.source === 'relay' ? (await this.chromeInfo(this.browser)).name : 'Cloud browser';
    await this.drive.write(`${folder}image.jpg`, 'image/jpeg', image);
    if (jpegSize(thumbnail)) await this.drive.write(`${folder}thumbnail.jpg`, 'image/jpeg', thumbnail);
    await writeCapture(this.drive, {
      version: 1, captureId, name: shot.name?.trim().slice(0, 200) || captureName(shot.page.title, at), by: 'agent', source: this.browser.source, browser,
      page: { url: shot.page.url.slice(0, 8192), title: shot.page.title.slice(0, 500) }, target: { groupId: this.browser.groupId, targetId: shot.targetId },
      startedAt: at, endedAt: at, state: 'saved', reason: null, tracks: { image: { path: 'image.jpg', ...size } },
    });
    const url = `drive://workspace/${folder}image.jpg`;
    this.captures.push({ url, image: shot.image });
    return { captureId, url };
  }

  /** The files `drive://workspace/<path>` addresses name, for one upload: never a file outside this workspace's drive. */
  async uploadFiles(input: unknown): Promise<ScriptUploadFiles> {
    const urls = z.array(z.string().max(8192)).parse(input);
    if (!urls.length || urls.length > UPLOAD_FILES) throw new Error(`upload() sets 1 to ${UPLOAD_FILES} files`);
    const paths = urls.map(url => {
      const resource = parseResourceUri(url);
      if (resource?.kind !== 'drive' || resource.mount !== 'workspace' || resource.suffix) throw new Error(`${url} is not a file of this workspace's drive: upload() takes drive://workspace/<path>`);
      return resource.path;
    });
    if (this.browser.source === 'relay' && (await this.chromeInfo(this.browser)).protocol < UPLOAD_PROTOCOL) throw new Error('Update the GitSpace extension in Chrome to upload drive files into pages');
    const listed = await this.drive.list('');
    const entries = paths.map((path, index) => {
      const entry = listed.find(candidate => candidate.path === path);
      if (!entry) throw new Error(`${urls[index]} does not exist`);
      return { path, name: path.split('/').at(-1) ?? path, size: entry.size, mediaType: entry.mediaType ?? resourceMediaType(path) ?? 'application/octet-stream' };
    });
    if (entries.reduce((total, entry) => total + entry.size, 0) > UPLOAD_BYTES) throw new Error(`upload() sets at most ${UPLOAD_BYTES / 1024 / 1024} MiB of files at once`);
    if (this.browser.source === 'relay') return { kind: 'links', files: await Promise.all(entries.map(async ({ path, name, size, mediaType }) => ({ url: await this.drive.url(path), name, mediaType, size }))) };
    return {
      kind: 'bytes',
      files: await Promise.all(entries.map(async ({ path, name, mediaType }) => {
        const bytes = await this.drive.read(path);
        if (!bytes) throw new Error(`drive://workspace/${path} does not exist`);
        return { name, mediaType, bytes };
      })),
    };
  }

  /** A download the cloud browser started while this run was live. */
  downloaded(download: BrowserDownload): void {
    const listed: FollowedDownload = { name: download.name, outcome: null };
    this.downloads.push(listed);
    this.saving.push(download.saved.then(
      saved => { listed.outcome = { saved }; },
      (error: unknown) => { listed.outcome = { error: error instanceof Error ? error.message.slice(0, 1024) : String(error) }; },
    ));
  }

  /** The run's files for its result, once its script ended: the downloads saved while it ran (`chrome`: those your
   * Chrome's extension saved; the cloud browser's are waited for up to 30 s), and each capture's address and image. */
  async report(chrome: SavedDownload[]): Promise<{ downloads: ScriptRunDownload[]; content: RuntimeToolResult['content'] }> {
    const waited = Promise.withResolvers<void>();
    const timer = setTimeout(waited.resolve, DOWNLOAD_WAIT_MS);
    try { await Promise.race([Promise.allSettled(this.saving), waited.promise]); } finally { clearTimeout(timer); }
    const downloads = [...this.downloads, ...chrome.map(saved => ({ name: saved.path, outcome: { saved } }))].map(({ name, outcome }): ScriptRunDownload => {
      if (!outcome) return { name, saving: true };
      if ('error' in outcome) return { name, error: outcome.error };
      return { file: `drive://workspace/${outcome.saved.path.split('/').map(encodeURIComponent).join('/')}`, size: outcome.saved.size, mediaType: outcome.saved.mediaType };
    });
    return { downloads, content: this.captures.flatMap(({ url, image }) => [{ type: 'text' as const, text: `Capture saved to ${url}` }, { type: 'image' as const, data: image, mimeType: 'image/jpeg' }]) };
  }
}
