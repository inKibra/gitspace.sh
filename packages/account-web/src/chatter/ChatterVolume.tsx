// Chatter volume in the sidebar (docs/CHATTER-DESIGN.md §2, §7): under each workspace row's status dot a small level
// indicator, one to three bars for Low, Normal and High, grey and struck through for Mute, glowing for a few seconds
// when the workspace posts. It opens a popover with M (mute while the fader keeps its notch) and a fader with four
// notches; the project row's sets the project agent's level and mutes Chatter for the whole project.
import { Popover } from '@base-ui/react/popover';
import { badgeColors } from '@gitspace/ui';
import { CHATTER_LEVELS, CHATTER_PROJECT_STRIP, defaultChatterLevel, type ChatterLevel, type ChatterVolumes } from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { Bell01, BellOff01 } from '@untitledui/icons';
import { motion } from 'framer-motion';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { STATUS_COLOR } from '../GitSpaceShell.js';
import { liveTicks } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';

export const LEVEL_LABEL: Readonly<Record<ChatterLevel, string>> = { mute: 'Mute', low: 'Low', normal: 'Normal', high: 'High' };
const LEVEL_DETAIL: Readonly<Record<ChatterLevel, string>> = {
  mute: 'Its posts stay in the stream and in chatter_read but reach no agent’s digest.',
  low: 'In a digest only when the model judges a post strongly relevant to that agent.',
  normal: 'The model picks its posts for an agent’s digest as usual.',
  high: 'Every agent always hears it.',
};
/** How many of the indicator's three bars each level lights. */
const BARS: Readonly<Record<ChatterLevel, number>> = { mute: 0, low: 1, normal: 2, high: 3 };
const GLOW_MS = 3200;
/** Without a notice (a device the account directory socket does not admit), volumes are read again this often. */
const VOLUMES_FALLBACK_MS = 60_000;

/** The volumes of the projects in the sidebar, by project id, and the changes a person makes to them. */
export interface ChatterVolumesValue {
  volumes: ReadonlyMap<string, ChatterVolumes>;
  setVolume(projectId: string, strip: string, change: { level?: ChatterLevel; muted?: boolean }): void;
  setProjectMute(projectId: string, on: boolean): void;
}
export const ChatterVolumesContext = createContext<ChatterVolumesValue | null>(null);

/** Reads each project's volumes, again after each of its `chatter` notices; a device that cannot read a project's
 * Chatter (a workspace-scoped one) gets no volumes for it, and its rows show no indicator. */
export function ChatterVolumesProvider({ projectIds, children }: { projectIds: readonly string[]; children: ReactNode }) {
  const [volumes, setVolumes] = useState<ReadonlyMap<string, ChatterVolumes>>(new Map());
  const put = useCallback((projectId: string, next: ChatterVolumes) => setVolumes(current => new Map(current).set(projectId, next)), []);
  const value = useMemo<ChatterVolumesValue>(() => ({
    volumes,
    setVolume: (projectId, strip, change) => void rpcClient.chatter.setVolume({ projectId, strip, ...change }).then(result => {
      if (result.status === 'ok') put(projectId, result.value.volumes);
      else console.warn('Chatter volume was not set', result.error);
    }),
    setProjectMute: (projectId, on) => void rpcClient.chatter.setProjectMute({ projectId, on }).then(result => {
      if (result.status === 'ok') put(projectId, result.value.volumes);
      else console.warn('Chatter project mute was not set', result.error);
    }),
  }), [volumes, put]);
  return <ChatterVolumesContext.Provider value={value}>
    {projectIds.map(projectId => <WatchVolumes key={projectId} projectId={projectId} onVolumes={put} />)}
    {children}
  </ChatterVolumesContext.Provider>;
}

function WatchVolumes({ projectId, onVolumes }: { projectId: string; onVolumes(projectId: string, volumes: ChatterVolumes): void }) {
  useEffect(() => {
    const controller = new AbortController();
    const watch = async (): Promise<void> => {
      for await (const _tick of liveTicks([projectLiveKey(projectId, 'chatter')], controller.signal, undefined, () => VOLUMES_FALLBACK_MS)) {
        const read = await rpcClient.chatter.volumes({ projectId }, { signal: controller.signal });
        if (read.status === 'ok') onVolumes(projectId, read.value);
      }
    };
    watch().catch((error: unknown) => { if (!controller.signal.aborted) console.warn('Chatter volumes stopped updating', error); });
    return () => controller.abort();
  }, [projectId, onVolumes]);
  return null;
}

/** One strip's indicator, read from the sidebar's volumes: a workspace (`phase` sets its default) or the project agent
 * (`project`), whose popover also mutes Chatter for the project. Nothing while the project's volumes are unread. */
