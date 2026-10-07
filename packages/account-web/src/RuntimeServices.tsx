import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeService, RuntimeServiceCommand, RuntimeServiceResult } from '@gitspace/protocol-runtime/services';
import { Badge, Button } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Inventory = Extract<RuntimeServiceResult, { op: 'list' }>['machines'];
const serviceControls = {
  running: { start: false, stop: true, progress: null },
  ready: { start: false, stop: true, progress: null },
  stopped: { start: true, stop: false, progress: null },
  exited: { start: true, stop: false, progress: null },
  failed: { start: true, stop: false, progress: null },
  starting: { start: false, stop: false, progress: 'Starting service…' },
  stopping: { start: false, stop: false, progress: 'Stopping service…' },
  restarting: { start: false, stop: false, progress: 'Restarting service…' },
} satisfies Record<RuntimeService['state'], { start: boolean; stop: boolean; progress: string | null }>;
const operationProgress = {
  start: 'Starting', stop: 'Stopping', restart: 'Restarting', logs: 'Loading logs for',
} satisfies Record<Exclude<RuntimeServiceCommand['op'], 'list'>, string>;
export function useRuntimeServices(snapshot: RuntimeSnapshot) {
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const [machines, setMachines] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
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
    if (command.op === 'logs') setLoadingLogs(true);
    else setPendingMessage(`${operationProgress[command.op]} ${command.name} · ${machineName}…`);
    setError(null);
    const current = generation.current;
    try {
      const result = await rpcClient.runtime.services({ ...identity, command });
      if (current !== generation.current) return;
      if (result.status === 'error') { setError(rpcErrorMessage(result.error, 'runtime.services')); return; }
      if (result.value.op === 'logs') setLogs({ title: `${command.name} · ${machineName}`, text: result.value.log.text });
      else await refresh();
    } finally {
      if (command.op === 'logs') setLoadingLogs(false);
      else setPendingMessage(null);
    }
  };
  return { machines, error, pending: pendingMessage !== null, pendingMessage, loadingLogs, logs, refresh, act, closeLogs: () => setLogs(null) };
}

export function RuntimeServices({ snapshot, machines: names }: { snapshot: RuntimeSnapshot; machines: readonly { id: string; label: string }[] }) {
  const state = useRuntimeServices(snapshot);
  return <section className="space-y-3 p-3" aria-label="Workspace services">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Services</h3><Button variant="secondary" size="sm" disabled={state.pending} onClick={() => void state.refresh()}>Refresh</Button></div>
    <p className="text-xs text-muted-foreground">Declared services and agent processes on each machine. Private links use GitSpace service login.</p>
    {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
    {state.pendingMessage && <p role="status" className="text-xs text-muted-foreground">{state.pendingMessage}</p>}
    {state.loadingLogs && <p role="status" className="text-xs text-muted-foreground">Loading service logs…</p>}
    {state.machines === null && <p role="status" className="text-xs text-muted-foreground">Loading services…</p>}
    {state.machines?.length === 0 && <p className="text-sm text-muted-foreground">No machines attached. Attach a machine to run services.</p>}
    {state.machines?.map(machine => {
      const label = names.find(item => item.id === machine.machineId)?.label ?? machine.machineId;
      return <section key={`${machine.attachmentId}:${machine.generation}`} className="space-y-2 rounded-lg border border-border p-3" aria-label={`Services on ${label}`}>
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{label}</h4><Badge>{machine.available ? 'Available' : 'Unavailable'}</Badge></div>
        {(machine.error || !machine.available) && <p className="text-xs text-muted-foreground">{machine.error || 'Machine offline. Service controls are unavailable.'}</p>}
        {machine.available && machine.services.length === 0 && <p className="text-xs text-muted-foreground">No declared services or agent processes.</p>}
        {machine.services.map(service => <div key={`${service.source}:${service.name}`} className="space-y-2 rounded-md bg-muted/30 p-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{service.name}</span><Badge>{service.state}</Badge><span className="text-xs text-muted-foreground">{service.source === 'declared' ? 'Environment service' : 'Agent process'}</span></div>
          {machine.available && serviceControls[service.state].progress && <p role="status" className="text-xs text-muted-foreground">{serviceControls[service.state].progress}</p>}
          {service.url && <a className="block break-all text-xs underline" href={service.url} target="_blank" rel="noopener noreferrer">{service.url} · Private</a>}
          <div className="flex flex-wrap gap-2">{(['start', 'stop', 'restart', 'logs'] as const).map(op => <Button key={op} variant="secondary" size="sm" className="min-h-10" disabled={!machine.available || (op === 'logs' ? state.loadingLogs : state.pending || (op === 'start' ? !serviceControls[service.state].start : !serviceControls[service.state].stop))} onClick={() => void state.act({ op, name: service.name, source: service.source, machineId: machine.machineId, attachmentId: machine.attachmentId, generation: machine.generation }, label)}>{op === 'start' ? 'Start' : op === 'stop' ? 'Stop' : op === 'restart' ? 'Restart' : 'Logs'}</Button>)}</div>
        </div>)}
      </section>;
    })}
    {state.logs && <section aria-label="Service logs" className="space-y-2"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">{state.logs.title}</h4><Button variant="secondary" size="sm" onClick={state.closeLogs}>Close logs</Button></div><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{state.logs.text || 'No output yet.'}</pre></section>}
  </section>;
}
