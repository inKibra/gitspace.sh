import { wire, type WireCodec } from 'result-rpc';
import { z } from 'zod';
import { streamCursorSchema, streamEventSchema, type StreamEvent } from '@gitspace/protocol-sync';

export const StreamCursorCodec = wire.serializable(
  (value): value is number => streamCursorSchema.safeParse(value).success,
  { id: 'gitspace/stream-cursor/v1' },
);

export function streamCodec<T>(value: WireCodec<T>) {
  const schema = streamEventSchema(z.custom<T>((candidate) => value.decode(candidate).ok));
  return wire.serializable(
    (candidate): candidate is StreamEvent<T> => schema.safeParse(candidate).success,
    { id: `gitspace/stream/v1:${value.schema}` },
  );
}
