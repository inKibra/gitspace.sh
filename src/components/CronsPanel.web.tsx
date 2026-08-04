/** @jsxImportSource react */
import { useState, type ReactElement, type ReactNode } from 'react';
import { CRON_WHEN_HELP, describeNextRun, parseCronWhen, validateTriggerWhen } from '../core/trigger-grammar.js';

/**
 * CronsPanel — the '◷ Crons & triggers' dock pane (mock: agent-surfaces-app/src/app/CronsTriggers.tsx).
 * Trigger registry cards (cron / event / manual runs that write data artifacts) with a
 * capability strip, run-history spark and an inline expanding editor.
 *
 * Pure presentational — `triggers` come from the registry (triggers/*.trigger.json on the
 * artifacts branch); saves/runs go through the registry RPCs so the daemon owns validation
 * and the run lifecycle.
 */

/* ── Canonical trigger model ──────────────────────────────────────────────── */
import type { TriggerDraft, TriggerRecord } from '../core/triggers.js';
export type Trigger = TriggerRecord;
export type TriggerKind = TriggerRecord['kind'];
export type TriggerStatus = TriggerRecord['status'];
export type TriggerHistoryEntry = TriggerRecord['history'][number];

export interface TriggerIssue {
  path: string;
  issues: string[];
}

