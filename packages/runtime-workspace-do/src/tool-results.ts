import { utf8ByteLength } from '@earendil-works/chord/output';
import type { ToolResultKey, ToolResultStore } from '@gitspace/runtime-core';
import { toolResultReference, type RuntimeToolResultRequest } from '@gitspace/protocol-runtime';
import { createSearchMatcher, searchMatchingLines } from '../../protocol-runtime/src/search.js';
import { textPage } from './cloud-files.js';

/** UTF-16 code units per stored page: about 512 KB of text, at most 1.5 MB of UTF-8, under a Durable Object's 2 MB row. */
const PAGE_CHARACTERS = 512 * 1024;

/** The workspace's kept tool outputs, which `read` and `grep` page and search as `result://` paths. */
export type WorkspaceToolResults = ToolResultStore & {
  /** A `read` of a kept output, its lines paged as a file's (one-based offset and limit, one page without a limit), or a
   * `grep`, the lines its pattern matches as `line:content`, paged by its offset and limit. */
  answer(key: ToolResultKey, request: RuntimeToolResultRequest): Promise<string>;
};

/**
 * Tool outputs longer than the transcript keeps, in two tables of the workspace object's SQLite that no turn's context
 * reads: a row per call, keyed by conversation and call so a rerun replaces its earlier attempt's, and its text in
 * pages. Past `maxWorkspaceBytes` the oldest results are pruned as a result is written; a pruned result keeps its row,
 * so its reference says it was pruned.
 */
export function createToolResultStore(sql: SqlStorage, workspaceId: string, maxWorkspaceBytes: number): WorkspaceToolResults {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_tool_results(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, call_id TEXT NOT NULL, bytes INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id, call_id))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_tool_result_pages(result_id INTEGER NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(result_id, page))');
  const reference = (key: ToolResultKey) => toolResultReference({ workspaceId, ...key });
  async function text(key: ToolResultKey): Promise<string> {
    const row = sql.exec<{ id: number; pruned: number }>('SELECT id,pruned FROM runtime_tool_results WHERE conversation_id=? AND call_id=?', key.conversationId, key.callId).toArray()[0];
    if (!row) throw new Error(`${reference(key)} names no kept tool output`);
    if (row.pruned) throw new Error(`${reference(key)} was pruned: a workspace keeps ${maxWorkspaceBytes / 1024 / 1024} MB of long tool outputs, and newer ones replaced it. Run the call again for its output.`);
    return sql.exec<{ text: string }>('SELECT text FROM runtime_tool_result_pages WHERE result_id=? ORDER BY page', row.id).toArray().map(page => page.text).join('');
  }
  return {
    // Every statement runs without an await between them, so the object commits the write and its pruning together.
    async put(input) {
      const previous = sql.exec<{ id: number }>('SELECT id FROM runtime_tool_results WHERE conversation_id=? AND call_id=?', input.conversationId, input.callId).toArray()[0];
      if (previous) {
        sql.exec('DELETE FROM runtime_tool_result_pages WHERE result_id=?', previous.id);
        sql.exec('DELETE FROM runtime_tool_results WHERE id=?', previous.id);
      }
      const bytes = utf8ByteLength(input.text);
      const id = sql.exec<{ id: number }>('INSERT INTO runtime_tool_results(conversation_id,call_id,bytes) VALUES(?,?,?) RETURNING id', input.conversationId, input.callId, bytes).toArray()[0]?.id;
      if (id === undefined) throw new Error('Kept tool output was not stored');
      for (let start = 0, page = 0; start < input.text.length; page++) {
        let end = Math.min(start + PAGE_CHARACTERS, input.text.length);
        // A page never ends between the halves of a surrogate pair.
        const last = input.text.charCodeAt(end - 1);
        if (end < input.text.length && last >= 0xd800 && last <= 0xdbff) end--;
        sql.exec('INSERT INTO runtime_tool_result_pages(result_id,page,text) VALUES(?,?,?)', id, page, input.text.slice(start, end));
        start = end;
      }
      let total = sql.exec<{ total: number | null }>('SELECT SUM(bytes) AS total FROM runtime_tool_results WHERE pruned=0').toArray()[0]?.total ?? 0;
      if (total > maxWorkspaceBytes) {
        for (const oldest of sql.exec<{ id: number; bytes: number }>('SELECT id,bytes FROM runtime_tool_results WHERE pruned=0 AND id<>? ORDER BY id', id).toArray()) {
          if (total <= maxWorkspaceBytes) break;
          sql.exec('DELETE FROM runtime_tool_result_pages WHERE result_id=?', oldest.id);
          sql.exec('UPDATE runtime_tool_results SET pruned=1 WHERE id=?', oldest.id);
          total -= oldest.bytes;
        }
      }
      return reference(input);
    },
    text,
    async answer(key, request) {
      const whole = await text(key);
      if (request.tool === 'read') return textPage(whole, request.args.offset, request.args.limit);
      const { args, regex } = createSearchMatcher(request.args);
      try {
        const lines: string[] = [];
        let matched = 0;
        for (const { line, text: content } of searchMatchingLines(regex, args.multiline, whole)) {
          if (matched++ < args.offset) continue;
          if (lines.length === args.limit) return `${lines.join('\n')}\n[More matches: grep again with offset ${args.offset + args.limit}]`;
          lines.push(`${line + 1}:${content}`);
        }
        return lines.join('\n');
      } finally { regex.free(); }
    },
  };
}
