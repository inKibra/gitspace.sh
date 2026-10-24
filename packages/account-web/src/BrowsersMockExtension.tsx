// Throwaway Batch 18 mockup, part 3: the extension. Toolbar icon, popup, in-page toolbar, the agent's cursor,
// comments on pages and recording a skill. Static data; the cursor and the recording are simulated.
import { Button, InputCopy, Switch, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import { MessagePlusSquare, Recording01 } from '@untitledui/icons';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';

const BLUE = '#1a73e8';
const PURPLE = '#a142f4';
const RED = '#dc2626';

function Caption({ children }: { children: ReactNode }) { return <p className="text-caption text-muted-foreground">{children}</p>; }
function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-caption text-muted-foreground"><strong className="text-foreground">Design note · </strong>{children}</p>;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Toolbar icon ──

type IconState = 'off' | 'on' | 'acting' | 'attention';
function ExtensionIcon({ state, large }: { state: IconState; large?: boolean }) {
  const size = large ? 40 : 20;
  const ring: Record<IconState, string> = { off: 'transparent', on: 'transparent', acting: BLUE, attention: '#f59e0b' };
  return <span className="relative inline-flex items-center justify-center rounded-full p-[3px]" style={{ boxShadow: `0 0 0 2px ${ring[state]}` }}>
    <img src="/favicon.png" alt="" width={size} height={size} className={state === 'acting' ? 'animate-pulse' : ''} style={{ filter: state === 'off' ? 'grayscale(1) opacity(.45)' : undefined, borderRadius: 6 }} />
    {state === 'on' ? <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white bg-[#22c55e]" /> : null}
    {state === 'acting' ? <span className="absolute -right-1.5 -top-1.5 rounded-full px-1 text-[9px] font-bold leading-[14px] text-white" style={{ background: BLUE }}>1</span> : null}
    {state === 'attention' ? <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[#f59e0b] px-1 text-[9px] font-bold leading-[14px] text-white">!</span> : null}
    {state === 'off' ? <span className="absolute inset-x-0 top-1/2 h-[2px] -rotate-45 bg-neutral-500" /> : null}
  </span>;
}

// ── Popup ──

type PopupTab = { host: string; group?: string };
type Capability = 'view' | 'comment';
function Popup({ on, onToggle, tab = { host: 'news.ycombinator.com' }, watching }: { on: boolean; onToggle(): void; tab?: PopupTab; watching?: string }) {
  const [people, setPeople] = useState<Record<Capability, boolean>>({ view: true, comment: true });
  return <div className="flex w-[360px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1 text-left shadow-xl">
    <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
      <img src="/favicon.png" alt="" width={24} height={24} className="rounded-md" style={{ filter: on ? undefined : 'grayscale(1)' }} />
      <div className="min-w-0 flex-1"><p className="text-body font-semibold">GitSpace</p><p className="truncate text-caption text-muted-foreground">bradleat.gitspace.sh · Studio desktop</p></div>
      <Switch checked={on} label={on ? 'On' : 'Off'} onToggle={onToggle} />
    </header>
    {on ? <>
      <div className="flex items-center gap-2 bg-[#22c55e]/10 px-4 py-2 text-caption"><StatusDot color="green" />Connected · approved in GitSpace and ToneTempo</div>
      <section className="flex flex-col gap-1 px-4 py-3">
        <h3 className="text-caption font-semibold text-muted-foreground">Using this Chrome</h3>
        {[
          { color: BLUE, workspace: 'Cross-machine browser relay', project: 'GitSpace', activity: 'main · filling “Customer name”', live: true },
          { color: PURPLE, workspace: 'Challenges and streaks', project: 'ToneTempo', activity: 'idle · 2 tabs', live: false },
        ].map(row => <div key={row.workspace} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-hover">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
          <div className="min-w-0 flex-1"><p className="truncate text-caption font-medium">{row.workspace} <span className="font-normal text-muted-foreground">· {row.project}</span></p><p className={`truncate text-[11px] ${row.live ? 'text-foreground' : 'text-muted-foreground'}`}>{row.live ? '▶ ' : ''}{row.activity}</p></div>
          {row.live ? <Button variant="secondary" size="compact">Stop</Button> : <Button variant="ghost" size="compact">Show</Button>}
        </div>)}
      </section>
      <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <h3 className="text-caption font-semibold text-muted-foreground">This tab · {tab.host}{tab.group ? <> · in <span style={{ color: BLUE }}>{tab.group}</span></> : null}</h3>
        <InputCopy value="https://bradleat.gitspace.sh/s/7Kq2mX9fV1#c8Zr4tWb0yLe" displayValue="bradleat.gitspace.sh/s/7Kq2mX9f…" />
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">People can</span>
          {(['view', 'comment'] satisfies Capability[]).map(capability => <button key={capability} type="button" disabled={capability === 'view'} onClick={() => setPeople(current => ({ ...current, [capability]: !current[capability] }))} className={`rounded-full border px-2 py-0.5 ${people[capability] ? 'border-transparent text-white' : 'border-border text-muted-foreground'}`} style={people[capability] ? { background: BLUE } : undefined}>{people[capability] ? '✓ ' : ''}{capability}</button>)}
          <span className="ml-auto text-muted-foreground">for 1 hour ▾</span>
        </div>
        <p className="text-[11px] text-muted-foreground">Paste it into one of your workspaces to give its agent this tab, or send it to someone to watch and point{people.comment ? ' and comment' : ''}. Only you and your agent ever click or type. Ends when it expires, when you stop it, or when the tab closes.</p>
        {watching ? <div className="flex items-center gap-2 rounded-lg bg-surface-3 px-2.5 py-1.5 text-caption"><StatusDot color="green" pulse /><span className="min-w-0 flex-1 truncate">{watching}</span><Button variant="ghost" size="compact">Stop sharing</Button></div> : null}
        {tab.group ? <div className="flex items-center gap-2"><span className="shrink-0 whitespace-nowrap"><Button variant="ghost" size="compact">Remove from group</Button></span><span className="text-[11px] text-muted-foreground">Drag it to another group in Chrome to move it.</span></div> : null}
      </section>
      <footer className="flex items-center gap-2 border-t border-border px-4 py-2 text-caption"><Button variant="ghost" size="compact">Open GitSpace</Button><span className="flex-1" /><Button variant="ghost" size="compact">Identity &amp; pairing</Button></footer>
    </> : <div className="flex flex-col gap-2 px-4 py-4">
      <p className="text-body font-medium">Off: agents can&apos;t use this Chrome</p>
      <p className="text-caption text-muted-foreground">Running scripts were stopped. Tab groups stay; nothing resumes until an agent asks again.</p>
      <div className="flex gap-2"><Button variant="primary" size="compact" onClick={onToggle}>Turn on</Button><Button variant="ghost" size="compact">Off for 1 hour</Button></div>
    </div>}
  </div>;
}

// ── Humanised pointer motion ──

type Point = { x: number; y: number };
/** Fitts-style duration: longer and further targets take longer, small hops stay quick. */
const travelMs = (from: Point, to: Point) => 260 + 170 * Math.log2(1 + Math.hypot(to.x - from.x, to.y - from.y) / 22);
const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return { x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x, y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y };
}
function tween(ms: number, ease: (t: number) => number, frame: (t: number) => void, alive: () => boolean) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const start = performance.now();
  const step = (now: number) => {
    if (!alive()) return resolve();
    const t = Math.min(1, (now - start) / ms);
    frame(ease(t));
    if (t < 1) requestAnimationFrame(step); else resolve();
  };
  requestAnimationFrame(step);
  return promise;
}
/** A curved path that bows to one side, overshoots slightly, then settles on the target. */
async function glide(from: Point, to: Point, bow: number, set: (point: Point) => void, alive: () => boolean) {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / length, y: dx / length };
  const curve = length * 0.22 * bow;
  const overshoot = Math.min(9, length * 0.04);
  const end = { x: to.x + dx / length * overshoot, y: to.y + dy / length * overshoot };
  const p1 = { x: from.x + dx * 0.25 + normal.x * curve, y: from.y + dy * 0.25 + normal.y * curve };
  const p2 = { x: from.x + dx * 0.8 + normal.x * curve * 0.35, y: from.y + dy * 0.8 + normal.y * curve * 0.35 };
  await tween(travelMs(from, to), easeInOutCubic, t => set(bezier(from, p1, p2, end, t)), alive);
  await tween(140, easeOut, t => set({ x: end.x + (to.x - end.x) * t, y: end.y + (to.y - end.y) * t }), alive);
}
function targetPoint(page: HTMLElement, element: HTMLElement, across = 0.3): Point {
  const box = page.getBoundingClientRect(), rect = element.getBoundingClientRect();
  return { x: rect.left - box.left + Math.min(rect.width * across, 46), y: rect.top - box.top + rect.height * 0.55 };
}

export function Pointer({ point, color, label, pressed }: { point: Point; color: string; label?: string; pressed: boolean }) {
  return <div className="pointer-events-none absolute left-0 top-0 z-20" style={{ transform: `translate(${point.x}px, ${point.y}px)` }}>
    <svg width="22" height="24" viewBox="0 0 22 24" style={{ transform: `scale(${pressed ? 0.86 : 1})`, transformOrigin: '2px 2px', transition: 'transform 90ms', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' }}>
      <path d="M2 2 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z" fill={color} stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
    {label ? <span className="absolute left-4 top-5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white shadow" style={{ background: color }}>{label}</span> : null}
  </div>;
}
function Ripples({ ripples, color }: { ripples: readonly (Point & { id: number })[]; color: string }) {
  return <>{ripples.map(ripple => <span key={ripple.id} className="pointer-events-none absolute z-10 size-8 rounded-full" style={{ left: ripple.x - 16, top: ripple.y - 16, border: `2px solid ${color}`, animation: 'gs-ripple 520ms ease-out forwards' }} />)}</>;
}

// ── The page (httpbin's pizza form) ──

type Form = { name: string; email: string; size: string; bacon: boolean; cheese: boolean };
const EMPTY: Form = { name: '', email: '', size: '', bacon: false, cheese: false };
type Targets = Record<'name' | 'phone' | 'email' | 'medium' | 'bacon' | 'cheese' | 'submit' | 'sizes', RefObject<HTMLElement | null>>;
function useTargets(): Targets {
  return { name: useRef(null), phone: useRef(null), email: useRef(null), medium: useRef(null), bacon: useRef(null), cheese: useRef(null), submit: useRef(null), sizes: useRef(null) };
}
function PizzaForm({ form, targets, focus, flash }: { form: Form; targets: Targets; focus: string | null; flash: string | null }) {
  const field = (key: 'name' | 'phone' | 'email', label: string, value: string) => <label className="flex flex-col gap-1">{label}
    <span ref={targets[key] as RefObject<HTMLSpanElement>} data-anchor={`textbox “${label}”`} className="relative block h-8 w-80 rounded border bg-white px-2 leading-8 transition-shadow" style={focus === key ? { borderColor: BLUE, boxShadow: `0 0 0 3px ${BLUE}33` } : flash === key ? { borderColor: RED, boxShadow: `0 0 0 3px ${RED}33` } : { borderColor: '#d4d4d4' }}>{value}{focus === key ? <span className="animate-pulse">|</span> : null}</span></label>;
  const box = (key: 'bacon' | 'cheese', label: string, checked: boolean) => <span ref={targets[key] as RefObject<HTMLSpanElement>} data-anchor={`checkbox “${label}”`} className="inline-flex items-center gap-1.5 rounded px-1" style={flash === key ? { boxShadow: `0 0 0 2px ${RED}` } : undefined}><span className="flex size-4 items-center justify-center rounded-[3px] border border-neutral-400 text-[11px]">{checked ? '✓' : ''}</span>{label}</span>;
  return <div className="flex flex-col gap-3.5 p-7 text-[14px] text-neutral-900">
    {field('name', 'Customer name:', form.name)}
    {field('phone', 'Telephone:', '')}
    {field('email', 'E-mail address:', form.email)}
    <div ref={targets.sizes as RefObject<HTMLDivElement>} data-anchor="group “Pizza Size”" className="flex items-center gap-3">Pizza Size {['Small', 'Medium', 'Large'].map(size => <span key={size} ref={size === 'Medium' ? targets.medium as RefObject<HTMLSpanElement> : undefined} className="inline-flex items-center gap-1"><span className="flex size-4 items-center justify-center rounded-full border border-neutral-400">{form.size === size ? <span className="size-2 rounded-full bg-neutral-800" /> : null}</span>{size}</span>)}</div>
    <div className="flex items-center gap-3">Toppings {box('bacon', 'Bacon', form.bacon)}{box('cheese', 'Extra Cheese', form.cheese)}</div>
    <span ref={targets.submit as RefObject<HTMLSpanElement>} data-anchor="button “Submit order”" className="w-fit rounded border border-neutral-400 bg-neutral-100 px-3 py-1" style={flash === 'submit' ? { boxShadow: `0 0 0 2px ${RED}` } : undefined}>Submit order</span>
  </div>;
}

// ── Modes ──

type Mode = 'acting' | 'idle' | 'you' | 'capture' | 'capture-comment' | 'saved';
const MODES: { mode: Mode; label: string }[] = [
  { mode: 'acting', label: 'Agent acting' }, { mode: 'idle', label: 'Idle' }, { mode: 'you', label: 'You took over' },
  { mode: 'capture', label: 'Capturing' }, { mode: 'capture-comment', label: 'Capturing: commenting' }, { mode: 'saved', label: 'Capture saved' },
];

/** The agent filling the form with humanised motion, looping. */
function useAgentScript(active: boolean, page: RefObject<HTMLDivElement | null>, targets: Targets) {
  const [point, setPoint] = useState<Point>({ x: 640, y: 40 });
  const [pressed, setPressed] = useState(false);
  const [ripples, setRipples] = useState<(Point & { id: number })[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [focus, setFocus] = useState<string | null>(null);
  const [doing, setDoing] = useState('Reading the page');
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const live = () => alive;
    let at: Point = { x: 640, y: 40 };
    const set = (next: Point) => { at = next; setPoint(next); };
    const click = async () => { if (!alive) throw new Error('stopped'); setPressed(true); setRipples(current => [...current, { ...at, id: performance.now() }]); await sleep(110); setPressed(false); };
    const move = async (key: keyof Targets, bow: number, across?: number) => { const element = targets[key].current, root = page.current; if (element && root) await glide(at, targetPoint(root, element, across), bow, set, live); if (!alive) throw new Error('stopped'); };
    void (async () => {
      while (alive) {
        setForm(EMPTY); setFocus(null); set({ x: 640, y: 40 }); setDoing('Reading the page'); await sleep(900);
        setDoing('Filling “Customer name”'); await move('name', 1); await click(); setFocus('name');
        for (const [index, character] of [...'Ada'].entries()) { if (!alive) return; await sleep(110 + ((index * 37) % 70)); setForm(current => ({ ...current, name: current.name + character })); }
        await sleep(380); setFocus(null);
        setDoing('Choosing “Medium”'); await move('medium', -0.8, 0.1); await click(); setForm(current => ({ ...current, size: 'Medium' })); await sleep(300);
        setDoing('Ticking “Bacon”'); await move('bacon', 0.9, 0.12); await click(); setForm(current => ({ ...current, bacon: true })); await sleep(260);
        setDoing('Ticking “Extra Cheese”'); await move('cheese', -0.5, 0.1); await click(); setForm(current => ({ ...current, cheese: true })); await sleep(420);
        setDoing('Pointing at “Submit order” · waiting for you'); await move('submit', 1.1, 0.5); await sleep(2200);
      }
    })().catch(() => {});
    return () => { alive = false; };
  }, [active]);
  useEffect(() => { if (!ripples.length) return; const timer = setTimeout(() => setRipples(current => current.slice(1)), 600); return () => clearTimeout(timer); }, [ripples]);
  return { point, pressed, ripples, form, focus, doing };
}

type Step = { at: string; text: string; detail?: string; mutation?: boolean; comment?: boolean };
/** The person's demonstration, simulated: their pointer moves and each action becomes a step. */
function useRecording(active: boolean, page: RefObject<HTMLDivElement | null>, targets: Targets) {
  const [point, setPoint] = useState<Point>({ x: 600, y: 300 });
  const [steps, setSteps] = useState<Step[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [flash, setFlash] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const live = () => alive;
    let at: Point = { x: 600, y: 300 };
    const set = (next: Point) => { at = next; setPoint(next); };
    const move = async (key: keyof Targets, bow: number, across?: number) => { const element = targets[key].current, root = page.current; if (element && root) await glide(at, targetPoint(root, element, across), bow, set, live); if (!alive) throw new Error('stopped'); };
    const record = async (key: string, step: Step) => { if (!alive) throw new Error('stopped'); setFlash(key); setSteps(current => [...current, step]); await sleep(450); setFlash(null); };
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    void (async () => {
      setSteps([{ at: '0:00', text: 'Open httpbin.org/forms/post', detail: 'page.goto' }]); setForm(EMPTY); setSeconds(0);
      await sleep(900);
      await move('name', -0.7); setForm(current => ({ ...current, name: 'Ada' })); await record('name', { at: '0:03', text: 'Fill “Customer name”', detail: "getByRole('textbox', { name: 'Customer name:' }).fill('Ada')" });
      await sleep(500); await move('phone', 0.6); await record('phone', { at: '0:05', text: '“Telephone only matters for delivery orders”', detail: 'comment on textbox “Telephone:”', comment: true });
      await sleep(400); await move('email', 0.6); setForm(current => ({ ...current, email: '•••••••••••' })); await record('email', { at: '0:07', text: 'Fill “E-mail address” · masked', detail: "…fill(‹secret›)" });
      await sleep(500); await move('bacon', -1, 0.12); setForm(current => ({ ...current, bacon: true })); await record('bacon', { at: '0:10', text: 'Tick “Bacon”', detail: "getByRole('checkbox', { name: 'Bacon' }).check()" });
      await sleep(600); await move('submit', 0.8, 0.5); await record('submit', { at: '0:14', text: 'Click “Submit order”', detail: "getByRole('button', { name: 'Submit order' }).click()" });
      if (alive) setSteps(current => [...current, { at: '0:14', text: 'POST /post → 200', detail: 'mutating request', mutation: true }]);
    })().catch(() => {});
    return () => { alive = false; clearInterval(timer); };
  }, [active]);
  return { point, steps, form, flash, seconds };
}

// ── In-page toolbar ──

function Bar({ children, tone }: { children: ReactNode; tone?: string }) {
  return <div className="absolute inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-2.5 whitespace-nowrap rounded-2xl border border-neutral-200 bg-white px-3 py-2 text-[13px] text-neutral-800 shadow-2xl" style={tone ? { boxShadow: `0 10px 30px rgba(0,0,0,.18), 0 0 0 1px ${tone}55` } : undefined}>{children}</div>;
}
function BarButton({ children, onClick, dark, icon }: { children: ReactNode; onClick?(): void; dark?: boolean; icon?: ReactNode }) {
  return <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${dark ? 'bg-neutral-900 text-white' : 'border border-neutral-300 hover:bg-neutral-50'}`}>{icon}{children}</button>;
}
const Divider = () => <span className="h-6 w-px bg-neutral-200" />;
const ToolIcons = ({ onMode }: { onMode(mode: Mode): void }) => <>
  <BarButton onClick={() => onMode('capture-comment')} icon={<MessagePlusSquare width={14} height={14} />}>Comment</BarButton>
  <BarButton onClick={() => onMode('capture')} icon={<Recording01 width={14} height={14} />}>Capture</BarButton>
</>;
const Logo = ({ dot }: { dot?: string }) => <span className="relative shrink-0"><img src="/favicon.png" alt="" width={22} height={22} className="rounded-md" />{dot ? <span className="absolute -bottom-0.5 -right-0.5 size-2.5 animate-pulse rounded-full border-2 border-white" style={{ background: dot }} /> : null}</span>;

// ── Comments ──

type Pin = { id: number; x: number; y: number; anchor: string; draft?: boolean };
function CommentLayer({ page }: { page: RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [open, setOpen] = useState<number>(1);
  const [region, setRegion] = useState<DOMRect | null>(null);
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const phone = root.querySelector<HTMLElement>('[data-anchor^="textbox “Telephone"]');
    if (phone) { const p = targetPoint(root, phone, 1); setPins([{ id: 1, x: p.x + 280, y: p.y - 16, anchor: 'textbox “Telephone:”' }]); }
    const sizes = root.querySelector<HTMLElement>('[data-anchor^="group “Pizza Size"]');
    if (sizes) { const box = root.getBoundingClientRect(), rect = sizes.getBoundingClientRect(); setRegion(new DOMRect(rect.left - box.left - 6, rect.top - box.top - 5, rect.width + 12, rect.height + 10)); }
  }, []);
  const local = (rect: DOMRect) => { const box = page.current?.getBoundingClientRect(); return box ? new DOMRect(rect.left - box.left, rect.top - box.top, rect.width, rect.height) : rect; };
  const anchorOf = (target: EventTarget | null) => target instanceof HTMLElement ? target.closest<HTMLElement>('[data-anchor]') : null;
  return <div className="absolute inset-0 z-20" style={{ cursor: 'crosshair' }}
    onMouseMove={event => { const element = anchorOf(document.elementsFromPoint(event.clientX, event.clientY).find(item => item instanceof HTMLElement && item.closest('[data-anchor]')) ?? null); setHover(element ? local(element.getBoundingClientRect()) : null); }}
    onClick={event => {
      const element = anchorOf(document.elementsFromPoint(event.clientX, event.clientY).find(item => item instanceof HTMLElement && item.closest('[data-anchor]')) ?? null);
      if (!element || !page.current) return;
      const rect = local(element.getBoundingClientRect());
      const id = Math.max(2, ...pins.map(pin => pin.id)) + 1;
      setPins(current => [...current.filter(pin => !pin.draft), { id, x: rect.right - 10, y: rect.top - 10, anchor: element.dataset.anchor ?? 'element', draft: true }]);
      setOpen(id);
    }}>
    {hover ? <span className="pointer-events-none absolute rounded" style={{ left: hover.left - 3, top: hover.top - 3, width: hover.width + 6, height: hover.height + 6, outline: `2px dashed ${BLUE}` }} /> : null}
    {region ? <><span className="pointer-events-none absolute rounded" style={{ left: region.left, top: region.top, width: region.width, height: region.height, outline: `2px dashed ${PURPLE}`, background: `${PURPLE}10` }} />
      <PinBadge x={region.right - 10} y={region.top - 12} n={2} color={PURPLE} onClick={() => setOpen(2)} /></> : null}
    {pins.map(pin => <PinBadge key={pin.id} x={pin.x} y={pin.y} n={pin.id} color={BLUE} onClick={() => setOpen(pin.id)} />)}
    {pins.filter(pin => pin.id === open).map(pin => <Thread key={pin.id} pin={pin} />)}
    {open === 2 && region ? <Thread pin={{ id: 2, x: region.right - 10, y: region.top - 12, anchor: 'area around group “Pizza Size”' }} region /> : null}
  </div>;
}
function PinBadge({ x, y, n, color, onClick }: { x: number; y: number; n: number; color: string; onClick(): void }) {
  return <button type="button" onClick={event => { event.stopPropagation(); onClick(); }} className="absolute z-30 flex size-6 items-center justify-center rounded-full rounded-bl-none text-[11px] font-bold text-white shadow-md" style={{ left: x, top: y, background: color }}>{n}</button>;
}
function Thread({ pin, region }: { pin: Pin; region?: boolean }) {
  return <div onClick={event => event.stopPropagation()} className="absolute z-40 flex w-72 cursor-auto flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-[12px] text-neutral-800 shadow-2xl" style={{ left: Math.min(pin.x + 30, 540), top: Math.max(8, pin.y - 10) }}>
    <p className="text-[11px] text-neutral-500">On {pin.anchor} · files into <strong className="text-neutral-700">Cross-machine browser relay</strong></p>
    {pin.draft ? null : region
      ? <Message who="Bradley" when="5 min" text="Make Medium the default size here." />
      : <>
        <Message who="Bradley" when="3 min" text="This should accept +44 numbers; it rejects them." />
        <Message who="main" when="1 min" agent text="Found it: the pattern only allows digits. Fixed in a3f9c21; reload to check." />
      </>}
    <div className="rounded-lg border border-neutral-300 px-2 py-1.5 text-neutral-400">{pin.draft ? 'Write a comment…' : 'Reply…'}</div>
    <div className="flex items-center gap-2">{pin.draft ? null : <button type="button" className="text-[11px] text-neutral-500">Resolve</button>}<span className="flex-1" /><button type="button" className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white" style={{ background: BLUE }}>{pin.draft ? 'Comment' : 'Reply'}</button></div>
  </div>;
}
function Message({ who, when, text, agent }: { who: string; when: string; text: string; agent?: boolean }) {
  return <div className="flex gap-2"><span className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: agent ? BLUE : '#525252' }}>{agent ? 'AI' : who[0]}</span><div><p className="text-[11px]"><strong>{who}</strong> <span className="text-neutral-400">· {when} ago</span></p><p>{text}</p></div></div>;
}

// ── Skill written ──

function SavedCard({ onRun }: { onRun(): void }) {
  const tracks = ['5 steps', '1 comment', 'video 0:14 · sound', 'page layout'];
  return <div className="absolute inset-x-0 bottom-4 z-30 mx-auto flex w-[560px] flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 text-[13px] text-neutral-800 shadow-2xl">
    <div className="flex items-center gap-2.5"><Logo /><div className="min-w-0 flex-1"><p className="font-semibold">Capture saved: Order a pizza <span className="font-normal text-neutral-400">✎</span></p><p className="text-[12px] text-neutral-500">In the Browser tab of Cross-machine browser relay · not in the repository</p></div></div>
    <div className="flex flex-wrap gap-1.5">{tracks.map(track => <span key={track} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700">{track}</span>)}</div>
    <p className="text-[12px] text-neutral-600">Mention <span className="rounded bg-neutral-100 px-1 font-medium">@Order a pizza</span> in the chat: the agent can turn it into a skill, follow up on your comment, or watch the moment you mean. Sharing sends the whole recording.</p>
    <div className="flex items-center gap-2"><BarButton>Copy mention</BarButton><BarButton>Share</BarButton><BarButton onClick={onRun}>Replay steps</BarButton><span className="flex-1" /><BarButton dark>Open in GitSpace</BarButton></div>
  </div>;
}

// ── Chrome window ──

function FakeChrome({ mode, onMode }: { mode: Mode; onMode(mode: Mode): void }) {
  const page = useRef<HTMLDivElement | null>(null);
  const targets = useTargets();
  const agent = useAgentScript(mode === 'acting', page, targets);
  const recording = useRecording(mode === 'capture', page, targets);
  const videoSeconds = useSeconds(mode === 'capture' || mode === 'capture-comment');
  const capturing = mode === 'capture' || mode === 'capture-comment';
  const [sound, setSound] = useState(true);
  const [popup, setPopup] = useState(false);
  const [on, setOn] = useState(true);
  const recordingState = mode === 'capture';
  const form = mode === 'acting' ? agent.form : recordingState ? recording.form : mode === 'saved' ? { ...EMPTY, name: 'Ada', email: '•••••••••••', bacon: true } : mode === 'idle' || mode === 'you' ? { ...EMPTY, name: 'Ada', size: 'Medium', bacon: true, cheese: true } : EMPTY;
  const frame: CSSProperties = mode === 'acting' ? { boxShadow: `inset 0 0 0 3px ${BLUE}, inset 0 0 26px ${BLUE}55` }
    : capturing ? { boxShadow: `inset 0 0 0 3px ${RED}, inset 0 0 22px ${RED}40` }
    : mode === 'you' ? { boxShadow: 'inset 0 0 0 2px #a3a3a3' } : {};
  const iconState: IconState = !on ? 'off' : mode === 'acting' || capturing ? 'acting' : 'on';
  return <div className="relative w-full max-w-[980px] rounded-xl border border-neutral-300 bg-[#dee1e6] shadow-xl">
    <style>{'@keyframes gs-ripple { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.4); opacity: 0 } }'}</style>
    <div className="flex items-end gap-1 rounded-t-xl px-2 pt-2">
      <span className="mb-1 mr-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: BLUE }}>{mode === 'acting' ? '▶ ' : capturing ? '● ' : ''}Cross-machine browser relay</span>
      <span className="flex items-center gap-1.5 rounded-t-lg bg-white px-3 py-1.5 text-[12px] text-neutral-800" style={{ borderTop: `2px solid ${BLUE}` }}>httpbin.org — Forms</span>
      <span className="flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-[12px] text-neutral-600" style={{ borderTop: `2px solid ${BLUE}` }}>Pull request #153</span>
      <span className="flex-1" />
    </div>
    <div className="flex items-center gap-2 bg-white px-3 py-1.5">
      <span className="flex-1 rounded-full bg-[#f1f3f4] px-3 py-1 text-[12px] text-neutral-700">httpbin.org/forms/post</span>
      <button type="button" onClick={() => setPopup(value => !value)} className="relative rounded-full p-0.5 hover:bg-neutral-100" aria-label="GitSpace extension">
        <ExtensionIcon state={iconState} />
        {!popup ? <span className="absolute -bottom-7 right-0 whitespace-nowrap rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-white">Click me: the popup</span> : null}
      </button>
    </div>
    {popup ? <div className="absolute right-2 top-[78px] z-50"><Popup on={on} onToggle={() => setOn(value => !value)} tab={{ host: 'httpbin.org', group: 'Cross-machine browser relay' }} /></div> : null}
    <div ref={page} className="relative h-[470px] overflow-hidden rounded-b-xl bg-white" style={frame}>
      <PizzaForm form={form} targets={targets} focus={mode === 'acting' ? agent.focus : null} flash={recordingState ? recording.flash : null} />
      {mode === 'acting' ? <><Ripples ripples={agent.ripples} color={BLUE} /><Pointer point={agent.point} color={BLUE} label="main" pressed={agent.pressed} /><Pointer point={{ x: 470, y: 250 }} color={PURPLE} label="Ana · watching" pressed={false} /></> : null}
      {recordingState ? <><Pointer point={recording.point} color="#111" pressed={false} /><RecordingTimeline steps={recording.steps} /></> : null}
      {capturing ? <VideoBadge seconds={videoSeconds} sound={sound} /> : null}
      {mode === 'capture-comment' ? <CommentLayer page={page} /> : null}

      {mode === 'acting' ? <Bar tone={BLUE}><Logo dot={BLUE} /><div className="min-w-0"><p className="font-semibold">main <span className="font-normal text-neutral-500">· Cross-machine browser relay</span></p><p className="text-[12px] text-neutral-600">{agent.doing}…</p></div><Divider /><ToolIcons onMode={onMode} /><Divider /><BarButton onClick={() => onMode('you')}>Take over</BarButton><BarButton dark onClick={() => onMode('idle')}>Stop</BarButton></Bar> : null}
      {mode === 'idle' ? <Bar><Logo /><span>GitSpace · <strong>Cross-machine browser relay</strong> · idle</span><Divider /><ToolIcons onMode={onMode} /></Bar> : null}
      {mode === 'you' ? <Bar><Logo /><div><p className="font-semibold">You&apos;re in control</p><p className="text-[12px] text-neutral-500">main is paused · it sees your changes when it resumes</p></div><Divider /><ToolIcons onMode={onMode} /><Divider /><button type="button" onClick={() => onMode('acting')} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-white" style={{ background: BLUE }}>Resume agent</button></Bar> : null}
      {mode === 'capture-comment' ? <Bar tone={PURPLE}><span className="size-3 animate-pulse rounded-full" style={{ background: RED }} /><div><p className="font-semibold">Pizza form review <span className="font-normal text-neutral-400">✎</span> <span className="font-normal tabular-nums text-neutral-500">· {clock(videoSeconds)}</span></p><p className="text-[12px] text-neutral-500">Comment tool · click an element or drag an area · 2 comments</p></div><Divider /><BarButton onClick={() => onMode('capture')}>Back to doing (Esc)</BarButton><BarButton dark onClick={() => onMode('saved')}>Done</BarButton></Bar> : null}
      {recordingState ? <Bar tone={RED}><span className="size-3 animate-pulse rounded-full" style={{ background: RED }} /><div><p className="font-semibold tabular-nums">Capturing · Order a pizza <span className="font-normal text-neutral-400">✎</span> · {clock(recording.seconds)} · {recording.steps.filter(step => !step.comment).length} steps · {recording.steps.filter(step => step.comment).length} comment</p><p className="text-[12px] text-neutral-500">Do it as you normally would; press C to point something out. Secrets are masked.</p></div><Divider /><BarButton onClick={() => onMode('capture-comment')} icon={<MessagePlusSquare width={14} height={14} />}>Comment</BarButton><button type="button" onClick={() => setSound(value => !value)} className="rounded-lg border border-neutral-300 px-2 py-1.5 text-[12px]">{sound ? '🔊 Sound' : '🔇 No sound'}</button><BarButton onClick={() => onMode('idle')}>Discard</BarButton><BarButton dark onClick={() => onMode('saved')}>Done</BarButton></Bar> : null}

      {mode === 'saved' ? <SavedCard onRun={() => onMode('acting')} /> : null}
    </div>
  </div>;
}

function useSeconds(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { if (!active) return; setSeconds(0); const timer = setInterval(() => setSeconds(value => value + 1), 1000); return () => clearInterval(timer); }, [active]);
  return seconds;
}
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
/** Video runs quietly: a corner badge, no frame, so the recording shows the page as it is. */
function VideoBadge({ seconds, sound }: { seconds: number; sound: boolean }) {
  return <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white"><span className="size-2 animate-pulse rounded-full" style={{ background: RED }} />REC {clock(seconds)} · {sound ? 'tabCapture · with sound' : 'frames · no sound'}</div>;
}

function RecordingTimeline({ steps }: { steps: readonly Step[] }) {
  return <div className="absolute right-3 top-3 z-20 flex w-80 flex-col gap-1.5 rounded-xl border border-neutral-200 bg-white/95 p-3 text-[12px] text-neutral-800 shadow-xl">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Steps and comments · on the video&apos;s clock</p>
    {steps.map((step, index) => <div key={index} className="flex gap-2">
      <span className="w-10 shrink-0 tabular-nums text-[#1a73e8] underline">▶{step.at}</span>
      <div className="min-w-0"><p className={step.mutation ? 'text-[#b45309]' : step.comment ? 'italic' : ''} style={step.comment ? { color: PURPLE } : undefined}>{step.comment ? '💬 ' : `${index + 1}. `}{step.text}</p>{step.detail ? <p className="truncate font-mono text-[10px] text-neutral-500">{step.detail}</p> : null}</div>
    </div>)}
  </div>;
}

/** What a person sees when they open the share link. */
function Viewer() {
  return <div className="flex flex-col gap-2">
    <h3 className="text-body font-medium">What a person sees</h3>
    <div className="flex w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-xl">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <img src="/favicon.png" alt="" width={20} height={20} className="rounded-md" />
        <p className="min-w-0 flex-1 truncate text-caption"><strong>Bradley</strong> is sharing <span className="font-mono">news.ycombinator.com</span> · you can watch, point and comment · 52 min left</p>
        <span className="flex -space-x-1.5">{[['B', '#525252'], ['A', PURPLE]].map(([initial, color]) => <span key={initial} className="flex size-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white" style={{ background: color }}>{initial}</span>)}</span>
        <Button variant="secondary" size="compact">Comment</Button>
      </div>
      <div className="relative flex h-56 flex-col gap-1.5 bg-[#f6f6ef] p-4 text-[12px] text-neutral-800">
        <Pointer point={{ x: 300, y: 84 }} color={BLUE} label="main · agent" pressed={false} />
        <Pointer point={{ x: 470, y: 128 }} color="#525252" label="Bradley" pressed={false} />
        <Pointer point={{ x: 210, y: 150 }} color={PURPLE} label="You (Ana)" pressed={false} />
        <div className="-mx-4 -mt-4 mb-2 bg-[#ff6600] px-4 py-1 text-[12px] font-bold text-black">Hacker News</div>
        {['Show HN: Agents that drive your own Chrome', 'The case for boring technology (2015)', 'A tour of CDP input events', 'Fitts’s law in UI design'].map((title, index) => <p key={title}><span className="text-neutral-400">{index + 1}.</span> {title}</p>)}
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">Live view of the tab, refreshed as it changes · everyone&apos;s pointer is visible; only Bradley or his agent can click or type · no other tabs, no cookies, no browser endpoint</p>
    </div>
  </div>;
}

export function ExtensionMock() {
  const [mode, setMode] = useState<Mode>('acting');
  const [on, setOn] = useState(true);
  return <PageCanvas className="max-w-6xl">
    <PageHeader kicker="Chrome extension" title="GitSpace in your Chrome" description="Three surfaces: the toolbar icon (always visible), the popup (opens when you click the icon), and the in-page toolbar (on tabs GitSpace is using, or when you comment or record)." />
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-subtitle font-medium">In the tab</h2>
          <TabsSubtle size="compact" selectedIndex={MODES.findIndex(item => item.mode === mode)} onSelect={index => setMode(MODES[index]?.mode ?? 'acting')} idPrefix="mock-mode" aria-label="Tab state">{MODES.map((item, index) => <TabsSubtleItem key={item.mode} index={index} label={item.label} />)}</TabsSubtle></div>
        <FakeChrome key={mode} mode={mode} onMode={setMode} />
        <ul className="grid gap-2 text-caption text-muted-foreground md:grid-cols-2">
          <li><strong className="text-foreground">Agent acting:</strong> the agent&apos;s pointer travels on a curved path with ease-in-out, overshoots a few pixels and settles; travel time grows with distance (Fitts&apos;s law); each click ripples; typing has uneven gaps. It is drawn only: commands still go through CDP.</li>
          <li><strong className="text-foreground">Capture:</strong> one button for everything you record. Your actions become steps with Playwright locators (secrets masked, requests that change data marked), the tab is recorded (tabCapture with sound on your Chrome, frames otherwise), and the page layout is kept so comments can point at elements later. Press C to comment while you work; comments land in the steps on the same clock, so the agent reads what you did and why.</li>
          <li><strong className="text-foreground">Comment:</strong> starts a capture with the comment tool on, for when you only want to point things out. Hover outlines what a comment attaches to; click an element or drag an area. Try clicking a field.</li>
          <li><strong className="text-foreground">Capture saved:</strong> one capture with tracks (steps, comments, video, layout), named, in the Browser tab; nothing goes into the repository. Mention it in the chat and the agent can make a skill of it, follow up on your comments, or watch the moment you mean. Sharing sends the whole recording.</li>
        </ul>
        <Note>Everything in the tab sits in a closed shadow root added over the extension&apos;s debugger connection, and is kept out of the agent&apos;s views and screenshots, so the agent never reads its own toolbar or comment pins.</Note>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-subtitle font-medium">Toolbar icon</h2>
        <div className="flex flex-wrap gap-6">
          {([['off', 'Off', 'Agents can’t reach this Chrome'], ['on', 'On', 'Connected, nothing running'], ['acting', 'Working', 'An agent is acting, or you are recording'], ['attention', 'Needs you', 'Disconnected, or a project needs approval']] satisfies [IconState, string, string][]).map(([state, label, detail]) => <div key={state} className="flex w-44 flex-col items-center gap-2 rounded-xl bg-surface-2 p-4 text-center">
            <div className="flex h-12 w-full items-center justify-center rounded-lg bg-[#dee1e6]"><ExtensionIcon state={state} large /></div>
            <p className="text-body font-medium">{label}</p><Caption>{detail}</Caption>
          </div>)}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div><h2 className="text-subtitle font-medium">Popup</h2><Caption>The panel Chrome opens when you click the GitSpace icon next to the address bar (try it in the window above). It is about this Chrome as a whole: on or off, who is using it, and a share link for the current tab. Comment and Record live only in the in-page toolbar, which a tab gets once it is in a workspace.</Caption></div>
        <div className="flex flex-wrap items-start gap-6"><Popup on={on} onToggle={() => setOn(value => !value)} /><Popup on onToggle={() => {}} tab={{ host: 'httpbin.org', group: 'Cross-machine browser relay' }} watching="Ana is watching · 52 min left" /><Popup on={false} onToggle={() => setOn(true)} /></div>
        <Note>One share link per tab, no Share button: copying it creates it. Who opens it decides what it does. Pasted into one of <em>your</em> workspaces, it gives that workspace&apos;s agent the tab (the composer turns it into a tab chip; the agent never sees the link). Opened by a person, it is the live viewer with the capabilities ticked here. A person&apos;s own agents get nothing from it. See view 2 for the paste and below for the viewer.</Note>
        <Viewer />
        <Note>Pairing, the fingerprint and reset move under &ldquo;Identity &amp; pairing&rdquo;; pairing starts from GitSpace (Plugins → Pair a Chrome). Off stops running scripts and refuses new ones without unpairing.</Note>
      </section>
    </div>
  </PageCanvas>;
}
