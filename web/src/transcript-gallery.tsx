import { useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { AgentTranscript, type BlockHost } from '../../src/blocks/render/index.web.js';
import { getTranscriptRange, type TranscriptEntry, type TranscriptSource } from '../../src/blocks/agent/transcript-source.js';
import type { Block } from '../../src/blocks/index.js';

// ── a fake session: a linear branch of ~100 entries (drives REAL pagination) ──
const entries: TranscriptEntry[] = [];
let prev: string | null = null;
function add(id: string, type: string, extra: Partial<TranscriptEntry>): void {
  entries.push({ id, parentId: prev, type, ...extra } as TranscriptEntry);
  prev = id;
}
for (let n = 0; n < 50; n++) {
  add(`u${n}`, 'message', { message: { role: 'user', content: `**Question ${n}** — explain widget ${n}.`, timestamp: n } as never });
  add(`a${n}`, 'message', { message: { role: 'assistant', content: [{ type: 'text', text: `Widget ${n} does X then Y.\n\n- handles edge ${n}\n- returns \`result\`` }], timestamp: n } as never });
  if (n === 25) add('cmp', 'compaction', { summary: 'Older turns summarized for context.', shortSummary: 'earlier context compacted' });
}
// a tool-call sequence near the leaf
add('atc', 'message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Running the suite.' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'bun test' } }], timestamp: 99 } as never });
add('tr1', 'message', { message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: '31 pass, 0 fail' }], isError: false, timestamp: 99 } as never });
const LEAF = prev;

const byId = new Map(entries.map((e) => [e.id, e]));
const source: TranscriptSource = { getLeafId: () => LEAF, getEntry: (id) => byId.get(id) };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchRange = async (before: string | undefined, limit: number) => {
  await delay(280); // visible "loading older…"
  return getTranscriptRange(source, { before, limit });
};

const host: BlockHost = { readOnly: false, resolve: () => {}, dispatch: () => {} };

function Harness() {
  // fake live streaming: append an assistant message every few seconds
  const [live, setLive] = useState<Block[]>([{ id: 'live0', type: 'message', data: { role: 'assistant', text: 'Streaming a live follow-up…' } }]);
  useEffect(() => {
    let n = 1;
    const t = setInterval(() => {
      setLive((prevLive) => [...prevLive, { id: `live${n}`, type: 'message', data: { role: 'assistant', text: `Live chunk ${n} arriving…` } }]);
      n += 1;
    }, 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{
      height: '100vh', background: 'var(--gs-bg)', color: 'var(--gs-text)',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontFeatureSettings: '"cv01", "ss03"',
      ['--gs-font' as string]: "'JetBrains Mono', ui-monospace, monospace",
    } as CSSProperties}>
      <AgentTranscript fetchRange={fetchRange} live={live} host={host} busy pageSize={20} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
