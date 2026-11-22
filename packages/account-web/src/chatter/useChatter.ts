import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatterDigest, ChatterHearings, ChatterKind, ChatterTopic, ChatterTopicAction } from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { liveTicks } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { EMPTY_CHATTER, mergeChatter, type ChatterState } from './chatter-state.js';

/** Without a notice (a device the account directory socket does not admit), the stream is read again this often. */
const CHATTER_FALLBACK_MS = 60_000;

export type ChatterPostOutcome = { status: 'ok'; topic: ChatterTopic; similar: ChatterTopic | null } | { status: 'error'; message: string };

/** A project's Chatter in this tab: the newest page, then what is newer after each project `chatter` notice burst;
 * older pages and one topic's earlier posts on demand. The active topics (for the composer's autocomplete and
 * similar-topic hint) are read with each refresh. */
export function useChatter(projectId: string) {
  const [state, setState] = useState<ChatterState>(EMPTY_CHATTER);
  const [active, setActive] = useState<readonly ChatterTopic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<ChatterState>(EMPTY_CHATTER);
  const update = useCallback((next: (current: ChatterState) => ChatterState) => {
    latest.current = next(latest.current);
    setState(latest.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    latest.current = EMPTY_CHATTER;
    setState(EMPTY_CHATTER);
    setActive([]);
    setError(null);
    const signal = controller.signal;
    const refresh = async () => {
      const topics = rpcClient.chatter.topics({ projectId }, { signal });
      if (latest.current.cursor === 0) {
        const page = await rpcClient.chatter.watch({ projectId }, { signal });
        if (page.status === 'error') throw page.error;
        update(current => mergeChatter(current, page.value.events, page.value.topics, { cursor: page.value.cursor, older: page.value.more }));
      } else {
        for (let more = true; more && !signal.aborted;) {
          const page = await rpcClient.chatter.watch({ projectId, after: latest.current.cursor }, { signal });
          if (page.status === 'error') throw page.error;
          update(current => mergeChatter(current, page.value.events, page.value.topics, { cursor: page.value.more ? page.value.events.at(-1)?.offset : page.value.cursor }));
          more = page.value.more;
        }
      }
      const listed = await topics;
      if (listed.status === 'error') throw listed.error;
      setActive(listed.value.topics);
      // Active topic rows change without a new event (a sameness suggestion, a repeat): the tab's rows follow them.
      update(current => mergeChatter(current, [], listed.value.topics));
    };
    const run = async () => {
      let delay = 250;
      while (!signal.aborted) {
        try {
          for await (const _tick of liveTicks([projectLiveKey(projectId, 'chatter')], signal, undefined, () => CHATTER_FALLBACK_MS)) {
            await refresh();
            if (signal.aborted) return;
            delay = 250;
            setError(null);
          }
          return;
        } catch (cause) {
          if (signal.aborted) return;
          setError(rpcErrorMessage(cause, 'Read Chatter'));
          const wait = Promise.withResolvers<void>();
          const timer = setTimeout(wait.resolve, Math.floor(delay * (0.5 + Math.random() * 0.5)));
          signal.addEventListener('abort', () => { clearTimeout(timer); wait.resolve(); }, { once: true });
          await wait.promise;
          delay = Math.min(delay * 2, 10_000);
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [projectId, update]);

  /** The page before the oldest event this tab holds, or before the oldest of one topic's. */
  const loadOlder = useCallback(async (topic?: string) => {
    const held = latest.current.events.filter(event => topic === undefined || event.topicKey === topic);
    const before = held[0]?.offset;
    const page = await rpcClient.chatter.watch({ projectId, before, topic });
    if (page.status === 'error') {
      setError(rpcErrorMessage(page.error, 'Read Chatter'));
      return;
    }
    update(current => mergeChatter(current, page.value.events, page.value.topics, topic === undefined ? { older: page.value.more } : {}));
  }, [projectId, update]);

  const post = useCallback(async (input: { topic: string; kind: ChatterKind; text: string }): Promise<ChatterPostOutcome> => {
    const result = await rpcClient.chatter.post({ projectId, id: crypto.randomUUID(), ...input });
    if (result.status === 'error') return { status: 'error', message: rpcErrorMessage(result.error, 'Post to Chatter') };
    const { post: written, topic, similar, line } = result.value;
    update(current => mergeChatter(current, line ? [written, line] : [written], [topic]));
    return { status: 'ok', topic, similar };
  }, [projectId, update]);

  /** Null when it took effect, else why not. */
  const act = useCallback(async (key: string, action: ChatterTopicAction): Promise<string | null> => {
    const result = await rpcClient.chatter.topicAct({ projectId, key, action });
    if (result.status === 'error') return rpcErrorMessage(result.error, 'Change the topic');
    const { topic, line } = result.value;
    update(current => mergeChatter(current, line ? [line] : [], [topic]));
    return null;
  }, [projectId, update]);

  /** Hear as: one listener's digest (a workspace id, or `project` for the project agent); a string says why not. */
  const hearAs = useCallback(async (listener: string): Promise<ChatterDigest | string> => {
    const result = await rpcClient.chatter.digestPreview({ projectId, listener });
    return result.status === 'ok' ? result.value : rpcErrorMessage(result.error, 'Hear as an agent');
  }, [projectId]);

  /** Who hears the post at `offset`; a string says why it could not be read. */
  const hearings = useCallback(async (offset: number): Promise<ChatterHearings | string> => {
    const result = await rpcClient.chatter.hearings({ projectId, offset });
    return result.status === 'ok' ? result.value : rpcErrorMessage(result.error, 'Read who hears it');
  }, [projectId]);

  return { state, active, error, loadOlder, post, act, hearAs, hearings };
}
