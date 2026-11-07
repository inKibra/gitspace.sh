import { Button, Tooltip } from '@gitspace/ui';
import type { EvidenceReference } from '@gitspace/protocol';
import { File02 } from '@untitledui/icons';
import { useContext } from 'react';
import { RuntimeAvailability, ic, openWorkspaceFirst } from '../inspector/inspector-shared.js';

function EvidenceButton({ reference, onOpen }: { reference: EvidenceReference; onOpen: (reference: EvidenceReference) => void }) {
  const disabled = !useContext(RuntimeAvailability) && reference.kind === 'git';
  const button = <Button variant="tertiary" size="compact" type="button" disabled={disabled} onClick={() => onOpen(reference)}>{ic(File02, 14)}{reference.label}</Button>;
  return disabled ? <Tooltip content={openWorkspaceFirst}><span>{button}</span></Tooltip> : button;
}

/** Evidence references as buttons that open them (a file, a drive file, a review thread); git files need a live workspace. */
export function EvidenceList({ evidence, onOpen, prefix }: { evidence: readonly EvidenceReference[]; onOpen: (reference: EvidenceReference) => void; prefix: string }) {
  if (!evidence.length) return null;
  return <div className="flex flex-wrap gap-1">{evidence.map((reference, index) => <EvidenceButton reference={reference} onOpen={onOpen} key={`${prefix}:${index}`} />)}</div>;
}

/** A person by the device id a record names: "you" for this browser's device. */
export function personLabel(id: string, viewerId: string): string {
  return id === viewerId ? 'you' : id;
}
