import { z } from 'zod';
import { browserUnbase64 } from '@gitspace/protocol-runtime';
import { browserDownloadPath } from './browser-upload.js';
import type { CdpBrowserShim, CdpEvent, CdpShimClient } from './browser-shim.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/** A download saved to the workspace drive: its path there (`browser/downloads/<date>/<name>`), size and type. */
export type SavedDownload = { path: string; size: number; mediaType: string };
/** A download the browser started: its file name, and its saving, which fails with the reason it was not saved. */
export type BrowserDownload = { name: string; saved: Promise<SavedDownload> };

const Attached = z.object({ sessionId: z.string() });
const Paused = z.object({
  requestId: z.string(), request: z.object({ url: z.string() }),
  responseStatusCode: z.number().int().optional(), responseHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});
const Stream = z.object({ stream: z.string() });
const Read = z.object({ data: z.string(), base64Encoded: z.boolean().optional(), eof: z.boolean() });
/** Each read of a download's body asks the browser for this much. */
const READ_BYTES = 1024 * 1024;
/** Text types Chrome saves instead of showing. */
const SAVED_TEXT: Readonly<Record<string, true>> = {
  'text/csv': true, 'text/x-csv': true, 'text/comma-separated-values': true, 'text/tab-separated-values': true, 'text/tsv': true,
  'text/calendar': true, 'text/x-calendar': true, 'text/vcard': true, 'text/x-vcard': true, 'text/rtf': true,
};
const encoder = new TextEncoder();

/** Whether Chrome shows a document of this type as a page: HTML, text, XML, JSON, scripts, images, audio and video.
 * Everything else (archives, PDFs, office files, octet streams) it saves. */
function shownAsPage(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return !SAVED_TEXT[mediaType];
  return /^(?:image|audio|video)\//u.test(mediaType) || mediaType === 'multipart/x-mixed-replace'
    || /^application\/(?:xhtml\+xml|xml|json|javascript|ecmascript|x-javascript|[\w.-]+\+(?:xml|json))$/u.test(mediaType);
}

/** The file name a download asks for: `filename*` (RFC 6266), then `filename`, then the URL's last segment. */
function downloadName(disposition: string, url: string): string {
  const extended = /filename\*\s*=\s*[\w-]+'[\w-]*'([^;]+)/iu.exec(disposition)?.[1];
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/iu.exec(disposition);
  let name = '';
  try { name = extended ? decodeURIComponent(extended.trim()) : ''; } catch { name = ''; }
  if (!name && plain) name = plain[1]?.replace(/\\(.)/gu, '$1') ?? plain[2] ?? '';
  if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? ''); } catch { name = ''; } }
  return name;
}

/**
 * The cloud browser's downloads go to the workspace drive (docs/APERTURE-DESIGN.md §6.1), never to Browser Run's disk:
 * a client of the shim of its own attaches to every page and pauses each document response; one that Chrome would save
 * (`Content-Disposition: attachment`, or a type it does not show as a page) is read as a stream into the day's
 * downloads folder (`browser/downloads/<YYYY-MM-DD>/<name>`, ` (2)` before the extension for a name already taken) and
 * the browser's own download is cancelled. Other responses go on unchanged.
 */
export class CloudDownloads {
  private client: CdpShimClient | undefined;
  /** Paths of downloads being saved now, which a second one with the same name must not take; names are chosen one at
   * a time, so two downloads of one name never choose the same path. */
  private readonly saving = new Set<string>();
  private naming: Promise<unknown> = Promise.resolve();
  private constructor(private readonly drive: Pick<WorkspaceDrive, 'list' | 'write'>, private readonly started: (download: BrowserDownload) => void) {}

  static async open(shim: CdpBrowserShim, drive: Pick<WorkspaceDrive, 'list' | 'write'>, started: (download: BrowserDownload) => void): Promise<CloudDownloads> {
    const downloads = new CloudDownloads(drive, started);
    const client = shim.client(event => { void downloads.route(event).catch(() => {}); });
    downloads.client = client;
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return downloads;
  }

  private async route(event: CdpEvent): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (event.method === 'Target.attachedToTarget' && !event.sessionId) {
      const { sessionId } = Attached.parse(event.params);
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sessionId);
      return;
    }
    if (event.method !== 'Fetch.requestPaused' || !event.sessionId) return;
    const sessionId = event.sessionId, paused = Paused.parse(event.params);
    const headers = new Map(paused.responseHeaders?.map(entry => [entry.name.toLowerCase(), entry.value]));
    const status = paused.responseStatusCode ?? 0;
    const disposition = headers.get('content-disposition') ?? '', mediaType = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const saved = status >= 200 && status < 300 && (/^\s*attachment\b/iu.test(disposition) || (mediaType !== '' && !shownAsPage(mediaType)));
    if (!saved) { await client.send('Fetch.continueRequest', { requestId: paused.requestId }, sessionId); return; }
    const name = downloadName(disposition, paused.request.url);
    this.started({ name, saved: this.download(client, sessionId, paused.requestId, name, mediaType || 'application/octet-stream') });
  }

  /** Streams one paused response into the drive, then cancels it in the browser, saved or not. */
  private async download(client: CdpShimClient, sessionId: string, requestId: string, name: string, mediaType: string): Promise<SavedDownload> {
    let path: string | undefined;
    try {
      const choosing = this.naming.then(() => browserDownloadPath(this.drive, name, Date.now(), this.saving)).then(chosen => { this.saving.add(chosen); return chosen; });
      this.naming = choosing.catch(() => {});
      path = await choosing;
      const { stream } = Stream.parse(await client.send('Fetch.takeResponseBodyAsStream', { requestId }, sessionId));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = Read.parse(await client.send('IO.read', { handle: stream, size: READ_BYTES }, sessionId));
          if (chunk.data) controller.enqueue(chunk.base64Encoded ? browserUnbase64(chunk.data) : encoder.encode(chunk.data));
          if (chunk.eof) { controller.close(); await client.send('IO.close', { handle: stream }, sessionId).catch(() => {}); }
        },
        async cancel() { await client.send('IO.close', { handle: stream }, sessionId).catch(() => {}); },
      }, { highWaterMark: 0 });
      const written = await this.drive.write(path, mediaType, body);
      return { path: written.path, size: written.size, mediaType };
    } finally {
      if (path) this.saving.delete(path);
      // The browser's own download never starts: its response was taken, and nothing lands on Browser Run's disk.
      await client.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId).catch(() => {});
    }
  }
}
