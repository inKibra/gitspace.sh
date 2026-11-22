// What an inference profile's Services spent: ghosts' answers and the Decisions service's, by day, model and the
// workspace whose agent spent it (`service_usage`), shown under the profile's providers beside their usage.
import type { ServiceUsageRow } from '@gitspace/protocol';
import { Card, CardDescription, CardGroup, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ThinkingIndicator } from '@gitspace/ui';
import { useContext } from 'react';
import { tokens, usd } from './inspector/UsageView.js';
import { AccountDirectoryContext } from './useAccountDirectory.js';

/** Days of Service usage the view reads. */
export const SERVICE_USAGE_DAYS = 30;
const SERVICE_LABEL: Record<ServiceUsageRow['service'], string> = { ghost: 'Ghosts', decision: 'Decisions' };
const SERVICES: readonly ServiceUsageRow['service'][] = ['ghost', 'decision'];
export interface ServiceUsageProps {
  rows: readonly ServiceUsageRow[] | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
}

/** Ghosts and decisions over the last `SERVICE_USAGE_DAYS` days: totals per service, then one row per day, service, model
 * and workspace. A row without a workspace is the account's own: a person's ghosts, or decisions made for no workspace. */
export function ServiceUsageSection({ rows, status, error }: ServiceUsageProps) {
  const directory = useContext(AccountDirectoryContext);
  const names = new Map<string, string>();
  for (const project of directory?.projects ?? []) names.set(project.id, `${project.name} (project agent)`);
  for (const entry of Object.values(directory?.directory ?? {})) for (const workspace of entry.workspaces) names.set(workspace.id, workspace.name);
  const totals = SERVICES.map(service => {
    const of = (rows ?? []).filter(row => row.service === service);
    return { service, requests: of.reduce((sum, row) => sum + row.requests, 0), tokens: of.reduce((sum, row) => sum + row.input + row.output, 0), costUsd: of.reduce((sum, row) => sum + row.costUsd, 0) };
  });
  return <section className="flex flex-col gap-3" aria-label="Ghosts and decisions usage">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-subtitle font-semibold text-foreground">Ghosts and decisions</h2>
      <span className="text-caption text-muted-foreground">Last {SERVICE_USAGE_DAYS} days · this profile</span>
    </div>
    {status === 'error' ? <p role="alert" className="text-caption text-destructive">Service usage is unavailable: {error ?? 'could not read it'}</p>
      : rows === null ? <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator aria-label="Reading service usage" />Reading service usage…</p>
      : rows.length === 0 ? <p className="text-caption text-muted-foreground">No ghost or decision has spent anything on this profile in the last {SERVICE_USAGE_DAYS} days.</p>
      : <>
        <CardGroup columns={2} separated border="outlined">
          {totals.map(total => <Card key={total.service} size="compact"><CardHeader><CardDescription>{SERVICE_LABEL[total.service]} · {total.requests}× · {tokens(total.tokens)} tokens</CardDescription><CardTitle className="tabular-nums">{usd(total.costUsd)}</CardTitle></CardHeader></Card>)}
        </CardGroup>
        <Table size="compact">
          <TableHeader><TableRow><TableHead>Day</TableHead><TableHead>Service</TableHead><TableHead>Model</TableHead><TableHead>Workspace</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Tokens in / out</TableHead><TableHead className="text-right">API cost</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row, index) => <TableRow key={`${row.day}:${row.service}:${row.model}:${row.workspaceId}`} index={index} data-service-usage={row.service}>
              <TableCell className="tabular-nums">{row.day}</TableCell>
              <TableCell>{SERVICE_LABEL[row.service]}</TableCell>
              <TableCell className="break-all">{row.model}</TableCell>
              <TableCell>{row.workspaceId === '' ? <span className="text-muted-foreground">{row.service === 'ghost' ? 'You' : 'No workspace'}</span> : names.get(row.workspaceId) ?? row.workspaceId}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{row.requests}×</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{tokens(row.input)} / {tokens(row.output)}</TableCell>
              <TableCell className="text-right tabular-nums text-foreground">{usd(row.costUsd)}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
        <p className="text-caption text-muted-foreground">Ghosts are read-only chats about a session, a person’s or an agent’s (ghost_ask, counted under the asking workspace); decisions are the Decisions service’s answers (Chatter digests, history searches, decide). API cost is priced from the model catalog: an estimate, not your bill.</p>
      </>}
  </section>;
}
