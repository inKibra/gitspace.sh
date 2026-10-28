import { z } from 'zod';
import { parseResourceUri, resourceMediaType } from '@gitspace/protocol/resource-uri';
import { browserUnbase64, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { captureFolder, captureName, writeCapture } from './browser-capture.js';
import { DOWNLOAD_WAIT_MS, DownloadList, listedDownload, type BrowserDownload, type ListedDownload, type ScriptDownload, type ScriptDownloads } from './browser-downloads.js';
import { browserDriveFile } from './browser-upload.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/** The browser a run drives, as its files need it: the cloud browser, or your Chrome with its name and extension
 * protocol (read once, when a capture or an upload first needs them) and the run's downloads as the relay follows them
 * (`downloads`, answering as `ScriptRunFiles.downloads` does). */
export type ScriptRunBrowser =
  | { source: 'headless'; groupId: string }
  | { source: 'relay'; groupId: string; chrome: () => Promise<{ name: string }>; downloads: (version: number) => Promise<ScriptDownloads> };
/** The drive files an upload sets: bytes for Playwright on the cloud browser; on your Chrome sealed `/files/` links,
 * which the extension fetches itself (`GitSpace.setInputFilesFromUrls`), so the bytes never cross the relay. */
export type ScriptUploadFiles =
  | { kind: 'bytes'; files: { name: string; mediaType: string; bytes: Uint8Array }[] }
  | { kind: 'links'; files: { url: string; name: string; mediaType: string; size: number }[] };

/** Captures one run may save. */
export const SCRIPT_CAPTURES = 5;
/** One upload sets at most this many files, this many bytes in all: on the cloud browser Playwright carries them in one
 * CDP message. */
const UPLOAD_FILES = 8, UPLOAD_BYTES = 20 * 1024 * 1024;
/** The largest image side models take (docs/SIMPLIFICATION.md entry 66); a script's capture aims at 1600. */
const IMAGE_PIXELS = 2000;
const RUN_ENDED = 'The script run ended';
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
 * most five), the drive files it sets into pages (`upload()`), and its downloads, which the script follows while it
 * runs (`downloads`) and copies elsewhere in the drive (`saveDownload`): the cloud browser's started while it ran, kept
 * here; your Chrome's, kept by the relay. The sandbox reaches it only through the session's `BrowserSessionFiles`
 * binding for this run, so its input is untrusted and checked here.
 */
export class ScriptRunFiles {
  private readonly captures: { url: string; image: string }[] = [];
  private capturing = 0;
  /** The cloud browser's downloads while the run was live. */
  private readonly cloud = new DownloadList();
  private readonly saving: Promise<unknown>[] = [];
  /** Resolved when the run ends (`end`). */
  private readonly ending = Promise.withResolvers<void>();
  private ended = false;
  /** The relay's last answer about your Chrome's downloads, which every call after the end repeats. */
  private relayed: ScriptDownloads = { version: 0, ended: false, downloads: [] };
  private chrome: Promise<{ name: string }> | undefined;

  constructor(private readonly drive: Pick<WorkspaceDrive, 'write' | 'list' | 'read' | 'url' | 'copy'>, readonly browser: ScriptRunBrowser) {}

  /** Whether the run is still live: the cloud browser's downloads go to live runs only. */
  get running(): boolean { return !this.ended; }

  private chromeInfo(browser: Extract<ScriptRunBrowser, { source: 'relay' }>): Promise<{ name: string }> {
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
      version: 2, captureId, name: shot.name?.trim().slice(0, 200) || captureName(shot.page.title, at), by: 'agent', source: this.browser.source, browser,
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
    const { outcome, ...started } = download;
    this.cloud.start(started);
    this.saving.push(outcome.then(settled => this.cloud.settle(download.id, settled)));
  }

  /** The run's downloads once they differ from `version` (`DownloadList.state`): the cloud browser's kept here, your
   * Chrome's asked of the relay. Once the run ended every call answers at once, `ended` true. */
  async downloads(input: unknown): Promise<ScriptDownloads> {
    const version = z.number().int().nonnegative().parse(input);
    return this.follow(version);
  }

  private async follow(version: number): Promise<ScriptDownloads> {
    if (this.browser.source === 'headless') return this.cloud.state(version);
    if (this.ended) return { ...this.relayed, ended: true };
    const answered = await Promise.race([this.browser.downloads(version), this.ending.promise.then(() => null)]);
    if (!answered) return { ...this.relayed, ended: true };
    this.relayed = answered;
    return answered;
  }

  /** Copies the run's saved download `id` to `drive://workspace/<path>`, replacing a file there, without moving its
   * bytes; answers the copy's address. A download still being saved is waited for while the run lasts. */
  async saveDownload(idInput: unknown, urlInput: unknown): Promise<{ file: string }> {
    const id = z.string().max(256).parse(idInput), url = z.string().max(8192).parse(urlInput);
    if (this.ended) throw new Error(RUN_ENDED);
    const target = parseResourceUri(url);
    if (target?.kind !== 'drive' || target.mount !== 'workspace' || target.suffix) throw new Error(`${url} is not a file of this workspace's drive: saveAs() takes drive://workspace/<path>`);
    // -1 is never a version, so the first look answers at once; each later one waits for the next change.
    let version = -1;
    for (;;) {
      const state = await this.follow(version);
      const download = state.downloads.find(item => item.id === id);
      if (!download) throw new Error(`This run has no download ${id}`);
      const { outcome } = download;
      if (outcome && 'error' in outcome) throw new Error(`${download.name} was not saved: ${outcome.error}`);
      if (outcome) {
        const source = parseResourceUri(outcome.file);
        if (source?.kind !== 'drive') throw new Error(`${outcome.file} is not a drive file`);
        return { file: browserDriveFile((await this.drive.copy(source.path, target.path)).path) };
      }
      if (state.ended) throw new Error(`${download.name} was still being saved when the run ended`);
      version = state.version;
    }
  }

  /** The run ended: waiters on its downloads answer, `ended` true, and nothing more is saved for it. */
  end(): void {
    this.ended = true;
    this.cloud.end();
    this.ending.resolve();
  }

  /** The run's files for its result, once its script ended: its downloads, each once (`chrome`: your Chrome's, as the
   * relay followed them; the cloud browser's still being saved are waited for up to 30 s), and each capture's address
   * and image. */
  async report(chrome: ScriptDownload[]): Promise<{ downloads: ListedDownload[]; content: RuntimeToolResult['content'] }> {
    const waited = Promise.withResolvers<void>();
    const timer = setTimeout(waited.resolve, DOWNLOAD_WAIT_MS);
    try { await Promise.race([Promise.all(this.saving), waited.promise]); } finally { clearTimeout(timer); }
    const downloads = [...this.cloud.downloads, ...chrome].map(listedDownload);
    return { downloads, content: this.captures.flatMap(({ url, image }) => [{ type: 'text' as const, text: `Capture saved to ${url}` }, { type: 'image' as const, data: image, mimeType: 'image/jpeg' }]) };
  }
}
