// The Evidence block (docs/BLOCK-DOCUMENTS-DESIGN.md §5): a reference a requirement, rubric or judgment rests on (a
// commit's file, a drive artifact, a command run, an older review thread), drawn as a link card that opens it. Its
// Markdown form is `evidenceMarkdown`.
import { Button, Tooltip } from '@gitspace/ui';
import type { EvidenceReference } from '@gitspace/protocol';
import { File02, GitCommit, MessageSquare01, Terminal } from '@untitledui/icons';
import { useContext } from 'react';
import { RuntimeAvailability, ic, openWorkspaceFirst } from '../inspector/inspector-shared.js';

export const EVIDENCE_ICON: Record<EvidenceReference['kind'], typeof File02> = { artifact: File02, git: GitCommit, command: Terminal, 'review-thread': MessageSquare01 };

/** One Evidence block: its kind's icon and label, opening the reference; git files need a live workspace. */
export function EvidenceBlock({ reference, onOpen }: { reference: EvidenceReference; onOpen: (reference: EvidenceReference) => void }) {
  const disabled = !useContext(RuntimeAvailability) && reference.kind === 'git';
  const text = reference.kind === 'command' ? `${reference.label} · exit ${reference.exitCode}` : reference.label;
  const button = <Button variant="tertiary" size="compact" type="button" disabled={disabled} onClick={() => onOpen(reference)}>{ic(EVIDENCE_ICON[reference.kind], 14)}{text}</Button>;
  return <span data-block-type="Evidence" data-evidence={reference.kind} className="inline-flex">{disabled ? <Tooltip content={openWorkspaceFirst}><span>{button}</span></Tooltip> : button}</span>;
}

/** Evidence blocks in a row. */
export function EvidenceList({ evidence, onOpen, prefix }: { evidence: readonly EvidenceReference[]; onOpen: (reference: EvidenceReference) => void; prefix: string }) {
  if (!evidence.length) return null;
  return <div className="flex flex-wrap gap-1">{evidence.map((reference, index) => <EvidenceBlock reference={reference} onOpen={onOpen} key={`${prefix}:${index}`} />)}</div>;
}

/** A person by the device id a record names: "you" for this browser's device. */
export function personLabel(id: string, viewerId: string): string {
  return id === viewerId ? 'you' : id;
}
