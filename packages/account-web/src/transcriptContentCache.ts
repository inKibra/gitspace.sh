import { TRANSCRIPT_CACHE_ROWS, transcriptItemSchema, type TranscriptContentPage, type TranscriptItem, type TranscriptRow } from '@gitspace/blocks';

const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
const CONTENT_READS = 3;
type ReadContent = (rowId: string, offset: number, signal: AbortSignal) => Promise<TranscriptContentPage>;
interface ContentEntry {
  key: string;
  rowId: string;
  ordinal: number;
  revision: number;
  item?: TranscriptItem;
  error?: string;
  bytes: number;
  controller?: AbortController;
}

/** Complete items never replace the bounded wire rows. Only mounted/active rows
 * are pinned; old completed items may survive virtual unmount within this budget. */
export class TranscriptContentCache {
  private readonly entries = new Map<string, ContentEntry>();
  private readonly running = new Set<ContentEntry>();
  private needed = new Set<string>();
  private reader: ReadContent | null = null;
  private readonly listeners = new Set<() => void>();
  private bytes = 0;

  constructor(
    private readonly generation: string | null,
    private readonly limits = { bytes: CONTENT_CACHE_BYTES, entries: TRANSCRIPT_CACHE_ROWS, reads: CONTENT_READS },
  ) {}

  private key(row: TranscriptRow): string {
    const revision = row.contentRevision ?? 0;
    // Content can advance beyond its preview while a live page is in flight.
    // Reuse that complete newer version until the preview overtakes it.
    for (const entry of this.entries.values()) {
      if (entry.rowId === row.id && entry.item && entry.revision >= revision) return entry.key;
    }
    return JSON.stringify([this.generation, row.id, revision]);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get(row: TranscriptRow): { item?: TranscriptItem; error?: string } {
    const current = this.entries.get(this.key(row));
    if (current?.item) return { item: current.item, error: current.error };
    // Keep the last complete version on screen while a streamed replacement loads.
    for (const entry of this.entries.values()) {
      if (entry.rowId === row.id && entry.item) return { item: entry.item, error: current?.error };
    }
    return { error: current?.error };
  }

  setNeeded(rows: Iterable<TranscriptRow>, reader: ReadContent): void {
    this.reader = reader;
    const needed = new Set<string>();
    for (const row of rows) {
      const key = this.key(row);
      needed.add(key);
      const entry = this.entries.get(key);
      if (entry) {
        entry.ordinal = row.ordinal;
        if (!row.truncated && !entry.item) {
          entry.controller?.abort();
          delete entry.error;
          entry.item = row.item;
          entry.bytes = row.contentBytes * 2;
          this.bytes += entry.bytes;
        }
      } else {
        const bytes = row.truncated ? 0 : row.contentBytes * 2;
        this.entries.set(key, { key, rowId: row.id, ordinal: row.ordinal, revision: row.contentRevision ?? 0, bytes, ...(!row.truncated ? { item: row.item } : {}) });
        this.bytes += bytes;
      }
    }
    this.needed = needed;
    this.trim();
    this.pump();
  }

  retry(row: TranscriptRow): void {
    const entry = this.entries.get(this.key(row));
    if (!entry?.error || !this.needed.has(entry.key)) return;
    delete entry.error;
    this.notify();
    this.pump();
  }

  /** Release pending reads; nested execution windows also release full payloads. */
  suspend(discard = false): void {
    this.reader = null;
    this.needed.clear();
    if (discard) for (const entry of this.entries.values()) this.remove(entry);
    else this.trim();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private remove(entry: ContentEntry): void {
    entry.controller?.abort();
    this.entries.delete(entry.key);
    this.bytes -= entry.bytes;
  }

  private trim(): void {
    const pinned = new Set(this.needed);
    const completed = new Map<string, ContentEntry>();
    for (const entry of this.entries.values()) if (entry.item) completed.set(entry.rowId, entry);
    for (const key of this.needed) {
      const entry = this.entries.get(key)!;
      if (!entry.item) {
        const previous = completed.get(entry.rowId);
        if (previous) pinned.add(previous.key);
      }
    }
    for (const entry of this.entries.values()) {
      if (pinned.has(entry.key)) continue;
      // Do not accumulate obsolete streaming revisions, queued reads or failures.
      if (!entry.item || completed.get(entry.rowId) !== entry) this.remove(entry);
    }
    const ordinals: number[] = [];
    for (const key of this.needed) ordinals.push(this.entries.get(key)!.ordinal);
    const distance = (entry: ContentEntry): number => {
      let result = Number.POSITIVE_INFINITY;
      for (const ordinal of ordinals) result = Math.min(result, Math.abs(entry.ordinal - ordinal));
      return result;
    };
    if (this.bytes <= this.limits.bytes && this.entries.size <= this.limits.entries) return;
    const disposable = [...this.entries.values()].filter((entry) => !pinned.has(entry.key));
    disposable.sort((a, b) => distance(b) - distance(a));
    for (const entry of disposable) {
      if (this.bytes <= this.limits.bytes && this.entries.size <= this.limits.entries) break;
      this.remove(entry);
    }
    // Visible content may itself exceed the background budget. Never truncate it.
  }

  private pump(): void {
    if (!this.reader) return;
    for (const key of this.needed) {
      if (this.running.size >= this.limits.reads) break;
      const entry = this.entries.get(key)!;
      if (entry.item || entry.error || entry.controller) continue;
      const controller = new AbortController();
      entry.controller = controller;
      this.running.add(entry);
      void this.load(entry, this.reader, controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted && this.entries.get(key) === entry) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          this.notify();
        }
      }).finally(() => {
        this.running.delete(entry);
        delete entry.controller;
        this.pump();
      });
    }
  }

  private async load(entry: ContentEntry, reader: ReadContent, signal: AbortSignal): Promise<void> {
    const parts: string[] = [];
    let received = 0;
    let total: number | undefined;
    let revision: number | undefined;
    while (true) {
      const page = await reader(entry.rowId, received, signal);
      if (signal.aborted || this.entries.get(entry.key) !== entry) return;
      if (received > 0 && (page.contentRevision !== revision || page.totalCharacters !== total)) {
        // A live item changed between chunks. Restart its snapshot without
        // replacing the last complete rendering with a preview or an error.
        parts.length = 0;
        received = 0;
        total = undefined;
        revision = undefined;
        continue;
      }
      if (received === 0) revision = page.contentRevision;
      total ??= page.totalCharacters;
      if (page.offset !== received || received + page.text.length > total) throw new Error('Block content is not contiguous.');
      parts.push(page.text);
      received += page.text.length;
      if (page.nextOffset === null) break;
      if (!page.text.length || page.nextOffset !== received) throw new Error('Block content is not contiguous.');
    }
    if (received !== total) throw new Error('Block content is incomplete.');
    const serialized = parts.join('');
    parts.length = 0;
    const item = transcriptItemSchema.parse(JSON.parse(serialized));
    if (item.id !== entry.rowId) throw new Error('Content belongs to a different block.');
    if (revision !== undefined && revision > entry.revision) {
      const previousKey = entry.key;
      this.entries.delete(previousKey);
      entry.revision = revision;
      entry.key = JSON.stringify([this.generation, entry.rowId, revision]);
      this.entries.set(entry.key, entry);
      if (this.needed.delete(previousKey)) this.needed.add(entry.key);
    }
    entry.item = item;
    // Account for UTF-16 string storage conservatively without serializing or
    // encoding the parsed object again. This is a payload budget, not a heap cap.
    entry.bytes = serialized.length * 2;
    this.bytes += entry.bytes;
    this.trim();
    this.notify();
  }
}
