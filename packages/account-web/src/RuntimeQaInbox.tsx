import { useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeQaDocumentSchema, type RuntimeQaActionInput } from '@gitspace/protocol-runtime/workspace-controls';
import { Badge, Button, ScrollArea, useShape } from '@gitspace/ui';
import { EmptyState } from './GitSpaceShell.js';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export function RuntimeQaInbox({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const shape = useShape();
  const document = snapshot.documents['gitspace.qa'];
  const parsed = document === undefined ? null : RuntimeQaDocumentSchema.safeParse(document);
  const [editing, setEditing] = useState<string | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const [target, setTarget] = useState<'gitspace' | 'repository'>('gitspace');
  const [duplicate, setDuplicate] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [shareDraft, setShareDraft] = useState<string | null>(null);
  const identity = RuntimeIdentitySchema.parse(snapshot);
  const act = async (itemId: string, action: RuntimeQaActionInput['action']) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await rpcClient.runtime.qa({ ...identity, itemId, action });
      if (result.status === 'error') throw result.error;
      if (result.value.shareDraft) {
        const url = new URL(result.value.shareDraft);
        if (url.protocol !== 'https:') throw new Error('The sharing destination is not a secure issue draft.');
        setShareDraft(url.href);
        window.open(url.href, '_blank', 'noopener,noreferrer');
      }
      setEditing(null); setExcerpt(''); setDuplicate('');
    } catch (cause) { setError(rpcErrorMessage(cause, 'Update QA report')); }
    finally { busy.current = false; setPending(false); }
  };
  if (parsed?.success === false) return <p role="alert" className="p-6 text-destructive">The saved QA document is invalid. Reports have not been discarded.</p>;
  const items = parsed?.data?.items ?? [];
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="mx-auto flex max-w-3xl flex-col gap-4 p-6"><h2 className="text-title font-semibold">QA inbox</h2><p className="text-body text-muted-foreground">Reports stay inside your project. Review and redact an excerpt before opening an external issue draft. You must submit the issue yourself; preparing a draft does not mark this report as sent.</p>{shareDraft ? <p role="status" className="text-body"><a className="underline underline-offset-4" href={shareDraft} target="_blank" rel="noopener noreferrer">Open reviewed issue draft</a></p> : null}{error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}{!items.length ? <EmptyState title="No QA reports" description="Reports filed by this workspace appear here with their history reference." /> : items.map((item) => <article key={item.id} className={`${shape.container} bg-surface-2 p-4 shadow-surface-1`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-subtitle font-semibold">{item.title}</h3><Badge>{item.state}</Badge></div><div className="my-3"><GitSpaceMarkdown>{item.description}</GitSpaceMarkdown></div><p className="text-caption text-muted-foreground">{item.tool ?? 'Conversation'} · {item.model} · runtime {item.runtimeVersion}</p><p className="mt-1 break-all font-mono text-caption">{item.historyRef}</p>{item.duplicateOf ? <p className="mt-2 text-caption">Merged into {item.duplicateOf}</p> : null}
    {item.state === 'open' ? <div className="mt-4 flex flex-wrap gap-2"><Button variant="ghost" disabled={pending} onClick={() => void act(item.id, { kind: 'dismiss' })}>Dismiss</Button><Button variant="secondary" disabled={pending} onClick={() => { setEditing(item.id); setExcerpt(item.description); setDuplicate(''); }}>Review report</Button></div> : null}
    {editing === item.id ? <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4"><label className="flex flex-col gap-2 text-caption">Merge duplicate into<select className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={duplicate} onChange={(event) => setDuplicate(event.target.value)}><option value="">Choose another report</option>{items.filter((candidate) => candidate.id !== item.id && candidate.state === 'open').map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label><Button variant="secondary" disabled={pending || !duplicate} onClick={() => void act(item.id, { kind: 'merge', targetId: duplicate })}>Merge duplicate</Button>
      <label className="flex flex-col gap-2 text-caption">Redacted excerpt<textarea className="min-h-32 rounded-md bg-surface-3 px-3 py-2 text-body" value={excerpt} onChange={(event) => setExcerpt(event.target.value)} /></label><label className="flex flex-col gap-2 text-caption">External destination<select className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={target} onChange={(event) => { if (event.target.value === 'gitspace' || event.target.value === 'repository') setTarget(event.target.value); }}><option value="gitspace">GitSpace issue draft</option><option value="repository">Project repository issue draft</option></select></label><p className="text-caption text-muted-foreground">Remove credentials, personal data and private source before sharing. The redacted excerpt is included in the external draft URL. Submit the issue on the destination site.</p><div className="flex gap-2"><Button variant="ghost" disabled={pending} onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={pending || !excerpt.trim()} loading={pending} onClick={() => { if (window.confirm(`Open an issue draft containing this redacted excerpt at ${target === 'gitspace' ? 'GitSpace' : 'the project repository'}? This leaves your project.`)) void act(item.id, { kind: 'share', target, redactedExcerpt: excerpt.trim(), confirmed: true }); }}>Open reviewed draft</Button></div>
    </div> : null}
  </article>)}</div></ScrollArea>;
}
