import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import type { GitLfsHeldBack } from '@gitspace/protocol-workspace';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ScrollArea } from '@gitspace/ui';

export type ConfirmLfsTransition = (heldBack: readonly GitLfsHeldBack[], onCommit: () => void | Promise<void>, blockedReason?: string | null) => Promise<boolean>;
export function runtimeLfsHeldBack(snapshot: RuntimeSnapshot | undefined): GitLfsHeldBack[] {
  const document = snapshot?.documents['gitspace.code'];
  if (document === undefined || document === null) return [];
  return RuntimeGitCheckpointSchema.parse(document).lfs?.heldBack ?? [];
}

export function LfsTransitionDialog({ paths, blockedReason, onChoose }: { paths: readonly GitLfsHeldBack[] | null; blockedReason?: string | null; onChoose(choice: 'commit' | 'continue' | 'cancel'): void }) {
  return <Dialog open={paths !== null} onOpenChange={open => { if (!open) onChoose('cancel'); }}><DialogContent className="flex max-h-[85dvh] flex-col"><DialogHeader><DialogTitle>Leave these LFS changes on this machine?</DialogTitle><DialogDescription>LFS changes leave this machine only after a commit</DialogDescription></DialogHeader>{blockedReason ? <p role="alert" className="break-words text-caption text-warning">{blockedReason}</p> : null}<ScrollArea className="min-h-0 flex-1"><ul className="flex flex-col gap-2">{paths?.map(item => <li key={item.path} className="break-all font-mono text-caption">{item.path}</li>)}</ul></ScrollArea><div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => onChoose('cancel')}>Cancel</Button><Button variant="secondary" onClick={() => onChoose('continue')}>Continue without them</Button><Button variant="primary" onClick={() => onChoose('commit')}>Commit first</Button></div></DialogContent></Dialog>;
}

export function useLfsTransition() {
  const [request, setRequest] = useState<{ paths: readonly GitLfsHeldBack[]; blockedReason?: string | null } | null>(null);
  const pending = useRef<((choice: 'commit' | 'continue' | 'cancel') => void) | null>(null);
  useEffect(() => () => { pending.current?.('cancel'); pending.current = null; }, []);
  const choose = (choice: 'commit' | 'continue' | 'cancel') => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(choice);
  };
  return {
    confirm: async (heldBack: readonly GitLfsHeldBack[], onCommit: () => void | Promise<void>, blockedReason?: string | null): Promise<boolean> => {
      if (!heldBack.length && !blockedReason) return true;
      if (pending.current) return false;
      const choice = await new Promise<'commit' | 'continue' | 'cancel'>(resolve => { pending.current = resolve; setRequest({ paths: heldBack, blockedReason }); });
      if (choice === 'commit') await onCommit();
      return choice === 'continue';
    },
    dialog: <LfsTransitionDialog paths={request?.paths ?? null} blockedReason={request?.blockedReason} onChoose={choose} />,
  };
}
