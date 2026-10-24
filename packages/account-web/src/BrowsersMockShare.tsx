// Throwaway Batch 18 mockup, part 4: joining through a share link. The greeting page, then the viewer with comment
// mode. Hover outlines are resolved locally here; for real they come from the live tab (DOM.getNodeForLocation).
import { Button, InputField, InputGroup, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import { MessagePlusSquare } from '@untitledui/icons';
import { useRef, useState, type ReactNode } from 'react';
import { Pointer } from './BrowsersMockExtension.js';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';

const BLUE = '#1a73e8';
const PURPLE = '#a142f4';
const ORANGE = '#ff6600';
const CommentGlyph = glyph(MessagePlusSquare);

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-caption text-muted-foreground"><strong className="text-foreground">Design note · </strong>{children}</p>;
}

type Greeting = 'guest' | 'signed-in' | 'session' | 'ended';
function GreetingCard({ state, onJoin }: { state: Greeting; onJoin(): void }) {
  const [name, setName] = useState('');
  if (state === 'ended') return <div className="flex w-[420px] flex-col items-center gap-3 rounded-2xl border border-border bg-surface-1 p-8 text-center shadow-xl">
    <img src="/favicon.png" alt="" width={36} height={36} className="rounded-lg opacity-60" />
    <h2 className="text-subtitle font-semibold">This share has ended</h2>
    <p className="text-body text-muted-foreground">Bradley stopped sharing, the time ran out, or the tab was closed. Ask Bradley for a new link.</p>
  </div>;
  const signedIn = state === 'signed-in';
  if (state === 'session') return <div className="flex w-[420px] flex-col gap-5 rounded-2xl border border-border bg-surface-1 p-7 shadow-xl">
    <div className="flex items-center gap-2.5"><img src="/favicon.png" alt="" width={28} height={28} className="rounded-lg" /><span className="text-body font-semibold">GitSpace</span></div>
    <div className="flex flex-col gap-1"><h2 className="text-title font-semibold tracking-tight">Bradley shared a capture with you</h2><p className="text-body text-muted-foreground">A recording of a browsing session, with comments. Bradley&apos;s browser doesn&apos;t need to be on.</p></div>
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
      <span className="flex size-9 items-center justify-center rounded-lg text-white" style={{ background: PURPLE }}><MessagePlusSquare width={16} height={16} /></span>
      <div className="min-w-0"><p className="truncate text-body font-medium">Pizza form review</p><p className="truncate text-caption text-muted-foreground">httpbin.org/forms/post · 4:12 · 2 comments</p></div>
    </div>
    <ul className="flex flex-col gap-1.5 text-body"><li>✓ Watch the whole session and scrub through it</li><li>✓ Reply, and comment at any moment on anything</li><li className="text-muted-foreground">✕ The live page: this is a recording</li></ul>
    <InputGroup><InputField index={0} label="Your name" placeholder="Shown on your comments" value={name} onChange={setName} /></InputGroup>
    <Button variant="primary" disabled={!name.trim()} onClick={onJoin}>Open</Button>
    <p className="text-caption text-muted-foreground">Contains a recording of everything visible in the tab during the session. Ends in 7 days or when Bradley stops sharing.</p>
  </div>;
  return <div className="flex w-[420px] flex-col gap-5 rounded-2xl border border-border bg-surface-1 p-7 shadow-xl">
    <div className="flex items-center gap-2.5"><img src="/favicon.png" alt="" width={28} height={28} className="rounded-lg" /><span className="text-body font-semibold">GitSpace</span></div>
    <div className="flex flex-col gap-1"><h2 className="text-title font-semibold tracking-tight">Bradley is sharing a tab with you</h2><p className="text-body text-muted-foreground">Live, as it happens in Bradley&apos;s Chrome.</p></div>
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
      <span className="flex size-9 items-center justify-center rounded-lg text-body font-bold text-white" style={{ background: ORANGE }}>Y</span>
      <div className="min-w-0"><p className="truncate text-body font-medium">Hacker News</p><p className="truncate font-mono text-caption text-muted-foreground">news.ycombinator.com</p></div>
      <span className="ml-auto flex items-center gap-1.5 text-caption text-muted-foreground"><span className="size-2 rounded-full bg-[#22c55e]" />live</span>
    </div>
    <ul className="flex flex-col gap-1.5 text-body">
      <li>✓ Watch the tab live</li>
      <li>✓ Point: everyone sees your pointer with your name</li>
      <li>✓ Comment on anything on the page</li>
      <li className="text-muted-foreground">✕ Click or type in the page; only Bradley and his agent can</li>
    </ul>
    {signedIn ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-caption">Joining as <strong>Ana Ruiz</strong> (signed in to GitSpace)</p>
      : <InputGroup><InputField index={0} label="Your name" placeholder="Shown on your pointer and comments" value={name} onChange={setName} /></InputGroup>}
    <Button variant="primary" disabled={!signedIn && !name.trim()} onClick={onJoin}>Join</Button>
    <p className="text-caption text-muted-foreground">Bradley sees that you joined. Ends in 52 min or when Bradley stops sharing. {signedIn ? '' : 'No account needed.'}</p>
  </div>;
}

