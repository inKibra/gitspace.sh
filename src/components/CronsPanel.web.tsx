/** @jsxImportSource react */
import { useState, type ReactElement, type ReactNode } from 'react';

/**
 * CronsPanel — the '◷ Crons & triggers' dock pane (mock: agent-surfaces-app/src/app/CronsTriggers.tsx).
 * Ship-mode control plane: trigger registry cards (cron / event / manual runs that write data
 * artifacts) with a capability strip, run-history spark and an inline expanding editor.
 *
 * Pure presentational — pass `triggers` from the trigger registry once it exists; with no
 * triggers the pane renders the empty state inside the full bar+list chrome.
 */

/* ── Trigger model (mirrors the mock's trigger card data) ──────────────────── */

export type TriggerKind = 'cron' | 'event' | 'manual';
export type TriggerStatus = 'ok' | 'pending' | 'failed' | 'idle';
export type TriggerHistoryEntry = 'ok' | 'fail' | 'pending';

export interface TriggerRun {
  type: 'skill' | 'workflow' | 'command';
  ref: string;
  /** Per-trigger instruction shown in the inline editor */
  prompt?: string;
}

export interface SideEffectGrant {
  grant: string;
  needsApproval: boolean;
}

export interface TriggerSkill {
  name: string;
  summary: string;
  body: string;
}

export interface Trigger {
  name: string;
  kind: TriggerKind;
  /** Schedule / condition text, e.g. 'every 6h', 'Mon 09:00', 'on new share' */
  when: string;
  status: TriggerStatus;
  /** Last run, e.g. '2h ago' */
  last: string;
  /** Next run, e.g. 'in 4h' */
  next?: string;
  /** Run cost, e.g. '1.2k tok · $0.03' */
  cost?: string;
  /** Artifacts this trigger is ALLOWED to mutate (capability scope) */
  writes: string[];
  /** Recent run outcomes, newest last (5-dot spark) */
  history: TriggerHistoryEntry[];
  note?: string;
  /** Richer card data (mock parity) — all optional */
  id?: string;
  scope?: 'workspace' | 'project';
  /** One-line intent */
  does?: string;
  /** The work: command / skill / workflow (+ prompt) */
  runs?: TriggerRun;
  /** Inputs it consumes */
  reads?: string[];
  /** External grants beyond data (PR / email / deploy) */
  sideEffects?: SideEffectGrant[];
  /** Dashboards/panels that consume its output */
  feeds?: string[];
  /** Expanded skill definition for the editor accordion */
  skill?: TriggerSkill;
}

export interface CronsPanelProps {
  triggers?: Trigger[];
  /** Stage-driven: true once the chain is in ship (triggers armed + running) */
  live?: boolean;
  /** Persist a new/edited trigger (registry write). */
  onSave?: (trigger: Trigger) => Promise<void> | void;
  /** Execute a trigger now (spawns an agent run; history recorded). */
  onRunNow?: (trigger: Trigger) => Promise<void> | void;
}

/* ── Tones ─────────────────────────────────────────────────────────────────── */

type ChipTone = 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'dim';

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  green: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
  blue: 'bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]',
  amber: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
  red: 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
  violet: 'bg-[rgba(188,140,255,0.09)] text-[#bc8cff]',
  dim: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]',
};

const KIND_TONE: Record<TriggerKind, ChipTone> = { cron: 'blue', event: 'violet', manual: 'dim' };
const STATUS_TONE: Record<TriggerStatus, ChipTone> = { ok: 'green', pending: 'amber', failed: 'red', idle: 'dim' };
const HIST_TONE: Record<TriggerHistoryEntry, string> = {
  ok: 'var(--gs-success)',
  fail: 'var(--gs-danger)',
  pending: 'var(--gs-warning)',
};

/* ── Atoms ─────────────────────────────────────────────────────────────────── */

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-[5px] whitespace-nowrap border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] uppercase leading-[1.4] tracking-[0.05em] ${CHIP_TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

function XsButton({ onClick, children }: { onClick?: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-[5px] border border-[var(--gs-border)] bg-transparent px-[6px] py-[2px] text-[10px] text-[var(--gs-text-muted)] transition-colors hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]"
    >
      {children}
    </button>
  );
}

