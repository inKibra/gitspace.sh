import { z } from 'zod';
import { browserUnbase64 } from '@gitspace/protocol-runtime';
import { browserDownloadPath, browserDriveFile } from './browser-upload.js';
import type { CdpBrowserShim, CdpEvent, CdpShimClient } from './browser-shim.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/** A download as a run or a step follows it (docs/APERTURE-DESIGN.md §6.1): `id` is stable within its run (the cloud
 * browser's own id; on your Chrome the upload id), `targetId` the tab that started it (null when unknown: an older
 * extension), `url` where it came from ('' when unknown), `name` the file name it asked for. `outcome` is null while
 * it is being saved, then its drive address (`drive://workspace/<path>`, each segment encoded), size and type, or why
 * it was not saved. */
export const ScriptDownloadSchema = z.object({
  id: z.string(), targetId: z.string().nullable(), url: z.string(), name: z.string(),
  outcome: z.union([z.object({ file: z.string(), size: z.number().int().nonnegative(), mediaType: z.string() }), z.object({ error: z.string() })]).nullable(),
});
export type ScriptDownload = z.infer<typeof ScriptDownloadSchema>;
export type DownloadOutcome = NonNullable<ScriptDownload['outcome']>;
/** A run's downloads as its script reads them: all of them in the order they started, `version` counting changes (a
 * start or a settle each add one), `ended` once the run ended. */
export type ScriptDownloads = { version: number; ended: boolean; downloads: ScriptDownload[] };
/** A download in a result (a run's, or a single step's `downloads`): saved at its drive address, still being saved, or
 * not saved and why. */
export type ListedDownload = { file: string; size: number; mediaType: string } | { name: string; saving: true } | { name: string; error: string };
/** A download the cloud browser started: its id, tab, address and file name, and its outcome once it settles. */
export type BrowserDownload = Omit<ScriptDownload, 'outcome'> & { outcome: Promise<DownloadOutcome> };
/** A result waits this long for downloads begun and not yet settled: a run's after its script ended, a step's after
 * it answered. */
export const DOWNLOAD_WAIT_MS = 30_000;

/** A download as a result lists it. */
export function listedDownload({ name, outcome }: ScriptDownload): ListedDownload {
  if (!outcome) return { name, saving: true };
  if ('error' in outcome) return { name, error: outcome.error };
  return outcome;
}

/** The downloads one run follows: every start and settle is one change, and the waiters of `state` wake on the next
 * change or on the end. */
export class DownloadList {
  readonly downloads: ScriptDownload[] = [];
  private version = 0;
  private ended = false;
  private changed = Promise.withResolvers<void>();

  start(download: Omit<ScriptDownload, 'outcome'>): void {
    this.downloads.push({ ...download, outcome: null });
    this.change();
  }

  /** A download saved or failed; one already settled, or not in the list, stays as it is. */
  settle(id: string, outcome: DownloadOutcome): void {
    const download = this.downloads.find(item => item.id === id);
    if (!download || download.outcome) return;
    download.outcome = outcome;
    this.change();
  }

  /** The run ended: waiters answer, and every later `state` answers at once. Downloads still settle afterwards. */
  end(): void {
    this.ended = true;
    this.changed.resolve();
  }

  /** The list once its version differs from `version` or it ended: at once when it does already, else at its next
   * change, its end or `until`, whichever comes first. */
  async state(version: number, until?: Promise<unknown>): Promise<ScriptDownloads> {
    if (version === this.version && !this.ended) await Promise.race(until ? [this.changed.promise, until] : [this.changed.promise]);
    return { version: this.version, ended: this.ended, downloads: this.downloads.map(download => ({ ...download })) };
  }

  private change(): void {
    this.version++;
    const changed = this.changed;
    this.changed = Promise.withResolvers<void>();
    changed.resolve();
  }
}

/** An unreported download, as `StepDownloads` keeps it: `listed` once a step listed it still saving, `startedAt` for
 * the order of a listing, `expiresAt` when it is dropped unreported. */
const StepDownloadRow = ScriptDownloadSchema.extend({ listed: z.boolean(), startedAt: z.number().int(), expiresAt: z.number().int() });
type StepDownloadRow = z.infer<typeof StepDownloadRow>;
const Expiring = z.object({ expiresAt: z.number() });
/** An unreported download is kept this long after it started or settled. */
const STEP_DOWNLOAD_KEEP_MS = 60 * 60_000;

/**
 * Downloads that single steps started (no running script claimed them), kept in `storage` under `prefix` per owner (a
 * workspace on one browser) until a step's result lists them: the step that started one when it began before the step
 * answered, else the owner's next step. A result lists each settled download once; one still saving is listed as
 * saving once, then again when it settled.
 */
export class StepDownloads {
  private changed = Promise.withResolvers<void>();
  constructor(private readonly storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>, private readonly prefix: string) {}