type Anchor = { left: number; top: number; width: number; height: number; label: string };
type Draft = Anchor & { region?: boolean };
const stories = ['Show HN: Agents that drive your own Chrome', 'The case for boring technology (2015)', 'A tour of CDP input events', 'Fitts’s law in UI design', 'Ask HN: How do you review AI-written code?'];

function GuestViewer() {
  const page = useRef<HTMLDivElement | null>(null);
  const [commenting, setCommenting] = useState(true);
  const [hover, setHover] = useState<Anchor | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const local = (element: HTMLElement): Anchor => {
    const box = page.current?.getBoundingClientRect(), rect = element.getBoundingClientRect();
    return { left: rect.left - (box?.left ?? 0), top: rect.top - (box?.top ?? 0), width: rect.width, height: rect.height, label: element.dataset.anchor ?? 'element' };
  };
  const anchorAt = (x: number, y: number) => document.elementsFromPoint(x, y).map(item => item instanceof HTMLElement ? item.closest<HTMLElement>('[data-anchor]') : null).find(Boolean) ?? null;
  const point = (event: { clientX: number; clientY: number }) => { const box = page.current?.getBoundingClientRect(); return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }; };
  return <div className="flex w-full max-w-[880px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-xl">
    <header className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
      <img src="/favicon.png" alt="" width={20} height={20} className="rounded-md" />
      <p className="min-w-0 flex-1 truncate text-caption"><strong>Bradley</strong> is sharing <span className="font-mono">news.ycombinator.com</span> · 52 min left</p>
      <span className="flex -space-x-1.5">{[['B', '#525252'], ['A', PURPLE]].map(([initial, color]) => <span key={initial} className="flex size-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white" style={{ background: color }}>{initial}</span>)}</span>
      <Button variant={commenting ? 'primary' : 'secondary'} size="compact" leadingIcon={CommentGlyph} onClick={() => { setCommenting(value => !value); setHover(null); setDraft(null); }}>{commenting ? 'Commenting' : 'Comment'}</Button>
    </header>
    <div ref={page} className="relative h-[380px] select-none bg-[#f6f6ef] text-[13px] text-neutral-800" style={{ cursor: commenting ? 'crosshair' : 'default', boxShadow: commenting ? `inset 0 0 0 3px ${PURPLE}` : undefined }}
      onMouseMove={event => {
        if (!commenting) return;
        if (drag) { const p = point(event); setDrag(current => current && { ...current, w: p.x - current.x, h: p.y - current.y }); return; }
        const element = anchorAt(event.clientX, event.clientY);
        setHover(element ? local(element) : null);
      }}
      onMouseDown={event => { if (!commenting || draft) return; const p = point(event); setDrag({ ...p, w: 0, h: 0 }); }}
      onMouseUp={event => {
        if (!commenting || !drag) return;
        const area = drag; setDrag(null);
        if (Math.abs(area.w) > 12 && Math.abs(area.h) > 12) { setDraft({ left: Math.min(area.x, area.x + area.w), top: Math.min(area.y, area.y + area.h), width: Math.abs(area.w), height: Math.abs(area.h), label: 'an area of the page', region: true }); return; }
        const element = anchorAt(event.clientX, event.clientY);
        if (element) setDraft(local(element));
      }}>
      <div className="bg-[#ff6600] px-4 py-1.5 text-[13px] font-bold text-black" data-anchor="banner “Hacker News”">Hacker News <span className="font-normal">new | past | comments | ask | show</span></div>
      <ol className="flex flex-col gap-2.5 px-4 py-3">{stories.map((title, index) => <li key={title} className="flex gap-1.5"><span className="text-neutral-400">{index + 1}.</span><div><span className="w-fit" data-anchor={`link “${title}”`}>{title}</span><p className="text-[11px] text-neutral-500">{120 - index * 17} points · {index + 2} hours ago · <span data-anchor={`link “${40 + index * 9} comments”`}>{40 + index * 9} comments</span></p></div></li>)}</ol>
      <Pointer point={{ x: 470, y: 74 }} color={BLUE} label="main · agent" pressed={false} />
      <Pointer point={{ x: 640, y: 210 }} color="#525252" label="Bradley" pressed={false} />
      <span className="pointer-events-none absolute rounded-full rounded-bl-none px-1.5 text-[10px] font-bold leading-5 text-white" style={{ left: 330, top: 102, background: BLUE }}>1</span>
      {commenting && hover && !draft && !drag ? <><span className="pointer-events-none absolute rounded" style={{ left: hover.left - 3, top: hover.top - 2, width: hover.width + 6, height: hover.height + 4, outline: `2px dashed ${PURPLE}` }} /><span className="pointer-events-none absolute rounded px-1.5 py-0.5 text-[10px] text-white" style={{ left: hover.left - 3, top: hover.top - 22, background: PURPLE }}>{hover.label}</span></> : null}
      {drag ? <span className="pointer-events-none absolute rounded" style={{ left: Math.min(drag.x, drag.x + drag.w), top: Math.min(drag.y, drag.y + drag.h), width: Math.abs(drag.w), height: Math.abs(drag.h), outline: `2px dashed ${PURPLE}`, background: `${PURPLE}14` }} /> : null}
      {draft ? <>
        <span className="pointer-events-none absolute rounded" style={{ left: draft.left - 3, top: draft.top - 2, width: draft.width + 6, height: draft.height + 4, outline: `2px solid ${PURPLE}`, background: draft.region ? `${PURPLE}14` : undefined }} />
        <div onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()} className="absolute z-30 flex w-72 cursor-auto flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-[12px] shadow-2xl" style={{ left: Math.min(draft.left + draft.width + 12, 560), top: Math.max(8, Math.min(draft.top - 8, 230)) }}>
          <p className="text-[11px] text-neutral-500">On {draft.label} · as <strong className="text-neutral-700">Ana (guest)</strong></p>
          <div className="rounded-lg border border-neutral-300 px-2 py-1.5 text-neutral-400">Write a comment…</div>
          <div className="flex items-center gap-2"><button type="button" className="text-[11px] text-neutral-500" onClick={() => setDraft(null)}>Cancel</button><span className="flex-1" /><button type="button" className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white" style={{ background: PURPLE }} onClick={() => setDraft(null)}>Comment</button></div>
        </div>
      </> : null}
      <Pointer point={{ x: 250, y: 300 }} color={PURPLE} label="You (Ana)" pressed={false} />
    </div>
    <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">{commenting ? 'Hover to see what a comment would attach to, click it, or drag across an area. Bradley sees your comment on the page in his Chrome and in his workspace.' : 'Watching live · your pointer is visible to everyone here'}</p>
  </div>;
}