export interface CronsPanelProps {
  triggers?: Trigger[];
  triggerIssues?: TriggerIssue[];
  onSave?: (trigger: TriggerDraft) => Promise<void> | void;
  onRunNow?: (trigger: Trigger) => Promise<void> | void;
  target?: string;
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

/** Honest per-trigger status chip: what will actually happen, not stage theater. */
function statusChip(t: Trigger): { tone: ChipTone; label: string } {
  if (t.kind === 'cron' && parseCronWhen(t.when) === null) return { tone: 'red', label: 'never fires · bad schedule' };
  if (t.kind === 'event') return { tone: 'dim', label: 'manual only · no event engine' };
  return { tone: STATUS_TONE[t.status], label: t.status };
}

function TriggerCard({ t, onRunNow, onSave }: { t: Trigger; onRunNow?: (t: Trigger) => Promise<void> | void; onSave?: (t: TriggerDraft) => Promise<void> | void }): ReactElement {
  const [open, setOpen] = useState(false);
  // Inline editor state (seeded from the record each time the editor opens).
  const [editWhen, setEditWhen] = useState(t.when);
  const [editPrompt, setEditPrompt] = useState(t.runs?.prompt ?? '');
  const [editWrites, setEditWrites] = useState(t.writes.join(', '));
  const [savingEdit, setSavingEdit] = useState(false);
  const editWhenError = validateTriggerWhen(t.kind, editWhen);
  const lastRun = t.runLog?.[t.runLog.length - 1];
  const status = statusChip(t);
  const nextRun = t.kind === 'cron' && t.status !== 'pending' ? describeNextRun(t.when, lastRun?.at ?? null) : null;
  const openEditor = (): void => {
    setEditWhen(t.when);
    setEditPrompt(t.runs?.prompt ?? '');
    setEditWrites(t.writes.join(', '));
    setOpen(true);
  };

  return (
    <div
      className="border border-[var(--gs-border)] bg-[var(--gs-bg-surface)]"
    >
      {/* header row */}
      <div className="flex items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-[9px]">
        <span className="font-mono text-[12.5px] text-[var(--gs-text)]">{t.name}</span>
        <Chip tone={KIND_TONE[t.kind]}>{t.kind}</Chip>
        <span className="font-mono text-[10.5px] text-[var(--gs-text-dim)]">{t.when}</span>
        {t.scope ? <ScopeBadge scope={t.scope} /> : null}
        <span className="ml-auto" />
        <Chip tone={status.tone}>{status.label}</Chip>
        <XsButton onClick={onRunNow ? () => void Promise.resolve(onRunNow(t)).catch(() => {}) : undefined}>⟳ Run now</XsButton>
        <XsButton onClick={() => (open ? setOpen(false) : openEditor())}>{open ? 'Close' : 'Edit'}</XsButton>
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
        {t.feeds && t.feeds.length > 0 ? (
          <span className="text-[10.5px] text-[var(--gs-text-dim)]">feeds ▸ {t.feeds.join(', ')}</span>
        ) : null}
        <span className="ml-auto" />
        <span className="font-mono text-[10px] text-[var(--gs-text-dim)]">
          {lastRun ? `last ${new Date(lastRun.at).toLocaleString()} (${lastRun.status})` : t.last}
          {nextRun ? ` · next ${nextRun}` : ''}
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
          <EditorKicker>
            prompt <span className="normal-case tracking-normal text-[var(--gs-text-dim)]">— per-trigger instruction</span>
          </EditorKicker>
          <textarea
            className="box-border min-h-[120px] w-full resize-y border border-[var(--gs-border)] bg-black px-[11px] py-[9px] font-[family-name:var(--gs-font)] text-[11.5px] leading-[1.55] text-[var(--gs-text)] focus:border-[var(--gs-border-active)] focus:outline-none"
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
          />
          {t.kind === 'cron' ? (
            <>
              <EditorKicker>schedule</EditorKicker>
              <input
                className="w-full border border-[var(--gs-border)] bg-black px-2 py-1 font-[family-name:var(--gs-font)] text-[11.5px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-border-active)]"
                value={editWhen}
                onChange={(e) => setEditWhen(e.target.value)}
              />
              {editWhenError ? <div className="mt-1 text-[10.5px] text-[var(--gs-danger)]">{editWhenError}</div> : null}
            </>
          ) : null}
          <EditorKicker>capability scope — what this trigger may touch</EditorKicker>
          <div className="mb-[5px] flex flex-wrap items-center gap-[7px]">
            <span className="w-[78px] flex-none text-[10px] uppercase tracking-[0.07em] text-[var(--gs-text-dim)]">
              may write
            </span>
            <input
              className="min-w-[240px] flex-1 border border-[var(--gs-border)] bg-black px-2 py-1 font-[family-name:var(--gs-font)] text-[11px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-border-active)]"
              value={editWrites}
              onChange={(e) => setEditWrites(e.target.value)}
              placeholder="data/**, reports/*.report.json"
            />
          </div>
          {onSave ? (
            <div className="mt-2 flex justify-end gap-2">
              <XsButton onClick={() => setOpen(false)}>Cancel</XsButton>
              <button
                type="button"
                disabled={savingEdit || !!editWhenError}
                onClick={async () => {
                  setSavingEdit(true);
                  try {
                    await onSave({
                      ...t,
                      when: t.kind === 'cron' ? editWhen.trim() : t.when,
                      writes: editWrites.split(',').map((x) => x.trim()).filter(Boolean),
                      runs: { type: t.runs?.type ?? 'skill', ref: t.runs?.ref ?? 'agent-prompt', prompt: editPrompt.trim() },
                    });
                    setOpen(false);
                  } catch { /* toast raised by the caller */ }
                  finally { setSavingEdit(false); }
                }}
                className="border border-[#1f4a2f] px-2.5 py-[3px] text-[11px] text-[var(--gs-accent)] disabled:opacity-40"
              >
                {savingEdit ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Pane ──────────────────────────────────────────────────────────────────── */

function NewTriggerForm({ onSave, onClose, target }: { onSave: (t: TriggerDraft) => Promise<void> | void; onClose: () => void; target?: string }): ReactElement {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TriggerKind>('cron');
  const [when, setWhen] = useState('every 6h');
  const [does, setDoes] = useState('');
  const [prompt, setPrompt] = useState('');
  const [writes, setWrites] = useState('data/');
  const [saving, setSaving] = useState(false);
  const whenError = validateTriggerWhen(kind, when);
  const valid = name.trim().length > 0 && prompt.trim().length > 0 && !whenError;
  const field = 'w-full border border-[var(--gs-border)] bg-black px-2 py-1 text-[11.5px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]';
  return (
    <div className="mb-3 border border-[var(--gs-border-active)] bg-[var(--gs-bg-elevated)] p-3">
      <div className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">New trigger</div>
      <div className="grid grid-cols-2 gap-2">
        <input className={field} placeholder="name (e.g. nightly-metrics)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-2">
          <select
            className={field}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as TriggerKind;
              setKind(next);
              setWhen(next === 'cron' ? 'every 6h' : next === 'manual' ? 'manual' : 'on event');
            }}
          >
            <option value="cron">cron</option><option value="event">event (runs manually — no event engine yet)</option><option value="manual">manual</option>
          </select>
          <input className={field} placeholder={kind === 'cron' ? 'every 5m · every 6h · every 1d' : 'condition label'} value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
      </div>
      {kind === 'cron' ? (
        <div className={`mt-1 text-[10px] ${whenError ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text-ghost)]'}`}>
          {whenError ?? `${CRON_WHEN_HELP} · fires from this machine's daemon; first run within ~1 minute of saving`}
        </div>
      ) : null}
      <input className={`${field} mt-2`} placeholder="one-line intent (what it does)" value={does} onChange={(e) => setDoes(e.target.value)} />
      <textarea className={`${field} mt-2 h-20 resize-none font-[family-name:var(--gs-font)]`} placeholder="agent prompt — what a run should do; write outputs as data artifacts" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="mt-2">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">capability scope — may write</span>
          <span className="text-[10px] text-[var(--gs-text-ghost)]">artifact paths this trigger's runs are allowed to modify · comma-separated globs</span>
        </div>
        <input className={field} placeholder="data/**, reports/*.report.json" value={writes} onChange={(e) => setWrites(e.target.value)} />
        <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Runs are prompted with this scope and enforced by the machine daemon.</div>
      </div>
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
                scope: target?.endsWith(':@base') ? 'project' : 'workspace',
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

export function CronsPanel({ triggers = [], triggerIssues = [], onSave, onRunNow, target }: CronsPanelProps): ReactElement {
  const [creating, setCreating] = useState(false);
  const armed = triggers.filter((t) => t.kind === 'cron' && parseCronWhen(t.when) !== null).length;
  return (
    <div className="gs-ui flex h-full min-h-0 flex-col bg-[var(--gs-bg)]">
      <div className="flex flex-none items-center gap-[11px] border-b border-[var(--gs-border)] bg-[#050505] px-4 py-[11px]"><span className="text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">Crons &amp; triggers</span><Chip tone={armed > 0 ? 'green' : 'dim'}>{armed > 0 ? `● ${armed} armed · fires from this machine` : 'no cron triggers armed'}</Chip><span className="ml-auto" /><button type="button" disabled={!onSave} onClick={onSave ? () => setCreating((v) => !v) : undefined} className="border border-[var(--gs-border)] px-2 py-1 text-[11px] disabled:opacity-40">＋ New trigger</button></div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3.5">
        {creating && onSave && <NewTriggerForm onSave={onSave} onClose={() => setCreating(false)} target={target} />}
        {triggerIssues.map((issue) => <div key={issue.path} className="border border-[var(--gs-danger)] bg-[var(--gs-bg-surface)] px-3 py-2 text-[11px] text-[var(--gs-danger)]"><div className="font-mono">Invalid trigger: {issue.path}</div>{issue.issues.map((message) => <div key={message}>• {message}</div>)}</div>)}
        {triggers.length === 0 && triggerIssues.length === 0 ? <div className="text-[12.5px] text-[var(--gs-text-muted)]">No triggers yet.</div> : triggers.map((t, i) => <TriggerCard key={`${t.id}-${i}`} t={t} onRunNow={onRunNow} onSave={onSave} />)}
      </div>
    </div>
  );
}

export default CronsPanel;
