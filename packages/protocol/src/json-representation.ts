import { type AnyWireCodec } from 'result-rpc';
import { gitspaceContract } from './rpc-contract.js';
import { codecJsonSchema, completeJsonSchema, completeSchema } from './json-wire.js';
import { decodeJsonValue, encodeJsonValue, wireValueJsonSchema, type JsonSchema } from './json-value.js';

export { decodeJsonValue, encodeJsonValue } from './json-value.js';

export interface ProcedureJsonRepresentation {
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly errorsSchema: JsonSchema;
  decodeInput(value: unknown): unknown;
  encodeOutput(value: unknown): unknown;
  /** Only declared public errors; causes and undeclared fields never cross MCP. */
  encodeError(value: unknown): unknown;
}

const cache = new Map<string, ProcedureJsonRepresentation>();

function encodeCodec(codec: AnyWireCodec, value: unknown): unknown {
  // The contract registry erases Input; the codec is the runtime proof boundary.
  const encoded = codec.encode(value as never);
  if (!encoded.ok) throw new TypeError(`RPC value failed validation: ${encoded.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return encodeJsonValue(encoded.value);
}

/**
 * A schema-backed JSON projection of the existing RPC wire contract, not a
 * second validator. Decoding revives rich values then invokes the original
 * codec. Guarded Zod codecs therefore retain their original values (including
 * omitted defaults and untrimmed strings), rather than Zod's parsed output.
 * Subscription output schemas describe one emitted value, not a collected list.
 */
export function procedureJsonRepresentation(path: string): ProcedureJsonRepresentation {
  const cached = cache.get(path);
  if (cached) return cached;
  const procedure = gitspaceContract.procedures.get(path);
  if (!procedure) throw new TypeError(`Unknown RPC procedure: ${path}`);
  const { input, output, definitions } = procedure._def;
  const errors = Object.values(definitions).filter((definition) => definition.policy.visibility === 'public');
  const representation: ProcedureJsonRepresentation = {
    inputSchema: completeJsonSchema(input),
    outputSchema: completeSchema({ anyOf: [codecJsonSchema(output), wireValueJsonSchema] }),
    errorsSchema: completeSchema(errors.length ? {
      oneOf: errors.map((definition) => ({
        type: 'object',
        properties: { _tag: { const: definition.tag }, data: codecJsonSchema(definition.codec) },
        required: ['_tag', 'data'],
        additionalProperties: false,
      })),
    } : { not: {} }),
    decodeInput(value) {
      const decoded = input.decode(decodeJsonValue(value));
      if (!decoded.ok) throw new TypeError(`RPC input failed validation: ${decoded.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
      return decoded.value;
    },
    encodeOutput(value) {
      return encodeCodec(output, value);
    },
    encodeError(value) {
      const definition = errors.find((candidate) => candidate.is(value));
      if (!definition || !definition.is(value)) throw new TypeError('RPC error is not a declared public error for this procedure');
      return { _tag: definition.tag, data: encodeCodec(definition.codec, value.data) };
    },
  };
  cache.set(path, representation);
  return representation;
}