const LENGTH = 252;
const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
type TimedComment = { n: number; at: number; anchor: string; who: string; text: string; later?: boolean; x: number; y: number };
const timedComments: TimedComment[] = [
  { n: 1, at: 31, anchor: 'textbox “Telephone:”', who: 'Bradley', text: 'Telephone only matters for delivery orders.', x: 290, y: 100 },
  { n: 2, at: 125, anchor: 'area around “Pizza Size”', who: 'Bradley', text: 'Make Medium the default size here.', x: 300, y: 198 },
  { n: 3, at: 190, anchor: 'textbox “E-mail address:” · from the recording, approximate', who: 'Ana (guest)', text: 'Should this say it is optional?', later: true, x: 290, y: 162 },
];
const stepTimes = [4, 22, 48, 77, 101, 160, 214];

function SavedSession() {
  const [time, setTime] = useState(140);
  const [hover, setHover] = useState(false);
  const visible = timedComments.filter(comment => comment.at <= time);
  const active = visible.at(-1);
  return <div className="flex w-full max-w-[880px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-xl">
    <header className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
      <img src="/favicon.png" alt="" width={20} height={20} className="rounded-md" />
      <p className="min-w-0 flex-1 truncate text-caption"><strong>Pizza form review</strong> · capture from Bradley · {mmss(LENGTH)} · whole recording</p>
      <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted-foreground">Bradley&apos;s Chrome is offline · recording</span>
    </header>
    <div className="flex h-[330px]">
      <aside className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2">
        {timedComments.map(comment => <button key={comment.n} type="button" onClick={() => setTime(comment.at)} className={`flex gap-2 rounded-lg p-2 text-left text-caption ${active?.n === comment.n ? 'bg-surface-3' : 'hover:bg-hover'}`}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[10px] font-bold text-white" style={{ background: comment.later ? '#525252' : PURPLE }}>{comment.n}</span>
          <span className="min-w-0"><span className="block">{comment.text}</span><span className="block text-[11px] text-muted-foreground">{comment.who} · at {mmss(comment.at)}{comment.later ? ' · added later' : ''}</span></span>
        </button>)}
      </aside>
      <div className="relative flex-1 cursor-crosshair bg-white text-[13px] text-neutral-900" onMouseLeave={() => setHover(false)}>
        <div className="flex flex-col gap-3 p-6">
          {['Customer name:', 'Telephone:', 'E-mail address:'].map(label => <label key={label} className="flex flex-col gap-1">{label}<span onMouseEnter={() => setHover(label === 'E-mail address:')} className="h-7 w-64 rounded border border-neutral-300 px-2 leading-7">{label === 'Customer name:' && time > 22 ? 'Ada' : ''}</span></label>)}
          <span>Pizza Size ○ Small {time > 101 ? '◉' : '○'} Medium ○ Large</span>
        </div>
        {hover ? <><span className="pointer-events-none absolute rounded" style={{ left: 21, top: 150, width: 262, height: 34, outline: `2px dashed ${PURPLE}` }} /><span className="pointer-events-none absolute rounded px-1.5 py-0.5 text-[10px] text-white" style={{ left: 21, top: 128, background: PURPLE }}>textbox “E-mail address:” · from the recording</span></> : null}
        {visible.map(comment => <span key={comment.n} className="absolute flex size-6 items-center justify-center rounded-full rounded-bl-none text-[11px] font-bold text-white shadow" style={{ left: comment.x, top: comment.y, background: comment.later ? '#525252' : PURPLE }}>{comment.n}</span>)}
        {active ? <div className="absolute right-3 top-3 flex w-60 flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-[12px] shadow-xl">
          <p className="text-[11px] text-neutral-500">On {active.anchor} · at {mmss(active.at)}</p>
          <p><strong>{active.who}</strong> · {active.text}</p>
          <div className="rounded-lg border border-neutral-300 px-2 py-1.5 text-neutral-400">Reply as Ana (guest)…</div>
        </div> : null}
      </div>
    </div>
    <div className="flex items-center gap-3 border-t border-border px-4 py-2.5">
      <button type="button" className="flex size-7 items-center justify-center rounded-full bg-neutral-900 text-[11px] text-white" aria-label="Play">▶</button>
      <span className="w-20 text-caption tabular-nums">{mmss(time)} / {mmss(LENGTH)}</span>
      <div className="relative h-8 flex-1 cursor-pointer" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setTime(Math.round((event.clientX - box.left) / box.width * LENGTH)); }}>
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-3" />
        <span className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-neutral-500" style={{ width: `${time / LENGTH * 100}%` }} />
        {stepTimes.map(at => <span key={at} title="step" className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-neutral-400" style={{ left: `${at / LENGTH * 100}%` }} />)}
        {timedComments.map(comment => <span key={comment.n} className="absolute top-0 flex size-4 -translate-x-1/2 items-center justify-center rounded-full rounded-bl-none text-[9px] font-bold text-white" style={{ left: `${comment.at / LENGTH * 100}%`, background: comment.later ? '#525252' : PURPLE }}>{comment.n}</span>)}
        <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-900 shadow" style={{ left: `${time / LENGTH * 100}%` }} />
      </div>
      <Button variant="secondary" size="compact" leadingIcon={CommentGlyph}>Comment at {mmss(time)}</Button>
    </div>
  </div>;
}

export function ShareGuestMock() {
  const [greeting, setGreeting] = useState<Greeting>('guest');
  const states: Greeting[] = ['guest', 'signed-in', 'session', 'ended'];
  return <PageCanvas className="max-w-6xl">
    <PageHeader kicker="Share link" title="Joining a shared tab" description="What someone sees when they open Bradley's share link: a greeting, then the live tab, where they point and comment the same way Bradley does in Chrome." />
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-subtitle font-medium">Greeting</h2>
          <TabsSubtle size="compact" selectedIndex={states.indexOf(greeting)} onSelect={index => setGreeting(states[index] ?? 'guest')} idPrefix="mock-greeting" aria-label="Greeting state"><TabsSubtleItem index={0} label="Guest" /><TabsSubtleItem index={1} label="Signed in to GitSpace" /><TabsSubtleItem index={2} label="Shared capture" /><TabsSubtleItem index={3} label="Ended" /></TabsSubtle></div>
        <div className="flex justify-center rounded-2xl bg-surface-2 py-10"><GreetingCard state={greeting} onJoin={() => document.getElementById('guest-viewer')?.scrollIntoView({ behavior: 'smooth' })} /></div>
        <Note>The page opens at <span className="font-mono">bradleat.gitspace.sh/s/…#secret</span>; the secret stays in the fragment and is exchanged for a short session when they press Join, so a link preview bot that fetches the page joins nothing. It names the tab and what they may do before anything is shown live.</Note>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-subtitle font-medium">A shared capture, browser offline</h2>
        <SavedSession />
        <Note>A comment session is a capture: the whole session is recorded, with the page layout kept alongside the frames. People scrub it, see comments appear on the timeline where they were made, and add their own at any moment; hovering or clicking the frame finds the element from the layout kept at that time, marked approximate. When the live page is open again, those anchors are matched to real elements. Live sharing of the tab is a separate link.</Note>
      </section>
      <section id="guest-viewer" className="flex flex-col gap-3">
        <h2 className="text-subtitle font-medium">In the share: commenting</h2>
        <GuestViewer />
        <Note>Yes, the same element picking as in Chrome. The guest only has frames of the page, so the viewer sends the pointer position (it already does, for presence) and the live tab answers what is under it (<span className="font-mono">DOM.getNodeForLocation</span> plus its box and accessible name); the outline follows with a short lag. A click stores the same anchor a comment made in Chrome gets (§9); a dragged area stores its bounds and a crop. Guest comments carry the name they gave, marked as a guest.</Note>
      </section>
    </div>
  </PageCanvas>;
}
