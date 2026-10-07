import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { CloudSearchIndex } from '../src/cloud-search-index.js';

export class CloudSearchProof extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    await this.ctx.storage.deleteAll();
    const benchmark = new URL(request.url).searchParams.has('benchmark');
    const count = benchmark ? 10000 : 120;
    const contents = new Map<string, string>();
    let reads = 0;
    const entries = new Map<string, { oid: string; mode: string; type: 'blob' }>();
    for (let n = 0; n < count; n++) {
      const content = `export const item${n} = '${'ordinary '.repeat(64)}';\n${n === 42 ? 'uniqueNeedle' : 'ordinary'}\n`;
      const oid = n.toString(16).padStart(40, '0');
      entries.set(`src/file${String(n).padStart(5, '0')}.ts`, { oid, mode: '100644', type: 'blob' });
      contents.set(oid, content);
    }
    const contentBytes = [...contents.values()].reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0);
    const source = { listSnapshotEntries: async () => new Map(entries), readBlob: async (_repository: string, oid: string) => { reads++; const content = contents.get(oid); return content === undefined ? null : new Blob([content]); } };
    let index = new CloudSearchIndex(this.ctx.storage, source, 'workspace-proof');
    const start = performance.now();
    await index.update({ worktreeCommit: 'a'.repeat(40), worktreeTree: 'b'.repeat(40) });
    const initialMs = performance.now() - start;
    assert.equal(reads, count);
    const queryStart = performance.now();
    const first = index.search({ pattern: 'uniqueNeedle', path: '.' });
    const queryMs = performance.now() - queryStart;
    assert.equal(first.text, 'src/file00042.ts:2:uniqueNeedle');
    assert.equal(first.scannedFiles, 1);
    assert.equal(reads, count);
    entries.delete('src/file00042.ts');
    const changed = 'f'.repeat(40);
    entries.set('src/file00001.ts', { oid: changed, mode: '100644', type: 'blob' });
    contents.set(changed, 'replacementNeedle\n');
    const updateStart = performance.now();
    await index.update({ worktreeCommit: 'c'.repeat(40), worktreeTree: 'd'.repeat(40) });
    const updateMs = performance.now() - updateStart;
    assert.equal(reads, count + 1);
    index = new CloudSearchIndex(this.ctx.storage, source, 'workspace-proof');
    await index.update({ worktreeCommit: 'c'.repeat(40), worktreeTree: 'd'.repeat(40) });
    assert.equal(reads, count + 1);
    assert.equal(index.search({ pattern: 'uniqueNeedle', path: '.' }).text, '');
    assert.equal(index.search({ pattern: 'replacementNeedle', path: '.' }).text, 'src/file00001.ts:1:replacementNeedle');
    const measurement = { files: count, contentBytes, indexBytes: this.ctx.storage.sql.databaseSize, initialMs, updateMs, queryMs, changedBlobReads: reads - count, queryScannedFiles: first.scannedFiles };
    if (!benchmark) {
      const saved = 'e'.repeat(40), unavailable = '9'.repeat(40);
      entries.set('new/a.ts', { oid: saved, mode: '100644', type: 'blob' });
      entries.set('new/b.ts', { oid: unavailable, mode: '100644', type: 'blob' });
      contents.set(saved, 'recoveredNeedle\n');
      await assert.rejects(index.update({ worktreeCommit: 'e'.repeat(40), worktreeTree: 'e'.repeat(40) }));
      assert.throws(() => index.search({ pattern: 'replacementNeedle', path: '.' }), /not materialized/);
      const beforeRecovery = reads;
      contents.set(unavailable, 'recoveredNeedle\n');
      index = new CloudSearchIndex(this.ctx.storage, source, 'workspace-proof');
      await index.update({ worktreeCommit: 'e'.repeat(40), worktreeTree: 'e'.repeat(40) });
      assert.equal(reads - beforeRecovery, 1, 'Recovery must reuse files already indexed before interrupted publication');
      assert.equal(index.search({ pattern: 'recoveredNeedle', path: '.' }).text, 'new/a.ts:1:recoveredNeedle\nnew/b.ts:1:recoveredNeedle');
    }
    return Response.json({ passed: true, measurement });
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<CloudSearchProof> }) { return env.PROOF.get(env.PROOF.idFromName('proof')).fetch(request); } };
