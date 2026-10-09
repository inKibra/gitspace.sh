import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApplyPatchArgumentsSchema, RuntimeBashCommandArgumentsSchema, RuntimeEditArgumentsSchema, RuntimeWriteArgumentsSchema, type RuntimeMachineSelector, type RuntimeQuestionTool } from '@gitspace/protocol-runtime';
import { Badge, Button, useShape } from '@gitspace/ui';
import { ChevronRight } from '@untitledui/icons';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Machine = { id: string; label: string };
type ApprovalView = { verb: string; subject: string | null; description: string | null; facts: Array<[string, string]>; body: ReactNode };

/** A fence longer than any tilde run in the text, so file content can never close the block early. */
function fenced(text: string, language: string): string {
  const fence = '~'.repeat(Math.max(3, ...[...text.matchAll(/~+/gu)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function machineText(selector: RuntimeMachineSelector | undefined, machines: readonly Machine[]): string {
  if (selector === undefined) return 'Workspace default';
  if (typeof selector === 'string') return machines.find(machine => machine.id === selector)?.label ?? selector;
  return [selector.profile ? `Profile ${selector.profile}` : null, selector.needs?.length ? `needs ${selector.needs.join(', ')}` : null, selector.prefer ? `prefer ${selector.prefer}` : null].filter(Boolean).join(' · ') || 'Workspace default';
}

function Collapsed({ summary, open = false, children }: { summary: string; open?: boolean; children: string }) {
  return <details open={open} className="group min-w-0 text-caption">
    <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden"><ChevronRight className="shrink-0 transition-transform group-open:rotate-90" width={14} height={14} strokeWidth={1.5} aria-hidden />{summary}</summary>
    <GitSpaceMarkdown>{children}</GitSpaceMarkdown>
  </details>;
}

function editDiff(edits: readonly { oldText: string; newText: string }[]): string {
  const side = (prefix: string, text: string) => text.split('\n').map(line => `${prefix}${line}`).join('\n');
  return edits.map((edit, index) => `@@ replacement ${index + 1} @@\n${side('-', edit.oldText)}\n${side('+', edit.newText)}`).join('\n');
}

function approvalView({ name, args }: RuntimeQuestionTool, machines: readonly Machine[]): ApprovalView {
  if (name === 'write') {
    const write = RuntimeWriteArgumentsSchema.safeParse(args);
    if (write.success) {
      const lines = lineCount(write.data.content);
      const extension = /\.([A-Za-z0-9]+)$/u.exec(write.data.path)?.[1]?.toLowerCase() ?? '';
      return { verb: 'Write', subject: write.data.path, description: write.data.message ?? null, facts: [['Size', plural(lines, 'line')]], body: <Collapsed summary={`Show content · ${plural(lines, 'line')}`}>{fenced(write.data.content, extension)}</Collapsed> };
    }
  }
  if (name === 'edit') {
    const edit = RuntimeEditArgumentsSchema.safeParse(args);
    if (edit.success) return { verb: 'Edit', subject: edit.data.path, description: edit.data.message ?? null, facts: [['Changes', plural(edit.data.edits.length, 'replacement')]], body: <Collapsed open summary="Diff">{fenced(editDiff(edit.data.edits), 'diff')}</Collapsed> };
  }
  if (name === 'apply_patch') {
    const patch = ApplyPatchArgumentsSchema.safeParse(args);
    if (patch.success) {
      const paths = [...new Set([...patch.data.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map(match => match[1]!.trim()))];
      return { verb: 'Edit', subject: paths.join(', ') || null, description: patch.data.message ?? null, facts: [['Files', plural(paths.length, 'file')]], body: <Collapsed open summary="Patch">{fenced(patch.data.patch, 'diff')}</Collapsed> };
    }
  }
  if (name === 'bash') {
    const bash = RuntimeBashCommandArgumentsSchema.safeParse(args);
    if (bash.success) return {
      verb: 'Run command', subject: null, description: null,
      facts: [['Directory', bash.data.cwd ?? 'Repository root'], ['Machine', machineText(bash.data.on, machines)], ...(bash.data.at ? [['Source', bash.data.at] satisfies [string, string]] : []), ...(bash.data.background ? [['Mode', 'Background job'] satisfies [string, string]] : [])],
      body: <GitSpaceMarkdown>{fenced(bash.data.command, 'sh')}</GitSpaceMarkdown>,
    };
  }
  return { verb: 'Use', subject: name, description: null, facts: [], body: <Collapsed summary="Arguments">{fenced(JSON.stringify(args, null, 2), 'json')}</Collapsed> };
}

/** Approval for one tool call, rendered from the call itself instead of a stringified prompt. */
export function ToolApprovalCard({ tool, machines, connected, onAnswer }: { tool: RuntimeQuestionTool; machines: readonly Machine[]; connected: boolean; onAnswer(approved: boolean): Promise<void> }) {
  const shape = useShape();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const view = approvalView(tool, machines);
  const answer = async (approved: boolean) => {
    if (busy.current || !connected) return;
    busy.current = true; setPending(true); setError(null);
    try { await onAnswer(approved); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Answer tool approval')); }
    finally { busy.current = false; setPending(false); }
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== '1' && event.key !== '2')) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      void answerRef.current(event.key === '1');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  return <section aria-label="Tool approval" className={`${shape.container} pointer-events-auto mb-2 flex max-h-[55dvh] flex-col gap-3 overflow-y-auto bg-surface-3 p-4 shadow-surface-3`}>
    <div className="flex items-start justify-between gap-3">
      <h2 className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{view.verb}{view.subject ? <> <span className="font-mono">{view.subject}</span></> : null}</h2>
      <Badge color="amber">Approval required</Badge>
    </div>
    {view.description ? <p className="text-caption text-muted-foreground text-pretty">{view.description}</p> : null}
    {view.facts.length ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
      {view.facts.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}
    </dl> : null}
    {view.body}
    {!connected ? <p role="status" className="text-caption text-muted-foreground">Reconnect before answering.</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto text-caption text-muted-foreground">Press 1 to approve, 2 to reject</span>
      <Button variant="secondary" aria-keyshortcuts="2" disabled={pending || !connected} onClick={() => void answer(false)}>Reject</Button>
      <Button variant="primary" aria-keyshortcuts="1" loading={pending} disabled={pending || !connected} onClick={() => void answer(true)}>Approve</Button>
    </div>
  </section>;
}
