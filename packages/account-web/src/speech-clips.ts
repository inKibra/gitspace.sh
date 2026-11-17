// The narration clips one page has asked for, by voice and text, made at most CLIPS_AT_ONCE at a time. A clip a frame
// waits for goes before the clips only prepared ahead, and a prepared clip not yet started drops when its preparation
// is called off. A clip that could not be made is forgotten, so asking again makes it again.
import type { SpeechClip } from './speech.js';

/** How many clips are made at once. */
export const CLIPS_AT_ONCE = 3;

interface Waiting {
  key: string;
  /** The preparation that queued it; null once a frame waits for it. */
  signal: AbortSignal | null;
  start(): void;
  drop(): void;
}

export interface SpeechClips {
  /** The clip `key` names, made by `request` unless it is made or being made; it goes before every prepared clip. */
  clip(key: string, request: () => Promise<SpeechClip | null>): Promise<SpeechClip | null>;
  /** Makes these clips ahead, in order, after the ones a frame waits for; those not started when `signal` aborts drop. */
  prepare(lines: readonly { key: string; request: () => Promise<SpeechClip | null> }[], signal: AbortSignal): void;
}

export function speechClips(): SpeechClips {
  const clips = new Map<string, Promise<SpeechClip | null>>();
  const waiting: Waiting[] = [];
  let running = 0;
  const next = (): void => {
    while (running < CLIPS_AT_ONCE) {
      const item = waiting.shift();
      if (!item) return;
      item.start();
    }
  };
  const make = (key: string, request: () => Promise<SpeechClip | null>, signal: AbortSignal | null): Promise<SpeechClip | null> => {
    const known = clips.get(key);
    if (known) {
      const index = signal === null ? waiting.findIndex((item) => item.key === key) : -1;
      const [item] = index >= 0 ? waiting.splice(index, 1) : [];
      if (item) waiting.unshift({ ...item, signal: null });
      return known;
    }
    const { promise, resolve } = Promise.withResolvers<SpeechClip | null>();
    clips.set(key, promise);
    void promise.then((clip) => { if (!clip && clips.get(key) === promise) clips.delete(key); });
    const item: Waiting = {
      key, signal,
      start: () => {
        running += 1;
        void request().then(resolve, () => resolve(null)).finally(() => { running -= 1; next(); });
      },
      // Forgotten at once, so a preparation asked again right after makes it again.
      drop: () => { clips.delete(key); resolve(null); },
    };
    if (signal) waiting.push(item);
    else waiting.unshift(item);
    next();
    return promise;
  };
  return {
    clip: (key, request) => make(key, request, null),
    prepare(lines, signal) {
      if (signal.aborted) return;
      for (const line of lines) void make(line.key, line.request, signal);
      signal.addEventListener('abort', () => {
        for (let index = waiting.length - 1; index >= 0; index -= 1) if (waiting[index]?.signal === signal) waiting.splice(index, 1)[0]?.drop();
      }, { once: true });
    },
  };
}
