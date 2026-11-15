// A Roadmap block: phases in order along a track, shipped ones filled, the current one pulsing, later ones faint; each
// phase's items carry a status mark and live reference chips. The track fills to the current phase as the block appears.
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { badgeColors } from '@gitspace/ui';
import { Check, XClose } from '@untitledui/icons';
import { useActions } from '@json-render/react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { RefChip } from './references.js';
import { ItemComment, commentItem } from '../comments/CommentLayer.js';

type RoadmapProps = z.output<typeof gitspaceUiCatalog.components.Roadmap.props>;
type Phase = RoadmapProps['phases'][number];
type ItemStatus = NonNullable<Phase['items'][number]['status']>;

const PHASE: Record<Phase['status'], { tone: string; label: string; faint: boolean }> = {
  done: { tone: badgeColors.green, label: 'Shipped', faint: false },
  active: { tone: badgeColors.blue, label: 'Now', faint: false },
  next: { tone: 'var(--foreground)', label: 'Next', faint: false },
  later: { tone: 'var(--muted-foreground)', label: 'Later', faint: true },
  blocked: { tone: badgeColors.red, label: 'Blocked', faint: false },
};

/** The track's node for a phase: filled with a check when shipped, a pulsing ring now, hollow ahead, a cross when blocked. */
function Node({ status }: { status: Phase['status'] }) {
  const { tone } = PHASE[status];
  if (status === 'done') return <span className="relative z-10 flex size-5 items-center justify-center rounded-full" style={{ background: tone }}><Check width={12} height={12} strokeWidth={3} className="text-white" /></span>;
  if (status === 'blocked') return <span className="relative z-10 flex size-5 items-center justify-center rounded-full" style={{ background: tone }}><XClose width={12} height={12} strokeWidth={3} className="text-white" /></span>;
  if (status === 'active') return <span className="relative z-10 flex size-5 items-center justify-center">
    <span className="absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:animate-none" style={{ background: tone }} />
    <span className="size-5 rounded-full border-[5px] bg-background" style={{ borderColor: tone }} />
  </span>;
  return <span className={`relative z-10 size-5 rounded-full border-2 bg-background ${status === 'later' ? 'border-dashed' : ''}`} style={{ borderColor: tone }} />;
}

/** An item's mark: done ticked, active pulsing, to do hollow, blocked crossed, waiting on the person orange. */
function Mark({ status }: { status: ItemStatus }) {
  if (status === 'done') return <Check width={12} height={12} strokeWidth={3} style={{ color: badgeColors.green }} aria-label="done" />;
  if (status === 'blocked') return <XClose width={12} height={12} strokeWidth={3} style={{ color: badgeColors.red }} aria-label="blocked" />;
  if (status === 'active') return <span className="status-dot size-2 rounded-full" data-pulse style={{ background: badgeColors.blue }} aria-label="in progress" />;
  if (status === 'needs-you') return <span className="size-2 rounded-full" style={{ background: badgeColors.orange, boxShadow: `0 0 0 3px color-mix(in oklab, ${badgeColors.orange} 30%, transparent)` }} aria-label="needs you" />;
  return <span className="size-2 rounded-full border border-muted-foreground/60" aria-label="to do" />;
}

export function RoadmapView({ phases }: RoadmapProps) {
  const [drawn, setDrawn] = useState(false);
  const { execute } = useActions();
  /** The option picked per item (`roadmap:<phase>:<item>`), staged in the person's message bar. */
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => { const frame = requestAnimationFrame(() => setDrawn(true)); return () => cancelAnimationFrame(frame); }, []);
  const reached = phases.reduce((last, phase, index) => phase.status === 'done' || phase.status === 'active' ? index : last, -1);
  return <div className="overflow-x-auto pb-1">
    <ol className="grid min-w-full grid-flow-col auto-cols-[minmax(12.5rem,1fr)] gap-3">
      {phases.map((phase, index) => {
        const { tone, label, faint } = PHASE[phase.status];
        const segment = index < reached ? badgeColors.green : 'var(--border)';
        return <li key={index} className={`flex min-w-0 flex-col gap-2 ${faint ? 'opacity-60' : ''}`}>
          <div className="relative flex h-6 items-center">
            <Node status={phase.status} />
            {index < phases.length - 1 ? <span className="absolute left-5 right-[-0.75rem] top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-border">
              <span className="block h-full origin-left rounded-full transition-transform duration-500 ease-out motion-reduce:transition-none"
                style={{ background: segment, transform: `scaleX(${drawn && index < reached ? 1 : 0})`, transitionDelay: `${index * 140}ms` }} />
            </span> : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl bg-surface-1 p-3"
            style={{ boxShadow: `inset 0 3px 0 0 ${tone}, ${phase.status === 'active' ? `0 0 0 2px color-mix(in oklab, ${tone} 35%, transparent), ` : ''}0 1px 2px rgb(0 0 0 / 0.08)` }}>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: tone }}>{label}{phase.when ? <span className="font-normal normal-case tracking-normal text-muted-foreground"> · {phase.when}</span> : null}</span>
              <span className="text-body font-semibold leading-snug text-foreground">{phase.title}</span>
              {phase.note ? <span className="text-caption leading-snug text-muted-foreground">{phase.note}</span> : null}
            </div>
            {phase.items.length ? <ul className="flex flex-col gap-1.5">
              {phase.items.map((item, itemIndex) => <li key={itemIndex} className="group/item flex min-w-0 items-start gap-2" {...commentItem(`phases/${index}/items/${itemIndex}`, `item “${item.label}”`)}>
                <span className="mt-[5px] flex size-3 shrink-0 items-center justify-center"><Mark status={item.status ?? 'todo'} /></span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className={`text-caption leading-snug ${item.status === 'done' ? 'text-muted-foreground' : 'text-foreground'}`}>{item.label} <ItemComment path={`phases/${index}/items/${itemIndex}`} label={`item “${item.label}”`} quote={item.label} /></span>
                  {item.refs?.length ? <span className="flex flex-wrap gap-1">{item.refs.map((reference, refIndex) => <RefChip key={refIndex} reference={reference} />)}</span> : null}
                  {item.decide ? <span className="flex flex-col gap-1 rounded-md p-1.5" style={{ background: `color-mix(in oklab, ${badgeColors.orange} 8%, transparent)` }}>
                    <span className="text-[11px] leading-snug text-foreground/80">{item.decide.question}</span>
                    <span className="flex flex-wrap gap-1">{item.decide.options.map(option => {
                      const key = `roadmap:${index}:${itemIndex}`;
                      const chosen = picked[key] === option;
                      return <button key={option} type="button" className="rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors"
                        style={chosen ? { background: badgeColors.blue, color: 'white' } : { boxShadow: 'inset 0 0 0 1px var(--border)', background: 'var(--background)' }}
                        onClick={() => {
                          setPicked(current => ({ ...current, [key]: option }));
                          void execute({ action: 'stage', params: { kind: 'decision', key, label: option, detail: `${item.label}: ${item.decide?.question ?? ''}`, payload: { phase: phase.title, item: item.label, choice: option } } });
                        }}>{chosen ? '✓ ' : ''}{option}</button>;
                    })}</span>
                  </span> : null}
                </span>
              </li>)}
            </ul> : null}
          </div>
        </li>;
      })}
    </ol>
  </div>;
}
