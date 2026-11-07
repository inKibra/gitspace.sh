import { Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle, ScrollArea, useShape } from '@gitspace/ui';
import type { ServiceView } from '@gitspace/protocol';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { Dataflow03, LinkExternal01, Play, Terminal } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { glyph } from '../glyph.js';
import { EmptyState, StatusDot } from '../GitSpaceShell.js';
import type { InspectorProps } from './Inspector.js';
import { ic, settle, formatDate, Tone, Heading, SectionTitle, Padded, MetaCard } from './inspector-shared.js';

const ServerGlyph = glyph(Dataflow03);

function serviceDot(state: ServiceView['state']): WorkspaceStatusColor {
  if (state === 'running' || state === 'ready') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'stopped' || state === 'exited') return 'dim';
  return 'blue';
}
export function ServicesSurface({ services, onOpenTerminal, onStart, onStop }: {
  services: readonly ServiceView[];
  onOpenTerminal?: (name: string) => void;
  onStart?: InspectorProps['onStartService'];
  onStop?: InspectorProps['onStopService'];
}) {
  const shape = useShape();
  const [selectedId, setSelectedId] = useState<string | null>(services[0]?.id ?? null);
  useEffect(() => setSelectedId((current) => services.some((service) => service.id === current) ? current : services[0]?.id ?? null), [services]);
  const selected = services.find((service) => service.id === selectedId) ?? null;
  if (!selected) return <Padded><EmptyState icon={ic(Play, 22)} title="No workspace services" description="Declare services in .gitspace/services.json. GitSpace assigns stable local ports and runs them through OMP Hub." /></Padded>;
  const running = selected.state !== 'stopped' && selected.state !== 'exited' && selected.state !== 'failed';
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2"><SectionTitle>Services</SectionTitle><span className="text-caption text-muted-foreground tabular-nums">{services.filter((service) => service.state === 'running' || service.state === 'ready').length} running</span></div>
      <CardGroup orientation="inline" border="outlined">{services.map((service) => <Card size="compact" selected={service.id === selected.id} onClick={() => setSelectedId(service.id)} label={service.name} key={service.id}>
        <CardMedia icon={ServerGlyph} />
        <CardHeader><CardTitle className="flex items-center gap-2"><StatusDot color={serviceDot(service.state)} />{service.name}</CardTitle><CardDescription className="tabular-nums">{service.port ? `:${service.port}` : service.state}</CardDescription></CardHeader>
        <CardFooter><Tone value={service.state} /></CardFooter>
      </Card>)}</CardGroup>
    </section>
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1"><span><Tone value={selected.state} /></span><Heading>{selected.name}</Heading><p className="text-body text-muted-foreground tabular-nums">Workspace generation {selected.generation}</p></header>
      <code className={`${shape.container} block overflow-auto bg-surface-1 p-3 font-mono text-caption text-foreground`}>{selected.command}</code>
      <CardGroup columns={2} separated border="outlined">
        <MetaCard label="Endpoint"><span className="truncate">{selected.url ?? 'Allocated when started'}</span></MetaCard>
        <MetaCard label="Port">{selected.port ?? '—'}</MetaCard>
        <MetaCard label="Started">{selected.startedAt ? formatDate(selected.startedAt) : 'Not started'}</MetaCard>
        <MetaCard label="Exit">{selected.exitCode ?? '—'}</MetaCard>
      </CardGroup>
      <div className="flex flex-wrap gap-2">
        {selected.url ? <Button variant="secondary" size="compact" asChild><a href={selected.url} target="_blank" rel="noreferrer">{ic(LinkExternal01, 14)}Open service</a></Button> : null}
        {running ? <Button variant="secondary" size="compact" type="button" onClick={() => settle(onStop?.(selected.name) ?? Promise.resolve())}>Stop</Button> : <Button variant="secondary" size="compact" type="button" onClick={() => settle(onStart?.(selected.name) ?? Promise.resolve())}>Start</Button>}
        {running ? <Button variant="secondary" size="compact" type="button" onClick={() => onOpenTerminal?.(selected.terminalName)}>{ic(Terminal, 14)}Open logs</Button> : null}
      </div>
    </section>
  </div></ScrollArea>;
}
