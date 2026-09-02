import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { stripJsonComments, workerMetadataFromWrangler } from '../src/index.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

describe('worker release metadata', () => {
  it('derives the upload metadata from the real wrangler.jsonc', async () => {
    const metadata = await workerMetadataFromWrangler(repositoryRoot);
    expect(metadata.mainModule).toBe('worker.mjs');
    expect(metadata.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(metadata.compatibilityFlags).toContain('nodejs_compat');
    expect(metadata.durableObjects).toContainEqual({ name: 'CREDENTIALS', className: 'CredentialVaultDO' });
    expect(metadata.migrations[0]).toEqual({ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'] });
    // Every migration tag introduces classes that are bound; the platform replays them in order.
    const bound = new Set(metadata.durableObjects.map((binding) => binding.className));
    for (const migration of metadata.migrations) {
      for (const className of migration.newSqliteClasses) expect(bound.has(className)).toBe(true);
    }
  });

  it('strips comments outside string literals and trailing commas', () => {
    const source = `{
      // line comment
      "url": "http://x/y", /* block */ "flags": ["a", "b",],
      "note": "keeps // this and /* this */",
    }`;
    expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'http://x/y', flags: ['a', 'b'], note: 'keeps // this and /* this */' });
  });
});
