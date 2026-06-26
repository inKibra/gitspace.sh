import { type ReactElement } from 'react';
import type { ApprovalGateData, ChecklistData, HostUiDialogData, ReviewGateData, VerdictChipData } from '../types/interaction.js';
import { defineRenderer } from './registry.web.js';
import { useBlockHost } from './host.web.js';

const BTN = 'text-[11px] border px-2 py-0.5 disabled:opacity-40 disabled:cursor-default';
const BTN_PRIMARY = `${BTN} border-[var(--gs-accent)] text-[var(--gs-accent)]`;
const BTN_SECONDARY = `${BTN} border-[var(--gs-border)] text-[var(--gs-text-secondary)]`;
const BTN_DANGER = `${BTN} border-[var(--gs-danger)] text-[var(--gs-danger)]`;

// ── approval-gate (permission request) ──────────────────────────────────────
defineRenderer<ApprovalGateData>('approval-gate', ({ data, block }): ReactElement => {
  const host = useBlockHost();
  const options = data.options ?? ['Allow once', 'Always allow', 'Deny'];
  return (
    <div className="my-2 border border-[var(--gs-warning)] bg-[rgba(255,204,0,0.05)]">
      <div className="px-2 py-1 text-[11px] text-[var(--gs-warning)] border-b border-[var(--gs-warning)]">⚠ permission needed</div>
      <div className="px-2 py-2">
        <div className="mb-2 text-[12px] text-[var(--gs-text)] font-[family-name:var(--gs-font)]">{data.tool} · {data.detail}</div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o, i) => (
            <button key={o} type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, o)} className={i === 0 ? BTN_PRIMARY : BTN_SECONDARY}>{o}</button>
          ))}
        </div>
      </div>
    </div>
  );
});

// ── host-ui dialog ──────────────────────────────────────────────────────────
defineRenderer<HostUiDialogData>('hostui-dialog', ({ data, block }): ReactElement => {
  const host = useBlockHost();
  return (
    <div className="my-2 border border-[var(--gs-info)] bg-[rgba(68,136,255,0.05)] px-2 py-2">
      <div className="mb-1 text-[11px] text-[var(--gs-info)]">◆ agent asks · {data.dialog}</div>
      <div className="mb-2 text-[12.5px] text-[var(--gs-text)]">{data.prompt}</div>
      {data.dialog === 'select' && (
        <div className="flex flex-wrap gap-1.5">
          {(data.options ?? []).map((o) => <button key={o} type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, o)} className={BTN_SECONDARY}>{o}</button>)}
        </div>
      )}
      {data.dialog === 'confirm' && (
        <div className="flex gap-1.5">
          <button type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, true)} className={BTN_PRIMARY}>Yes</button>
          <button type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, false)} className={BTN_SECONDARY}>No</button>
        </div>
      )}
      {data.dialog === 'input' && <DialogInput onSend={(v) => host.resolve(block.id, v)} disabled={host.readOnly} />}
    </div>
  );
});

function DialogInput({ onSend, disabled }: { onSend: (value: string) => void; disabled: boolean }): ReactElement {
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('v') as HTMLInputElement | null;
        if (input?.value) onSend(input.value);
      }}
    >
      <input name="v" disabled={disabled} className="flex-1 bg-black border border-[var(--gs-border)] px-2 py-0.5 text-[12px] text-[var(--gs-text)] outline-none disabled:opacity-40" placeholder="type a response…" />
      <button type="submit" disabled={disabled} className={BTN_PRIMARY}>Send</button>
    </form>
  );
}

// ── verdict-chip ────────────────────────────────────────────────────────────
const VERDICT_TONE: Record<VerdictChipData['verdict'], string> = {
  pass: 'border-[var(--gs-success)] text-[var(--gs-success)]',
  fail: 'border-[var(--gs-danger)] text-[var(--gs-danger)]',
  partial: 'border-[var(--gs-warning)] text-[var(--gs-warning)]',
};
const VERDICT_GLYPH: Record<VerdictChipData['verdict'], string> = { pass: '✓', fail: '✕', partial: '~' };
defineRenderer<VerdictChipData>('verdict-chip', ({ data }): ReactElement => (
  <span className={`my-2 inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] ${VERDICT_TONE[data.verdict]}`}>
    <span>{VERDICT_GLYPH[data.verdict]}</span>
    <span>{data.label}</span>
    {data.severity && <span className="text-[var(--gs-text-dim)]">sev {data.severity}</span>}
    {data.confidence && <span className="text-[var(--gs-text-dim)]">conf {data.confidence}</span>}
  </span>
));

// ── checklist / todos ───────────────────────────────────────────────────────
defineRenderer<ChecklistData>('checklist', ({ data, block }): ReactElement => {
  const host = useBlockHost();
  return (
    <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-2">
      {data.title && <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--gs-text-dim)]">{data.title}</div>}
      {data.items.map((item, i) => (
        <button
          key={i}
          type="button"
          disabled={host.readOnly}
          onClick={() => host.dispatch({ kind: 'toggle', blockId: block.id, index: i })}
          className="flex w-full items-start gap-2 py-0.5 text-left disabled:cursor-default"
        >
          <span className={`mt-[1px] inline-block h-3.5 w-3.5 shrink-0 border text-center text-[10px] leading-[13px] ${item.done ? 'border-[var(--gs-success)] text-[var(--gs-success)]' : 'border-[var(--gs-border-active)] text-transparent'}`}>✓</span>
          <span className={`text-[12.5px] leading-[1.5] ${item.done ? 'text-[var(--gs-text-dim)] line-through' : 'text-[var(--gs-text-secondary)]'}`}>{item.text}</span>
          {item.evidence && <span className="ml-auto text-[10px] text-[var(--gs-text-dim)] font-[family-name:var(--gs-font)]">{item.evidence}</span>}
        </button>
      ))}
    </div>
  );
});

// ── review-gate ─────────────────────────────────────────────────────────────
defineRenderer<ReviewGateData>('review-gate', ({ data, block }): ReactElement => {
  const host = useBlockHost();
  return (
    <div className="my-2 border border-[var(--gs-border-active)] bg-[var(--gs-bg-elevated)]">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--gs-border)]">
        <span className="text-[11px] uppercase tracking-wide text-[var(--gs-text-dim)]">◆ review gate</span>
        <span className="text-[12px] text-[var(--gs-text)]">{data.label}</span>
        {data.status !== 'pending' && (
          <span className={`ml-auto text-[11px] ${data.status === 'approved' ? 'text-[var(--gs-success)]' : 'text-[var(--gs-danger)]'}`}>{data.status}</span>
        )}
      </div>
      <div className="px-2 py-2">
        {data.detail && <div className="mb-2 text-[12px] text-[var(--gs-text-muted)]">{data.detail}</div>}
        {data.status === 'pending' ? (
          <div className="flex gap-1.5">
            <button type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, 'approved')} className={BTN_PRIMARY}>Approve</button>
            <button type="button" disabled={host.readOnly} onClick={() => host.resolve(block.id, 'rejected')} className={BTN_DANGER}>Request changes</button>
          </div>
        ) : (
          <div className="text-[11px] text-[var(--gs-text-dim)]">resolved · {data.status}</div>
        )}
      </div>
    </div>
  );
});
