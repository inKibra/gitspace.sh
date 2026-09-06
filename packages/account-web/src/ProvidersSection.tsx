import type { ProviderLoginEvent, ProviderUsage, ProviderUsageLimit, ProviderUsageReport, ProviderView } from '@gitspace/protocol';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardMedia,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  InputCopy,
  InputField,
  InputGroup,
  MenuItem,
  ThinkingIndicator,
} from '@gitspace/ui';
import { ChevronDown, CpuChip01, RefreshCcw01, XClose } from '@untitledui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState } from './GitSpaceShell.js';
import { glyph } from './glyph.js';
import { formatProjectCronTime } from './ProjectCronsPage.js';

export type ProvidersUsageStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface ProviderLoginFlow { flowId: string; providerId: string; events: readonly ProviderLoginEvent[] }
export interface ProviderLoginProps {
  flow: ProviderLoginFlow | null;
  respond(promptId: string, value: string): Promise<void>;
  /** Cancels a running flow or dismisses a finished one. */
  cancel(): Promise<void>;
}
export interface ProvidersSectionProps {
  providers: readonly ProviderView[];
  /** The provider list itself failed to load; shown instead of the rows. */
  error?: string;
  usage: ProviderUsage | null;
  usageStatus: ProvidersUsageStatus;
  usageError?: string;
  /** The section became visible; the host starts the lazy usage query. */
  onShow(): void;
  onRefreshUsage(): Promise<void>;
  onSignIn(providerId: string): Promise<void>;
  onSignOut(providerId: string, credentialId: string | null): Promise<void>;
  onSetApiKey(providerId: string, key: string): Promise<void>;
  login: ProviderLoginProps;
}

const PROVIDER_ICON = glyph(CpuChip01);
const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const UNIT_SUFFIX: Readonly<Record<string, string>> = { tokens: ' tokens', requests: ' requests', minutes: ' min', bytes: ' bytes' };

function icon(Icon: typeof XClose): ReactNode { return <Icon width={16} height={16} strokeWidth={1.5} />; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function formatAmount(value: number, unit: string): string {
  if (unit === 'usd') return `$${value.toFixed(2)}`;
  if (unit === 'percent') return `${Math.round(value)}%`;
  return COMPACT_NUMBER.format(value);
}
export function formatUsageAmount(limit: ProviderUsageLimit): string {
  const suffix = UNIT_SUFFIX[limit.unit] ?? '';
  // Percent windows are already a share of the limit; "62% / 100%" says nothing "62% used" doesn't.
  if (limit.unit === 'percent' && limit.used !== null) return `${Math.round(limit.used)}% used`;
  if (limit.used !== null && limit.limit !== null) return `${formatAmount(limit.used, limit.unit)} / ${formatAmount(limit.limit, limit.unit)}${suffix}`;
  if (limit.remaining !== null && limit.limit !== null) return `${formatAmount(limit.remaining, limit.unit)} of ${formatAmount(limit.limit, limit.unit)}${suffix} left`;
  if (limit.remaining !== null) return `${formatAmount(limit.remaining, limit.unit)}${suffix} left`;
  if (limit.used !== null) return `${formatAmount(limit.used, limit.unit)}${suffix} used`;
  if (limit.remainingFraction !== null) return `${Math.round(limit.remainingFraction * 100)}% left`;
  return limit.status ?? '—';
}
export function formatUsageReset(resetsAt: string | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() - now < 60_000) return 'resets now';
  return `resets ${formatProjectCronTime(at, now)}`;
}

function UsageLimitRow({ limit, now }: { limit: ProviderUsageLimit; now: number }) {
  const fraction = limit.remainingFraction === null ? null : Math.min(1, Math.max(0, limit.remainingFraction));
  const reset = formatUsageReset(limit.resetsAt, now);
  return <div className="flex flex-col gap-1" data-usage-limit={limit.id}>
    <div className="flex items-center justify-between gap-3 text-caption">
      <span className="min-w-0 truncate text-foreground">{limit.label}{limit.window ? <span className="text-muted-foreground"> · {limit.window}</span> : null}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatUsageAmount(limit)}{reset ? ` · ${reset}` : ''}</span>
    </div>
    {fraction === null ? null
      // FLUID-GAP: progress meter (no meter/progress component in the registry) — a 4px track on Fluid tokens.
      : <div role="meter" aria-label={`${limit.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${fraction < 0.1 ? 'bg-destructive' : 'bg-foreground'}`} style={{ width: `${fraction * 100}%` }} />
        </div>}
  </div>;
}
function UsageReports({ reports, error, now }: { reports: readonly ProviderUsageReport[]; error: string | null; now: number }) {
  const labelled = reports.length > 1;
  // Wraps under the row (the card is flex-wrap); the inset lines the block up
  // with the header text: media tile (32px) + gap (10px).
  return <div className="flex basis-full flex-col gap-3 pb-3 pl-[42px] pr-3">
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {reports.map((report) => <div key={report.account ?? report.provider} className="flex flex-col gap-2">
      {labelled && report.account ? <span className="text-caption font-medium text-foreground">{report.account}</span> : null}
      {report.limits.map((limit) => <UsageLimitRow key={limit.id} limit={limit} now={now} />)}
      {report.notes.map((note) => <p key={note} className="text-caption text-muted-foreground">{note}</p>)}
    </div>)}
  </div>;
}

