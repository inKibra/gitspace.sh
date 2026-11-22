import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AnyWireCodec } from 'result-rpc';
import { z } from 'zod';
import { gitspaceContract } from '../src/rpc-contract.js';
import { decodeJsonValue, encodeJsonValue } from '../src/json-representation.js';
import { codecJsonSchema, completeJsonSchema, wire, withJsonSchema } from '../src/json-wire.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const builder = fileURLToPath(new URL('./json-schema-names.ts', import.meta.url));

async function build(order: string): Promise<Record<string, string>> {
  const child = Bun.spawn(['bun', builder, order], { stdout: 'pipe', stderr: 'pipe' });
  const [text, failure, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${order} build failed: ${failure}`);
  const schemas: Record<string, string> = JSON.parse(text);
  return schemas;
}

function definitionName(codec: AnyWireCodec): string {
  const { $ref } = codecJsonSchema(codec);
  if (typeof $ref !== 'string') throw new Error('Expected a definition reference');
  return $ref;
}

interface Node { label: string; children: Node[] }

/** A tree and forest that refer to each other only through custom representations, so the cycle crosses definitions. */
function treeAndForest(id: string, extra: z.ZodType): { tree: AnyWireCodec; forest: AnyWireCodec } {
  const codecs: { tree?: AnyWireCodec; forest?: AnyWireCodec } = {};
  const forestReference = withJsonSchema(z.custom<unknown>(() => true), () => codecJsonSchema(codecs.forest!));
  const treeReference = withJsonSchema(z.custom<unknown>(() => true), () => codecJsonSchema(codecs.tree!));
  const tree = wire.standard(z.object({ label: z.string(), forest: forestReference }), { id: `${id}/tree` });
  const forest = wire.standard(z.object({ trees: z.array(treeReference), extra }), { id: `${id}/forest` });
  codecs.tree = tree;
  codecs.forest = forest;
  return { tree, forest };
}

describe('JSON schema definition names', () => {
  it('gives every procedure the same complete schema whatever order or subset built it', async () => {
    const [forward, reversed, pair] = await Promise.all([build('forward'), build('reversed'), build('pair')]);
    expect(Object.keys(forward).length).toBe(gitspaceContract.procedures.size);
    for (const [path, schema] of Object.entries(forward)) expect(reversed[path], path).toBe(schema);
    expect(Object.keys(pair).sort()).toEqual(['inspector.view', 'space.view']);
    for (const [path, schema] of Object.entries(pair)) expect(schema, path).toBe(forward[path]!);
    expect(forward['inspector.view']).toMatch(/"#\/\$defs\/gitspaceZod_[0-9a-f]{12}"/);
    expect(Object.values(forward).join('')).not.toContain('gitspacePending');
  }, 120_000);

  it('names a definition by its content', () => {
    const label = wire.standard(z.object({ label: z.string() }), { id: 'names/label' });
    const sameLabel = wire.standard(z.object({ label: z.string() }), { id: 'names/same-label' });
    const numberLabel = wire.standard(z.object({ label: z.number() }), { id: 'names/number-label' });
    expect(definitionName(label)).toMatch(/^#\/\$defs\/gitspaceZod_[0-9a-f]{12}$/);
    expect(definitionName(sameLabel)).toBe(definitionName(label));
    expect(definitionName(numberLabel)).not.toBe(definitionName(label));
  });

  it('names and round trips a self-recursive schema', () => {
    const node: z.ZodType<Node> = z.object({ label: z.string(), children: z.array(z.lazy(() => node)) });
    const sameNode: z.ZodType<Node> = z.object({ label: z.string(), children: z.array(z.lazy(() => sameNode)) });
    const numberNode: z.ZodType<unknown> = z.object({ label: z.number(), children: z.array(z.lazy(() => numberNode)) });
    const codec = wire.standard(node, { id: 'names/node' });
    expect(definitionName(wire.standard(sameNode, { id: 'names/same-node' }))).toBe(definitionName(codec));
    expect(definitionName(wire.standard(numberNode, { id: 'names/number-node' }))).not.toBe(definitionName(codec));
    const validate = ajv.compile(completeJsonSchema(codec));
    const value = { label: 'root', children: [{ label: 'leaf', children: [] }] };
    const json = JSON.parse(JSON.stringify(encodeJsonValue(value)));
    expect(validate(json)).toBe(true);
    expect(validate({ label: 'root', children: [{ label: 1, children: [] }] })).toBe(false);
    expect(codec.decode(decodeJsonValue(json))).toEqual({ ok: true, value });
  });

  it('names mutually recursive definitions by the whole cycle and round trips them', () => {
    const first = treeAndForest('names/first', z.string());
    const same = treeAndForest('names/same', z.string());
    const changed = treeAndForest('names/changed', z.number());
    expect(definitionName(same.tree)).toBe(definitionName(first.tree));
    expect(definitionName(same.forest)).toBe(definitionName(first.forest));
    expect(definitionName(first.forest)).not.toBe(definitionName(first.tree));
    // The changed tree's own fields are identical; only the forest it reaches differs.
    expect(definitionName(changed.tree)).not.toBe(definitionName(first.tree));
    expect(definitionName(changed.forest)).not.toBe(definitionName(first.forest));
    const validate = ajv.compile(completeJsonSchema(first.tree));
    const value = { label: 'root', forest: { trees: [{ label: 'leaf', forest: { trees: [], extra: 'inner' } }], extra: 'outer' } };
    const json = JSON.parse(JSON.stringify(encodeJsonValue(value)));
    expect(validate(json)).toBe(true);
    expect(validate({ ...value, forest: { trees: [{ label: 'leaf', forest: { trees: [], extra: 1 } }], extra: 'outer' } })).toBe(false);
    expect(first.tree.decode(decodeJsonValue(json))).toEqual({ ok: true, value });
  });
});
