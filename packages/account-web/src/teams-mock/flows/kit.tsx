// The pieces every Settings action draws with, so each dialog and wizard looks like account-web's own dialogs
// (Dialog, DialogContent, DialogHeader, DialogFooter; InputGroup + InputField; errors as `role="alert"` caption text in
// the destructive colour): a dialog frame with an optional step indicator, choice cards, a text area, a chip picker,
// a passkey step, an error line and a success panel. A wizard's steps are labelled ("1 Kind · 2 Details · 3 Sign in");
// the current one is highlighted and finished ones carry a check.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ThinkingIndicator } from '@gitspace/ui';
import { Check, CheckCircle, Fingerprint01 } from '@untitledui/icons';
import type { ComponentType, ReactNode } from 'react';
import { passkeyLabel } from '../settings/passkey.js';

export type FlowIcon = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;

/**
 * A Settings action's dialog. `id` lands on the content as `data-flow` (screenshots find it by that). With `steps`,
 * a step indicator heads the body and `step` (0-based) is the current one; `done` marks every step finished (the
 * success state). `footer` is the dialog's buttons; leave it out for a body that has its own.
 */
export function FlowDialog({ id, title, description, steps, step = 0, done = false, wide = true, onClose, children, footer }: {
  id: string; title: ReactNode; description?: ReactNode; steps?: readonly string[]; step?: number; done?: boolean; wide?: boolean;
  onClose(): void; children: ReactNode; footer?: ReactNode;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent size={wide ? 'lg' : 'sm'} data-flow={id} data-flow-step={done ? 'done' : String(step)} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription>{description}</DialogDescription> : null}</DialogHeader>
      {steps ? <StepIndicator steps={steps} current={step} done={done} /> : null}
      <div className="flex flex-col gap-4">{children}</div>
      {footer ? <DialogFooter className="flex-wrap">{footer}</DialogFooter> : null}
    </DialogContent>
  </Dialog>;
}

