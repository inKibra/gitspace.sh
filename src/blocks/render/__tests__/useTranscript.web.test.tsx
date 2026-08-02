import { act, renderHook } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { Block } from '../../index.js';
import type { TranscriptPage } from '../../agent/transcript-source.js';
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { useTranscript } from '../useTranscript.web.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface FetchRequest {
  before: string | undefined;
  deferred: Deferred<TranscriptPage>;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function message(id: string): Block {
  return { id, type: 'message', data: { role: 'assistant', text: id } };
}

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeAll(() => {
  setupTestDom();
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  teardownTestDom();
});

describe('useTranscript', () => {
  it('keeps the refreshed tail when pre-refresh older and live-turn requests resolve late', async () => {
    const requests: FetchRequest[] = [];
    const fetchRange = (before: string | undefined): Promise<TranscriptPage> => {
      const request = { before, deferred: deferred<TranscriptPage>() };
      requests.push(request);
      return request.deferred.promise;
    };
    const { result, rerender } = renderHook(
      ({ live, refreshNonce }: { live: readonly Block[]; refreshNonce: number }) => useTranscript({
        fetchRange,
        live,
        refreshNonce,
      }),
      { initialProps: { live: [], refreshNonce: 0 } },
    );

    await act(async () => {
      requests[0]!.deferred.resolve({
        blocks: [message('committed-before-shake')],
        oldestCursor: 'before-shake-cursor',
        hasMore: true,
      });
    });

    const container = document.createElement('div');
    Object.defineProperties(container, {
      clientHeight: { value: 100, writable: true },
      scrollHeight: { value: 1000, writable: true },
      scrollTop: { value: 0, writable: true },
    });
    Object.assign(result.current.containerRef, { current: container });

    act(() => {
      result.current.onScroll();
    });
    act(() => {
      result.current.jumpToLatest();
    });
    rerender({ live: [message('live-before-shake')], refreshNonce: 0 });
    rerender({ live: [], refreshNonce: 0 });
    rerender({ live: [], refreshNonce: 1 });

    expect(requests.map((request) => request.before)).toEqual([
      undefined,
      'before-shake-cursor',
      undefined,
      undefined,
    ]);

    await act(async () => {
      requests[3]!.deferred.resolve({
        blocks: [message('after-shake')],
        oldestCursor: null,
        hasMore: false,
      });
    });
    expect(result.current.committed.map((block) => block.id)).toEqual(['after-shake']);

    await act(async () => {
      requests[1]!.deferred.resolve({
        blocks: [message('stale-older')],
        oldestCursor: 'stale-cursor',
        hasMore: false,
      });
      requests[2]!.deferred.resolve({
        blocks: [message('stale-live-tail')],
        oldestCursor: 'stale-live-cursor',
        hasMore: false,
      });
    });

    expect(result.current.committed.map((block) => block.id)).toEqual(['after-shake']);
  });
});
