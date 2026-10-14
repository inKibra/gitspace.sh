import type { ConversationRecord, Cursor, Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { pageSessionHistory, sourceHistoryMetadata, type HistorySourceEntry } from '@gitspace/protocol-agent';
import type { SessionHistoryService } from '@gitspace/runtime-core/session-controls';
import { createTranscriptReader, type ExecutorResultReader } from './transcript.js';
import { readCloudUsage } from './usage.js';

const ctx = BACKGROUND_CONTEXT;
const RECENT_ENTRIES = 256;
const ANCESTRY_LIMIT = 1024;
const PROMPT_CHARACTERS = 4096;
type ConversationRow = { parent: number | null; at: number | null };
type EntryRow = { conversation: number; first: string | null };

/** Session history reads Pi's own conversation and entry tables; nothing is mirrored. */
export function createSessionHistory(durable: DurableObjectStorage, storage: Storage, executorResult?: ExecutorResultReader): SessionHistoryService {
  const sql = durable.sql;
  // Reclaim the retired derived copies of Pi history.
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_state');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_rows');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_content');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_execution');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_binding');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_pending');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_scopes');
  sql.exec('DROP TABLE IF EXISTS runtime_transcript_counts');
  sql.exec('DROP TABLE IF EXISTS runtime_history_branches');
  sql.exec('DROP TABLE IF EXISTS runtime_history_entries');
  sql.exec('DROP TABLE IF EXISTS runtime_history_progress');
  const transcript = createTranscriptReader(storage, executorResult);
  let usagePending = Promise.resolve();

  function numberId(id: string) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== id) throw new Error('Invalid history identity');
    return value;
  }
  async function conversationRecord(id: number): Promise<ConversationRecord> {
    const record = (await storage.scanConversations({}, 1, { after: id - 1 }, ctx)).items[0];
    if (!record || Number(record.id) !== id) throw new Error('Conversation not found');
    return record;
  }
  function conversationRow(id: number): ConversationRow {
    const row = sql.exec<ConversationRow>("SELECT json_extract(record,'$.parent.conversationId') AS parent,json_extract(record,'$.parent.at') AS at FROM conversations WHERE id=?", id).toArray()[0];
    if (!row) throw new Error('Conversation not found');
    return row;
  }
  /** Forks share their source's tree; the family is the conversation without a fork parent. */
  function familyOf(id: number, roots: Map<number, number>): number {
    let current = id;
    for (let depth = 0; depth < ANCESTRY_LIMIT; depth++) {
      const known = roots.get(current);
      if (known !== undefined) { roots.set(id, known); return known; }
      const parent = conversationRow(current).parent;
      if (parent === null) { roots.set(id, current); return current; }
      current = parent;
    }
    throw new Error('History ancestry exceeds its depth limit');
  }
  function entryRow(id: number): EntryRow | undefined {
    return sql.exec<EntryRow>("SELECT conversation_id AS conversation,json_extract(record,'$.model[0]') AS first FROM entries WHERE id=?", id).toArray()[0];
  }
  function firstOwnEntry(conversation: number, after: number): number | null {
    return sql.exec<{ id: number | null }>('SELECT MIN(id) AS id FROM entries WHERE conversation_id=? AND id>?', conversation, after).toArray()[0]?.id ?? null;
  }
  /** A child continues its conversation or opens a fork taken at the parent entry. */
  function childIds(family: number, parentId: number | null): number[] {
    if (parentId === null) {
      const first = firstOwnEntry(family, -1);
      return first === null ? [] : [first];
    }
    const owner = entryRow(parentId);
    if (!owner) return [];
    const ids: number[] = [];
    const next = firstOwnEntry(owner.conversation, parentId);
    if (next !== null) ids.push(next);
    for (const fork of sql.exec<{ id: number }>("SELECT id FROM conversations WHERE json_extract(record,'$.parent.at')=?", parentId)) {
      const first = firstOwnEntry(fork.id, -1);
      if (first !== null) ids.push(first);
    }
    return ids.sort((left, right) => left - right);
  }
  function sourceEntry(family: number, id: number, roots: Map<number, number>): HistorySourceEntry | null {
    const row = entryRow(id);
    if (!row || familyOf(row.conversation, roots) !== family) return null;
    const previous = sql.exec<{ id: number | null }>('SELECT MAX(id) AS id FROM entries WHERE conversation_id=? AND id<?', row.conversation, id).toArray()[0]?.id ?? null;
    const parentId = previous ?? conversationRow(row.conversation).at;
    const first: unknown = row.first === null ? undefined : JSON.parse(row.first);
    return { id: String(id), parentId: parentId === null ? null : String(parentId), sequence: id, ...sourceHistoryMetadata(first), childCount: childIds(family, id).length };
  }

  return {
    async conversation(id) { return (await conversationRecord(numberId(id))).id; },
    async recent(target) {
      const prompts: { entryId: string; text: string }[] = [];
      let tokens: number | null = null;
      let anchorId: string | null = null;
      let seen = 0;
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries({ conversationId: target }, Math.min(64, RECENT_ENTRIES - seen), cursor, ctx);
        for (const entry of page.items) {
          anchorId ??= String(entry.id);
          const assistant = entry.model?.find(message => message.role === 'assistant');
          if (tokens === null && assistant?.role === 'assistant') tokens = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
          const text = (entry.model ?? []).filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
          if (text.length > 0 && text.length <= PROMPT_CHARACTERS) prompts.push({ entryId: String(entry.id), text });
        }
        seen += page.items.length;
        cursor = page.next;
      } while (cursor && seen < RECENT_ENTRIES);
      return { anchorId, prompts: prompts.reverse(), tokens };
    },
    async page(target, request) {
      const roots = new Map<number, number>();
      const family = familyOf(Number(target), roots);
      const leaf = (await storage.scanEntries({ conversationId: target }, 1, undefined, ctx)).items[0];
      return pageSessionHistory({
        entry: id => sourceEntry(family, numberId(id), roots),
        children(parentId, sequence, direction, limit) {
          const ids = childIds(family, parentId === null ? null : numberId(parentId));
          const selected = direction === 'before' ? ids.filter(id => id < (sequence ?? Number.MAX_SAFE_INTEGER)).reverse() : ids.filter(id => id > (sequence ?? -1));
          return selected.slice(0, limit).flatMap(id => sourceEntry(family, id, roots) ?? []);
        },
      }, request, leaf === undefined ? null : String(leaf.id));
    },
    async resolve(target, id) {
      const value = numberId(id);
      const roots = new Map<number, number>();
      const row = entryRow(value);
      if (!row || familyOf(row.conversation, roots) !== familyOf(Number(target), roots)) throw new Error('History entry not found in this conversation family');
      const owner = (await conversationRecord(row.conversation)).id;
      const record = (await storage.scanEntries({ conversationId: owner }, 1, { after: value + 1 }, ctx)).items[0];
      if (!record || Number(record.id) !== value) throw new Error('History entry not found');
      return { conversationId: owner, entryId: record.id };
    },
    transcriptPage: (target, request) => transcript.page(target, request),
    transcriptContent: (target, request) => transcript.content(target, request),
    async usage(target, harness) {
      const result = usagePending.catch(() => {}).then(() => readCloudUsage(durable, storage, harness, target));
      usagePending = result.then(() => {}, () => {});
      return result;
    },
  };
}
