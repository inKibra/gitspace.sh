import { Badge, Button, Card, CardContent } from '@gitspace/ui';
import { CheckCircle, Copy01, LogOut01, Plus, Trash01 } from '@untitledui/icons';
import { useEffect, useState } from 'react';

type InviteStatus = 'available' | 'reserved' | 'consumed' | 'revoked' | 'expired';
type AccountStatus = 'provisioning' | 'active' | 'quarantined' | 'suspended' | 'failed';
type OperatorView = 'overview' | 'accounts' | 'invitations';
interface OperatorInvite {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  status: InviteStatus;
  consumedBy: string | null;
  consumedHandle: string | null;
  consumedAt: number | null;
  revokedAt: number | null;
}
interface CreatedInvite {
  invite: OperatorInvite;
  token: string;
  signupUrl: string;
}
interface OperatorAccount {
  userId: string;
  handle: string;
  status: AccountStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  tenantHostname: string;
  tenantRelease: string | null;
  tenantProvisionedAt: number | null;
  lastError: string | null;
  fleet: { total: number; online: number; physical: number; sandboxes: number; lastSeenAt: number | null };
  credits: { balanceMicros: number; reservedMicros: number; riskReserveMicros: number; status: 'active' | 'quarantined'; reason: string | null; updatedAt: string } | null;
  usage: { records: number; debitedMicros: number };
  deployment: { active: string | null; uploadedAt: string | null; appliedMigrationTag: string | null };
}
interface OperatorOverview {
  accounts: { total: number; active: number; attention: number };
  fleet: { total: number; online: number; physical: number; sandboxes: number };
  credits: { configuredAccounts: number; balanceMicros: number; debitedMicros: number };
  invitations: { available: number; consumed: number };
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function formatMicros(micros: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

function statusColor(status: InviteStatus | AccountStatus): 'gray' | 'green' | 'red' | 'yellow' {
  if (status === 'available' || status === 'active') return 'green';
  if (status === 'reserved' || status === 'provisioning') return 'yellow';
  if (status === 'revoked' || status === 'expired' || status === 'failed' || status === 'quarantined' || status === 'suspended') return 'red';
  return 'gray';
}

async function operatorRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error('The operator session has expired. Reload to authenticate again.');
  const body = await response.json() as { status: 'ok'; value: T } | { status: 'error'; error: { message: string } };
  if (!response.ok || body.status === 'error') throw new Error(body.status === 'error' ? body.error.message : `Request failed with HTTP ${response.status}`);
  return body.value;
}

function MetricCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <Card className="bg-surface-2 shadow-surface-2"><CardContent className="p-5"><p className="text-caption font-medium text-muted-foreground">{label}</p><p className="mt-3 text-display font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-caption text-muted-foreground">{detail}</p></CardContent></Card>;
}

