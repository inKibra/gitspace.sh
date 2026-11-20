// A StateFlow block: services and the state each holds, played one step at a time. Each step's call travels as a token
// from one service to the other and the state it sets updates there; removed services and calls are struck, added green.
// In a Sequence frame, its steps play while the frame plays and pause with it.
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { badgeColors } from '@gitspace/ui';
import { ChevronLeft, ChevronRight, PauseCircle, PlayCircle, RefreshCcw01 } from '@untitledui/icons';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { ItemComment, commentItem } from '../comments/CommentLayer.js';
import { SequenceFrame } from './BlockDocument.js';

type StateFlowProps = z.output<typeof gitspaceUiCatalog.components.StateFlow.props>;
type Service = StateFlowProps['services'][number];
type Change = NonNullable<Service['change']>;

const TONE: Record<Change, string> = { added: badgeColors.green, removed: badgeColors.red, same: badgeColors.blue };
const STEP_MS = 2200;

/** Each service's state after the steps up to `upTo` (inclusive), and which keys the step at `upTo` set. */
function stateAt(props: StateFlowProps, upTo: number): { values: Map<string, Map<string, string>>; fresh: Set<string> } {
  const values = new Map(props.services.map(service => [service.id, new Map((service.state ?? []).map(entry => [entry.key, entry.value]))]));
  const fresh = new Set<string>();
  props.steps.slice(0, upTo + 1).forEach((step, index) => {
    for (const set of step.sets ?? []) {
      values.get(set.service)?.set(set.key, set.value);
      if (index === upTo) fresh.add(`${set.service}/${set.key}`);
    }
  });
  return { values, fresh };
}

