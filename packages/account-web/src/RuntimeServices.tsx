import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeServiceCommand, RuntimeServiceResult } from '@gitspace/protocol-runtime/services';
import { Badge, Button } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Inventory = Extract<RuntimeServiceResult, { op: 'list' }>['machines'];
export function useRuntimeServices(snapshot: RuntimeSnapshot) {
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const [machines, setMachines] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [logs, setLogs] = useState<{ title: string; text: string } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const result = await rpcClient.runtime.services({ ...identity, command: { op: 'list' } });
    if (current !== generation.current) return;
    if (result.status === 'error') { setError(rpcErrorMessage(result.error, 'runtime.services')); return; }
    if (result.value.op === 'list') { setMachines(result.value.machines); setError(null); }
  }, [identity]);
  const attachmentKey = JSON.stringify(snapshot.attachments.map(item => [item.machineId, item.attachmentId, item.generation, item.state, item.heartbeatAt !== null && Date.now() - Date.parse(item.heartbeatAt) < 30_000]));
  useEffect(() => { setMachines(null); setLogs(null); void refresh(); return () => { generation.current++; }; }, [refresh, attachmentKey]);
  const act = async (command: Exclude<RuntimeServiceCommand, { op: 'list' }>, machineName: string) => {
    setPending(true); setError(null);
    const current = generation.current;
    try {
      const result = await rpcClient.runtime.services({ ...identity, command });
      if (current !== generation.current) return;
      if (result.status === 'error') { setError(rpcErrorMessage(result.error, 'runtime.services')); return; }
      if (result.value.op === 'logs') setLogs({ title: `${command.name} · ${machineName}`, text: result.value.log.text });
      else await refresh();
    } finally { setPending(false); }
  };
  return { machines, error, pending, logs, refresh, act, closeLogs: () => setLogs(null) };
}

export function RuntimeServices({ snapshot, machines: names }: { snapshot: RuntimeSnapshot; machines: readonly { id: string; label: string }[] }) {
  const state = useRuntimeServices(snapshot);
  return <section className="space-y-3 p-3" aria-label="Workspace services">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Services</h3><Button variant="secondary" size="sm" disabled={state.pending} onClick={() => void state.refresh()}>Refresh</Button></div>
    <p className="text-xs text-muted-foreground">Declared services and agent processes on each cache. Private links use GitSpace service login.</p>
    {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
    {state.machines === null && <p role="status" className="text-xs text-muted-foreground">Loading services…</p>}
    {state.machines?.length === 0 && <p className="text-sm text-muted-foreground">No machine caches attached. Attach a machine to run services.</p>}
    {state.machines?.map(machine => {
      const label = names.find(item => item.id === machine.machineId)?.label ?? machine.machineId;
      return <section key={`${machine.attachmentId}:${machine.generation}`} className="space-y-2 rounded-lg border border-border p-3" aria-label={`Services on ${label}`}>
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{label}</h4><Badge>{machine.available ? 'Available' : 'Unavailable'}</Badge></div>
        {machine.error && <p className="text-xs text-muted-foreground">{machine.error}</p>}
        {machine.available && machine.services.length === 0 && <p className="text-xs text-muted-foreground">No declared services or agent processes.</p>}
        {machine.services.map(service => <div key={`${service.source}:${service.name}`} className="space-y-2 rounded-md bg-muted/30 p-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{service.name}</span><Badge>{service.state}</Badge><span className="text-xs text-muted-foreground">{service.source === 'declared' ? 'Environment service' : 'Agent process'}</span></div>
          {service.url && <a className="block break-all text-xs underline" href={service.url} target="_blank" rel="noopener noreferrer">{service.url} · Private</a>}
          <div className="flex flex-wrap gap-2">{(['start', 'stop', 'restart', 'logs'] as const).map(op => <Button key={op} variant="secondary" size="sm" className="min-h-10" disabled={state.pending || !machine.available} onClick={() => void state.act({ op, name: service.name, source: service.source, machineId: machine.machineId, attachmentId: machine.attachmentId, generation: machine.generation }, label)}>{op === 'start' ? 'Start' : op === 'stop' ? 'Stop' : op === 'restart' ? 'Restart' : 'Logs'}</Button>)}</div>
        </div>)}
      </section>;
    })}
    {state.logs && <section aria-label="Service logs" className="space-y-2"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">{state.logs.title}</h4><Button variant="secondary" size="sm" onClick={state.closeLogs}>Close logs</Button></div><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{state.logs.text || 'No output yet.'}</pre></section>}
  </section>;
}
