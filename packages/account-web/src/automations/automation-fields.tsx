import { SelectContent, SelectItem, useShape } from '@gitspace/ui';
import { type ReactElement, type ReactNode } from 'react';

export function Stat({ value, label }: { value: ReactNode; label: string }): ReactElement {
  return <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
    <strong className="text-title font-semibold tabular-nums text-foreground">{value}</strong>
    <span className="text-caption text-muted-foreground">{label}</span>
  </div>;
}

export function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-body text-foreground [overflow-wrap:anywhere]">{children}</dd>
  </>;
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return <section aria-label={title} className="mb-8 flex flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-2"><h2 className="text-subtitle font-semibold">{title}</h2>{aside}</div>
    {children}
  </section>;
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }): ReactElement {
  return <div className="flex min-w-0 flex-col gap-1">
    <label className="flex min-w-0 flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">{label}</span>{children}</label>
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

export function TextInput({ label, value, onChange, invalid = false, mono = false, placeholder, type = 'text', min, max }: { label: string; value: string; onChange(value: string): void; invalid?: boolean; mono?: boolean; placeholder?: string; type?: 'text' | 'number' | 'time'; min?: number; max?: number }): ReactElement {
  const shape = useShape();
  return <input aria-label={label} aria-invalid={invalid || undefined} placeholder={placeholder} value={value} type={type} min={min} max={max} onChange={event => onChange(event.currentTarget.value)}
    className={`${shape.input} h-9 w-full min-w-0 border bg-background px-2 text-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${invalid ? 'border-destructive' : 'border-border'} ${mono ? 'font-mono' : ''}`} />;
}

export function options(values: readonly { value: string; label: string }[]): ReactElement {
  return <SelectContent>{values.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}
