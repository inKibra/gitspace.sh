import { afterEach, expect, jest, test } from 'bun:test';
import { CAPTURE_MAX_MS, ScreencastRecorder } from './browser-screencast.js';

afterEach(() => { jest.useRealTimers(); });

/** A JPEG's first bytes: its start and a frame header with its size, then a byte telling frames apart. */
function jpeg(width: number, height: number, mark: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, mark]);
}
function recording() {
  const appended: number[] = [], acks: number[] = [], limits: string[] = [];
  const recorder = new ScreencastRecorder({ startedAt: Date.now(), append: async bytes => { appended.push(bytes.at(-1) ?? -1); }, ack: async id => { acks.push(id); }, limit: reason => { limits.push(reason); } });
  let session = 0;
  const frame = (width: number, height: number, mark: number) => recorder.frame({ data: Buffer.from(jpeg(width, height, mark)).toString('base64'), sessionId: ++session, metadata: { deviceWidth: 1, deviceHeight: 1 } });
  return { recorder, appended, acks, limits, frame };
}

test('keeps at most one frame per 200 ms, the newest of each burst, and acknowledges every frame so the screencast goes on', async () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const { recorder, appended, acks, frame } = recording();
  frame(800, 600, 1);
  jest.advanceTimersByTime(50); frame(800, 600, 2);
  jest.advanceTimersByTime(70); frame(1280, 720, 3);
  jest.advanceTimersByTime(80);
  jest.advanceTimersByTime(250); frame(800, 600, 4);
  jest.advanceTimersByTime(20); frame(800, 600, 5);
  const frames = await recorder.stop();
  expect(acks).toEqual([1, 2, 3, 4, 5]);
  expect(appended).toEqual([1, 3, 4, 5]);
  expect(frames.index.frames.map(({ t }) => t)).toEqual([0, 200, 450, 470]);
  expect(frames.index.frames.map(({ offset }) => offset)).toEqual([0, 24, 48, 72]);
  expect(frames).toMatchObject({ count: 4, width: 1280, height: 720 });
  expect(frames.thumbnail?.at(-1)).toBe(1);
});

test('a frame kept on time makes the one held before it stale, so frames stay in order', async () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const { recorder, appended, frame } = recording();
  frame(800, 600, 1);
  jest.advanceTimersByTime(100); frame(800, 600, 2);
  // The page changes again only after the held frame's time: the newer frame is kept, the held one never is.
  jest.setSystemTime(Date.now() + 150); frame(800, 600, 3);
  jest.advanceTimersByTime(1_000);
  await recorder.stop();
  expect(appended).toEqual([1, 3]);
});

test('stops keeping frames at 30 minutes and says why', async () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const { recorder, appended, limits, frame } = recording();
  frame(800, 600, 1);
  jest.setSystemTime(Date.now() + CAPTURE_MAX_MS);
  frame(800, 600, 2);
  frame(800, 600, 3);
  expect(limits).toEqual(['The capture reached 30 minutes']);
  expect((await recorder.stop()).count).toBe(1);
  expect(appended).toEqual([1]);
});
