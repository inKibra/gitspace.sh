import { defineDoc, defineEntry, type ConversationId, type EntryId, type EntryRecord, type Harness, type Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { receiptDigest } from '@gitspace/protocol-runtime';
import { TranscriptEventSchema, type TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import { sourceHistoryMetadata } from '@gitspace/protocol-agent';

export type LegacyHistorySource = {
  accountId: string; projectId: string; workspaceId: string; generation: number; manifestHash: string;
  sessionId: string; ompSessionId: string; title: string;
  originalTree: { objectKey: string; objectHash: string };
  branch: { leafEntryId: string | null; entries?: number; messages?: number; branchEntries?: number; branchMessages?: number; leaves?: number };
};
export type LegacyTranscriptEvent = Omit<TranscriptEvent, 'createdAt'> & { createdAt: string | Date };
export type LegacyHistoryImportInput = {
  operationId: string; sourceDigest: string; source: LegacyHistorySource;
  /** Validated, selected-branch records in source order; never executable submissions. */
  events: AsyncIterable<LegacyTranscriptEvent> | Iterable<LegacyTranscriptEvent>;
};
export type LegacyHistoryReceipt = {
  version: 1; operationId: string; sourceDigest: string; source: LegacyHistorySource;
  conversationId: string; importedEvents: number; importedEntries: number; transcriptDigest: string;
};
type Chunks = { last: number; count: number; characters: number };
type Progress = {
  fingerprint: string; operationId: string; sourceDigest: string; source: LegacyHistorySource;
  importedEvents: number; importedEntries: number; transcriptDigest: string;
  pending: { digest: string; chunks: Chunks } | null;
  receipt: LegacyHistoryReceipt | null;
};
export const LegacyHistoryDoc = defineDoc<{ state: Progress | null }>({ kind: 'gitspace.legacy-history', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ state: null }) });
export const LegacyHistoryEntry = defineEntry<{
  sequence: number; digest: string; event: string | null; chunks: Chunks | null;
  metadata: { role: 'user' | 'assistant' | null; preview: string; tools: number };
}>('gitspace.legacy-history-event');
type LegacyHistoryChunkData = { digest: string; previous: number | null; offset: number; text: string };
export const LegacyHistoryChunk = defineEntry<LegacyHistoryChunkData>('gitspace.legacy-history-chunk');
export const LegacyHistoryBoundary = defineEntry<{ text: string }>('gitspace.legacy-history-boundary');
// Even worst-case JSON escaping stays well below a DO SQLite row's 2 MiB ceiling.
const chunkCharacters = 16_384;
const context = BACKGROUND_CONTEXT;
async function digestText(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Owning import uses only public Harness transactions and Storage readers. No task,
 * model, submission, inference admission, or credential API participates. The caller
 * must fence this staged root from runtime users until the returned receipt commits. */
export async function importLegacyHistory(input: LegacyHistoryImportInput & { harness: Harness; storage: Storage; conversationId: ConversationId }): Promise<LegacyHistoryReceipt> {
  const { harness, storage, conversationId } = input;
  const fingerprint = await receiptDigest({ operationId: input.operationId, sourceDigest: input.sourceDigest, source: input.source });
  const emptyDigest = await digestText('gitspace.legacy-history.v1');
  if (!input.operationId || !input.sourceDigest) throw new Error('Legacy import identity is required');
  const completed = (await harness.snapshot(LegacyHistoryDoc, conversationId, context))?.state?.receipt;
  if (!completed && (await storage.scanSubmissions({ conversationId }, 1, undefined, context)).items.length) throw new Error('Legacy import requires an unused staged conversation');
  await harness.commit(async tx => {
    const doc = await tx.doc(LegacyHistoryDoc, conversationId);
    if (doc.state) {
      if (doc.state.fingerprint !== fingerprint) throw new Error('Legacy import source conflicts with staged history');
      return;
    }
    if ((await tx.scanEntries({ conversationId }, 1)).items.length || (await tx.scanTasks({ conversationId }, 1)).items.length) throw new Error('Legacy import requires an empty staged conversation');
    doc.state = { fingerprint, operationId: input.operationId, sourceDigest: input.sourceDigest, source: input.source, importedEvents: 0, importedEntries: 0, transcriptDigest: emptyDigest, pending: null, receipt: null };
  }, context);
  const saved = (await harness.snapshot(LegacyHistoryDoc, conversationId, context))!.state!;
  let sequence = 0;
  let transcriptDigest = emptyDigest;
  let previousOrdinal = -1;
  for await (const candidate of input.events) {
    const event = TranscriptEventSchema.parse({ ...candidate, createdAt: candidate.createdAt instanceof Date ? candidate.createdAt.toISOString() : candidate.createdAt });
    if (event.ordinal <= previousOrdinal) throw new Error('Legacy transcript ordinals must increase');
    previousOrdinal = event.ordinal;
    const text = JSON.stringify(event);
    const digest = await digestText(text);
    transcriptDigest = await receiptDigest([transcriptDigest, digest]);
    if (sequence < saved.importedEvents) {
      sequence++;
      if (sequence === saved.importedEvents && transcriptDigest !== saved.transcriptDigest) throw new Error('Legacy import transcript prefix changed');
      continue;
    }
    if (saved.receipt) throw new Error('Legacy import transcript grew after completion');
    let pending = sequence === saved.importedEvents ? saved.pending : null;
    if (pending && pending.digest !== digest) throw new Error('Legacy import interrupted record changed');
    if (text.length > chunkCharacters) {
      for (let offset = pending?.chunks.characters ?? 0; offset < text.length; offset += chunkCharacters) {
        const part = text.slice(offset, offset + chunkCharacters);
        pending = await harness.commit(async tx => {
          const state = (await tx.doc(LegacyHistoryDoc, conversationId)).state!;
          if (state.fingerprint !== fingerprint || state.importedEvents !== sequence || (state.pending?.chunks.characters ?? 0) !== offset || state.receipt) throw new Error('Legacy import changed concurrently');
          const chunk = await tx.appendEntry(LegacyHistoryChunk, conversationId, { data: { digest, previous: state.pending?.chunks.last ?? null, offset, text: part } });
          state.importedEntries++;
          state.pending = { digest, chunks: { last: Number(chunk.id), count: (state.pending?.chunks.count ?? 0) + 1, characters: offset + part.length } };
          return { digest, chunks: { ...state.pending.chunks } };
        }, context);
      }
    }
    const metadata = sourceHistoryMetadata(event.payload.message);
    if (!metadata.preview) metadata.preview = `${event.kind}: ${text.slice(0, 240)}`;
    await harness.commit(async tx => {
      const state = (await tx.doc(LegacyHistoryDoc, conversationId)).state!;
      if (state.fingerprint !== fingerprint || state.importedEvents !== sequence || state.receipt || (state.pending?.digest ?? null) !== (pending?.digest ?? null)) throw new Error('Legacy import changed concurrently');
      await tx.appendEntry(LegacyHistoryEntry, conversationId, { data: { sequence, digest, event: pending ? null : text, chunks: pending?.chunks ?? null, metadata } });
      state.importedEvents++;
      state.importedEntries++;
      state.transcriptDigest = transcriptDigest;
      state.pending = null;
    }, context);
    sequence++;
  }
  if (sequence < saved.importedEvents || (sequence === saved.importedEvents && transcriptDigest !== saved.transcriptDigest)) throw new Error('Legacy import transcript ended before its committed prefix');
  return harness.commit(async tx => {
    const state = (await tx.doc(LegacyHistoryDoc, conversationId)).state!;
    if (state.fingerprint !== fingerprint || state.importedEvents !== sequence || state.transcriptDigest !== transcriptDigest || state.pending) throw new Error('Legacy import did not settle its complete transcript');
    if (!state.receipt) {
      await tx.appendEntry(LegacyHistoryBoundary, conversationId, { head: 'self', data: { text: 'Legacy OMP history imported as a read-only record. Pi begins a fresh context here; only a new explicit user message starts work.' } });
      state.importedEntries++;
      state.receipt = { version: 1, operationId: state.operationId, sourceDigest: state.sourceDigest, source: state.source, conversationId: String(conversationId), importedEvents: state.importedEvents, importedEntries: state.importedEntries, transcriptDigest };
    }
    return { ...state.receipt, source: { ...state.source, originalTree: { ...state.source.originalTree }, branch: { ...state.source.branch } } };
  }, context);
}

/** Hydrate one original event for existing bounded transcript/content projection.
 * Chunk entries are storage, never visible messages or model context. */
export async function readLegacyHistoryEvent(storage: Storage, entry: EntryRecord): Promise<TranscriptEvent | null> {
  if (!LegacyHistoryEntry.is(entry)) return null;
  let text = entry.data.event;
  if (text === null) {
    const chunks = entry.data.chunks;
    if (!chunks) throw new Error('Legacy history content reference is missing');
    const parts: string[] = [];
    let current: number | null = chunks.last;
    let expectedEnd = chunks.characters;
    for (let count = 0; count < chunks.count; count++) {
      if (current === null) throw new Error('Legacy history content reference ended early');
      const found: { entry: EntryRecord } | null | undefined = await storage.entry(current as EntryId, context);
      if (!found || !LegacyHistoryChunk.is(found.entry) || found.entry.conversationId !== entry.conversationId || found.entry.data.digest !== entry.data.digest) throw new Error('Legacy history content reference is invalid');
      const part: LegacyHistoryChunkData = found.entry.data;
      if (part.offset + part.text.length !== expectedEnd) throw new Error('Legacy history content reference has a gap');
      parts.push(part.text);
      expectedEnd = part.offset;
      current = part.previous;
    }
    if (current !== null || expectedEnd !== 0) throw new Error('Legacy history content reference has extra chunks');
    text = parts.reverse().join('');
  }
  if (await digestText(text) !== entry.data.digest) throw new Error('Legacy history content digest mismatch');
  return TranscriptEventSchema.parse(JSON.parse(text));
}

const projectedLegacyKinds: Readonly<Record<string, true>> = { turn_start: true, turn_end: true, agent_end: true, session_compact: true, compaction: true, message_start: true, message_update: true, message_end: true, tool_execution_start: true, tool_execution_update: true, tool_execution_end: true, error: true };
/** Unknown legacy extension entries still have readable, labeled historical content;
 * they are not reinterpreted as extension hooks or executable Pi operations. */
export function legacyHistoryProjection(event: TranscriptEvent): TranscriptEvent {
  if (projectedLegacyKinds[event.kind] === true) return event;
  return { ...event, kind: 'message_end', payload: { message: { role: 'custom', customType: event.kind, display: true, content: JSON.stringify(event.payload) } } };
}