export function StripVolume({ projectId, strip, name, phase, className, style }: { projectId: string; strip: string; name: string; phase: string | null; className?: string; style?: CSSProperties }) {
  const chatter = useContext(ChatterVolumesContext);
  const volumes = chatter?.volumes.get(projectId);
  if (!chatter || !volumes) return null;
  const set = volumes.strips.find(entry => entry.strip === strip);
  const muted = set?.muted ?? false;
  const silenced = volumes.projectMuted?.on ?? false;
  return <span className={className} style={style}>
    <VolumeIndicator name={name} fader={set?.level ?? defaultChatterLevel(phase)} muted={muted} silenced={silenced} phase={phase} at={volumes.recent.find(entry => entry.strip === strip)?.at.getTime()}
      onLevel={level => chatter.setVolume(projectId, strip, muted ? { level, muted: false } : { level })} onMute={() => chatter.setVolume(projectId, strip, { muted: !muted })}>
      {strip === CHATTER_PROJECT_STRIP ? <button type="button" aria-pressed={silenced} onClick={() => chatter.setProjectMute(projectId, !silenced)}
        title={silenced ? 'Unmute Chatter: digests resume for every agent' : 'Mute Chatter for the project: posts stay in the stream and chatter_read; no agent gets a digest'}
        className={`mt-2 flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-[11.5px] ${silenced ? 'font-medium' : 'text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground'}`}
        style={silenced ? { color: badgeColors.amber, background: `color-mix(in oklab, ${badgeColors.amber} 16%, transparent)` } : undefined}>
        {silenced ? <BellOff01 width={13} height={13} strokeWidth={2} /> : <Bell01 width={13} height={13} strokeWidth={2} />}
        {silenced ? 'Chatter muted for the project' : 'Mute Chatter for the project'}
      </button> : null}
    </VolumeIndicator>
  </span>;
}

/** The project row's second line: the project agent's indicator, whose popover also mutes Chatter for the project, and
 * what it is. Nothing while the project's volumes are unread. */
export function ProjectAgentVolume({ projectId }: { projectId: string }) {
  const volumes = useContext(ChatterVolumesContext)?.volumes.get(projectId);
  if (!volumes) return null;
  return <div data-project-volume="" className="flex h-[18px] min-w-0 items-center gap-1.5 pl-2 pr-2 text-[11px] text-muted-foreground">
    <StripVolume projectId={projectId} strip={CHATTER_PROJECT_STRIP} name="the project agent" phase={null} />
    <span className="truncate">{volumes.projectMuted?.on ? 'Chatter muted for the project' : 'project agent'}</span>
  </div>;
}

/** Three bars rising left to right, the first `count` in `color`. */
function Bars({ count, color }: { count: number; color: string }) {
  return <>{[0, 1, 2].map(bar => <span key={bar} className="w-[2px] rounded-[0.5px]" style={{ height: 3 + bar * 3, background: bar < count ? color : 'color-mix(in oklab, var(--foreground) 16%, transparent)' }} />)}</>;
}

/** The level indicator: its bars, struck through when muted, and a glow a post restarts and that decays over a few
 * seconds (a remount picks the decay up where it was). It opens the volume popover. */
