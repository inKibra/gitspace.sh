import {
  previewTranscriptItem, collectTranscriptProjection,
  transcriptPageRequestSchema, transcriptContentRequestSchema,
  TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS,
  type TranscriptContentPage, type TranscriptContentRequest, type TranscriptPage, type TranscriptPageRequest, type TranscriptRow,
} from '@gitspace/blocks';
import { decryptArtifactBytes, encryptArtifactBytes } from '@gitspace/protocol';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DIRECTORY_BYTES = 32;
const LOOKUP_BYTES = 72;
const SEALED_OVERHEAD = 29;
const CONTENT_BYTES = TRANSCRIPT_CONTENT_CHUNK_CHARACTERS * 2;
// Bump when projection or the on-disk layout changes.
const INDEX_VERSION = 2;

interface Manifest { build: string; total: number }
interface Directory { offset: number; length: number; contentOffset: number; characters: number }

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** Immutable R2 index. Only the cold build materializes the source; every subsequent
 * read uses fixed-width directories and byte ranges. Each record is independently
 * sealed for encrypted checkpoints, so range reads never require decrypting history. */
export class SavedTranscriptIndex {
  private constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
    readonly generation: string,
    private readonly key: Uint8Array | null,
    private readonly manifest: Manifest,
  ) {}

  static async open(bucket: R2Bucket, userId: string, identity: readonly unknown[], key: Uint8Array | null, load: () => Promise<TranscriptEvent[]>): Promise<SavedTranscriptIndex> {
    const generation = await hash(JSON.stringify([INDEX_VERSION, userId, ...identity, key !== null]));
    const prefix = `users/${userId}/transcript-index/v${INDEX_VERSION}/${generation}`;
    const object = await bucket.get(`${prefix}/manifest`);
    if (object) {
      const stored = new Uint8Array(await object.arrayBuffer());
      const manifest = JSON.parse(decoder.decode(key ? await decryptArtifactBytes(stored, key) : stored)) as Manifest;
      if (!/^[a-f0-9-]{36}$/.test(manifest.build) || !Number.isSafeInteger(manifest.total) || manifest.total < 0) throw new Error('Saved transcript index is invalid');
      return new SavedTranscriptIndex(bucket, prefix, generation, key, manifest);
    }
    const index = new SavedTranscriptIndex(bucket, prefix, generation, key, { build: crypto.randomUUID(), total: 0 });
    await index.build(await load());
    return index;
  }

  private seal(bytes: Uint8Array): Promise<Uint8Array> { return this.key ? encryptArtifactBytes(bytes, this.key) : Promise.resolve(bytes); }
  private unseal(bytes: Uint8Array): Promise<Uint8Array> { return this.key ? decryptArtifactBytes(bytes, this.key) : Promise.resolve(bytes); }
  private width(bytes: number): number { return bytes + (this.key ? SEALED_OVERHEAD : 0); }
  private path(part: string): string { return `${this.prefix}/${this.manifest.build}/${part}`; }

  private async range(part: string, offset: number, length: number): Promise<Uint8Array> {
    if (!length) return new Uint8Array();
    const object = await this.bucket.get(this.path(part), { range: { offset, length } });
    if (!object) throw new Error('Saved transcript index data is unavailable');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== length) throw new Error('Saved transcript index range is incomplete');
    return bytes;
  }

  private async build(events: TranscriptEvent[]): Promise<void> {
    const rows: Uint8Array[] = [];
    const directory: Uint8Array[] = [];
    const contents: Uint8Array[] = [];
    const lookup: { hash: string; ordinal: number }[] = [];
    let offset = 0;
    let contentOffset = 0;
    const projection = collectTranscriptProjection(events);
    const statuses = new Map(projection.turns.map((turn) => [turn.id, turn.status]));
    const ordinals = new Map<string, number>();
    for (const { turnId, item } of projection.rows) {
        const ordinal = rows.length;
        const preview = previewTranscriptItem(item);
        const row: TranscriptRow = { id: item.id, ordinal, turnId, turnStatus: statuses.get(turnId) ?? 'done', contentRevision: 0, ...preview };
        ordinals.set(item.id, ordinal);
        const text = JSON.stringify(item);
        const stored = await this.seal(encoder.encode(JSON.stringify(row)));
        const entry = new Uint8Array(DIRECTORY_BYTES);
        const view = new DataView(entry.buffer);
        view.setFloat64(0, offset);
        view.setFloat64(8, stored.byteLength);
        view.setFloat64(16, preview.truncated ? contentOffset : -1);
        view.setFloat64(24, text.length);
        directory.push(await this.seal(entry));
        rows.push(stored);
        lookup.push({ hash: await hash(item.id), ordinal });
        offset += stored.byteLength;
        if (preview.truncated) {
          for (let start = 0; start < text.length; start += TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) {
            // UTF-16 code units preserve exact JSON string slicing, even at surrogate boundaries.
            const chunk = new Uint8Array(CONTENT_BYTES);
            const units = new DataView(chunk.buffer);
            const end = Math.min(text.length, start + TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
            for (let i = start; i < end; i++) units.setUint16((i - start) * 2, text.charCodeAt(i));
            const sealed = await this.seal(chunk);
            contents.push(sealed);
            contentOffset += sealed.byteLength;
          }
        }
    }
    lookup.sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
    const ids: Uint8Array[] = [];
    for (const entry of lookup) {
      const bytes = new Uint8Array(LOOKUP_BYTES);
      bytes.set(encoder.encode(entry.hash));
      new DataView(bytes.buffer).setFloat64(64, entry.ordinal);
      ids.push(await this.seal(bytes));
    }
    this.manifest.total = rows.length;
    const hidden = new Set(projection.links.filter((link) => link.hide).map((link) => link.rowId));
    const scopes = new Map<string, Set<number>>();
    for (const link of projection.links) {
      const ordinal = ordinals.get(link.rowId);
      if (ordinal === undefined) continue;
      let scope = scopes.get(link.executionId);
      if (!scope) scopes.set(link.executionId, scope = new Set());
      scope.add(ordinal);
    }
    const saveScope = async (name: string, selected: number[]) => {
      const records: Uint8Array[] = [];
      for (const ordinal of selected) {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, ordinal);
        records.push(await this.seal(bytes));
      }
      await this.bucket.put(this.path(`scopes/${name}/ordinals`), concatenate(records));
      await this.bucket.put(this.path(`scopes/${name}/manifest`), await this.seal(encoder.encode(JSON.stringify({ total: selected.length }))));
    };
    await saveScope('main', projection.rows.flatMap(({ item }, ordinal) => hidden.has(item.id) ? [] : [ordinal]));
    for (const [executionId, selected] of scopes) await saveScope(await hash(executionId), [...selected].sort((a, b) => a - b));
    // Unique build paths prevent concurrent cold requests mixing randomly sealed records.
    await Promise.all([
      this.bucket.put(this.path('rows'), concatenate(rows)),
      this.bucket.put(this.path('directory'), concatenate(directory)),
      this.bucket.put(this.path('lookup'), concatenate(ids)),
      this.bucket.put(this.path('content'), concatenate(contents)),
    ]);
    await this.bucket.put(`${this.prefix}/manifest`, await this.seal(encoder.encode(JSON.stringify(this.manifest))));
  }

  private async entries(start: number, count: number): Promise<Directory[]> {
    const width = this.width(DIRECTORY_BYTES);
    const bytes = await this.range('directory', start * width, count * width);
    const entries: Directory[] = [];
    for (let i = 0; i < count; i++) {
      const plain = await this.unseal(bytes.subarray(i * width, (i + 1) * width));
      const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
      entries.push({ offset: view.getFloat64(0), length: view.getFloat64(8), contentOffset: view.getFloat64(16), characters: view.getFloat64(24) });
    }
    return entries;
  }

  private async ordinal(id: string): Promise<number> {
    const target = await hash(id);
    const width = this.width(LOOKUP_BYTES);
    let low = 0;
    let high = this.manifest.total;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const bytes = await this.unseal(await this.range('lookup', middle * width, width));
      const candidate = decoder.decode(bytes.subarray(0, 64));
      if (candidate === target) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(64);
      if (candidate < target) low = middle + 1;
      else high = middle;
    }
    throw new Error('Saved transcript row does not exist');
  }

  private async rows(entries: Directory[]): Promise<TranscriptRow[]> {
    const rows: TranscriptRow[] = [];
    // Correlated histories have gaps; never read the intervening unrelated payloads.
    for (let start = 0; start < entries.length;) {
      let end = start + 1;
      while (end < entries.length && entries[end]!.offset === entries[end - 1]!.offset + entries[end - 1]!.length) end++;
      const first = entries[start]!;
      const last = entries[end - 1]!;
      const bytes = await this.range('rows', first.offset, last.offset + last.length - first.offset);
      for (let index = start; index < end; index++) {
        const entry = entries[index]!;
        rows.push(JSON.parse(decoder.decode(await this.unseal(bytes.subarray(entry.offset - first.offset, entry.offset - first.offset + entry.length)))) as TranscriptRow);
      }
      start = end;
    }
    return rows;
  }

  async page(request: TranscriptPageRequest): Promise<TranscriptPage> {
    request = transcriptPageRequestSchema.parse(request);
    const scope = request.executionId ? await hash(request.executionId) : 'main';
    const object = await this.bucket.get(this.path(`scopes/${scope}/manifest`));
    if (!object) {
      if (!request.executionId) throw new Error('Saved transcript directory is unavailable');
      return { generation: this.generation, revision: 1, rows: [], hasBefore: false, hasAfter: false, total: 0 };
    }
    const { total } = JSON.parse(decoder.decode(await this.unseal(new Uint8Array(await object.arrayBuffer())))) as { total: number };
    const width = this.width(8);
    const selection = async (start: number, count: number): Promise<number[]> => {
      const bytes = await this.range(`scopes/${scope}/ordinals`, start * width, count * width);
      const selected: number[] = [];
      for (let index = 0; index < count; index++) {
        const plain = await this.unseal(bytes.subarray(index * width, (index + 1) * width));
        selected.push(new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getFloat64(0));
      }
      return selected;
    };
    const lowerBound = async (ordinal: number) => {
      let low = 0;
      let high = total;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((await selection(middle, 1))[0]! < ordinal) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const current = request.generation === null || request.generation === this.generation;
    const before = current ? request.before : null;
    const after = current ? request.after : null;
    const aroundOrdinal = current && request.around !== null ? await this.ordinal(request.around) : null;
    const around = aroundOrdinal === null ? null : await lowerBound(aroundOrdinal);
    if (around !== null && (around >= total || (await selection(around, 1))[0] !== aroundOrdinal)) throw new Error('Saved transcript row is not in this history');
    let start: number;
    let end: number;
    if (around !== null) {
      start = Math.max(0, around - Math.floor(TRANSCRIPT_PAGE_ROWS / 2));
      end = Math.min(total, start + TRANSCRIPT_PAGE_ROWS);
      start = Math.max(0, end - TRANSCRIPT_PAGE_ROWS);
    } else if (after !== null) {
      start = await lowerBound(after + 1);
      end = Math.min(total, start + TRANSCRIPT_PAGE_ROWS);
    } else {
      end = before !== null ? await lowerBound(before) : total;
      start = Math.max(0, end - TRANSCRIPT_PAGE_ROWS);
    }
    const selected = await selection(start, end - start);
    const entries: Directory[] = [];
    for (let offset = 0; offset < selected.length;) {
      let stop = offset + 1;
      while (stop < selected.length && selected[stop] === selected[stop - 1]! + 1) stop++;
      entries.push(...await this.entries(selected[offset]!, stop - offset));
      offset = stop;
    }
    let size = 2 + entries.reduce((sum, entry) => sum + entry.length - (this.key ? SEALED_OVERHEAD : 0) + 1, 0);
    while (size > TRANSCRIPT_PAGE_BYTES && entries.length) {
      const dropFirst = around !== null ? around - start > end - 1 - around : after === null;
      const removed = dropFirst ? entries.shift()! : entries.pop()!;
      size -= removed.length - (this.key ? SEALED_OVERHEAD : 0) + 1;
      if (dropFirst) start++; else end--;
    }
    return { generation: this.generation, revision: 1, rows: await this.rows(entries), hasBefore: start > 0, hasAfter: end < total, total };
  }

  async content(request: TranscriptContentRequest): Promise<TranscriptContentPage> {
    request = transcriptContentRequestSchema.parse(request);
    if (request.generation !== this.generation) throw new Error('Saved transcript generation changed');
    const ordinal = await this.ordinal(request.rowId);
    const [entry] = await this.entries(ordinal, 1);
    if (!entry || request.offset > entry.characters) throw new Error('Saved transcript content offset is invalid');
    const end = Math.min(entry.characters, request.offset + TRANSCRIPT_CONTENT_CHARACTERS);
    let text = '';
    if (entry.contentOffset < 0) {
      const [row] = await this.rows([entry]);
      text = JSON.stringify(row!.item).slice(request.offset, end);
    } else if (end > request.offset) {
      const first = Math.floor(request.offset / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
      const last = Math.floor((end - 1) / TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
      const width = this.width(CONTENT_BYTES);
      const bytes = await this.range('content', entry.contentOffset + first * width, (last - first + 1) * width);
      for (let chunk = first; chunk <= last; chunk++) {
        const plain = await this.unseal(bytes.subarray((chunk - first) * width, (chunk - first + 1) * width));
        const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
        const start = Math.max(request.offset, chunk * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
        const stop = Math.min(end, (chunk + 1) * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS);
        const units = new Uint16Array(stop - start);
        for (let i = start; i < stop; i++) units[i - start] = view.getUint16((i - chunk * TRANSCRIPT_CONTENT_CHUNK_CHARACTERS) * 2);
        text += String.fromCharCode(...units);
      }
    }
    return { text, offset: request.offset, nextOffset: end < entry.characters ? end : null, totalCharacters: entry.characters, contentRevision: 0 };
  }
}