export function StateFlowView(props: StateFlowProps) {
  const { title, services, steps } = props;
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [arrived, setArrived] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<string, HTMLDivElement>());
  const [points, setPoints] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const current = step >= 0 ? steps[step] : undefined;
  const framePlaying = useContext(SequenceFrame)?.playing ?? null;

  useEffect(() => {
    if (framePlaying !== null) setPlaying(framePlaying);
  }, [framePlaying]);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (step + 1 >= steps.length) { setPlaying(false); return; }
      setStep(step + 1);
    }, step < 0 ? 200 : STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, step, steps.length]);

  // The token starts on the calling service and, a frame later, moves to the called one.
  useLayoutEffect(() => {
    setArrived(false);
    const origin = frame.current?.getBoundingClientRect();
    const from = current ? boxes.current.get(current.from)?.getBoundingClientRect() : undefined;
    const to = current ? boxes.current.get(current.to)?.getBoundingClientRect() : undefined;
    if (!origin || !from || !to) { setPoints(null); return; }
    // The token rides on the box's top edge, clear of its name and state.
    const centre = (box: DOMRect) => ({ x: box.left - origin.left + box.width / 2, y: box.top - origin.top });
    setPoints({ from: centre(from), to: centre(to) });
    const next = requestAnimationFrame(() => requestAnimationFrame(() => setArrived(true)));
    return () => cancelAnimationFrame(next);
  }, [current]);

  const { values, fresh } = stateAt(props, step);
  const children = (parent: string | null) => services.filter(service => (service.parent ?? null) === parent);
  const tone = TONE[current?.change ?? 'same'];

  const box = (service: Service): ReactNode => {
    const change = service.change ?? 'same';
    const active = current && (current.from === service.id || current.to === service.id);
    const inner = children(service.id);
    const state = [...(values.get(service.id) ?? new Map<string, string>())];
    return <div key={service.id} ref={element => { if (element) boxes.current.set(service.id, element); else boxes.current.delete(service.id); }}
      className={`flex min-w-36 flex-col gap-1.5 rounded-lg bg-background p-2.5 transition-shadow duration-300 ${change === 'removed' ? 'border border-dashed' : ''}`}
      style={{
        borderColor: change === 'removed' ? TONE.removed : undefined,
        boxShadow: [change === 'added' ? `inset 0 0 0 1.5px ${TONE.added}` : change === 'same' ? 'inset 0 0 0 1px var(--border)' : null, active ? `0 0 0 3px color-mix(in oklab, ${tone} 30%, transparent)` : null].filter(Boolean).join(', ') || undefined,
        background: change === 'removed' ? `color-mix(in oklab, ${TONE.removed} 6%, var(--background))` : undefined,
      }}>
      <span className="flex items-baseline gap-1.5">
        <span className={`text-caption font-semibold ${change === 'removed' ? 'text-foreground/70 line-through' : 'text-foreground'}`}>{service.name}</span>
        {service.role ? <span className="text-[11px] text-muted-foreground">{service.role}</span> : null}
      </span>
      {state.length ? <span className="flex flex-col gap-0.5 font-mono text-[11px]">
        {state.map(([key, value]) => <span key={key} className="flex gap-2 rounded px-1 transition-colors duration-500" style={{ background: fresh.has(`${service.id}/${key}`) ? `color-mix(in oklab, ${tone} 18%, transparent)` : 'var(--surface-2)' }}>
          <span className="text-muted-foreground">{key}</span><span className="text-foreground">{value}</span>
        </span>)}
      </span> : null}
      {inner.length ? <div className="flex flex-wrap gap-2 pt-1">{inner.map(box)}</div> : null}
    </div>;
  };

  return <figure className="flex flex-col gap-3 rounded-lg bg-surface-1 p-3 shadow-surface-1">
    {title ? <figcaption className="text-caption text-muted-foreground">{title}</figcaption> : null}
    <p className="group/item min-h-10 text-caption leading-snug text-foreground/90" {...(current ? commentItem(`steps/${step}`, `step ${step + 1}`) : {})}>
      {current ? <>{current.change && current.change !== 'same' ? <span className="font-semibold" style={{ color: TONE[current.change] }}>{current.change === 'added' ? 'Added: ' : 'Removed: '}</span> : null}{current.caption} <ItemComment path={`steps/${step}`} label={`step ${step + 1}`} quote={current.caption} /></> : <span className="text-muted-foreground">Press play to walk through it.</span>}
    </p>
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Restart" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => { setStep(-1); setPlaying(false); }}><RefreshCcw01 width={14} height={14} /></button>
      <button type="button" aria-label="Previous step" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={step < 0} onClick={() => { setPlaying(false); setStep(step - 1); }}><ChevronLeft width={14} height={14} /></button>
      <button type="button" aria-label={playing ? 'Pause' : 'Play'} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-caption shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-2" onClick={() => { if (!playing && step + 1 >= steps.length) setStep(-1); setPlaying(!playing); }}>
        {playing ? <PauseCircle width={14} height={14} /> : <PlayCircle width={14} height={14} />}{playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" aria-label="Next step" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={step + 1 >= steps.length} onClick={() => { setPlaying(false); setStep(step + 1); }}><ChevronRight width={14} height={14} /></button>
      <span className="ml-2 flex flex-1 gap-1">{steps.map((item, index) => <span key={index} className="h-1 flex-1 rounded-full transition-opacity" style={{ background: TONE[item.change ?? 'same'], opacity: index <= step ? 0.9 : 0.2 }} />)}</span>
      <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">{Math.max(0, step + 1)} / {steps.length}</span>
    </div>
    <div ref={frame} className="relative flex flex-col items-center gap-6 py-2">
      {points ? <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
        <line x1={points.from.x} y1={points.from.y} x2={points.to.x} y2={points.to.y} stroke={tone} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.7" />
      </svg> : null}
      {children(null).map(box)}
      {points && current ? <span className="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] font-medium text-white shadow-md transition-all duration-700 ease-in-out motion-reduce:transition-none"
        style={{ left: arrived ? points.to.x : points.from.x, top: arrived ? points.to.y : points.from.y, background: tone, textDecoration: current.change === 'removed' ? 'line-through' : undefined }}>
        <span className="size-1.5 rounded-full bg-white/80" />{current.label}
      </span> : null}
    </div>
  </figure>;
}
