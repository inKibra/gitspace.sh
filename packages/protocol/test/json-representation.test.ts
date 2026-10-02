import { describe, expect, it } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { wire as rpcWire } from 'result-rpc';
import { z } from 'zod';
import { gitspaceContract, rpcErrors } from '../src/rpc-contract.js';
import { decodeJsonValue, encodeJsonValue, procedureJsonRepresentation } from '../src/json-representation.js';
import { completeJsonSchema, wire } from '../src/json-wire.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });

describe('RPC JSON representations', () => {
  it('compiles every advertised input, output and error schema with resolved references', () => {
    for (const path of gitspaceContract.procedures.keys()) {
      const representation = procedureJsonRepresentation(path);
      const input = ajv.compile(representation.inputSchema);
      expect(input([]), path).toBe(false);
      const output = ajv.compile(representation.outputSchema);
      expect(output({ $gitspace: 'wire', value: '[null]' }), path).toBe(true);
      const errors = ajv.compile(representation.errorsSchema);
      expect(errors({ _tag: 'undeclared', data: {} }), path).toBe(false);
    }
  }, 30_000);

  it('round trips rich values, tag collisions, graph identity, and property presence through actual JSON', () => {
    const shared = { value: 1 };
    const original = {
      date: new Date('2026-09-28T01:02:03.000Z'), integer: 12345678901234567890n,
      bytes: new Uint8Array([0, 128, 255]), buffer: new Uint16Array([0, 65535]).buffer,
      map: new Map<unknown, unknown>([[shared, new Set([undefined, -Infinity])]]), shared,
      values: [undefined, NaN, Infinity, -Infinity, -0], present: undefined,
      collision: { $gitspace: 'date', value: 'ordinary user content' },
    };
    const restored = decodeJsonValue(JSON.parse(JSON.stringify(encodeJsonValue(original)))) as typeof original;
    expect(restored).toEqual(original);
    expect([...restored.map.keys()][0]).toBe(restored.shared);
    expect(Object.hasOwn(restored, 'present')).toBe(true);
    expect(Object.hasOwn(restored, 'absent')).toBe(false);
    expect(Object.is(restored.values[4], -0)).toBe(true);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const restoredCycle = decodeJsonValue(JSON.parse(JSON.stringify(encodeJsonValue(cyclic)))) as typeof cyclic;
    expect(restoredCycle.self).toBe(restoredCycle);
  });

  it('rejects malformed tags instead of treating them as ordinary user objects', () => {
    expect(() => decodeJsonValue({ $gitspace: 'unknown', value: 'x' })).toThrow();
    expect(() => decodeJsonValue({ $gitspace: 'undefined', value: null })).toThrow();
    expect(() => decodeJsonValue({ $gitspace: 'date', value: 'not a date' })).toThrow();
    expect(() => decodeJsonValue({ $gitspace: 'wire', value: 'invalid serialized data' })).toThrow();
    expect(() => encodeJsonValue({ callback: () => undefined })).toThrow();
  });

  it('preserves guarded normalization/default semantics while retaining original wire fingerprints', () => {
    const schema = z.object({ label: z.string().trim().min(1).max(3), enabled: z.boolean().default(true), optional: z.string().optional() });
    const guard = (value: unknown): value is z.infer<typeof schema> => schema.safeParse(value).success;
    const original = rpcWire.serializable(guard, { id: 'regression/guard' });
    const represented = wire.serializable(guard, { id: 'regression/guard', jsonSchema: schema });
    const value = { label: '  abc  ', optional: undefined, retained: 'unknown property' };
    const encoded = represented.encode(value as unknown as z.infer<typeof schema>);
    expect(encoded).toEqual(original.encode(value as unknown as z.infer<typeof schema>));
    expect(represented.schema).toBe(original.schema);
    if (!encoded.ok) throw new Error('Expected the guard to accept its original input');
    expect(encoded.value).toBe(value);
    const json = encodeJsonValue(encoded.value);
    expect(ajv.compile(completeJsonSchema(represented))(json)).toBe(true);
    const restored = represented.decode(decodeJsonValue(json));
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Expected JSON round trip to remain valid');
    expect(restored.value.label).toBe('  abc  ');
    expect(Object.hasOwn(restored.value, 'enabled')).toBe(false);
    expect(Object.hasOwn(restored.value, 'optional')).toBe(true);
    expect(restored.value).toHaveProperty('retained', 'unknown property');
    const invalid = { label: '' };
    expect(represented.decode(invalid).ok).toBe(false);
  });

  it('uses original custom validation after JSON decoding rather than trusting descriptive schemas', () => {
    const representation = procedureJsonRepresentation('inference.create');
    const valid = { name: '  Profile  ', sourceProfileId: null };
    expect(ajv.compile(representation.inputSchema)(valid)).toBe(true);
    expect(representation.decodeInput(valid)).toEqual(valid);
    expect(() => representation.decodeInput({ ...valid, name: '   ' })).toThrow();
    expect(() => representation.decodeInput({ ...valid, unexpected: true })).toThrow();
  });

  it('composes stream custom validators with Date and opaque payload representations', () => {
    const representation = procedureJsonRepresentation('events');
    const value = {
      type: 'snapshot', resource: 'project/example', cursor: 1, revision: 1, previous: null,
      value: {
        offset: 1, eventId: 'event', projectId: 'project', scope: 'project', entity: 'example', entityId: 'one', revision: 1,
        operation: 'updated', createdAt: new Date('2026-09-28T00:00:00.000Z'),
        payload: { bytes: new Uint8Array([1, 2]), count: 9n, optional: undefined },
      },
    };
    const encoded = representation.encodeOutput(value);
    expect(ajv.compile(representation.outputSchema)(encoded)).toBe(true);
    expect(decodeJsonValue(JSON.parse(JSON.stringify(encoded)))).toEqual(value);
    expect(() => representation.encodeOutput({ ...value, cursor: -1 })).toThrow();
  });

  it('preserves declared failure data without exporting Error causes', () => {
    const representation = procedureJsonRepresentation('events');
    const error = rpcErrors.projectNotFound({ projectId: 'missing' });
    const encoded = representation.encodeError(error);
    expect(encoded).toEqual({ _tag: error._tag, data: { projectId: 'missing' } });
    expect(ajv.compile(representation.errorsSchema)(encoded)).toBe(true);
    expect(() => representation.encodeError(new Error('private failure'))).toThrow();
  });
});
