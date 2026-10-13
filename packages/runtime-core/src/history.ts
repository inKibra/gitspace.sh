import { createHash } from 'node:crypto';
export type HistoryDocument = { workspaceId: string; conversationId: string; ordinal: number; payload: Record<string, unknown>; createdAt: string };
export type HistorySql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]): Iterable<T> };
type HistoryMatch = { key: string; workspace_id: string; conversation_id: string; ordinal: number; created_at: string; text: string; rank: number };
const fragmentCharacters = 16_384;

export class RuntimeHistoryIndex {
  constructor(private readonly sql: HistorySql) {
    // This is a rebuildable application index, not Pi-owned history. The old index
    // duplicated whole payloads into rows that cannot fit large imported events.
    sql.exec('DROP TABLE IF EXISTS gitspace_history_fts');
    sql.exec('DROP TABLE IF EXISTS gitspace_history_indexed');
    sql.exec('CREATE TABLE IF NOT EXISTS gitspace_history_events (key TEXT PRIMARY KEY, digest TEXT NOT NULL, characters INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS gitspace_history_payload_parts (key TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(key,part))');
    sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS gitspace_history_fragments USING fts5(key UNINDEXED, workspace_id UNINDEXED, conversation_id UNINDEXED, ordinal UNINDEXED, created_at UNINDEXED, text, tokenize='unicode61')");
  }
  index(documents: readonly HistoryDocument[]) {
    for (const document of documents) {
      const key = JSON.stringify([document.workspaceId, document.conversationId, document.ordinal]);
      const payload = JSON.stringify(document.payload);
      const digest = createHash('sha256').update(payload).digest('hex');
      const existing = [...this.sql.exec<{ digest: string }>('SELECT digest FROM gitspace_history_events WHERE key=?', key)][0];
      if (existing?.digest === digest) continue;
      this.sql.exec('DELETE FROM gitspace_history_events WHERE key=?', key);
      this.sql.exec('DELETE FROM gitspace_history_fragments WHERE key=?', key);
      this.sql.exec('DELETE FROM gitspace_history_payload_parts WHERE key=?', key);
      let part = 0;
      for (const text of fragments(payload)) this.sql.exec('INSERT INTO gitspace_history_payload_parts(key,part,text) VALUES(?,?,?)', key, part++, text);
      for (const text of fragments(searchableText(document.payload), true)) {
        this.sql.exec('INSERT INTO gitspace_history_fragments(key,workspace_id,conversation_id,ordinal,created_at,text) VALUES(?,?,?,?,?,?)', key, document.workspaceId, document.conversationId, document.ordinal, document.createdAt, text);
      }
      // Publish only after all fragments exist; interrupted rebuilds are invisible.
      this.sql.exec('INSERT INTO gitspace_history_events(key,digest,characters) VALUES(?,?,?)', key, digest, payload.length);
    }
  }
  /** Exact serialized payload, fetched one bounded fragment at a time. */
  *content(workspaceId: string, conversationId: string, ordinal: number): Generator<string> {
    const key = JSON.stringify([workspaceId, conversationId, ordinal]);
    if (![...this.sql.exec('SELECT key FROM gitspace_history_events WHERE key=?', key)].length) throw new Error('History content is not indexed');
    for (const row of this.sql.exec<{ text: string }>('SELECT text FROM gitspace_history_payload_parts WHERE key=? ORDER BY part', key)) yield row.text;
  }
  async search(query: string, workspaceIds: readonly string[], judge: (state: string, questions: Record<string, string>) => Promise<Record<string, number>>, limit = 20) {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length || !workspaceIds.length) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const candidates: HistoryMatch[] = [];
    const seen = new Set<string>();
    // Deduplicate before the candidate limit, so one long event cannot crowd out
    // every other conversation merely because it has many matching fragments.
    for (const row of this.sql.exec<HistoryMatch>(`SELECT key,workspace_id,conversation_id,ordinal,created_at,snippet(gitspace_history_fragments,5,'','',' … ',64) AS text,rank FROM gitspace_history_fragments WHERE gitspace_history_fragments MATCH ? AND workspace_id IN (${workspaceIds.map(() => '?').join(',')}) AND key IN (SELECT key FROM gitspace_history_events) ORDER BY rank`, expression, ...workspaceIds)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      candidates.push({ ...row, text: row.text.slice(0, 4000) });
      if (candidates.length >= Math.min(100, Math.max(limit * 3, 30))) break;
    }
    if (!candidates.length) return [];
    const state = JSON.stringify({ query, candidates: candidates.map((row, index) => ({ id: String(index), text: row.text })) });
    const questions = Object.fromEntries(candidates.map((_row, index) => [String(index), `Does candidate ${index} contain information substantively relevant to the user's history query, rather than an incidental token match?`]));
    const scores = await judge(state, questions);
    return candidates.flatMap((row, index) => (scores[String(index)] ?? 0) >= 0.7 ? [{ workspaceId: row.workspace_id, conversationId: row.conversation_id, ordinal: row.ordinal, createdAt: row.created_at, snippet: row.text, content: { mode: 'content' as const, workspaceId: row.workspace_id, conversationId: row.conversation_id, ordinal: Number(row.ordinal), contentOffset: 0 }, relevance: scores[String(index)], rank: row.rank }] : []).slice(0, limit);
  }
}

function* fragments(text: string, preserveWords = false): Generator<string> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + fragmentCharacters, text.length);
    // SQLite stores UTF-8, so never persist half of a surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    if (preserveWords && end < text.length) {
      let boundary = end;
      while (boundary > offset && /[\p{L}\p{N}\p{M}_]/u.test(text[boundary - 1]!) && /[\p{L}\p{N}\p{M}_]/u.test(text[boundary]!)) boundary--;
      if (boundary > offset) end = boundary;
    }
    yield text.slice(offset, end);
    offset = end;
  }
}
function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(searchableText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['id', 'conversationId', 'taskId', 'requestId', 'attemptId', 'signature', 'ciphertext'].includes(key)).map(([, item]) => searchableText(item)).join('\n');
  return '';
}
