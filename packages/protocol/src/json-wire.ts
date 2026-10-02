import { wire as rpcWire, type AnyWireCodec, type ExternalWireSchemaOptions, type WireGuard, type WireNamespace, type WireValue, type WireCodec } from 'result-rpc';
import { z } from 'zod';
import {
  bigintJsonSchema, dateJsonSchema, encodeJsonValue, richJsonDefinitions, richJsonSchema,
  richObjectJsonSchema, specialNumberJsonSchema, undefinedJsonSchema, wireValueJsonSchema,
  type JsonSchema,
} from './json-value.js';

const representations = new WeakMap<AnyWireCodec, () => JsonSchema>();
const schemaCache = new WeakMap<object, JsonSchema>();
const customZodRepresentations = new WeakMap<object, () => JsonSchema>();
const definitions: Record<string, JsonSchema> = { ...richJsonDefinitions };
let nextDefinition = 0;
const negativeZeroJsonSchema = {
  ...specialNumberJsonSchema,
  properties: { $gitspace: { const: 'number' }, value: { const: '-0' } },
};

/** Adds representation metadata without changing a custom Zod validator. */
export function withJsonSchema<T extends z.ZodType>(schema: T, representation: () => JsonSchema): T {
  customZodRepresentations.set(schema, representation);
  return schema;
}

/** Zod is descriptive here: only the original RPC guard validates/normalizes. */
function zodJsonSchema(schema: z.ZodType): JsonSchema {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const name = `gitspaceZod${nextDefinition++}`;
  const reference = { $ref: `#/$defs/${name}` };
  schemaCache.set(schema, reference);
  const output = z.toJSONSchema(schema, {
    io: 'input',
    // The override below supplies explicit representations for rich values and
    // rejects unsupported kinds; this is not a permissive unknown fallback.
    unrepresentable: 'any',
    reused: 'inline',
    cycles: 'ref',
    override: ({ zodSchema, jsonSchema }) => {
      const custom = customZodRepresentations.get(zodSchema);
      if (custom) {
        Object.assign(jsonSchema, custom());
        return;
      }
      const type = zodSchema._zod.def.type;
      switch (type) {
        case 'string':
          if (zodSchema._zod.def.type === 'string' && zodSchema._zod.def.checks?.some((check) => check._zod.def.check === 'overwrite')) {
            const normalized = { ...jsonSchema };
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as JsonSchema)[key];
            Object.assign(jsonSchema, {
              type: 'string',
              description: `Validated after Zod string normalization; RPC preserves the original string. Normalized constraints: ${JSON.stringify(normalized)}`,
            });
          }
          break;
        case 'number':
          if (z.safeParse(zodSchema, -0).success) {
            const number = { ...jsonSchema };
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as JsonSchema)[key];
            Object.assign(jsonSchema, { anyOf: [number, negativeZeroJsonSchema] });
          }
          break;
        case 'unknown': case 'any': Object.assign(jsonSchema, richJsonSchema); break;
        case 'date': Object.assign(jsonSchema, dateJsonSchema); break;
        case 'bigint': Object.assign(jsonSchema, bigintJsonSchema); break;
        case 'undefined': case 'void': Object.assign(jsonSchema, undefinedJsonSchema); break;
        case 'nan': Object.assign(jsonSchema, { ...specialNumberJsonSchema, properties: { $gitspace: { const: 'number' }, value: { const: 'NaN' } } }); break;
        case 'custom': case 'transform': case 'symbol': case 'function': case 'promise': case 'file':
          throw new TypeError(`Missing explicit JSON representation for Zod ${type}`);
        case 'map': case 'set': Object.assign(jsonSchema, wireValueJsonSchema); break;
        case 'object':
          // safeParse guards retain the original object, including keys Zod
          // would strip. Describe those keys instead of silently normalizing.
          if (zodSchema._zod.def.type === 'object' && !zodSchema._zod.def.catchall) {
            jsonSchema.additionalProperties = richJsonSchema;
            const object = { ...jsonSchema };
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as JsonSchema)[key];
            Object.assign(jsonSchema, { type: 'object', anyOf: [object, wireValueJsonSchema] });
          }
          break;
        case 'record':
          {
            const record = { ...jsonSchema };
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as JsonSchema)[key];
            Object.assign(jsonSchema, { type: 'object', anyOf: [record, wireValueJsonSchema] });
          }
          break;
        case 'optional': case 'default': case 'prefault':
          // Missing properties stay omitted; a present undefined has a tag.
          // Zod's input schema normally omits the undefined union member.
          {
            const inner = { ...jsonSchema };
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as JsonSchema)[key];
            Object.assign(jsonSchema, { anyOf: [inner, undefinedJsonSchema] });
          }
          break;
      }
    },
  }) as JsonSchema;
  delete output.$schema;
  // Zod-local refs must survive composition under structural wire codecs.
  function rebase(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(rebase); return; }
    const object = value as JsonSchema;
    if (typeof object.$ref === 'string' && object.$ref.startsWith('#') && !object.$ref.startsWith('#/$defs/gitspace')) {
      object.$ref = `#/$defs/${name}${object.$ref.slice(1)}`;
    }
    Object.values(object).forEach(rebase);
  }
  rebase(output);
  definitions[name] = output;
  return reference;
}

function retain<T extends AnyWireCodec>(codec: T, schema: () => JsonSchema): T {
  representations.set(codec, schema);
  return codec;
}

/** Throws on a missing definition; codec identity strings are never parsed. */
export function codecJsonSchema(codec: AnyWireCodec): JsonSchema {
  const cached = schemaCache.get(codec);
  if (cached) return cached;
  const representation = representations.get(codec);
  if (!representation) throw new TypeError(`Missing JSON representation for RPC codec ${codec.kind}`);
  const schema = representation();
  schemaCache.set(codec, schema);
  return schema;
}


