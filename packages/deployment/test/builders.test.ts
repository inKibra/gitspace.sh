import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { stripJsonComments, workerMetadataFromWrangler } from '../src/index.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

describe('worker release metadata', () => {
  it('declares SQL storage for every durable class in the app release', async () => {
    const metadata = await workerMetadataFromWrangler(repositoryRoot);
    const bound = new Set(metadata.durableObjects.map((binding) => binding.className));
    const introduced = new Set(metadata.migrations.flatMap((migration) => migration.newSqliteClasses));
    expect(introduced).toEqual(bound);
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