function providerBadge(provider: ProviderView): { color: 'green' | 'gray' | 'amber'; label: string } {
  if (provider.accounts.length > 0 && provider.accounts.every((account) => account.disabled)) return { color: 'amber', label: 'Disabled' };
  return provider.hasAuth ? { color: 'green', label: 'Connected' } : { color: 'gray', label: 'Not signed in' };
}
function providerDescription(provider: ProviderView): string {
  if (provider.accounts.length) return provider.accounts.map((account) => account.label).join(', ');
  if (provider.hasAuth) return provider.source ? `Connected via ${provider.source}` : 'Connected';
  return 'Not connected';
}

function ProviderRow({ provider, signInMethods, reports, usageError, now, pending, onSignIn, onAddKey, onSignOut, index }: {
  provider: ProviderView;
  signInMethods: readonly ProviderView[];
  reports: readonly ProviderUsageReport[];
  usageError: string | null;
  now: number;
  pending: string | null;
  onSignIn(providerId: string): void;
  onAddKey(): void;
  onSignOut(credentialId: string): void;
  index?: number;
}) {
  const badge = providerBadge(provider);
  const showUsage = provider.hasAuth && provider.hasUsage && (reports.length > 0 || usageError !== null);
  const signInLabel = provider.accounts.length ? 'Add account' : 'Sign in';
  const signingIn = signInMethods.some((method) => pending === `login:${method.id}`);
  return <Card size="compact" index={index} className={showUsage ? 'flex-wrap' : undefined} data-provider={provider.id}>
    <CardMedia icon={PROVIDER_ICON} />
    <CardHeader><CardTitle>{provider.name}</CardTitle><CardDescription>{providerDescription(provider)}</CardDescription></CardHeader>
    <CardFooter className="gap-2">
      <Badge variant="dot" color={badge.color}>{badge.label}</Badge>
      {provider.authKind === 'api_key'
        ? <Button variant="secondary" size="compact" type="button" disabled={pending !== null} onClick={onAddKey}>{provider.accounts.length ? 'Replace API key' : 'Add API key'}</Button>
        : null}
      {signInMethods.length > 1
        ? <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" disabled={pending !== null} loading={signingIn} trailingIcon={glyph(ChevronDown)}>{signInLabel}</Button>} />
            <DropdownContent align="end">
              {signInMethods.map((method, methodIndex) => <MenuItem key={method.id} index={methodIndex} label={method.name} onSelect={() => onSignIn(method.id)} />)}
            </DropdownContent>
          </DropdownMenu>
        : signInMethods.map((method) => <Button key={method.id} variant="secondary" size="compact" type="button" disabled={pending !== null} loading={signingIn} onClick={() => onSignIn(method.id)}>{signInLabel}</Button>)}
      {provider.accounts.map((account) => <Button key={account.id} variant="ghost" size="icon-compact" type="button" aria-label={`Remove ${account.label}`} disabled={pending !== null} loading={pending === `logout:${provider.id}:${account.id}`} onClick={() => onSignOut(account.id)}>{icon(XClose)}</Button>)}
    </CardFooter>
    {showUsage ? <UsageReports reports={reports} error={usageError} now={now} /> : null}
  </Card>;
}