export function VolumeIndicator({ name, fader, muted, silenced, phase, at, onLevel, onMute, children }: {
  name: string; fader: ChatterLevel; muted: boolean; silenced: boolean; phase: string | null; at: number | undefined; onLevel(level: ChatterLevel): void; onMute(): void; children?: ReactNode;
}) {
  const level = muted ? 'mute' : fader;
  const quiet = level === 'mute' || silenced;
  const glow = quiet ? 'var(--muted-foreground)' : level === 'high' ? badgeColors.amber : STATUS_COLOR.green;
  const since = at === undefined ? GLOW_MS : Date.now() - at;
  const label = `${name}: Chatter ${silenced ? 'muted for the project' : LEVEL_LABEL[level]}`;
  return <Popover.Root modal={false}>
    <Popover.Trigger aria-label={`${label}. Change its volume`} title={label} data-volume={level} onClick={event => event.stopPropagation()}
      className="relative flex size-4 shrink-0 items-center justify-center rounded-[4px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50 data-[popup-open]:bg-active">
      <span className={`relative inline-flex h-[9px] items-end gap-px ${quiet ? 'opacity-70' : ''}`}>
        <Bars count={BARS[level]} color={quiet ? 'var(--muted-foreground)' : 'color-mix(in oklab, var(--foreground) 72%, transparent)'} />
        {level === 'mute' ? <span aria-hidden className="absolute -inset-x-[2px] top-1/2 h-px -rotate-[35deg] bg-muted-foreground" /> : null}
        {since < GLOW_MS ? <span key={at} aria-hidden className="chatter-glow absolute inset-0 inline-flex items-end gap-px"
          style={{ filter: `drop-shadow(0 0 2.5px ${glow})`, animationDuration: `${GLOW_MS}ms`, animationDelay: `-${since}ms` }}><Bars count={Math.max(1, BARS[level])} color={glow} /></span> : null}
      </span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
        <Popover.Popup onClick={event => event.stopPropagation()} className="w-[236px] rounded-xl border border-border bg-background p-2.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] outline-none">
          <div className="mb-2 flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 whitespace-nowrap text-[12px] font-semibold">Chatter volume</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{name}</span>
          </div>
          <div className="flex items-start gap-2">
            <button type="button" aria-pressed={muted} aria-label={`${muted ? 'Unmute' : 'Mute'} ${name} in Chatter`} title={muted ? 'Unmute: back to its fader’s level' : 'Mute: its posts stay in the stream but reach no digest'} onClick={onMute}
              className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold leading-none ${muted ? '' : 'text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground'}`}
              style={muted ? { color: badgeColors.amber, background: `color-mix(in oklab, ${badgeColors.amber} 20%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${badgeColors.amber} 45%, transparent)` } : undefined}>M</button>
            <Fader name={name} value={fader} muted={muted} onLevel={onLevel} />
          </div>
          <p className="mt-2 text-[11px] leading-[15px] text-muted-foreground">
            <span className="font-medium text-foreground">{muted && fader !== 'mute' ? `Muted (fader at ${LEVEL_LABEL[fader]})` : LEVEL_LABEL[level]}{level === defaultChatterLevel(phase) && !muted ? ' · default' : ''}.</span> {LEVEL_DETAIL[level]}
          </p>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** The popover's fader: four labelled notches, dragged or clicked to the nearest; arrow keys step. It commits on release. */
function Fader({ name, value, muted, onLevel }: { name: string; value: ChatterLevel; muted: boolean; onLevel(level: ChatterLevel): void }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<ChatterLevel | null>(null);
  const shown = drag ?? value;
  const at = (clientX: number): ChatterLevel => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return value;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return CHATTER_LEVELS[Math.round(ratio * (CHATTER_LEVELS.length - 1))] ?? value;
  };
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(at(event.clientX));
  };
  const up = (): void => {
    if (drag !== null && drag !== value) onLevel(drag);
    setDrag(null);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    const next = CHATTER_LEVELS[CHATTER_LEVELS.indexOf(value) + step];
    if (!step || !next) return;
    event.preventDefault();
    onLevel(next);
  };
  const percent = (level: ChatterLevel): string => `${(CHATTER_LEVELS.indexOf(level) / (CHATTER_LEVELS.length - 1)) * 100}%`;
  const tone = muted || shown === 'mute' ? 'var(--muted-foreground)' : shown === 'high' ? badgeColors.amber : STATUS_COLOR.green;
  return <div className="flex min-w-0 flex-1 flex-col gap-1 px-[6px]">
    <div ref={track} role="slider" tabIndex={0} aria-label={`${name} Chatter volume`} aria-valuemin={0} aria-valuemax={3} aria-valuenow={CHATTER_LEVELS.indexOf(shown)} aria-valuetext={LEVEL_LABEL[shown]}
      onPointerDown={down} onPointerMove={event => { if (drag !== null) setDrag(at(event.clientX)); }} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={key}
      className="relative h-[18px] cursor-ew-resize touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-foreground/30">
      <span className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-border" />
      <span className="absolute left-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full" style={{ width: percent(shown), background: tone, opacity: muted ? 0.5 : 0.9 }} />
      {CHATTER_LEVELS.map(level => <span key={level} className="absolute top-1/2 h-[8px] w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/30" style={{ left: percent(level) }} />)}
      <motion.span className="absolute top-1/2 size-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background"
        animate={{ left: percent(shown) }} transition={{ type: 'spring', stiffness: 700, damping: 40 }}
        style={{ boxShadow: muted ? '0 1px 3px rgba(0,0,0,0.3)' : `0 0 0 2px color-mix(in oklab, ${tone} 35%, transparent), 0 1px 3px rgba(0,0,0,0.3)` }} />
    </div>
    <div className="relative h-3 text-[10px] text-muted-foreground">
      {CHATTER_LEVELS.map((level, index) => <button type="button" key={level} onClick={() => { if (level !== value) onLevel(level); }}
        className={`absolute top-0 hover:text-foreground ${index === 0 ? '' : index === CHATTER_LEVELS.length - 1 ? '-translate-x-full' : '-translate-x-1/2'} ${level === shown ? 'font-semibold text-foreground' : ''}`} style={{ left: percent(level) }}>{LEVEL_LABEL[level]}</button>)}
    </div>
  </div>;
}
