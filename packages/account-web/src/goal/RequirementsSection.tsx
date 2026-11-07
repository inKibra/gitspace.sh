// The goal's requirements: each with its evidence and the Change Guide sections that show it. Only a person accepts
// (inspector.requirement.setAcceptance); the row then says who accepted it and when, and unticking reopens it.
import { Badge, Button, useShape } from '@gitspace/ui';
import type { ChangeGuideView, EvidenceReference, GoalRequirement, RequirementStatus } from '@gitspace/protocol';
import { BookOpen01, Check } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { formatDate } from '../inspector/inspector-shared.js';
import { EvidenceList, personLabel } from './Evidence.js';

const STATUS_COLOR: Record<RequirementStatus, 'green' | 'amber' | 'gray'> = { accepted: 'green', review: 'amber', missing: 'gray' };
const STATUS_LABEL: Record<RequirementStatus, string> = { accepted: 'accepted', review: 'evidence to check', missing: 'no evidence' };

export function RequirementsSection({ requirements, guide, viewerId, onSetAcceptance, onOpenEvidence, onOpenGuideSection }: {
  requirements: readonly GoalRequirement[]; guide: ChangeGuideView | null; viewerId: string;
  onSetAcceptance?(requirementId: string, accepted: boolean): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void; onOpenGuideSection(sectionId: string): void;
}): ReactElement {
  const shape = useShape();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!requirements.length) return <p className="text-body text-muted-foreground">No requirements yet.</p>;
  const required = requirements.filter(requirement => requirement.required);
  const accepted = required.filter(requirement => requirement.status === 'accepted').length;
  const setAcceptance = (requirement: GoalRequirement, value: boolean): void => {
    if (!onSetAcceptance || pending) return;
    setPending(requirement.id);
    setError(null);
    void onSetAcceptance(requirement.id, value)
      .catch((cause: unknown) => setError(rpcErrorMessage(cause, value ? `Accept ${requirement.title}` : `Reopen ${requirement.title}`)))
      .finally(() => setPending(null));
  };
  return <section aria-label="Requirements" className={`${shape.container} flex min-w-0 flex-col border border-border bg-surface-1 p-4`}>
    <div className="flex items-start justify-between gap-4">
      <span className="text-caption text-muted-foreground">Tick to accept; only a person accepts, the agent attaches evidence.</span>
      <span className="flex shrink-0 items-center gap-1.5 text-caption tabular-nums text-muted-foreground">{required.length && accepted === required.length ? <Check width={14} height={14} strokeWidth={2.5} className="text-foreground" /> : null}{accepted}/{required.length} required</span>
    </div>
    {/* FLUID-GAP: progress meter — the registry has no read-only progress bar; the fill width is the measured ratio. */}
    <div className={`${shape.bg} my-3 h-1 overflow-hidden bg-muted`} role="progressbar" aria-label="Accepted requirements" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={accepted}>
      <div className="h-full bg-foreground" style={{ width: `${required.length ? accepted / required.length * 100 : 0}%` }} />
    </div>
    {error ? <p role="alert" className="pb-2 text-caption text-destructive">{error}</p> : null}
    <ul className="flex flex-col divide-y divide-border">
      {requirements.map(requirement => {
        const checked = requirement.status === 'accepted';
        const disabled = !onSetAcceptance || pending !== null || (!checked && requirement.status === 'missing');
        const sections = guide?.sections.flatMap((section, index) => section.requirementIds.includes(requirement.id) ? [{ id: section.id, number: index + 1 }] : []) ?? [];
        return <li key={requirement.id} className="flex items-start gap-3 py-3" aria-label={requirement.title}>
          <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} aria-label={`${checked ? 'Reopen' : 'Accept'}: ${requirement.title}`} onClick={() => setAcceptance(requirement, !checked)}
            title={!checked && requirement.status === 'missing' ? 'No evidence to accept yet' : undefined}
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-foreground bg-foreground text-background' : 'border-border bg-background'} ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`}>
            {checked ? <Check width={12} height={12} strokeWidth={3} /> : null}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={`text-body font-medium ${checked ? 'text-muted-foreground' : 'text-foreground'}`}>{requirement.title}</span>
              {requirement.required ? null : <Badge size="compact" color="gray">optional</Badge>}
            </span>
            {requirement.description ? <GitSpaceMarkdown className="text-caption [&_p]:text-muted-foreground">{requirement.description}</GitSpaceMarkdown> : null}
            {checked && requirement.acceptedBy ? <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
              <span>Accepted by <span className="text-foreground">{personLabel(requirement.acceptedBy, viewerId)}</span>{requirement.acceptedAt ? <> · <time className="tabular-nums">{formatDate(requirement.acceptedAt)}</time></> : null}</span>
              {onSetAcceptance ? <Button variant="ghost" size="compact" type="button" disabled={pending !== null} onClick={() => setAcceptance(requirement, false)}>Reopen</Button> : null}
            </span> : null}
            {sections.length ? <span className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground">Shown in {sections.map(section => <Button key={section.id} variant="tertiary" size="compact" type="button" onClick={() => onOpenGuideSection(section.id)}><BookOpen01 width={12} height={12} />Guide §{section.number}</Button>)}</span> : null}
            <EvidenceList evidence={requirement.evidence} onOpen={onOpenEvidence} prefix={requirement.id} />
          </div>
          <span className="flex w-32 shrink-0 justify-end pt-0.5"><Badge variant="dot" size="compact" color={STATUS_COLOR[requirement.status]}>{STATUS_LABEL[requirement.status]}</Badge></span>
        </li>;
      })}
    </ul>
  </section>;
}
