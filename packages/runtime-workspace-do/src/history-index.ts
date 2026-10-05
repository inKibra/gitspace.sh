import type { ConversationId, ConversationRecord, EntryRecord, Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { pageSessionHistory, sourceHistoryMetadata, type HistorySourceEntry } from '@gitspace/protocol-agent';
import type { SessionHistoryService } from '@gitspace/runtime-core/session-controls';
import { createTranscriptIndex } from './transcript-index.js';
import { readCloudUsage } from './usage.js';
import type { RuntimeToolResult } from '@gitspace/protocol-runtime';

type Branch = { id: number; family: number; leaf: string | null };
type RecallRow = { parentId: string | null; prompt: string | null; tokens: number | null };
type IndexedEntry = { [Key in keyof HistorySourceEntry]: HistorySourceEntry[Key] };
const columns = 'id,parentId,sequence,role,preview,tools,childCount';
const batchSize = 128;

/** Disposable derived metadata. Pi's immutable entries remain the only transcript authority. */
export function createHistoryIndex(durable: DurableObjectStorage, storage: Storage, getExecutorResult?: (reference: { attemptId: string; sha256: string }, conversationId: string) => RuntimeToolResult | undefined) {
  const sql = durable.sql;
  const transcript = createTranscriptIndex(durable, storage, getExecutorResult);
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_history_branches(id INTEGER PRIMARY KEY,family INTEGER NOT NULL,leaf TEXT)');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_history_entries(id TEXT PRIMARY KEY,parentId TEXT,sequence INTEGER NOT NULL UNIQUE,role TEXT,preview TEXT NOT NULL,tools INTEGER NOT NULL,childCount INTEGER NOT NULL,owner INTEGER NOT NULL,family INTEGER NOT NULL,prompt TEXT,tokens INTEGER)');
  sql.exec('CREATE INDEX IF NOT EXISTS runtime_history_children ON runtime_history_entries(family,parentId,sequence)');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_history_progress(id INTEGER PRIMARY KEY,conversation INTEGER NOT NULL,entry INTEGER NOT NULL)');
  sql.exec('INSERT OR IGNORE INTO runtime_history_progress VALUES(1,-1,-1)');
  function branch(id: number) { return sql.exec<Branch>('SELECT id,family,leaf FROM runtime_history_branches WHERE id=?', id).toArray()[0]; }
  async function conversationRecord(id: number): Promise<ConversationRecord> {
    const record = (await storage.scanConversations({}, 1, { after: id - 1 }, BACKGROUND_CONTEXT)).items[0];
    if (!record || Number(record.id) !== id) throw new Error('Conversation not found');
    return record;
  }
  function numberId(id: string) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== id) throw new Error('Invalid history identity');
    return value;
  }
  async function exactEntry(owner: ConversationId, id: number): Promise<EntryRecord> {
    const record = (await storage.scanEntries({ conversationId: owner }, 1, { after: id + 1 }, BACKGROUND_CONTEXT)).items[0];
    if (!record || Number(record.id) !== id || record.conversationId !== owner) throw new Error('History entry not found');
    return record;
  }
  function addBranch(record: ConversationRecord) {
    const parent = record.parent ? branch(Number(record.parent.conversationId)) : undefined;
    if (record.parent && !parent) throw new Error('History ancestry index is unavailable');
    sql.exec('INSERT OR IGNORE INTO runtime_history_branches(id,family,leaf) VALUES(?,?,?)', Number(record.id), parent?.family ?? Number(record.id), record.parent ? String(record.parent.at) : null);
    sql.exec('UPDATE runtime_history_progress SET conversation=? WHERE id=1', Number(record.id));
  }
  function addEntry(record: EntryRecord) {
    const owner = branch(Number(record.conversationId));
    if (!owner) throw new Error('History owner index is unavailable');
    const metadata = sourceHistoryMetadata(record.model?.[0]);
    const promptText = (record.model ?? []).filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n');
    const assistant = record.model?.find(message => message.role === 'assistant');
    const tokens = assistant?.role === 'assistant' ? assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite : null;
    const prompt = promptText.length > 0 && promptText.length <= 4096 ? promptText : null;
    sql.exec('INSERT INTO runtime_history_entries(id,parentId,sequence,role,preview,tools,childCount,owner,family,prompt,tokens) VALUES(?,?,?,?,?,?,0,?,?,?,?)', String(record.id), owner.leaf, Number(record.id), metadata.role, metadata.preview, metadata.tools, owner.id, owner.family, prompt, tokens);
    if (owner.leaf !== null) sql.exec('UPDATE runtime_history_entries SET childCount=childCount+1 WHERE id=?', owner.leaf);
    sql.exec('UPDATE runtime_history_branches SET leaf=? WHERE id=?', String(record.id), owner.id);
    sql.exec('UPDATE runtime_history_progress SET entry=? WHERE id=1', Number(record.id));
  }
  async function ingest() {
    // Fixed high-water marks keep a continuously running producer from starving a reader.
    const conversationEnd = sql.exec<{ id: number }>('SELECT id FROM conversations ORDER BY id DESC LIMIT 1').toArray()[0]?.id ?? -1;
    const entryEnd = sql.exec<{ id: number }>('SELECT id FROM entries ORDER BY id DESC LIMIT 1').toArray()[0]?.id ?? -1;
    let progress = sql.exec<{ conversation: number; entry: number }>('SELECT conversation,entry FROM runtime_history_progress WHERE id=1').toArray()[0]!;
    while (progress.conversation < conversationEnd) {
      const page = await storage.scanConversations({}, batchSize, { after: progress.conversation }, BACKGROUND_CONTEXT);
      const records = page.items.filter(record => Number(record.id) <= conversationEnd);
      if (!records.length) throw new Error('History conversation backfill cannot advance');
      durable.transactionSync(() => { for (const record of records) addBranch(record); });
      progress.conversation = Number(records[records.length - 1]!.id);
    }
    while (progress.entry < entryEnd) {
      const ids = sql.exec<{ id: number; conversation_id: number }>('SELECT id,conversation_id FROM entries WHERE id>? AND id<=? ORDER BY id LIMIT ?', progress.entry, entryEnd, batchSize).toArray();
      if (!ids.length) throw new Error('History entry backfill cannot advance');
      const records: EntryRecord[] = [];
      for (const row of ids) records.push(await exactEntry((await conversationRecord(row.conversation_id)).id, row.id));
      durable.transactionSync(() => { for (const record of records) addEntry(record); });
      progress.entry = ids[ids.length - 1]!.id;
    }
  }
  let pending = Promise.resolve();
  let usagePending = Promise.resolve();
  function refresh() {
    // Invoked outside Session publication callbacks; a failed derived-index attempt is retryable.
    pending = pending.catch(() => {}).then(ingest);
    return pending;
  }
  function family(id: ConversationId) {
    const value = branch(Number(id));
    if (!value) throw new Error('History conversation index is unavailable');
    return value;
  }
  function entry(id: string, familyId: number): HistorySourceEntry | null {
    return sql.exec<IndexedEntry>(`SELECT ${columns} FROM runtime_history_entries WHERE id=? AND family=?`, id, familyId).toArray()[0] ?? null;
  }
  const service: SessionHistoryService = {
    async transcriptPage(target, request) { await pending; return transcript.page(target, request); },
    async transcriptContent(target, request) { await pending; return transcript.content(target, request); },
    async usage(target, harness) {
      await pending;
      const result = usagePending.catch(() => {}).then(() => readCloudUsage(durable, storage, harness, target));
      usagePending = result.then(() => {}, () => {});
      return result;
    },
    async conversation(id) { return (await conversationRecord(numberId(id))).id; },
    async recent(target) {
      await pending;
      const current = family(target);
      const prompts: { entryId: string; text: string }[] = [];
      let id = current.leaf;
      let tokens: number | null = null;
      for (let steps = 0; id !== null && steps < 256; steps++) {
        const row = sql.exec<RecallRow>('SELECT parentId,prompt,tokens FROM runtime_history_entries WHERE id=? AND family=?', id, current.family).toArray()[0];
        if (!row) throw new Error('History recall index is unavailable');
        tokens ??= row.tokens;
        if (row.prompt !== null) prompts.push({ entryId: id, text: row.prompt });
        id = row.parentId;
      }
      return { anchorId: current.leaf, prompts: prompts.reverse(), tokens };
    },
    async page(target, request) {
      await pending;
      const current = family(target);
      return pageSessionHistory({
        entry: id => entry(id, current.family),
        children(parentId, sequence, direction, limit) {
          const comparison = direction === 'before' ? '<' : '>';
          const order = direction === 'before' ? 'DESC' : 'ASC';
          return sql.exec<IndexedEntry>(`SELECT ${columns} FROM runtime_history_entries WHERE family=? AND parentId IS ? AND sequence ${comparison} ? ORDER BY sequence ${order} LIMIT ?`, current.family, parentId, sequence ?? (direction === 'before' ? Number.MAX_SAFE_INTEGER : -1), limit).toArray();
        },
      }, request, current.leaf);
    },
    async resolve(target, id) {
      await pending;
      const row = sql.exec<{ owner: number }>('SELECT owner FROM runtime_history_entries WHERE id=? AND family=?', id, family(target).family).toArray()[0];
      if (!row) throw new Error('History entry not found in this conversation family');
      const owner = (await conversationRecord(row.owner)).id;
      const record = await exactEntry(owner, numberId(id));
      return { conversationId: owner, entryId: record.id };
    },
  };
  return { service, refresh };
}
