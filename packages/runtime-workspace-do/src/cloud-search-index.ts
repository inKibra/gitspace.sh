import type { ArtifactsCodeStore } from './artifacts.js';
import { contentTrigrams, searchLiteralTrigrams, searchOrderedFiles, type SearchArguments, type SearchFile } from '../../protocol-runtime/src/search.js';
import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';

export type CloudSearchSource = Pick<ArtifactsCodeStore, 'listSnapshotEntries' | 'readBlob'>;
type IndexedFile = { path: string };

/** One current index, resumable file-sized updates. A commit marker is written only after all entries reconcile. */
export class CloudSearchIndex {
  private updating: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage, private readonly source: CloudSearchSource, private readonly repository: string) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_search_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), commit_id TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_search_files(path TEXT PRIMARY KEY, oid TEXT NOT NULL, binary INTEGER NOT NULL, indexed INTEGER NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_search_chunks(path TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(path,ordinal)) WITHOUT ROWID');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_search_trigrams(gram TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(gram,path)) WITHOUT ROWID');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS runtime_search_trigrams_path ON runtime_search_trigrams(path)');
  }
  update(checkpoint: Pick<RuntimeGitCheckpoint, 'worktreeCommit' | 'worktreeTree'>): Promise<void> {
    const update = this.updating.then(() => this.reconcile(checkpoint));
    this.updating = update.catch(() => {});
    return update;
  }
  private async reconcile(checkpoint: Pick<RuntimeGitCheckpoint, 'worktreeCommit' | 'worktreeTree'>): Promise<void> {
    if (this.storage.sql.exec<{ commit_id: string }>('SELECT commit_id FROM runtime_search_state WHERE singleton=1').toArray()[0]?.commit_id === checkpoint.worktreeCommit) return;
    // A partially reconciled index must never advertise its predecessor as readable.
    this.storage.sql.exec('DELETE FROM runtime_search_state');
    const entries = await this.source.listSnapshotEntries(this.repository, checkpoint.worktreeTree);
    const existing = new Map(this.storage.sql.exec<{ path: string; oid: string }>('SELECT path,oid FROM runtime_search_files').toArray().map(row => [row.path, row.oid]));
    for (const [path, entry] of entries) {
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) continue;
      const old = existing.get(path); existing.delete(path);
      if (old === entry.oid) continue;
      const blob = await this.source.readBlob(this.repository, entry.oid);
      if (!blob) throw new Error(`Missing search blob ${entry.oid}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // Rust string regex and ripgrep both search UTF-8. Invalid sequences use the same replacement decoding.
      const content = bytes.includes(0) ? null : new TextDecoder().decode(bytes);
      const grams = content === null ? [] : contentTrigrams(content, 8192);
      const indexed = grams.length <= 8192;
      this.storage.transactionSync(() => {
        this.storage.sql.exec('DELETE FROM runtime_search_trigrams WHERE path=?', path);
        this.storage.sql.exec('DELETE FROM runtime_search_chunks WHERE path=?', path);
        this.storage.sql.exec('INSERT OR REPLACE INTO runtime_search_files(path,oid,binary,indexed) VALUES(?,?,?,?)', path, entry.oid, content === null ? 1 : 0, indexed ? 1 : 0);
        if (content !== null) {
          // UTF-16 chunks stay below 512 KiB encoded, comfortably under the DO SQLite row limit.
          for (let offset = 0, ordinal = 0; offset < content.length; ordinal++) {
            let end = Math.min(content.length, offset + 128 * 1024);
            const last = content.charCodeAt(end - 1);
            if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
            this.storage.sql.exec('INSERT INTO runtime_search_chunks(path,ordinal,content) VALUES(?,?,?)', path, ordinal, content.slice(offset, end));
            offset = end;
          }
          // High-entropy files retain their complete searchable content, but cap posting amplification.
          if (indexed) for (let offset = 0; offset < grams.length; offset += 32) {
            const batch = grams.slice(offset, offset + 32);
            this.storage.sql.exec(`INSERT INTO runtime_search_trigrams(gram,path) VALUES ${batch.map(() => '(?,?)').join(',')}`, ...batch.flatMap(gram => [gram, path]));
          }
        }
      });
    }
    for (const path of existing.keys()) this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM runtime_search_trigrams WHERE path=?', path);
      this.storage.sql.exec('DELETE FROM runtime_search_chunks WHERE path=?', path);
      this.storage.sql.exec('DELETE FROM runtime_search_files WHERE path=?', path);
    });
    this.storage.sql.exec('INSERT OR REPLACE INTO runtime_search_state(singleton,commit_id) VALUES(1,?)', checkpoint.worktreeCommit);
    await this.storage.sync();
  }
  search(args: SearchArguments) {
    if (!this.storage.sql.exec('SELECT commit_id FROM runtime_search_state WHERE singleton=1').toArray().length) throw new Error('Canonical search index is not materialized');
    const grams = searchLiteralTrigrams(args).slice(0, 32);
    const rows = grams.length
      ? this.storage.sql.exec<IndexedFile>(`SELECT path FROM runtime_search_files WHERE binary=0 AND indexed=0 UNION SELECT path FROM runtime_search_trigrams WHERE gram IN (${grams.map(() => '?').join(',')}) GROUP BY path HAVING COUNT(*)=? ORDER BY path`, ...grams, grams.length)
      : this.storage.sql.exec<IndexedFile>('SELECT path FROM runtime_search_files WHERE binary=0 ORDER BY path');
    const content = (path: string) => this.storage.sql.exec<{ content: string }>('SELECT content FROM runtime_search_chunks WHERE path=? ORDER BY ordinal', path).toArray().map(row => row.content).join('');
    const ignores = this.storage.sql.exec<IndexedFile>("SELECT path FROM runtime_search_files WHERE binary=0 AND (path IN ('.gitignore','.ignore') OR path LIKE '%/.gitignore' OR path LIKE '%/.ignore')").toArray().map(row => ({ path: row.path, content: content(row.path) }));
    function* candidates(): Generator<SearchFile> { for (const row of rows) yield { path: row.path, content: content(row.path) }; }
    return searchOrderedFiles(candidates(), args, ignores);
  }
}
