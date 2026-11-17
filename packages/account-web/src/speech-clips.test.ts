import { describe, expect, it, vi } from 'vitest';
import type { SpeechClip } from './speech.js';
import { speechClips } from './speech-clips.js';

/** Requests the test answers by hand, in the order they started. */
function server() {
  const started: string[] = [];
  const answers = new Map<string, PromiseWithResolvers<SpeechClip | null>>();
  const request = (key: string) => (): Promise<SpeechClip | null> => {
    started.push(key);
    const answer = Promise.withResolvers<SpeechClip | null>();
    answers.set(key, answer);
    return answer.promise;
  };
  return {
    started, request,
    lines: (keys: readonly string[]) => keys.map((key) => ({ key, request: request(key) })),
    answer(key: string, clip: SpeechClip | Error): void {
      const answer = answers.get(key);
      if (!answer) throw new Error(`${key} was never requested`);
      if (clip instanceof Error) answer.reject(clip);
      else answer.resolve(clip);
    },
  };
}

describe('speech clips', () => {
  it('makes three clips at once, a frame\'s own clip before the prepared ones', async () => {
    const made = server();
    const clips = speechClips();
    const one = clips.clip('one', made.request('one'));
    clips.prepare(made.lines(['two', 'three', 'four', 'five']), new AbortController().signal);
    expect(made.started).toEqual(['one', 'two', 'three']);
    // A frame now waits for the prepared "five", then another for "six", never prepared: each goes before "four".
    const five = clips.clip('five', made.request('five'));
    const six = clips.clip('six', made.request('six'));
    made.answer('two', { url: '/two', durationMs: 1000 });
    await vi.waitFor(() => expect(made.started).toEqual(['one', 'two', 'three', 'six']));
    made.answer('one', { url: '/one', durationMs: 1000 });
    expect(await one).toEqual({ url: '/one', durationMs: 1000 });
    await vi.waitFor(() => expect(made.started).toEqual(['one', 'two', 'three', 'six', 'five']));
    made.answer('six', { url: '/six', durationMs: 1000 });
    expect(await six).toEqual({ url: '/six', durationMs: 1000 });
    await vi.waitFor(() => expect(made.started).toEqual(['one', 'two', 'three', 'six', 'five', 'four']));
    made.answer('five', { url: '/five', durationMs: 1000 });
    expect(await five).toEqual({ url: '/five', durationMs: 1000 });
    // A clip made once is not asked for again.
    expect(await clips.clip('two', made.request('two'))).toEqual({ url: '/two', durationMs: 1000 });
    expect(made.started.filter((key) => key === 'two')).toHaveLength(1);
  });

  it('drops the prepared clips not yet started when their preparation is called off, and forgets a clip that failed', async () => {
    const made = server();
    const clips = speechClips();
    const preparation = new AbortController();
    const a = clips.clip('a', made.request('a'));
    clips.prepare(made.lines(['b', 'c', 'd']), preparation.signal);
    preparation.abort();
    made.answer('a', new Error('synthesis failed'));
    expect(await a).toBeNull();
    made.answer('b', { url: '/b', durationMs: 1000 });
    expect(await clips.clip('b', made.request('b'))).toEqual({ url: '/b', durationMs: 1000 });
    // Two slots came free, and "d" was dropped before it started: it is not made.
    expect(made.started).toEqual(['a', 'b', 'c']);
    // Asked again, "d" and the failed "a" are made.
    clips.prepare(made.lines(['d', 'a']), new AbortController().signal);
    await vi.waitFor(() => expect(made.started).toEqual(['a', 'b', 'c', 'd', 'a']));
    // With every slot taken, a preparation called off and asked again at once (a frame moving on) queues its clip again.
    const moved = new AbortController();
    clips.prepare(made.lines(['e']), moved.signal);
    moved.abort();
    clips.prepare(made.lines(['e']), new AbortController().signal);
    made.answer('c', { url: '/c', durationMs: 1000 });
    await vi.waitFor(() => expect(made.started).toEqual(['a', 'b', 'c', 'd', 'a', 'e']));
  });
});
