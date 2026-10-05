import { z } from 'zod';
export type HistoryDocument = { workspaceId: string; conversationId: string; ordinal: number; payload: Record<string, unknown>; createdAt: string };
export type HistorySql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]): Iterable<T> };
export class RuntimeHistoryIndex {
  constructor(private readonly sql: HistorySql) {
    sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS gitspace_history_fts USING fts5(key UNINDEXED, workspace_id UNINDEXED, conversation_id UNINDEXED, ordinal UNINDEXED, created_at UNINDEXED, payload UNINDEXED, text, tokenize=\'unicode61\')');
    sql.exec('CREATE TABLE IF NOT EXISTS gitspace_history_indexed (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  index(documents: readonly HistoryDocument[]) {
    for (const document of documents) {
      const key = `${document.workspaceId}:${document.conversationId}:${document.ordinal}`;
      const payload = JSON.stringify(document.payload);
      const existing = [...this.sql.exec<{ payload: string }>('SELECT payload FROM gitspace_history_indexed WHERE key=?', key)][0];
      if (existing?.payload === payload) continue;
      this.sql.exec('DELETE FROM gitspace_history_fts WHERE key=?', key);
      this.sql.exec('INSERT INTO gitspace_history_fts(key,workspace_id,conversation_id,ordinal,created_at,payload,text) VALUES(?,?,?,?,?,?,?)', key, document.workspaceId, document.conversationId, document.ordinal, document.createdAt, payload, searchableText(document.payload));
      this.sql.exec('INSERT INTO gitspace_history_indexed(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload', key, payload);
    }
  }
  async search(query: string, workspaceIds: readonly string[], judge: (state: string, questions: Record<string, string>) => Promise<Record<string, number>>, limit = 20) {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length || !workspaceIds.length) return [];
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = [...this.sql.exec<{ workspace_id: string; conversation_id: string; ordinal: number; created_at: string; payload: string; text: string; rank: number }>(`SELECT workspace_id,conversation_id,ordinal,created_at,payload,text,bm25(gitspace_history_fts) AS rank FROM gitspace_history_fts WHERE gitspace_history_fts MATCH ? AND workspace_id IN (${workspaceIds.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`, expression, ...workspaceIds, Math.min(100, Math.max(limit * 3, 30)))];
    if (!rows.length) return [];
    const state = JSON.stringify({ query, candidates: rows.map((row, index) => ({ id: String(index), text: row.text.slice(0, 4000) })) });
    const questions = Object.fromEntries(rows.map((_row, index) => [String(index), `Does candidate ${index} contain information substantively relevant to the user's history query, rather than an incidental token match?`]));
    const scores = await judge(state, questions);
    return rows.flatMap((row, index) => (scores[String(index)] ?? 0) >= 0.7 ? [{ workspaceId: row.workspace_id, conversationId: row.conversation_id, ordinal: row.ordinal, createdAt: row.created_at, payload: z.record(z.string(), z.unknown()).parse(JSON.parse(row.payload)), relevance: scores[String(index)], rank: row.rank }] : []).slice(0, limit);
  }
}
function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(searchableText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['id', 'conversationId', 'taskId', 'requestId', 'attemptId', 'signature', 'ciphertext'].includes(key)).map(([, item]) => searchableText(item)).join('\n');
  return '';
}
