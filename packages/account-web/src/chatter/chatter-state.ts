import type { ChatterEvent, ChatterKind, ChatterPost, ChatterTopic, ChatterTopicLine } from '@gitspace/protocol/chatter-contract';

/** The part of a project's Chatter this tab has read: events oldest first, the rows of their topics, the newest offset
 * read (the next `after`), and whether older events remain. */
export interface ChatterState {
  events: readonly ChatterEvent[];
  topics: ReadonlyMap<string, ChatterTopic>;
  cursor: number;
  older: boolean;
}

export const EMPTY_CHATTER: ChatterState = { events: [], topics: new Map(), cursor: 0, older: false };

/** Events and topic rows read in any order, folded into `state`: each event once, by offset; a merge line moves the
 * events this tab holds under the merged topic to the topic it went into. Only a read of what is newer moves `cursor`:
 * a post this tab just wrote can be newer than events it has not read yet. */
export function mergeChatter(state: ChatterState, events: readonly ChatterEvent[], topics: readonly ChatterTopic[], read: { cursor?: number; older?: boolean } = {}): ChatterState {
  const byOffset = new Map(state.events.map(event => [event.offset, event]));
  for (const event of events) byOffset.set(event.offset, event);
  const moved = new Map<string, string>();
  for (const event of byOffset.values()) if (event.type === 'topic' && event.change.kind === 'merge') moved.set(event.change.from, event.topicKey);
  const merged = [...byOffset.values()].sort((left, right) => left.offset - right.offset).map(event => {
    const into = moved.get(event.topicKey);
    return into === undefined ? event : { ...event, topicKey: into };
  });
  const rows = new Map(state.topics);
  for (const topic of topics) rows.set(topic.key, topic);
  for (const from of moved.keys()) rows.delete(from);
  return { events: merged, topics: rows, cursor: Math.max(state.cursor, read.cursor ?? 0), older: read.older ?? state.older };
}

export interface ChatterGroup {
  key: string;
  topic: ChatterTopic | null;
  /** Its posts (of the filtered kind) and topic lines this tab holds, oldest first. */
  items: readonly (ChatterPost | ChatterTopicLine)[];
  posts: number;
  /** The newest offset in the group: groups are ordered by it, the most recently active last. */
  latest: number;
}

/** One group per topic, the most recently active at the bottom next to the composer. Filtering by a kind keeps that
 * kind's posts and drops topic lines; a topic with nothing left is not shown. */
export function groupChatter(state: ChatterState, filter: ChatterKind | 'all'): ChatterGroup[] {
  const groups = new Map<string, { items: (ChatterPost | ChatterTopicLine)[]; posts: number; latest: number }>();
  for (const event of state.events) {
    if (filter !== 'all' && (event.type !== 'post' || event.kind !== filter)) continue;
    const group = groups.get(event.topicKey) ?? { items: [], posts: 0, latest: 0 };
    group.items.push(event);
    if (event.type === 'post') group.posts++;
    group.latest = event.offset;
    groups.set(event.topicKey, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.posts > 0)
    .map(([key, group]) => ({ key, topic: state.topics.get(key) ?? null, ...group }))
    .sort((left, right) => left.latest - right.latest);
}

/** Posts per kind among those this tab holds. */
export function chatterKindCounts(events: readonly ChatterEvent[]): ReadonlyMap<ChatterKind, number> {
  const counts = new Map<ChatterKind, number>();
  for (const event of events) if (event.type === 'post') counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  return counts;
}