function ScopeBadge({ scope }: { scope: 'workspace' | 'project' }): ReactElement {
  const tone =
    scope === 'workspace'
      ? 'border-[rgba(91,155,255,0.25)] text-[var(--gs-info)]'
      : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]';
  return <span className={`border px-[5px] py-px text-[10.5px] uppercase tracking-[0.07em] ${tone}`}>{scope}</span>;
}

function Spark({ history }: { history: TriggerHistoryEntry[] }): ReactElement {
  return (
    <span className="inline-flex items-center gap-[2px]">
      {history.map((h, i) => (
        <span key={i} className="inline-block h-[12px] w-[5px] opacity-85" style={{ background: HIST_TONE[h] }} />
      ))}
    </span>
  );
}

function EditorKicker({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="mb-[5px] mt-2 text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)] first:mt-0">
      {children}
    </div>
  );
}

/* ── Trigger card ──────────────────────────────────────────────────────────── */

function TriggerCard({ t, live, onRunNow }: { t: Trigger; live: boolean; onRunNow?: (t: Trigger) => Promise<void> | void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [showSkill, setShowSkill] = useState(false);
  const sideEffects = t.sideEffects ?? [];
  const hasSideFx = sideEffects.length > 0;

  return (
    <div
      className={`border border-[var(--gs-border)] bg-[var(--gs-bg-surface)] ${
        hasSideFx ? 'border-l-2 border-l-[var(--gs-warning)]' : ''
      }`}
    >
      {/* header row */}
      <div className="flex items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-[9px]">
        <span className="font-mono text-[12.5px] text-[var(--gs-text)]">{t.name}</span>
        <Chip tone={KIND_TONE[t.kind]}>{t.kind}</Chip>
        <span className="font-mono text-[10.5px] text-[var(--gs-text-dim)]">{t.when}</span>
        {t.scope ? <ScopeBadge scope={t.scope} /> : null}
        <span className="ml-auto" />
        <Chip tone={live ? STATUS_TONE[t.status] : 'dim'}>{live ? t.status : 'armed'}</Chip>
        <XsButton onClick={onRunNow ? () => void Promise.resolve(onRunNow(t)).catch(() => {}) : undefined}>⟳ Run now</XsButton>
        <XsButton onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Edit'}</XsButton>
      </div>

      {/* one-line intent (sans) */}
      {t.does ? <div className="px-3 pb-1 pt-[9px] text-[12.5px] text-[var(--gs-text)]">{t.does}</div> : null}
      {t.note ? <div className="px-3 pb-1 pt-[3px] text-[11.5px] text-[var(--gs-text-muted)]">{t.note}</div> : null}

      {/* runs / reads / writes flow line */}
      <div className="flex flex-wrap items-center gap-[7px] px-3 pb-[9px] pt-[2px] text-[11px]">
        {t.runs ? (
          <>
            <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">runs</span>
            <span className="font-mono text-[var(--gs-text)]">
              {t.runs.type}: {t.runs.ref}
            </span>
            <span className="text-[var(--gs-text-dim)]">·</span>
          </>
        ) : null}
        {t.reads && t.reads.length > 0 ? (
          <>
            <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">reads</span>
            <span className="font-mono text-[var(--gs-text-dim)]">{t.reads.join(', ')}</span>
            <span className="text-[var(--gs-text-dim)]">→</span>
          </>
        ) : null}
        <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">writes</span>
        <span className="font-mono text-[var(--gs-text)]">{t.writes.join(', ')}</span>
      </div>

      {/* capability strip */}
      <div className="flex flex-wrap items-center gap-[9px] border-t border-[var(--gs-border-muted)] bg-[#060606] px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">capability</span>
        {hasSideFx ? (
          sideEffects.map((se) => (
            <Chip key={se.grant} tone="amber">
              can {se.grant}
              {se.needsApproval ? ' · approval' : ''}
            </Chip>
          ))
        ) : (
          <Chip tone="green">data-only · no side-effects</Chip>
        )}
        {t.feeds && t.feeds.length > 0 ? (
          <span className="text-[10.5px] text-[var(--gs-text-dim)]">feeds ▸ {t.feeds.join(', ')}</span>
        ) : null}
        <span className="ml-auto" />
        <span className="font-mono text-[10px] text-[var(--gs-text-dim)]">
          {t.last}
          {t.next ? ` · next ${t.next}` : ''}
          {t.cost ? ` · ${t.cost}` : ''}
        </span>
        {t.history.length > 0 ? <Spark history={t.history} /> : null}
      </div>

      {/* inline expanding editor */}
      {open ? (
        <div className="border-t border-[var(--gs-border)] bg-black px-3 py-2.5">
          {t.runs ? (
            <EditorKicker>
              runs · {t.runs.type}: {t.runs.ref}
            </EditorKicker>
          ) : null}
          {t.skill ? (
            <div className="mb-1 border border-[var(--gs-border-muted)]">
              <button
                type="button"
                onClick={() => setShowSkill((s) => !s)}
                className="flex w-full cursor-pointer items-center gap-[7px] border-none bg-[#070707] px-2.5 py-[7px] text-left text-[11.5px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]"
              >
                <span
                  className={`text-[10.5px] text-[var(--gs-text-dim)] transition-transform duration-[120ms] ${showSkill ? 'rotate-90' : ''}`}
                >
                  ▶
                </span>
                skill <span className="font-mono">{t.skill.name}</span>{' '}
                <span className="text-[var(--gs-text-dim)]">— {t.skill.summary}</span>
              </button>
              {showSkill ? (
                <div className="max-h-[300px] overflow-auto whitespace-pre-wrap border-t border-[var(--gs-border-muted)] bg-black px-[13px] py-[11px] text-[12px] leading-[1.6] text-[var(--gs-text-muted)]">
                  {t.skill.body}
                </div>
              ) : null}
            </div>
          ) : null}
          {t.runs?.prompt ? (
            <>
              <EditorKicker>
                prompt <span className="normal-case tracking-normal text-[var(--gs-text-dim)]">— per-trigger instruction</span>
              </EditorKicker>
              <textarea
                className="box-border min-h-[120px] w-full resize-y border border-[var(--gs-border)] bg-black px-[11px] py-[9px] font-[family-name:var(--gs-font)] text-[11.5px] leading-[1.55] text-[var(--gs-text)] focus:border-[var(--gs-border-active)] focus:outline-none"
                defaultValue={t.runs.prompt}
              />
            </>
          ) : null}
          <EditorKicker>capability scope — what this trigger may touch</EditorKicker>
          <div className="mb-[5px] flex flex-wrap items-center gap-[7px]">
            <span className="w-[78px] flex-none text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">
              may write
            </span>
            {t.writes.map((w) => (
              <Chip key={w} tone="dim">
                {w}
              </Chip>
            ))}
          </div>
          <div className="mb-[5px] flex flex-wrap items-center gap-[7px]">
            <span className="w-[78px] flex-none text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">
              side-effects
            </span>
            {hasSideFx ? (
              sideEffects.map((se) => (
                <label
                  key={se.grant}
                  className="inline-flex items-center gap-[5px] border border-[var(--gs-border)] px-2 py-[3px] text-[11px] text-[var(--gs-text)]"
                >
                  <input type="checkbox" defaultChecked /> {se.grant}
                  <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] text-[var(--gs-text-dim)]">
                    <input type="checkbox" defaultChecked={se.needsApproval} /> approval before live
                  </span>
                </label>
              ))
            ) : (
              <span className="text-[11px] text-[var(--gs-text-dim)]">none — writes data artifacts only</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Pane ──────────────────────────────────────────────────────────────────── */

function NewTriggerForm({ onSave, onClose }: { onSave: (t: Trigger) => Promise<void> | void; onClose: () => void }): ReactElement {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TriggerKind>('cron');
  const [when, setWhen] = useState('every 6h');
  const [does, setDoes] = useState('');
  const [prompt, setPrompt] = useState('');
  const [writes, setWrites] = useState('data/');
  const [saving, setSaving] = useState(false);
  const valid = name.trim().length > 0 && prompt.trim().length > 0;
  const field = 'w-full border border-[var(--gs-border)] bg-black px-2 py-1 text-[11.5px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]';
  return (
    <div className="mb-3 border border-[var(--gs-border-active)] bg-[var(--gs-bg-elevated)] p-3">
      <div className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">New trigger</div>
      <div className="grid grid-cols-2 gap-2">
        <input className={field} placeholder="name (e.g. nightly-metrics)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-2">
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as TriggerKind)}>
            <option value="cron">cron</option><option value="event">event</option><option value="manual">manual</option>
          </select>
          <input className={field} placeholder="when (every 6h / on push / manual)" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
      </div>
      <input className={`${field} mt-2`} placeholder="one-line intent (what it does)" value={does} onChange={(e) => setDoes(e.target.value)} />
      <textarea className={`${field} mt-2 h-20 resize-none font-[family-name:var(--gs-font)]`} placeholder="agent prompt — what a run should do; write outputs as data artifacts" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <input className={`${field} mt-2`} placeholder="may write (comma-separated artifact paths/prefixes)" value={writes} onChange={(e) => setWrites(e.target.value)} />
      <div className="mt-2 flex justify-end gap-2">
        <XsButton onClick={onClose}>Cancel</XsButton>
        <button
          type="button"
          disabled={!valid || saving}
          onClick={async () => {
            if (!valid) return;
            setSaving(true);
            try {
              await onSave({
                name: name.trim(), kind, when: when.trim() || 'manual', status: 'idle', last: 'never',
                writes: writes.split(',').map((x) => x.trim()).filter(Boolean), history: [],
                does: does.trim() || undefined,
                runs: { type: 'skill', ref: 'agent-prompt', prompt: prompt.trim() },
                scope: 'workspace',
              });
              onClose();
            } finally { setSaving(false); }
          }}
          className="border border-[#1f4a2f] px-2.5 py-[3px] text-[11px] text-[var(--gs-accent)] disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save trigger'}
        </button>
      </div>
    </div>
  );
}

export function CronsPanel({ triggers = [], live = false, onSave, onRunNow }: CronsPanelProps): ReactElement {
  const [creating, setCreating] = useState(false);
  return (
    <div className="gs-ui flex h-full min-h-0 flex-col bg-[var(--gs-bg)]">
      {/* bar */}
      <div className="flex flex-none items-center gap-[11px] border-b border-[var(--gs-border)] bg-[#050505] px-4 py-[11px]">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">Crons &amp; triggers</span>
        {live ? <Chip tone="green">● live · armed in ship</Chip> : <Chip tone="dim">design mode · runs once shipped</Chip>}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onSave ? () => setCreating((v) => !v) : undefined}
          title={onSave ? undefined : 'Trigger persistence unavailable on this backend'}
          className="inline-flex min-h-[28px] cursor-pointer items-center justify-center gap-[5px] border border-[var(--gs-border)] bg-transparent px-2 py-[3px] text-[11px] text-[var(--gs-text-muted)] transition-colors hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)] disabled:opacity-40"
        >
          ＋ New trigger</button>
      </div>

      {/* list */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3.5">
        {creating && onSave && <NewTriggerForm onSave={onSave} onClose={() => setCreating(false)} />}
        {triggers.length === 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[12.5px] text-[var(--gs-text-muted)]">No triggers yet.</div>
            <div className="max-w-[520px] text-[11.5px] leading-[1.55] text-[var(--gs-text-dim)]">
              Triggers are cron, event or manual runs that write data artifacts. Once the registry ships, runs will
              surface here and as ▸ last-run chips on the data artifacts they refresh.
            </div>
          </div>
        ) : (
          triggers.map((t, i) => <TriggerCard key={t.id ?? `${t.name}-${i}`} t={t} live={live} onRunNow={onRunNow} />)
        )}
      </div>
    </div>
  );
}

export default CronsPanel;