type JsonWireNamespace = Omit<WireNamespace, 'serializable'> & {
  readonly serializable: <T>(guard: WireGuard<T>, options: ExternalWireSchemaOptions & { jsonSchema: z.ZodType | JsonSchema }) => WireCodec<T, T & WireValue>;
};

export function completeSchema(schema: JsonSchema): JsonSchema {
  const included: Record<string, JsonSchema> = {};
  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as JsonSchema;
    if (typeof object.$ref === 'string' && object.$ref.startsWith('#/$defs/')) {
      const name = object.$ref.slice('#/$defs/'.length).split('/')[0]!;
      if (!Object.hasOwn(included, name)) {
        const definition = definitions[name];
        if (!definition) throw new TypeError(`Missing JSON schema definition ${name}`);
        included[name] = definition;
        visit(definition);
      }
    }
    Object.values(object).forEach(visit);
  }
  visit(schema);
  const root = typeof schema.$ref === 'string' ? definitions[schema.$ref.slice('#/$defs/'.length)] : schema;
  return { ...root, ...schema, $defs: included };
}

export function completeJsonSchema(codec: AnyWireCodec): JsonSchema {
  return completeSchema(codecJsonSchema(codec));
}

/**
 * Definition-site metadata only. All factories delegate to result-rpc, return
 * its exact codec, and leave schema identities, encode/decode, and guards intact.
 */
export const wire: JsonWireNamespace = {
  ...rpcWire,
  string: retain(rpcWire.string, () => ({ type: 'string' })),
  boolean: retain(rpcWire.boolean, () => ({ type: 'boolean' })),
  number: retain(rpcWire.number, () => ({ anyOf: [{ type: 'number' }, specialNumberJsonSchema] })),
  finiteNumber: retain(rpcWire.finiteNumber, () => ({ anyOf: [{ type: 'number' }, negativeZeroJsonSchema] })),
  bigint: retain(rpcWire.bigint, () => bigintJsonSchema),
  undefined: retain(rpcWire.undefined, () => undefinedJsonSchema),
  date: retain(rpcWire.date, () => dateJsonSchema),
  null: retain(rpcWire.null, () => ({ type: 'null' })),
  regexp: retain(rpcWire.regexp, () => wireValueJsonSchema),
  url: retain(rpcWire.url, () => wireValueJsonSchema),
  plainDate: retain(rpcWire.plainDate, () => wireValueJsonSchema),
  plainDateTime: retain(rpcWire.plainDateTime, () => wireValueJsonSchema),
  plainTime: retain(rpcWire.plainTime, () => wireValueJsonSchema),
  plainYearMonth: retain(rpcWire.plainYearMonth, () => wireValueJsonSchema),
  plainMonthDay: retain(rpcWire.plainMonthDay, () => wireValueJsonSchema),
  instant: retain(rpcWire.instant, () => wireValueJsonSchema),
  zonedDateTime: retain(rpcWire.zonedDateTime, () => wireValueJsonSchema),
  duration: retain(rpcWire.duration, () => wireValueJsonSchema),
  integer: (options = {}) => retain(rpcWire.integer(options), () => {
    const integer = { type: 'integer', minimum: Math.max(options.min ?? Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER), maximum: Math.min(options.max ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
    return (options.min === undefined || options.min <= 0) && (options.max === undefined || options.max >= 0) ? { anyOf: [integer, negativeZeroJsonSchema] } : integer;
  }),
  literal: (value) => retain(rpcWire.literal(value), () => ({ const: encodeJsonValue(value) })),
  enum: (values) => retain(rpcWire.enum(values), () => ({ type: 'string', enum: [...values] })),
  array: (item) => retain(rpcWire.array(item), () => ({ type: 'array', items: codecJsonSchema(item) })),
  union: (members) => retain(rpcWire.union(members), () => ({ anyOf: members.map(codecJsonSchema) })),
  nullable: (codec) => retain(rpcWire.nullable(codec), () => ({ anyOf: [codecJsonSchema(codec), { type: 'null' }] })),
  optional: (codec) => retain(rpcWire.optional(codec), () => ({ anyOf: [codecJsonSchema(codec), undefinedJsonSchema] })),
  record: (codec) => retain(rpcWire.record(codec), () => ({ anyOf: [{ type: 'object', properties: { $gitspace: false }, additionalProperties: codecJsonSchema(codec) }, wireValueJsonSchema] })),
  object: (shape) => retain(rpcWire.object(shape), () => ({
    type: 'object',
    properties: Object.fromEntries(Object.entries(shape).map(([key, codec]) => [key, codecJsonSchema(codec)])),
    required: Object.entries(shape).filter(([, codec]) => !('optional' in codec && codec.optional === true)).map(([key]) => key),
    additionalProperties: false,
  })),
  serializable: (guard, options) => retain(rpcWire.serializable(guard, options), () => {
    if (!options.jsonSchema) throw new TypeError(`Missing JSON representation for guarded codec ${options.id}`);
    return options.jsonSchema instanceof z.ZodType ? zodJsonSchema(options.jsonSchema) : options.jsonSchema;
  }),
  codec: (options) => retain(rpcWire.codec(options), () => codecJsonSchema(options.wire)),
  standard: (schema, options) => retain(rpcWire.standard(schema, options), () => {
    if (!(schema instanceof z.ZodType)) throw new TypeError(`Missing JSON representation for Standard Schema codec ${options.id}`);
    return zodJsonSchema(schema);
  }),
};

export { richObjectJsonSchema };