function ApiKeyDialog({ provider, onOpenChange, onSubmit }: { provider: ProviderView | null; onOpenChange(open: boolean): void; onSubmit(providerId: string, key: string): Promise<void> }) {
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setKey(''); setError(null); }, [provider?.id]);
  const submit = async (): Promise<void> => {
    if (!provider || !key.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(provider.id, key.trim());
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={provider !== null} onOpenChange={onOpenChange}>
    {provider ? <DialogContent>
      <DialogHeader><DialogTitle>{provider.name} API key</DialogTitle><DialogDescription>Stored in this machine’s OMP credential store. The key never leaves the machine.</DialogDescription></DialogHeader>
      <form id="provider-api-key-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <InputGroup className="w-full"><InputField index={0} label="API key" type="password" value={key} onChange={setKey} autoComplete="off" autoFocus required /></InputGroup>
        {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      </form>
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="provider-api-key-form" loading={pending} disabled={!key.trim()}>Save key</Button>
      </DialogFooter>
    </DialogContent> : null}
  </Dialog>;
}

function LoginPromptForm({ prompt, onRespond }: { prompt: Extract<ProviderLoginEvent, { type: 'prompt' }>; onRespond(promptId: string, value: string): Promise<void> }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onRespond(prompt.promptId, value);
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  };
  return <form id="provider-login-prompt" className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <InputGroup className="w-full"><InputField index={0} label={prompt.message} value={value} onChange={setValue} placeholder={prompt.placeholder ?? undefined} autoComplete="off" autoFocus disabled={pending} /></InputGroup>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </form>;
}

/** The sign-in flow's header, body, and footer — the Dialog frame is separate so the states render (and test) without a portal. */
export function SignInFlowView({ flow, providerName, login, onRetry }: { flow: ProviderLoginFlow; providerName: string; login: ProviderLoginProps; onRetry(): void }) {
  const [answered, setAnswered] = useState<readonly string[]>([]);
  const auth = flow.events.findLast((event) => event.type === 'auth');
  const done = flow.events.find((event) => event.type === 'done');
  const prompt = done ? undefined : flow.events.findLast((event) => event.type === 'prompt' && !answered.includes(event.promptId));
  const progress = flow.events.filter((event) => event.type === 'progress');
  const deviceAuthorization = flow.providerId === 'openai-codex-device';
  const close = (): void => void login.cancel();
  let status: ReactNode = null;
  if (done?.type === 'done') {
    status = done.ok
      ? <p className="text-caption text-foreground">Signed in to {done.provider.name}{done.provider.accounts.length ? ` as ${done.provider.accounts.map((account) => account.email ?? account.label).join(', ')}` : ''}.</p>
      : <p role="alert" className="text-caption text-destructive">{done.error}</p>;
  } else if (!auth && !prompt && progress.length === 0) {
    status = <span className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator aria-label="Starting sign-in" />Starting sign-in…</span>;
  }
  return <>
    <DialogHeader><DialogTitle>Sign in to {providerName}</DialogTitle><DialogDescription>Approve access on the provider’s site. Keep this dialog open until sign-in completes.</DialogDescription></DialogHeader>
    <div className="flex flex-col gap-4">
      {auth?.type === 'auth' && !done ? <>
        {auth.instructions ? <p className={deviceAuthorization ? 'font-mono text-body font-medium tabular-nums text-foreground' : 'text-caption text-muted-foreground'}>{auth.instructions}</p> : null}
        <InputCopy label="Sign-in URL" value={auth.url} />
        {/* OMP's launchUrl belongs to the machine's loopback interface, not necessarily this browser. */}
        <Button variant="primary" asChild><a href={auth.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a></Button>
        {deviceAuthorization ? <p role="status" aria-live="polite" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator aria-label="Waiting for authorization" />Waiting for authorization. This dialog updates automatically after approval.</p> : null}
        {auth.launchUrl && prompt ? <p className="text-caption text-muted-foreground">If sign-in ends at a localhost page that cannot load, copy the full URL from that tab’s address bar and paste it below. Sign-in on the same machine can finish automatically.</p> : null}
      </> : null}
      {progress.length ? <ul className="flex flex-col gap-1 text-caption text-muted-foreground">{progress.map((event, index) => event.type === 'progress' ? <li key={`${index}:${event.message}`}>{event.message}</li> : null)}</ul> : null}
      {prompt?.type === 'prompt' ? <LoginPromptForm key={prompt.promptId} prompt={prompt} onRespond={async (promptId, value) => { await login.respond(promptId, value); setAnswered((current) => [...current, promptId]); }} /> : null}
      {status}
    </div>
    <DialogFooter>
      {done?.type === 'done'
        ? done.ok
          ? <Button variant="primary" type="button" onClick={close}>Close</Button>
          : <><Button variant="secondary" type="button" onClick={close}>Close</Button><Button variant="primary" type="button" onClick={onRetry}>Retry</Button></>
        : <><Button variant="secondary" type="button" onClick={close}>Cancel</Button>{prompt ? <Button variant="primary" type="submit" form="provider-login-prompt">Continue</Button> : null}</>}
    </DialogFooter>
  </>;
}

export function ProvidersSection({ providers, error, usage, usageStatus, usageError, onShow, onRefreshUsage, onSignIn, onSignOut, onSetApiKey, login }: ProvidersSectionProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [apiKeyFor, setApiKeyFor] = useState<ProviderView | null>(null);
  useEffect(() => onShow(), []);
  const now = Date.now();
  // A login alias shares accounts and usage, but remains a separate sign-in method.
  const groups = new Map<string, { provider: ProviderView; signInMethods: ProviderView[]; index: number }>();
  for (const provider of providers) {
    let group = groups.get(provider.credentialProvider);
    if (!group) {
      group = { provider, signInMethods: [], index: groups.size };
      groups.set(provider.credentialProvider, group);
    } else if (provider.id === provider.credentialProvider) {
      group.provider = provider;
    }
    if (provider.loginable && provider.authKind === 'oauth') group.signInMethods.push(provider);
  }
  // The browser may be on another computer. Codex device authorization completes
  // without a loopback callback, including when the runtime is a cloud machine.
  const codex = groups.get('openai-codex');
  const codexDevice = codex?.signInMethods.find((method) => method.id === 'openai-codex-device' && method.available);
  if (codex && codexDevice) codex.signInMethods = [codexDevice];
  // Connected accounts first, then providers you can sign in to, then key-only ones.
  const rank = ({ provider, signInMethods }: { provider: ProviderView; signInMethods: readonly ProviderView[] }): number => (provider.hasAuth ? 0 : provider.loginable || signInMethods.length ? 1 : 2);
  const visible = [...groups.values()]
    .filter(({ provider, signInMethods }) => provider.loginable || signInMethods.length || provider.hasAuth || provider.available)
    .sort((left, right) => rank(left) - rank(right) || left.index - right.index);
  const loginProvider = login.flow ? providers.find((provider) => provider.id === login.flow?.providerId) : null;
  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setPending(key);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  const usageLabel = usageStatus === 'loading' ? 'Checking usage…' : usageStatus === 'error' ? usageError ?? 'Usage unavailable' : usage ? `Usage as of ${new Date(usage.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : null;
  return <section className="flex flex-col gap-3" aria-label="Model providers">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-subtitle font-semibold text-foreground">Providers</h2>
      <span className="flex items-center gap-2">
        {usageStatus === 'loading' ? <ThinkingIndicator aria-label="Checking usage" /> : null}
        {usageLabel ? <span className={`text-caption ${usageStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{usageLabel}</span> : null}
        <Button variant="ghost" size="icon-compact" type="button" aria-label="Refresh usage" disabled={usageStatus === 'loading'} onClick={() => void onRefreshUsage()}>{icon(RefreshCcw01)}</Button>
      </span>
    </div>
    {error
      ? <EmptyState icon={icon(CpuChip01)} title="Providers are unavailable" description={error} action={<Button variant="ghost" type="button" onClick={() => void onRefreshUsage()}>Retry</Button>} />
      : visible.length === 0
        ? <EmptyState icon={icon(CpuChip01)} title="No providers on this machine" description="The machine’s OMP install reports no loginable or configured model providers." />
        : <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
          {visible.map(({ provider, signInMethods }) => <ProviderRow
            key={provider.credentialProvider}
            provider={provider}
            signInMethods={signInMethods}
            reports={usage?.reports.filter((report) => report.provider === provider.credentialProvider) ?? []}
            usageError={usage?.errors.find((item) => item.provider === provider.credentialProvider)?.message ?? null}
            now={now}
            pending={pending}
            onSignIn={(providerId) => void run(`login:${providerId}`, () => onSignIn(providerId))}
            onAddKey={() => setApiKeyFor(provider)}
            onSignOut={(credentialId) => void run(`logout:${provider.id}:${credentialId}`, () => onSignOut(provider.id, credentialId))}
          />)}
        </CardGroup>}
    {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
    <p className="text-caption text-muted-foreground">Managed cloud machines use your encrypted account credential vault. Other machines use their configured OMP credential store.</p>
    <ApiKeyDialog provider={apiKeyFor} onOpenChange={(open) => { if (!open) setApiKeyFor(null); }} onSubmit={onSetApiKey} />
    <Dialog open={login.flow !== null} onOpenChange={(open) => { if (!open) void login.cancel(); }}>
      {login.flow ? <DialogContent><SignInFlowView key={login.flow.flowId} flow={login.flow} providerName={loginProvider?.name ?? login.flow.providerId} login={login} onRetry={() => { const providerId = login.flow?.providerId; if (providerId) void run(`login:${providerId}`, () => onSignIn(providerId)); }} /></DialogContent> : null}
    </Dialog>
  </section>;
}
