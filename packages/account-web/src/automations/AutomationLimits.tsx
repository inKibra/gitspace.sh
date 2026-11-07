import { Button, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@gitspace/ui';
import { useState, type ReactElement } from 'react';
import { type AutomationSettings } from '@gitspace/protocol/automations-contract';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { Field, TextInput } from './automation-fields.js';

export function LimitsEditor({ settings, onCancel, onSave }: { settings: AutomationSettings; onCancel(): void; onSave(settings: AutomationSettings): Promise<void> }): ReactElement {
  const [concurrency, setConcurrency] = useState(String(settings.concurrency));
  const [dailyRunCap, setDailyRunCap] = useState(String(settings.dailyRunCap));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concurrencyValue = Number(concurrency);
  const capValue = Number(dailyRunCap);
  const nextConcurrency = concurrency.trim() && Number.isInteger(concurrencyValue) && concurrencyValue >= 1 && concurrencyValue <= 10 ? concurrencyValue : null;
  const nextCap = dailyRunCap.trim() && Number.isInteger(capValue) && capValue >= 1 && capValue <= 1000 ? capValue : null;
  const save = async (): Promise<void> => {
    if (nextConcurrency === null || nextCap === null) return;
    setPending(true);
    setError(null);
    try { await onSave({ ...settings, concurrency: nextConcurrency, dailyRunCap: nextCap }); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Save limits')); }
    finally { setPending(false); }
  };
  return <>
    <DialogHeader>
      <DialogTitle>Limits</DialogTitle>
      <DialogDescription>Every automation in this project runs under these.</DialogDescription>
    </DialogHeader>
    <form id="automation-limits" noValidate className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="Runs working at once" error={nextConcurrency === null ? 'Between 1 and 10.' : undefined}><TextInput label="Runs working at once" type="number" min={1} max={10} value={concurrency} onChange={setConcurrency} invalid={nextConcurrency === null} /></Field>
      <Field label="Runs per automation per day" error={nextCap === null ? 'Between 1 and 1000.' : undefined}><TextInput label="Runs per automation per day" type="number" min={1} max={1000} value={dailyRunCap} onChange={setDailyRunCap} invalid={nextCap === null} /></Field>
      <p className="text-caption text-muted-foreground">A run holds a slot only while its agent works; a workspace waiting for you does not. Runs past the daily cap are skipped.</p>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-limits" loading={pending} disabled={pending || nextConcurrency === null || nextCap === null}>Save limits</Button>
    </DialogFooter>
  </>;
}