export function OperatorApp() {
  const [view, setView] = useState<OperatorView>('overview');
  const [email, setEmail] = useState('');
  const [overview, setOverview] = useState<OperatorOverview | null>(null);
  const [accounts, setAccounts] = useState<OperatorAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [invites, setInvites] = useState<OperatorInvite[]>([]);
  const [note, setNote] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedAccount = accounts.find((account) => account.userId === selectedAccountId) ?? null;

  const refresh = async (): Promise<void> => {
    const [session, nextOverview, accountResult, inviteResult] = await Promise.all([
      operatorRequest<{ authenticated: boolean; email: string }>('/v1/operator/session'),
      operatorRequest<OperatorOverview>('/v1/operator/overview'),
      operatorRequest<{ accounts: OperatorAccount[] }>('/v1/operator/accounts'),
      operatorRequest<{ invites: OperatorInvite[] }>('/v1/operator/invites'),
    ]);
    setEmail(session.email);
    setOverview(nextOverview);
    setAccounts(accountResult.accounts);
    setInvites(inviteResult.invites);
    if (!selectedAccountId && accountResult.accounts[0]) setSelectedAccountId(accountResult.accounts[0].userId);
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Operator data could not be loaded')).finally(() => setLoading(false));
  }, []);

  const createInvite = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const value = await operatorRequest<CreatedInvite>('/v1/operator/invites', { method: 'POST', body: JSON.stringify({ note, expiresInDays: Number(expiresInDays) }) });
      setCreated(value);
      setNote('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invitation could not be created');
    } finally {
      setPending(false);
    }
  };

  const revokeInvite = async (id: string): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await operatorRequest<{ revoked: boolean }>(`/v1/operator/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (created?.invite.id === id) setCreated(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invitation could not be revoked');
    } finally {
      setPending(false);
    }
  };

  const controlAccount = async (account: OperatorAccount, action: 'suspend' | 'quarantine' | 'restore'): Promise<void> => {
    const destructive = action !== 'restore';
    if (destructive && !window.confirm(`${action === 'suspend' ? 'Suspend' : 'Quarantine'} ${account.handle}.gitspace.sh? Tenant dispatch will be blocked.`)) return;
    setPending(true);
    setError(null);
    try {
      const reason = destructive ? `${action === 'suspend' ? 'Suspended' : 'Quarantined'} from the operator control panel` : null;
      await operatorRequest<{ account: OperatorAccount }>(`/v1/operator/accounts/${account.userId}/actions`, { method: 'POST', body: JSON.stringify({ action, reason }) });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account control action failed');
    } finally {
      setPending(false);
    }
  };

  const nav = (target: OperatorView, label: string) => <button type="button" onClick={() => setView(target)} className={`min-h-10 rounded-lg px-4 text-body font-medium transition-[background-color,transform] active:scale-[0.96] ${view === target ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>{label}</button>;

  return <main className="h-dvh overflow-x-hidden overflow-y-auto bg-background text-foreground antialiased">
    <header className="sticky top-0 z-20 bg-background/95 shadow-surface-1 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-4 lg:px-10">
        <div className="flex items-center gap-5"><a href="/" className="text-title font-semibold tracking-tight">GitSpace</a><nav className="flex items-center gap-1" aria-label="Operator sections">{nav('overview', 'Overview')}{nav('accounts', 'Accounts')}{nav('invitations', 'Invitations')}</nav></div>
        <div className="flex items-center gap-3"><span className="hidden text-caption text-muted-foreground sm:inline">{email}</span><a href="/cdn-cgi/access/logout"><Button variant="secondary" leadingIcon={LogOut01}>Sign out</Button></a></div>
      </div>
    </header>

    <section className="mx-auto w-full max-w-7xl px-6 pb-20 pt-12 lg:px-10 lg:pt-16">
      {loading ? <p className="text-body text-muted-foreground">Loading operator state…</p> : null}
      {error ? <Card className="mb-6 bg-red-50 shadow-surface-2"><CardContent className="p-4"><p role="alert" className="text-body text-red-700">{error}</p></CardContent></Card> : null}

      {!loading && view === 'overview' && overview ? <>
        <Badge color="gray">Platform</Badge>
        <h1 className="mt-5 text-balance text-[clamp(2.5rem,6vw,5.5rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Overview</h1>
        <p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">Production accounts, fleet availability, admission, and the current credit ledger foundation.</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Accounts" value={overview.accounts.total} detail={`${overview.accounts.active} active · ${overview.accounts.attention} need attention`} />
          <MetricCard label="Fleet" value={overview.fleet.online} detail={`${overview.fleet.total} machines · ${overview.fleet.physical} physical · ${overview.fleet.sandboxes} sandboxes`} />
          <MetricCard label="Available invitations" value={overview.invitations.available} detail={`${overview.invitations.consumed} consumed`} />
          <MetricCard label="Ledger debits" value={formatMicros(overview.credits.debitedMicros)} detail={`${overview.credits.configuredAccounts} accounts have credits configured`} />
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-6"><h2 className="text-title font-semibold">Account attention</h2><div className="mt-5 space-y-3">{accounts.filter((account) => account.status !== 'active').length === 0 ? <p className="text-body text-muted-foreground">Every registered account is active.</p> : accounts.filter((account) => account.status !== 'active').map((account) => <button key={account.userId} type="button" onClick={() => { setSelectedAccountId(account.userId); setView('accounts'); }} className="flex min-h-14 w-full items-center justify-between rounded-lg bg-surface-3 px-4 text-left shadow-surface-1 transition-transform active:scale-[0.96]"><span><span className="block text-body font-medium">{account.handle}</span><span className="text-caption text-muted-foreground">{account.reason ?? account.lastError ?? 'Review account state'}</span></span><Badge color={statusColor(account.status)}>{account.status}</Badge></button>)}</div></CardContent></Card>
          <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-6"><h2 className="text-title font-semibold">Credit posture</h2><p className="mt-5 text-display font-semibold tabular-nums">{formatMicros(overview.credits.balanceMicros)}</p><p className="mt-2 text-body text-muted-foreground">Configured balance across the fleet. Unconfigured accounts are currently admitted and shown explicitly in Accounts.</p></CardContent></Card>
        </div>
      </> : null}

      {!loading && view === 'accounts' ? <>
        <Badge color="gray">Operations</Badge><h1 className="mt-5 text-balance text-[clamp(2.5rem,6vw,5.5rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Accounts</h1><p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">Inspect tenant releases, fleets, credit state, and control dispatch without entering the tenant.</p>
        <div className="mt-10 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <Card className="h-fit bg-surface-2 shadow-surface-3"><CardContent className="p-0"><div className="px-5 py-4 text-caption text-muted-foreground tabular-nums">{accounts.length} accounts</div><div className="divide-y divide-border">{accounts.map((account) => <button key={account.userId} type="button" onClick={() => setSelectedAccountId(account.userId)} className={`flex min-h-20 w-full items-center justify-between gap-3 px-5 py-4 text-left transition-[background-color,transform] active:scale-[0.96] ${selectedAccountId === account.userId ? 'bg-surface-3' : 'hover:bg-surface-3/70'}`}><span className="min-w-0"><span className="block truncate text-body font-medium">{account.handle}.gitspace.sh</span><span className="mt-1 block text-caption text-muted-foreground tabular-nums">{account.fleet.online}/{account.fleet.total} machines online</span></span><Badge color={statusColor(account.status)}>{account.status}</Badge></button>)}</div></CardContent></Card>
          {selectedAccount ? <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-6 lg:p-8"><div className="flex flex-wrap items-start justify-between gap-4"><div><Badge color={statusColor(selectedAccount.status)}>{selectedAccount.status}</Badge><h2 className="mt-4 text-display font-semibold tracking-tight">{selectedAccount.handle}</h2><p className="mt-2 font-mono text-caption text-muted-foreground">{selectedAccount.userId}</p></div><div className="flex flex-wrap gap-2">{selectedAccount.status === 'active' ? <><Button variant="secondary" disabled={pending} onClick={() => void controlAccount(selectedAccount, 'quarantine')}>Quarantine</Button><Button variant="secondary" disabled={pending} onClick={() => void controlAccount(selectedAccount, 'suspend')}>Suspend</Button></> : <Button variant="primary" disabled={pending} onClick={() => void controlAccount(selectedAccount, 'restore')}>Restore</Button>}</div></div>
            {selectedAccount.reason || selectedAccount.lastError ? <p className="mt-5 rounded-lg bg-surface-3 p-4 text-body text-muted-foreground shadow-surface-1">{selectedAccount.reason ?? selectedAccount.lastError}</p> : null}
            <div className="mt-8 grid gap-4 sm:grid-cols-2"><MetricCard label="Machines online" value={`${selectedAccount.fleet.online}/${selectedAccount.fleet.total}`} detail={`${selectedAccount.fleet.physical} physical · ${selectedAccount.fleet.sandboxes} sandboxes`} /><MetricCard label="Ledger debits" value={formatMicros(selectedAccount.usage.debitedMicros)} detail={`${selectedAccount.usage.records} usage records`} /></div>
            <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-border pt-6 sm:grid-cols-2"><div><dt className="text-caption text-muted-foreground">Tenant</dt><dd className="mt-1 text-body">{selectedAccount.tenantHostname}</dd></div><div><dt className="text-caption text-muted-foreground">Release</dt><dd className="mt-1 break-all font-mono text-caption">{selectedAccount.deployment.active ?? 'Unknown'}</dd></div><div><dt className="text-caption text-muted-foreground">Created</dt><dd className="mt-1 text-body tabular-nums">{formatDate(selectedAccount.createdAt)}</dd></div><div><dt className="text-caption text-muted-foreground">Credits</dt><dd className="mt-1 text-body tabular-nums">{selectedAccount.credits ? `${formatMicros(selectedAccount.credits.balanceMicros)} · ${selectedAccount.credits.status}` : 'Unconfigured'}</dd></div></dl>
          </CardContent></Card> : <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-10 text-center text-body text-muted-foreground">Select an account.</CardContent></Card>}
        </div>
      </> : null}

      {!loading && view === 'invitations' ? <>
        <Badge color="gray">Admission</Badge><h1 className="mt-5 text-balance text-[clamp(2.5rem,6vw,5.5rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Invitations</h1><p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">Public signup is closed. Each link admits one GitSpace account and the invitation token is stored only as a hash.</p>
        <div className="mt-10 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <Card className="h-fit bg-surface-2 shadow-surface-3"><CardContent className="p-6"><h2 className="text-title font-semibold">Create invitation</h2><form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void createInvite(); }}><label className="block"><span className="mb-2 block text-caption font-medium">Note</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={160} placeholder="Who is this for?" className="min-h-12 w-full rounded-lg bg-surface-3 px-4 text-body outline-none shadow-surface-1 focus:ring-2 focus:ring-[color:var(--focus-ring)]" /></label><label className="block"><span className="mb-2 block text-caption font-medium">Expires in</span><select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} className="min-h-12 w-full rounded-lg bg-surface-3 px-4 text-body outline-none shadow-surface-1 focus:ring-2 focus:ring-[color:var(--focus-ring)]"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label><Button type="submit" variant="primary" disabled={pending} leadingIcon={Plus} className="w-full">{pending ? 'Creating…' : 'Create invitation'}</Button></form>{created ? <div className="mt-6 rounded-xl bg-surface-3 p-4 shadow-surface-1"><div className="flex items-center gap-2 text-body font-medium"><CheckCircle width={18} height={18} /> Link ready</div><p className="mt-2 text-pretty text-caption text-muted-foreground">Copy it now. The raw token cannot be retrieved later.</p><Button variant="secondary" className="mt-4 w-full" leadingIcon={Copy01} onClick={() => void navigator.clipboard.writeText(created.signupUrl)}>Copy invitation link</Button></div> : null}</CardContent></Card>
          <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-0"><div className="flex items-center justify-between px-6 py-5"><div><h2 className="text-title font-semibold">Issued invitations</h2><p className="mt-1 text-caption text-muted-foreground tabular-nums">{invites.length} total</p></div><Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Refresh</Button></div><div className="divide-y divide-border">{invites.length === 0 ? <p className="px-6 py-12 text-center text-body text-muted-foreground">No invitations issued.</p> : invites.map((invite) => <article key={invite.id} className="flex min-h-24 items-center justify-between gap-4 px-6 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge color={statusColor(invite.status)}>{invite.status}</Badge><span className="truncate text-body font-medium">{invite.note || 'Untitled invitation'}</span></div><p className="mt-2 text-caption text-muted-foreground tabular-nums">{invite.consumedHandle ? `${invite.consumedHandle}.gitspace.sh · ` : ''}{invite.status === 'consumed' ? `Used ${formatDate(invite.consumedAt)}` : invite.status === 'revoked' ? `Revoked ${formatDate(invite.revokedAt)}` : `Expires ${formatDate(invite.expiresAt)}`}</p></div>{invite.status === 'available' || invite.status === 'reserved' ? <Button variant="secondary" aria-label={`Revoke ${invite.note || 'invitation'}`} onClick={() => void revokeInvite(invite.id)} disabled={pending}><Trash01 width={16} height={16} /></Button> : null}</article>)}</div></CardContent></Card>
        </div>
      </> : null}
    </section>
  </main>;
}
