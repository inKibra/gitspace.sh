// Cursor agent.v1 field numbers follow @oh-my-pi/pi-catalog 18.2.11.
// This codec uses only Web APIs; it has no process, socket, or ambient auth state.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = new Uint8Array();

type WireField = { number: number; value: bigint | Uint8Array; wire: number };

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  do {
    const next = Number(value & 127n);
    value >>= 7n;
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Uint8Array.from(bytes);
}

export function uint(field: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Cursor unsigned integer');
  return concat([varint(BigInt(field * 8)), varint(BigInt(value))]);
}

export function bytes(field: number, value: Uint8Array): Uint8Array {
  return concat([varint(BigInt(field * 8 + 2)), varint(BigInt(value.length)), value]);
}

export function text(field: number, value: string): Uint8Array {
  return bytes(field, encoder.encode(value));
}

export function message(field: number, ...fields: Uint8Array[]): Uint8Array {
  return bytes(field, concat(fields));
}

export class CursorWire {
  readonly fields: readonly WireField[];

  constructor(data: Uint8Array = empty) {
    const fields: WireField[] = [];
    let offset = 0;
    const readVarint = (): bigint => {
      let value = 0n;
      for (let shift = 0n; shift < 70n; shift += 7n) {
        const byte = data[offset++];
        if (byte === undefined) throw new Error('Truncated Cursor protobuf varint');
        value |= BigInt(byte & 127) << shift;
        if (!(byte & 128)) return value;
      }
      throw new Error('Invalid Cursor protobuf varint');
    };
    while (offset < data.length) {
      const tag = Number(readVarint());
      const number = Math.floor(tag / 8);
      const wire = tag & 7;
      if (number === 0) throw new Error('Invalid Cursor protobuf field');
      if (wire === 0) {
        fields.push({ number, wire, value: readVarint() });
        continue;
      }
      const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(readVarint()) : -1;
      if (length < 0 || !Number.isSafeInteger(length) || offset + length > data.length) {
        throw new Error('Invalid or truncated Cursor protobuf field');
      }
      fields.push({ number, wire, value: data.subarray(offset, offset + length) });
      offset += length;
    }
    this.fields = fields;
  }

  has(number: number): boolean {
    return this.fields.some(field => field.number === number);
  }

  data(number: number): Uint8Array {
    const field = this.fields.findLast(field => field.number === number);
    if (!field) return empty;
    if (!(field.value instanceof Uint8Array) || field.wire !== 2) throw new Error('Expected Cursor protobuf bytes');
    return field.value;
  }

  all(number: number): CursorWire[] {
    return this.fields.filter(field => field.number === number).map(field => {
      if (!(field.value instanceof Uint8Array) || field.wire !== 2) throw new Error('Expected Cursor protobuf message');
      return new CursorWire(field.value);
    });
  }

  child(number: number): CursorWire {
    return new CursorWire(this.data(number));
  }

  string(number: number): string {
    return decoder.decode(this.data(number));
  }

  number(number: number): number {
    const field = this.fields.findLast(field => field.number === number);
    if (!field) return 0;
    if (typeof field.value !== 'bigint') throw new Error('Expected Cursor protobuf integer');
    const value = Number(field.value);
    if (!Number.isSafeInteger(value)) throw new Error('Cursor protobuf integer exceeds safe range');
    return value;
  }

  double(number: number): number {
    const field = this.fields.findLast(field => field.number === number);
    if (!field || field.wire !== 1 || !(field.value instanceof Uint8Array)) throw new Error('Expected Cursor protobuf double');
    return new DataView(field.value.buffer, field.value.byteOffset, 8).getFloat64(0, true);
  }
}

// google.protobuf.Value is the Cursor MCP schema/argument representation.
export function jsonValue(value: unknown): Uint8Array {
  if (value === null) return uint(1, 0);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite Cursor JSON number');
    const data = new Uint8Array(8);
    new DataView(data.buffer).setFloat64(0, value, true);
    return concat([varint(17n), data]);
  }
  if (typeof value === 'string') return text(3, value);
  if (typeof value === 'boolean') return uint(4, value ? 1 : 0);
  if (Array.isArray(value)) return message(6, ...value.map(item => bytes(1, jsonValue(item))));
  if (typeof value === 'object') {
    return message(5, ...Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) =>
      message(1, text(1, key), bytes(2, jsonValue(item)))));
  }
  throw new Error('Unsupported Cursor JSON value');
}

export function decodeJsonValue(data: Uint8Array): unknown {
  const value = new CursorWire(data);
  if (value.has(1)) return null;
  if (value.has(2)) return value.double(2);
  if (value.has(3)) return value.string(3);
  if (value.has(4)) return value.number(4) !== 0;
  if (value.has(5)) {
    return Object.fromEntries(value.child(5).all(1).map(entry => [entry.string(1), decodeJsonValue(entry.data(2))]));
  }
  if (value.has(6)) {
    return value.child(6).fields.filter(field => field.number === 1).map(field => {
      if (!(field.value instanceof Uint8Array)) throw new Error('Invalid Cursor JSON list');
      return decodeJsonValue(field.value);
    });
  }
  throw new Error('Unset Cursor JSON value');
}

export function connectFrame(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + data.length);
  new DataView(frame.buffer).setUint32(1, data.length, false);
  frame.set(data, 5);
  return frame;
}

export async function* connectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ flags: number; data: Uint8Array }> {
  const reader = body.getReader();
  let pending: Uint8Array = empty;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending = pending.length ? concat([pending, chunk.value]) : chunk.value;
      let offset = 0;
      while (pending.length - offset >= 5) {
        const flags = pending[offset];
        if (flags === undefined) throw new Error('Missing Cursor frame flags');
        const length = new DataView(pending.buffer, pending.byteOffset + offset + 1, 4).getUint32(0, false);
        if (pending.length - offset - 5 < length) break;
        yield { flags, data: pending.subarray(offset + 5, offset + 5 + length) };
        offset += 5 + length;
      }
      pending = pending.subarray(offset);
    }
    if (pending.length) throw new Error('Truncated Cursor Connect frame');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function blobKey(data: Uint8Array): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function storeBlob(store: Map<string, Uint8Array>, data: Uint8Array): Promise<Uint8Array> {
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data)));
  store.set(blobKey(id), data);
  return id;
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
