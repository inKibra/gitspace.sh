import { deserialize, serialize } from 'result-rpc';

export type JsonSchema = Record<string, unknown>;
const marker = '$gitspace';
const richRef = { $ref: '#/$defs/gitspaceJsonValue' };

function taggedSchema(tag: string, value?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: { [marker]: { const: tag }, ...(value ? { value } : {}) },
    required: value ? [marker, 'value'] : [marker],
    additionalProperties: false,
  };
}

export const undefinedJsonSchema = taggedSchema('undefined');
export const dateJsonSchema = taggedSchema('date', { type: 'string', format: 'date-time' });
export const bigintJsonSchema = taggedSchema('bigint', { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' });
export const specialNumberJsonSchema = taggedSchema('number', { enum: ['NaN', 'Infinity', '-Infinity', '-0'] });
export const wireValueJsonSchema = {
  ...taggedSchema('wire', { type: 'string' }),
  description: 'A result-rpc v1 serialized rich value. Used for binary, Map, Set, RegExp, URL, Temporal, shared/cyclic graphs, and escaping ordinary objects with a $gitspace key. Decoded values must still satisfy the procedure codec.',
};
export const richJsonSchema: JsonSchema = richRef;
export const richObjectJsonSchema: JsonSchema = {
  anyOf: [
    { type: 'object', properties: { [marker]: false }, additionalProperties: richRef },
    wireValueJsonSchema,
  ],
};
export const richJsonDefinitions: Record<string, JsonSchema> = {
  gitspaceJsonValue: {
    description: 'JSON values retain their shape. Rich values use $gitspace tagged objects. Present undefined is distinct from an omitted property; objects containing $gitspace are escaped in a wire envelope.',
    anyOf: [
      { type: ['null', 'boolean', 'string', 'number'] },
      { type: 'array', items: richRef },
      { type: 'object', properties: { [marker]: false }, additionalProperties: richRef },
      undefinedJsonSchema, dateJsonSchema, bigintJsonSchema, specialNumberJsonSchema, wireValueJsonSchema,
    ],
  },
};

function wireEnvelope(value: unknown): unknown {
  const result = serialize(value);
  if (!result.ok) throw new TypeError(`Cannot represent RPC value as JSON: ${result.message}`);
  return { [marker]: 'wire', value: result.value };
}

/**
 * Collision-safe JSON projection. Ordinary JSON stays readable. Date/bigint/
 * undefined/nonfinite numbers have explicit tags; other serializer-supported
 * values and reserved-key objects use a result-rpc v1 string envelope. A shared
 * or cyclic graph uses one envelope, retaining graph identity and array holes.
 * Unsupported values fail rather than being silently dropped by JSON.stringify.
 */
export function encodeJsonValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const graph = Symbol('shared graph');
  function observeGraph(input: unknown): void {
    if (input === null || typeof input !== 'object') return;
    if (seen.has(input)) throw graph;
    seen.add(input);
    observeChildren(input);
  }
  function observeChildren(input: object): void {
    if (input instanceof Map) {
      for (const [key, entry] of input) { observeGraph(key); observeGraph(entry); }
    } else if (input instanceof Set) {
      for (const entry of input) observeGraph(entry);
    } else if (ArrayBuffer.isView(input)) {
      observeGraph(input.buffer);
    } else {
      for (const entry of Object.values(input)) observeGraph(entry);
    }
  }
  function encode(input: unknown): unknown {
    if (input === undefined) return { [marker]: 'undefined' };
    if (typeof input === 'bigint') return { [marker]: 'bigint', value: input.toString() };
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)) return { [marker]: 'number', value: Object.is(input, -0) ? '-0' : String(input) };
      return input;
    }
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') throw new TypeError(`Unsupported RPC JSON value: ${typeof input}`);
    if (seen.has(input)) throw graph;
    seen.add(input);
    if (input instanceof Date) {
      if (Number.isNaN(input.getTime())) throw new TypeError('Cannot represent an invalid Date');
      return { [marker]: 'date', value: input.toISOString() };
    }
    if (Array.isArray(input)) {
      if (Object.keys(input).length !== input.length) {
        observeChildren(input);
        return wireEnvelope(input);
      }
      return input.map(encode);
    }
    const prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(input, marker)) {
      observeChildren(input);
      return wireEnvelope(input);
    }
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, encode(entry)]));
  }
  try { return encode(value); } catch (error) {
    if (error === graph) return wireEnvelope(value);
    throw error;
  }
}

/** Inverse of encodeJsonValue; malformed or unknown envelopes are rejected. */
export function decodeJsonValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function decode(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null) throw new TypeError('Expected a JSON value');
    if (seen.has(input)) throw new TypeError('Expected an acyclic JSON value');
    seen.add(input);
    if (Array.isArray(input)) return input.map(decode);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected a JSON object');
    const object = input as Record<string, unknown>;
    if (!Object.hasOwn(object, marker)) return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, decode(entry)]));
    const tag = object[marker];
    if (Object.keys(object).length !== (tag === 'undefined' ? 1 : 2) || (tag !== 'undefined' && !Object.hasOwn(object, 'value'))) throw new TypeError('Malformed RPC JSON envelope');
    const payload = object.value;
    if (tag === 'undefined') return undefined;
    if (typeof payload !== 'string') throw new TypeError('Expected a string RPC JSON envelope value');
    switch (tag) {
      case 'date': {
        const date = new Date(payload);
        if (Number.isNaN(date.getTime()) || date.toISOString() !== payload) throw new TypeError('Expected a canonical ISO Date');
        return date;
      }
      case 'bigint':
        if (!/^-?(0|[1-9][0-9]*)$/u.test(payload)) throw new TypeError('Expected a decimal bigint');
        return BigInt(payload);
      case 'number':
        switch (payload) {
          case 'NaN': return NaN;
          case 'Infinity': return Infinity;
          case '-Infinity': return -Infinity;
          case '-0': return -0;
          default: throw new TypeError('Unknown special number');
        }
      case 'wire': {
        const result = deserialize(payload);
        if (!result.ok) throw new TypeError(`Invalid serialized RPC value: ${result.message}`);
        return result.value;
      }
      default: throw new TypeError('Unknown RPC JSON envelope');
    }
  }
  return decode(value);
}
