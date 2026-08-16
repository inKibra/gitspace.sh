import { describe, expect, test } from 'bun:test';
import { AttachLifecycle, MAX_REPLAY_BYTES as ATTACH_REPLAY_CAP_BYTES } from '../attach-lifecycle.js';
import { PaneLifecycle, MAX_REPLAY_BYTES as PANE_REPLAY_CAP_BYTES } from '../pane-lifecycle.js';

type OutputHandler = (data: Uint8Array) => void;

interface OutputLifecycle {
  pushPtyData(data: Uint8Array): void;
  setOutputHandler(handler: OutputHandler | null): void;
}

interface LifecycleCase {
  name: string;
  replayCap: number;
  create: () => OutputLifecycle;
  clear: (lifecycle: OutputLifecycle) => void;
}

const lifecycleCases: LifecycleCase[] = [
  {
    name: 'PaneLifecycle',
    replayCap: PANE_REPLAY_CAP_BYTES,
    create: () => new PaneLifecycle({ paneId: 'pane-test', streamId: 7 }),
    clear: (lifecycle) => (lifecycle as PaneLifecycle).clear(),
  },
  {
    name: 'AttachLifecycle',
    replayCap: ATTACH_REPLAY_CAP_BYTES,
    create: () => new AttachLifecycle(() => {}),
    clear: (lifecycle) => (lifecycle as AttachLifecycle).clearAttachment(),
  },
];

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function filledChunk(length: number, value: number): Uint8Array {
  return Uint8Array.from({ length }, () => value);
}

for (const lifecycleCase of lifecycleCases) {
  describe(lifecycleCase.name, () => {
    test('bounds pre-handler replay and retains the most recent tail', () => {
      const lifecycle = lifecycleCase.create();
      const chunkSize = lifecycleCase.replayCap / 4;
      const pushed = Array.from({ length: 6 }, (_, index) => filledChunk(chunkSize, index + 1));
      const source = join(pushed);
      const delivered: Uint8Array[] = [];

      for (const chunk of pushed) lifecycle.pushPtyData(chunk);
      lifecycle.setOutputHandler((chunk) => delivered.push(chunk));

      const replay = join(delivered);
      expect(replay.length).toBeLessThanOrEqual(lifecycleCase.replayCap);
      expect(replay.length).toBe(lifecycleCase.replayCap);
      expect(replay).toEqual(source.slice(-lifecycleCase.replayCap));
    });

    test('streams every chunk when a handler is mounted before data arrives', () => {
      const lifecycle = lifecycleCase.create();
      const delivered: Uint8Array[] = [];
      const first = bytes('first live chunk');
      const second = bytes('second live chunk');

      lifecycle.setOutputHandler((chunk) => delivered.push(chunk));
      lifecycle.pushPtyData(first);
      lifecycle.pushPtyData(second);

      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toEqual(first);
      expect(delivered[1]).toEqual(second);
    });

    test('replays a capped tail after unmount and then resumes live streaming', () => {
      const lifecycle = lifecycleCase.create();
      const beforeUnmount: Uint8Array[] = [];
      const afterRemount: Uint8Array[] = [];
      const liveBeforeUnmount = bytes('live before unmount');
      const offlineChunks = Array.from(
        { length: 6 },
        (_, index) => filledChunk(lifecycleCase.replayCap / 4, 20 + index),
      );
      const offlineSource = join(offlineChunks);
      const liveAfterRemount = bytes('live after remount');

      lifecycle.setOutputHandler((chunk) => beforeUnmount.push(chunk));
      lifecycle.pushPtyData(liveBeforeUnmount);
      lifecycle.setOutputHandler(null);
      for (const chunk of offlineChunks) lifecycle.pushPtyData(chunk);

      expect(join(beforeUnmount)).toEqual(liveBeforeUnmount);

      lifecycle.setOutputHandler((chunk) => afterRemount.push(chunk));
      expect(join(afterRemount)).toEqual(offlineSource.slice(-lifecycleCase.replayCap));
      expect(join(afterRemount).length).toBe(lifecycleCase.replayCap);

      lifecycle.pushPtyData(liveAfterRemount);
      expect(join(afterRemount)).toEqual(
        join([offlineSource.slice(-lifecycleCase.replayCap), liveAfterRemount]),
      );
    });

    test('clear drops retained bytes before a handler mounts', () => {
      const lifecycle = lifecycleCase.create();
      const retainedBeforeClear = bytes('this must be discarded');
      const delivered: Uint8Array[] = [];

      lifecycle.pushPtyData(retainedBeforeClear);
      lifecycleCase.clear(lifecycle);
      lifecycle.setOutputHandler((chunk) => delivered.push(chunk));

      expect(delivered).toHaveLength(0);

      const afterClear = bytes('live after clear');
      lifecycle.pushPtyData(afterClear);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toEqual(afterClear);
    });

    test('holds a split multi-byte UTF-8 sequence until the sequence is complete', () => {
      const lifecycle = lifecycleCase.create();
      const delivered: Uint8Array[] = [];
      const prefix = bytes('prefix');
      const emoji = bytes('😀');
      const suffix = bytes('suffix');

      lifecycle.setOutputHandler((chunk) => delivered.push(chunk));
      lifecycle.pushPtyData(join([prefix, emoji.slice(0, 1)]));

      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toEqual(prefix);

      lifecycle.pushPtyData(join([emoji.slice(1), suffix]));

      expect(delivered).toHaveLength(2);
      expect(delivered[1]).toEqual(join([emoji, suffix]));
      expect(new TextDecoder().decode(join(delivered))).toBe('prefix😀suffix');
    });
  });
}
