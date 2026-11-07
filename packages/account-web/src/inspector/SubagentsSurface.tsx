import { TranscriptItemView } from '../chat/TranscriptItemView.js';
import { Badge, Button, Card, CardAction, CardContent, CardDescription, CardGroup, CardHeader, CardMedia, CardTitle, InputCopy, ScrollArea } from '@gitspace/ui';
import { Users01 } from '@untitledui/icons';
import { useState } from 'react';
import { glyph } from '../glyph.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState } from '../GitSpaceShell.js';
import type { InspectorProps } from './Inspector.js';
import { ic, shortHash, Tone, Padded } from './inspector-shared.js';

const UsersGlyph = glyph(Users01);
export function SubagentsSurface({ subagents, onStop, renderTranscript }: { subagents: InspectorProps['subagents']; onStop?: InspectorProps['onStopSubagent']; renderTranscript?: InspectorProps['renderSubagentTranscript'] }) {
  const [stopping, setStopping] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const stop = async (id: string) => {
    if (!onStop || stopping.includes(id)) return;
    setError(null); setStopping(values => [...values, id]);
    try { await onStop(id); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Stop subagent')); }
    finally { setStopping(values => values.filter(value => value !== id)); }
  };
  if (!subagents.length) return <Padded><EmptyState icon={ic(Users01, 22)} title="No delegated work" description="Subagents from the canonical agent transcript appear here while they run and after they yield." /></Padded>;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="p-4">{error ? <p role="alert" className="mb-3 text-destructive">{error}</p> : null}<CardGroup border="outlined">{subagents.map((agent) => {
    const model = agent.type === 'side-agent' && agent.runtime?.model ? `${agent.runtime.model.modelId} (${agent.runtime.model.provider})` : agent.model;
    return <Card key={agent.id}>
    <CardHeader><CardMedia icon={UsersGlyph} /><CardTitle>{agent.label}</CardTitle><CardDescription>{agent.type === 'side-agent' && agent.runtime ? <><span aria-label="Role">Role: {agent.runtime.role ?? 'Not selected'}</span> · <span aria-label="Model">Model: {model ?? 'Not admitted'}</span></> : [agent.agent ?? 'subagent', model, agent.status].filter(Boolean).join(' · ')}</CardDescription><CardAction className="flex flex-wrap gap-1"><Tone value={agent.status} />{agent.type === 'side-agent' && onStop && (agent.status === 'running' || agent.status === 'blocked') ? <Button variant="secondary" size="compact" aria-label={`Stop ${agent.label}`} disabled={stopping.includes(agent.agentId)} onClick={() => void stop(agent.agentId)}>{stopping.includes(agent.agentId) ? 'Stopping…' : 'Stop'}</Button> : null}{agent.type === 'execution' && agent.hasFailures && agent.status !== 'failed' ? <Badge variant="dot" color="red">Failure in history</Badge> : null}</CardAction></CardHeader>
    {agent.summary ? <CardContent><GitSpaceMarkdown>{agent.summary}</GitSpaceMarkdown></CardContent> : null}
    {agent.type === 'side-agent' && agent.runtime ? <CardContent>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
        <dt className="text-muted-foreground">Selected role</dt><dd>{agent.runtime.role ?? 'No role selected'}</dd>
        <dt className="text-muted-foreground">Admitted model</dt><dd className="break-all">{model ?? 'No model admitted'}</dd>
        {agent.runtime.definition ? <><dt className="self-center text-muted-foreground">Definition revision</dt><dd><InputCopy value={agent.runtime.definition.revision} displayValue={shortHash(agent.runtime.definition.revision)} className="max-w-48" /></dd></> : null}
      </dl>
      {agent.runtime.definition ? <details><summary className="min-h-10 cursor-pointer py-2 text-caption">Retained definition · read-only</summary><p className="mb-2 break-all font-mono text-caption text-muted-foreground">{agent.runtime.definition.path}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{agent.runtime.definition.content}</pre></details> : null}
    </CardContent> : null}
    {agent.type === 'side-agent' && renderTranscript ? <CardContent><Button variant="ghost" aria-expanded={expanded === agent.agentId} onClick={() => setExpanded(value => value === agent.agentId ? null : agent.agentId)}>{expanded === agent.agentId ? 'Hide transcript' : 'View transcript'}</Button>{expanded === agent.agentId ? renderTranscript(agent.agentId) : null}</CardContent> : agent.type === 'side-agent' && agent.messages?.length ? <CardContent><details><summary className="min-h-10 cursor-pointer py-2 text-caption">Conversation history</summary><div className="flex min-w-0 flex-col gap-2">{agent.messages.map(message => <TranscriptItemView key={message.id} item={message} active={false} />)}</div></details></CardContent> : null}
  </Card>; })}</CardGroup></div></ScrollArea>;
}