/** "1 Kind · 2 Details · 3 Sign in": numbered steps, the current one highlighted, finished ones checked. */
export function StepIndicator({ steps, current, done }: { steps: readonly string[]; current: number; done: boolean }) {
  return <ol aria-label="Steps" data-steps="" className="-mt-1 mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption">
    {steps.map((label, index) => {
      const finished = done || index < current;
      const active = !done && index === current;
      return <li key={label} aria-current={active ? 'step' : undefined} className="flex items-center gap-1.5">
        {index > 0 ? <span aria-hidden className="h-px w-3 bg-border" /> : null}
        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${active ? 'bg-foreground text-background' : finished ? 'bg-[color-mix(in_oklab,#17b26a_18%,transparent)] text-[#067647]' : 'bg-muted text-muted-foreground'}`}>
          {finished ? <Check width={12} height={12} strokeWidth={2.5} /> : index + 1}
        </span>
        <span className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
      </li>;
    })}
  </ol>;
}

/** Back / Cancel at the left of the footer's buttons, then the step's primary action. */
export function StepButtons({ step, onBack, onCancel, next, nextLabel, disabled, busy }: {
  step: number; onBack(): void; onCancel(): void; next(): void; nextLabel: string; disabled?: boolean; busy?: boolean;
}) {
  return <>
    {step > 0 ? <Button variant="ghost" onClick={onBack} disabled={busy}>Back</Button> : <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>}
    <Button variant="primary" onClick={next} disabled={disabled || busy} loading={busy}>{nextLabel}</Button>
  </>;
}

/** A form-level error: what went wrong and what to do about it. */
export function FlowError({ children }: { children: ReactNode }) {
  return <p role="alert" data-flow-error="" className="text-caption text-destructive">{children}</p>;
}

/** A hint under a field or group. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-caption text-muted-foreground">{children}</p>;
}

/** The finished state: a check, what happened, and what follows. */
export function FlowSuccess({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div role="status" data-flow-success="" className="flex items-start gap-3 rounded-xl bg-[color-mix(in_oklab,#17b26a_8%,transparent)] px-3 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#17b26a_30%,transparent)]">
    <CheckCircle width={20} height={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#079455]" />
    <span className="flex min-w-0 flex-col gap-1 text-body text-foreground"><span className="font-medium">{title}</span>{children ? <span className="text-caption text-muted-foreground">{children}</span> : null}</span>
  </div>;
}

export interface Choice { id: string; title: string; detail: ReactNode; icon?: FlowIcon; badge?: ReactNode; disabled?: string | null }

/** One-of choice cards (a radio group): a kind of provider, a policy, a way in. A disabled card says why. */
export function ChoiceCards({ label, choices, value, onChange, columns = 1 }: { label: string; choices: readonly Choice[]; value: string; onChange(id: string): void; columns?: 1 | 2 }) {
  return <div role="radiogroup" aria-label={label} className={`grid gap-2 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
    {choices.map((choice) => {
      const selected = choice.id === value;
      const Icon = choice.icon;
      return <button key={choice.id} type="button" role="radio" aria-checked={selected} data-choice={choice.id} disabled={Boolean(choice.disabled)} title={choice.disabled ?? undefined}
        onClick={() => onChange(choice.id)}
        className={`flex min-w-0 items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${selected ? 'bg-[color-mix(in_oklab,#6B97FF_10%,transparent)] shadow-[inset_0_0_0_1.5px_#6B97FF]' : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover'}`}>
        <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-[#6B97FF]' : 'shadow-[inset_0_0_0_1.5px_var(--border)]'}`}>{selected ? <span className="size-1.5 rounded-full bg-white" /> : null}</span>
        {Icon ? <Icon width={18} height={18} strokeWidth={1.5} className="mt-0.5 shrink-0 text-muted-foreground" /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="flex flex-wrap items-center gap-2 text-body font-medium text-foreground">{choice.title}{choice.badge}</span>
          <span className="text-caption text-muted-foreground">{choice.disabled ?? choice.detail}</span></span>
      </button>;
    })}
  </div>;
}

/** Many-of chips: projects, capabilities, repositories. Withheld ones are struck through. */
export function ChipPicker({ label, options, picked, onChange }: { label: string; options: ReadonlyArray<{ id: string; label: string; disabled?: string | null }>; picked: ReadonlySet<string>; onChange(next: ReadonlySet<string>): void }) {
  return <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
    {options.map((option) => {
      const on = picked.has(option.id);
      return <button key={option.id} type="button" aria-pressed={on} disabled={Boolean(option.disabled)} title={option.disabled ?? undefined}
        onClick={() => { const next = new Set(picked); if (on) next.delete(option.id); else next.add(option.id); onChange(next); }}
        className={`rounded-full px-2.5 py-1 text-caption transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-foreground text-background' : 'text-muted-foreground line-through shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-foreground'}`}>{option.label}</button>;
    })}
  </div>;
}

/** A labelled multi-line field, styled like InputField. */
export function TextArea({ label, value, onChange, placeholder, error, rows = 4, mono = false }: { label: string; value: string; onChange(value: string): void; placeholder?: string; error?: string; rows?: number; mono?: boolean }) {
  return <label className="flex flex-col gap-1.5">
    <span className="text-caption font-medium text-foreground">{label}</span>
    <textarea value={value} rows={rows} placeholder={placeholder} aria-invalid={error ? true : undefined} onChange={(event) => onChange(event.target.value)}
      className={`w-full resize-y rounded-xl bg-surface-1 px-3 py-2 text-body text-foreground outline-none placeholder:text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] focus:shadow-[inset_0_0_0_1.5px_#6B97FF] ${mono ? 'font-mono text-[12px]' : ''} ${error ? 'shadow-[inset_0_0_0_1.5px_var(--destructive)]' : ''}`} />
    {error ? <span role="alert" className="text-caption text-destructive">{error}</span> : null}
  </label>;
}

/** A key/value summary of what is about to be created. */
export function Summary({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return <dl data-flow-summary="" className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 rounded-xl px-3 py-2.5 text-body shadow-[inset_0_0_0_1px_var(--border)]">
    {rows.map(([key, value]) => <div key={key} className="contents"><dt className="text-caption text-muted-foreground">{key}</dt><dd className="min-w-0 break-words text-foreground">{value}</dd></div>)}
  </dl>;
}

/** The passkey confirmation step: waiting for the browser, then the caller moves on. */
export function PasskeyStep({ userId, what, waiting }: { userId: string; what: string; waiting: boolean }) {
  return <div role="status" data-passkey-step="" className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-3 text-body text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
    {waiting ? <ThinkingIndicator /> : null}<Fingerprint01 width={20} height={20} strokeWidth={1.5} />
    <span>{waiting ? `Confirm ${what} with ${passkeyLabel(userId)}…` : `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} needs ${passkeyLabel(userId)}.`}</span>
  </div>;
}

/** A secret shown once, with a warning that it can't be shown again. */
export function ShownOnce({ label, value }: { label: string; value: string }) {
  return <div data-shown-once="" className="flex flex-col gap-1.5 rounded-xl bg-[color-mix(in_oklab,#f79009_8%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#f79009_35%,transparent)]">
    <span className="text-caption font-medium text-foreground">{label} · shown once</span>
    <code className="break-all rounded-lg bg-surface-1 px-2 py-1.5 font-mono text-[12px] text-foreground">{value}</code>
    <span className="text-caption text-muted-foreground">Copy it now. GitSpace keeps only a hash; if it’s lost, revoke it and make a new one.</span>
  </div>;
}

/** A DNS record row (type, name, value) with its check state. */
export function DnsRecord({ type, name, value, state }: { type: string; name: string; value: string; state: 'waiting' | 'found' | 'wrong' }) {
  return <div data-dns-record={state} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
    <span className="font-mono text-caption font-semibold text-foreground">{type}</span>
    <span className="flex min-w-0 flex-col"><span className="break-all font-mono text-caption text-foreground">{name}</span><span className="break-all font-mono text-caption text-muted-foreground">{value}</span></span>
    <span className={`text-caption ${state === 'found' ? 'text-[#067647]' : state === 'wrong' ? 'text-destructive' : 'text-muted-foreground'}`}>{state === 'found' ? 'Found' : state === 'wrong' ? 'Wrong value' : 'Not found yet'}</span>
  </div>;
}