  /** A download began; kept downloads past their time go now. */
  async begin(owner: string, download: Omit<ScriptDownload, 'outcome'>): Promise<void> {
    const now = Date.now();
    for (const [key, stored] of await this.storage.list({ prefix: this.prefix })) {
      const kept = Expiring.safeParse(stored);
      if (!kept.success || kept.data.expiresAt <= now) await this.storage.delete(key);
    }
    await this.storage.put(`${this.prefix}${owner}:${download.id}`, { ...download, outcome: null, listed: false, startedAt: now, expiresAt: now + STEP_DOWNLOAD_KEEP_MS } satisfies StepDownloadRow);
    this.change();
  }

  /** A download saved or failed; one already settled, listed settled or never begun here stays as it is. */
  async settle(owner: string, id: string, outcome: DownloadOutcome): Promise<void> {
    const key = `${this.prefix}${owner}:${id}`, stored = await this.storage.get(key);
    if (!stored) return;
    const row = StepDownloadRow.parse(stored);
    if (row.outcome) return;
    await this.storage.put(key, { ...row, outcome, expiresAt: Date.now() + STEP_DOWNLOAD_KEEP_MS } satisfies StepDownloadRow);
    this.change();
  }

  /** What a step's result lists for `owner`, after waiting up to `DOWNLOAD_WAIT_MS` for downloads begun and never listed
   * to settle: each settled download (then forgotten), and each still saving that no result listed yet. */
  async report(owner: string): Promise<ListedDownload[]> {
    const rows = await this.settledRows(owner);
    const listed: StepDownloadRow[] = [];
    for (const [key, row] of rows) {
      if (row.outcome) { listed.push(row); await this.storage.delete(key); }
      else if (!row.listed) { listed.push(row); await this.storage.put(key, { ...row, listed: true } satisfies StepDownloadRow); }
    }
    return listed.sort((left, right) => left.startedAt - right.startedAt).map(listedDownload);
  }

  /** The owner's rows once none begun and never listed is still saving, or at `DOWNLOAD_WAIT_MS`. */
  private async settledRows(owner: string): Promise<Map<string, StepDownloadRow>> {
    const waited = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => waited.resolve(true), DOWNLOAD_WAIT_MS);
    try {
      for (;;) {
        const changed = this.changed.promise.then(() => false);
        const rows = new Map<string, StepDownloadRow>();
        for (const [key, stored] of await this.storage.list({ prefix: `${this.prefix}${owner}:` })) {
          const row = StepDownloadRow.parse(stored);
          if (row.expiresAt > Date.now()) rows.set(key, row);
        }
        if (![...rows.values()].some(row => !row.outcome && !row.listed)) return rows;
        if (await Promise.race([changed, waited.promise])) return rows;
      }
    } finally { clearTimeout(timer); }
  }

  private change(): void {
    const changed = this.changed;
    this.changed = Promise.withResolvers<void>();
    changed.resolve();
  }
}

const Attached = z.object({ sessionId: z.string(), targetInfo: z.object({ targetId: z.string() }) });
const Detached = z.object({ sessionId: z.string() });
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
 * the browser's own download is cancelled. Other responses go on unchanged. Each download is reported with the tab
 * that started it, known from this client's own attaches.
 */
export class CloudDownloads {
  private client: CdpShimClient | undefined;
  /** The tab of each page session this client attached to. */
  private readonly targets = new Map<string, string>();
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
      const { sessionId, targetInfo } = Attached.parse(event.params);
      this.targets.set(sessionId, targetInfo.targetId);
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sessionId);
      return;
    }
    if (event.method === 'Target.detachedFromTarget' && !event.sessionId) { this.targets.delete(Detached.parse(event.params).sessionId); return; }
    if (event.method !== 'Fetch.requestPaused' || !event.sessionId) return;
    const sessionId = event.sessionId, paused = Paused.parse(event.params);
    const headers = new Map(paused.responseHeaders?.map(entry => [entry.name.toLowerCase(), entry.value]));
    const status = paused.responseStatusCode ?? 0;
    const disposition = headers.get('content-disposition') ?? '', mediaType = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const saved = status >= 200 && status < 300 && (/^\s*attachment\b/iu.test(disposition) || (mediaType !== '' && !shownAsPage(mediaType)));
    if (!saved) { await client.send('Fetch.continueRequest', { requestId: paused.requestId }, sessionId); return; }
    const name = downloadName(disposition, paused.request.url), url = paused.request.url;
    const outcome = this.download(client, sessionId, paused.requestId, name, mediaType || 'application/octet-stream').then(
      (saved): DownloadOutcome => ({ file: browserDriveFile(saved.path), size: saved.size, mediaType: saved.mediaType }),
      (error: unknown): DownloadOutcome => ({ error: error instanceof Error ? error.message.slice(0, 1024) : String(error) }),
    );
    // An address too long to carry (a large data: URL) is left out.
    this.started({ id: crypto.randomUUID(), targetId: this.targets.get(sessionId) ?? null, url: url.length > 8192 ? '' : url, name, outcome });
  }

  /** Streams one paused response into the drive, then cancels it in the browser, saved or not. */
  private async download(client: CdpShimClient, sessionId: string, requestId: string, name: string, mediaType: string): Promise<{ path: string; size: number; mediaType: string }> {
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
