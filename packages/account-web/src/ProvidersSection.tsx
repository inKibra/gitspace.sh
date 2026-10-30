import type { ProviderAccount, ProviderLoginEvent, ProviderUsage, ProviderUsageLimit, ProviderUsageReport, ProviderView } from '@gitspace/protocol';
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
  type IconComponent,
  type IconComponentProps,
} from '@gitspace/ui';
import { AlertCircle, ChevronDown, CpuChip01, DotsHorizontal, RefreshCcw01 } from '@untitledui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState } from './GitSpaceShell.js';
import { glyph } from './glyph.js';
import { formatRelativeTime } from './relative-time.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export type ProvidersUsageStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface ProviderLoginFlow { flowId: string; profileId: string; providerId: string; events: readonly ProviderLoginEvent[]; connectionError?: string }
export interface ProviderLoginProps {
  flow: ProviderLoginFlow | null;
  respond(promptId: string, value: string): Promise<void>;
  /** Cancels a running flow or dismisses a finished one. */
  cancel(): Promise<void>;
  reconnect?(): void;
}
export interface ProvidersSectionProps {
  providers: readonly ProviderView[];
  loading?: boolean;
  /** The provider list itself failed to load; shown instead of the cards. */
  error?: string;
  usage: ProviderUsage | null;
  usageStatus: ProvidersUsageStatus;
  usageError?: string;
  /** The section became visible; the host starts the lazy usage query. */
  onShow(): void;
  onRefreshUsage(): Promise<void>;
  onSignIn(providerId: string): Promise<void>;
  onDisableAccount(providerId: string, credentialId: string): Promise<void>;
  onEnableAccount(providerId: string, credentialId: string): Promise<void>;
  onRemoveAccount(providerId: string, credentialId: string): Promise<void>;
  onSetApiKey(providerId: string, key: string): Promise<void>;
  login: ProviderLoginProps;
}
type UsageFailure = ProviderUsage['errors'][number];

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const UNIT_SUFFIX: Readonly<Record<string, string>> = { tokens: ' tokens', requests: ' requests', minutes: ' min', bytes: ' bytes' };
/** A provider's tile: its initial. One component per letter, so a re-render keeps the tile mounted. */
const MONOGRAMS = new Map<string, IconComponent>();

function icon(Icon: typeof CpuChip01): ReactNode { return <Icon width={16} height={16} strokeWidth={1.5} />; }
function errorMessage(error: unknown): string { return rpcErrorMessage(error, 'Provider account operation'); }
function monogram(name: string): IconComponent {
  const letter = name.slice(0, 1).toUpperCase();
  let tile = MONOGRAMS.get(letter);
  if (!tile) {
    tile = function Monogram({ className }: IconComponentProps) { return <span aria-hidden className={`text-[12px] font-semibold leading-none ${className ?? ''}`}>{letter}</span>; };
    MONOGRAMS.set(letter, tile);
  }
  return tile;
}

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
  return `resets ${formatRelativeTime(at, now)}`;
}

/** How much of a window is used, 0–1: the share it reports, else what is left subtracted from the whole. */
function usedShare(limit: ProviderUsageLimit): number | null {
  const share = limit.unit === 'percent' && limit.used !== null ? limit.used / 100
    : limit.used !== null && limit.limit ? limit.used / limit.limit
    : limit.remainingFraction === null ? null : 1 - limit.remainingFraction;
  return share === null ? null : Math.min(1, Math.max(0, share));
}

function UsageMeter({ limit, now }: { limit: ProviderUsageLimit; now: number }) {
  const share = usedShare(limit);
  const reset = formatUsageReset(limit.resetsAt, now);
  const label = limit.window && limit.window !== limit.label ? `${limit.label} · ${limit.window}` : limit.label;
  const high = share !== null && share >= 0.9;
  return <div className="flex min-w-0 flex-col gap-1" data-usage-limit={limit.id}>
    <div className="flex items-baseline justify-between gap-2 text-caption">
      <span className="min-w-0 truncate text-foreground">{label}</span>
      <span className={`shrink-0 tabular-nums ${high ? 'text-destructive' : 'text-muted-foreground'}`}>{formatUsageAmount(limit)}</span>
    </div>
    {share === null ? null
      // FLUID-GAP: progress meter (no meter/progress component in the registry) — a 4px track on Fluid tokens.
      : <div role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${high ? 'bg-destructive' : 'bg-foreground'}`} style={{ width: `${share * 100}%` }} />
        </div>}
    {reset ? <span className="text-[11px] text-muted-foreground">{reset}</span> : null}
  </div>;
}

/** Whether inference uses an account now: off, paused until a time (a limit or failure cooldown), or in use. */
function accountState(account: ProviderAccount, now: number): { color: 'green' | 'gray' | 'amber'; label: string; paused: boolean } {
  if (account.disabled) return { color: 'gray', label: 'Off', paused: false };
  const until = account.outUntil === null ? Number.NaN : Date.parse(account.outUntil);
  if (!(until > now)) return { color: 'green', label: 'In use', paused: false };
  const back = new Date(until);
  const sameDay = back.toDateString() === new Date(now).toDateString();
  return { color: 'amber', label: `Paused · back ${sameDay ? back.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : back.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, paused: true };
}

/** An account: who it is, whether inference uses it now, its usage windows (or why there are none), and its actions. */
function AccountRow({ provider, account, report, failure, usageStatus, now, pending, onToggle, onSignInAgain, onReplaceKey, onRemove }: {
  provider: ProviderView;
  account: ProviderAccount;
  report: ProviderUsageReport | undefined;
  failure: UsageFailure | undefined;
  usageStatus: ProvidersUsageStatus;
  now: number;
  pending: string | null;
  onToggle(): void;
  onSignInAgain: (() => void) | null;
  onReplaceKey(): void;
  onRemove(): void;
}) {
  const state = accountState(account, now);
  const actions = [
    { label: account.disabled ? 'Turn on' : 'Turn off', run: onToggle },
    ...account.type === 'api_key' ? [{ label: 'Replace key', run: onReplaceKey }] : onSignInAgain ? [{ label: 'Sign in again', run: onSignInAgain }] : [],
    { label: 'Remove…', run: onRemove },
  ];
  const busy = pending !== null && pending.endsWith(`:${provider.id}:${account.id}`);
  const usage = account.disabled ? null
    : report ? <>
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">{report.limits.map((limit) => <UsageMeter key={limit.id} limit={limit} now={now} />)}</div>
        {report.notes.map((note) => <p key={note} className="text-caption text-muted-foreground">{note}</p>)}
      </>
    : failure ? <p className="flex items-start gap-1.5 text-caption text-muted-foreground"><AlertCircle className="mt-px shrink-0" width={14} height={14} strokeWidth={1.5} /><span>Usage unavailable: {failure.message} Inference still uses this account.</span></p>
    : account.type === 'api_key' ? <p className="text-caption text-muted-foreground">{provider.name} doesn’t report usage for API keys.</p>
    : !provider.hasUsage ? <p className="text-caption text-muted-foreground">{provider.name} doesn’t report usage.</p>
    : usageStatus === 'loading' ? <p role="status" className="text-caption text-muted-foreground">Checking usage…</p>
    : usageStatus === 'idle' ? <p className="text-caption text-muted-foreground">Usage has not been checked yet.</p>
    : usageStatus === 'ready' ? <p className="text-caption text-muted-foreground">No usage reported.</p>
    : null;
  return <li className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0" data-account={account.id}>
    <div className="flex items-center gap-3">
      <span className={`flex min-w-0 flex-1 flex-col ${account.disabled ? 'opacity-60' : ''}`}>
        <span className="truncate text-body text-foreground">{account.label}</span>
        <span className="text-caption text-muted-foreground">{account.type === 'oauth' ? 'Subscription sign-in' : 'API key'}</span>
      </span>
      <Badge variant="dot" size="compact" color={state.color}>{state.label}</Badge>
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="ghost" size="icon-compact" type="button" aria-label={`Actions for ${account.label}`} disabled={pending !== null} loading={busy}>{icon(DotsHorizontal)}</Button>} />
        <DropdownContent align="end">{actions.map((action, index) => <MenuItem key={action.label} index={index} label={action.label} onSelect={action.run} />)}</DropdownContent>
      </DropdownMenu>
    </div>
    {state.paused && account.outReason ? <p className="text-caption text-muted-foreground">{account.outReason}. Inference skips this account until then.</p> : null}
    {usage}
  </li>;
}

/** The ways to add an account: each sign-in method, and an API key when the provider takes one and has none. */
function AddAccount({ provider, signInMethods, connected, pending, onSignIn, onAddKey }: {
  provider: ProviderView;
  signInMethods: readonly ProviderView[];
  connected: boolean;
  pending: string | null;
  onSignIn(providerId: string): void;
  onAddKey(): void;
}) {
  const ways = [
    ...signInMethods.map((method) => ({ label: signInMethods.length > 1 ? `Sign in with ${method.name}` : 'Sign in', run: () => onSignIn(method.id) })),
    ...provider.supportsApiKey && !provider.accounts.some((account) => account.type === 'api_key') ? [{ label: 'Add API key', run: onAddKey }] : [],
  ];
  const signingIn = signInMethods.some((method) => pending === `login:${method.id}`);
  const [only] = ways;
  if (!only) return null;
  if (ways.length === 1) return <Button variant="secondary" size="compact" type="button" disabled={pending !== null} loading={signingIn} onClick={only.run}>{connected ? 'Add account' : only.label}</Button>;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" disabled={pending !== null} loading={signingIn} trailingIcon={glyph(ChevronDown)}>{connected ? 'Add account' : 'Connect'}</Button>} />
    <DropdownContent align="end">{ways.map((way, index) => <MenuItem key={way.label} index={index} label={way.label} onSelect={way.run} />)}</DropdownContent>
  </DropdownMenu>;
}

function ApiKeyDialog({ provider, onOpenChange, onSubmit }: { provider: ProviderView | null; onOpenChange(open: boolean): void; onSubmit(providerId: string, key: string): Promise<void> }) {
  const [key, setKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setKey(''); setAccountId(''); setError(null); }, [provider?.id]);
  // Workers AI needs the Cloudflare account id in its URL; the vault stores both as {"token","accountId"}.
  const workersAi = provider?.id === 'cloudflare-workers-ai';
  const complete = key.trim().length > 0 && (!workersAi || accountId.trim().length > 0);
  const submit = async (): Promise<void> => {
    if (!provider || !complete) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(provider.id, workersAi ? JSON.stringify({ token: key.trim(), accountId: accountId.trim() }) : key.trim());
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={provider !== null} onOpenChange={onOpenChange}>
    {provider ? <DialogContent>
      <DialogHeader><DialogTitle>{provider.name} API key</DialogTitle><DialogDescription>Encrypted in this inference profile’s cloud credential vault. Machines do not receive provider credentials.</DialogDescription></DialogHeader>
      <form id="provider-api-key-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <InputGroup className="w-full"><InputField index={0} label={workersAi ? 'API token' : 'API key'} type="password" value={key} onChange={setKey} autoComplete="off" autoFocus required /></InputGroup>
        {workersAi ? <InputGroup className="w-full"><InputField index={1} label="Cloudflare account ID" value={accountId} onChange={setAccountId} autoComplete="off" required /></InputGroup> : null}
        {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      </form>
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="provider-api-key-form" loading={pending} disabled={!complete}>Save key</Button>
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
  const latestStep = flow.events.findLast((event) => event.type === 'prompt' || event.type === 'progress');
  const prompt = !done && latestStep?.type === 'prompt' && !answered.includes(latestStep.promptId) ? latestStep : undefined;
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
    <DialogHeader><DialogTitle>Sign in to {providerName}</DialogTitle><DialogDescription>Approve access on the provider’s site. Cloud sign-in continues if this browser closes. Return to this profile to resume any remaining code-entry step or view the result. Cancel explicitly stops sign-in.</DialogDescription></DialogHeader>
    <div className="flex flex-col gap-4">
      {auth?.type === 'auth' && !done ? <>
        {auth.instructions ? <p className={deviceAuthorization ? 'font-mono text-body font-medium tabular-nums text-foreground' : 'text-caption text-muted-foreground'}>{auth.instructions}</p> : null}
        <InputCopy label="Sign-in URL" value={auth.url} />
        <Button variant="primary" asChild><a href={auth.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a></Button>
        {deviceAuthorization ? <p role="status" aria-live="polite" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator aria-label="Waiting for authorization" />Waiting for authorization. This dialog updates automatically after approval.</p> : null}
        {auth.launchUrl && prompt ? <p className="text-caption text-muted-foreground">If sign-in ends at a localhost page that cannot load, copy the full URL from that tab’s address bar and paste it below. No connected machine is required.</p> : null}
      </> : null}
      {progress.length ? <ul className="flex flex-col gap-1 text-caption text-muted-foreground">{progress.map((event, index) => event.type === 'progress' ? <li key={`${index}:${event.message}`}>{event.message}</li> : null)}</ul> : null}
      {prompt?.type === 'prompt' ? <LoginPromptForm key={prompt.promptId} prompt={prompt} onRespond={async (promptId, value) => { await login.respond(promptId, value); setAnswered((current) => [...current, promptId]); }} /> : null}
      {status}
      {flow.connectionError ? <p role="alert" className="text-caption text-destructive">{flow.connectionError}{login.reconnect ? <Button variant="ghost" onClick={login.reconnect}>Reconnect sign-in</Button> : null}</p> : null}
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

export function ProvidersSection({ providers, loading = false, error, usage, usageStatus, usageError, onShow, onRefreshUsage, onSignIn, onDisableAccount, onEnableAccount, onRemoveAccount, onSetApiKey, login }: ProvidersSectionProps) {
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
    if (provider.supportsOAuth) group.signInMethods.push(provider);
  }
  // Codex device authorization completes in the cloud without a loopback callback.
  const codex = groups.get('openai-codex');
  const codexDevice = codex?.signInMethods.find((method) => method.id === 'openai-codex-device' && method.available);
  if (codex && codexDevice) codex.signInMethods = [codexDevice];
  const visible = [...groups.values()].filter(({ provider, signInMethods }) => provider.loginable || signInMethods.length || provider.hasAuth || provider.available);
  const connected = visible.filter(({ provider }) => provider.hasAuth);
  // Providers you can sign in to before key-only ones.
  const others = visible.filter(({ provider }) => !provider.hasAuth)
    .sort((left, right) => Number(!(left.provider.loginable || left.signInMethods.length)) - Number(!(right.provider.loginable || right.signInMethods.length)) || left.index - right.index);
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
  const reports = new Map(usage?.reports.map((report) => [report.credentialId, report]));
  const failures = new Map(usage?.errors.map((failure) => [failure.credentialId, failure]));
  const reportTimes = usage?.reports.map((report) => Date.parse(report.fetchedAt)).filter(Number.isFinite) ?? [];
  const reportTime = reportTimes.length ? Math.min(...reportTimes) : null;
  const usageLabel = usageStatus === 'loading' ? 'Checking usage…'
    : usageStatus === 'error' ? `Usage unavailable: ${usageError ?? 'could not fetch usage'}`
    : usage ? reportTime === null ? usage.errors.length ? 'Usage unavailable' : null
      : `${usage.errors.length ? 'Partial usage' : 'Usage'} as of ${new Date(reportTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : null;
  const signIn = (providerId: string): void => void run(`login:${providerId}`, () => onSignIn(providerId));
  return <section className="flex flex-col gap-8" aria-label="Model providers">
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-subtitle font-semibold text-foreground">{connected.length && !error && !loading ? 'Connected' : 'Providers'}</h2>
        <span className="flex items-center gap-2">
          {usageStatus === 'loading' ? <ThinkingIndicator aria-label="Checking usage" /> : null}
          {usageLabel ? <span role={usageStatus === 'error' ? 'alert' : undefined} className={`text-caption ${usageStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{usageLabel}</span> : null}
          <Button variant="ghost" size="icon-compact" type="button" aria-label="Refresh usage" disabled={usageStatus === 'loading'} onClick={() => void onRefreshUsage()}>{icon(RefreshCcw01)}</Button>
        </span>
      </div>
      {error
        ? <EmptyState icon={icon(CpuChip01)} title="Providers are unavailable" description={error} action={<Button variant="ghost" type="button" onClick={() => void onRefreshUsage()}>Retry</Button>} />
        : loading ? <EmptyState icon={<ThinkingIndicator />} title="Loading this profile’s providers…" />
        : visible.length === 0 ? <EmptyState icon={icon(CpuChip01)} title="No providers in this profile" description="The cloud provider catalog reports no loginable or configured model providers." />
        : connected.length === 0 ? <p className="text-caption text-muted-foreground">No provider is connected yet. Connect one below.</p>
        : connected.map(({ provider, signInMethods }, index) => {
          const using = provider.accounts.filter((account) => accountState(account, now).color === 'green').length;
          const summary = provider.accounts.length
            ? using === 0 ? 'No account available right now' : `${using} of ${provider.accounts.length} account${provider.accounts.length === 1 ? '' : 's'} in use`
            : provider.source ? `Connected via ${provider.source}` : 'Connected';
          return <CardGroup key={provider.credentialProvider} orientation="inline" border="outlined" proximityHover={false}>
            <Card size="compact" index={index} className="flex-wrap" data-provider={provider.id}>
              <CardMedia icon={monogram(provider.name)} />
              <CardHeader><CardTitle>{provider.name}</CardTitle><CardDescription>{summary}</CardDescription></CardHeader>
              <CardFooter><AddAccount provider={provider} signInMethods={signInMethods} connected pending={pending} onSignIn={signIn} onAddKey={() => setApiKeyFor(provider)} /></CardFooter>
              {provider.accounts.length
                // Lines up with the header text: media tile (32px) + gap (10px).
                ? <ul aria-label={`${provider.name} accounts`} className="flex basis-full flex-col pb-1 pl-[42px] pr-3">
                    {provider.accounts.map((account) => <AccountRow
                      key={account.id}
                      provider={provider}
                      account={account}
                      report={reports.get(account.id)}
                      failure={failures.get(account.id)}
                      usageStatus={usageStatus}
                      now={now}
                      pending={pending}
                      onToggle={() => void run(`${account.disabled ? 'enable' : 'disable'}:${provider.id}:${account.id}`, () => (account.disabled ? onEnableAccount : onDisableAccount)(provider.id, account.id))}
                      onSignInAgain={signInMethods[0] ? () => signIn(signInMethods[0]!.id) : null}
                      onReplaceKey={() => setApiKeyFor(provider)}
                      onRemove={() => {
                        if (!window.confirm(`Remove ${account.label} from ${provider.name}? This cannot be undone. Signing in again creates a new account.`)) return;
                        void run(`remove:${provider.id}:${account.id}`, () => onRemoveAccount(provider.id, account.id));
                      }}
                    />)}
                  </ul>
                : null}
            </Card>
          </CardGroup>;
        })}
    </div>
    {!error && !loading && others.length
      ? <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-subtitle font-semibold text-foreground">Add a provider</h2>
            <p className="text-caption text-muted-foreground">Sign in with a subscription, or add an API key. Each account you add joins the rotation.</p>
          </div>
          <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
            {others.map(({ provider, signInMethods }, index) => <Card key={provider.credentialProvider} size="compact" index={index} data-provider={provider.id}>
              <CardMedia icon={monogram(provider.name)} />
              <CardHeader><CardTitle>{provider.name}</CardTitle><CardDescription>{signInMethods.length ? provider.supportsApiKey ? 'Subscription sign-in or API key' : 'Subscription sign-in' : 'API key'}</CardDescription></CardHeader>
              <CardFooter><AddAccount provider={provider} signInMethods={signInMethods} connected={false} pending={pending} onSignIn={signIn} onAddKey={() => setApiKeyFor(provider)} /></CardFooter>
            </Card>)}
          </CardGroup>
        </div>
      : null}
    {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
    <p className="text-caption text-muted-foreground">Credentials are encrypted in this inference profile’s vault. Other profiles cannot use them. Removing credentials may interrupt active work, but does not recall requests already sent to a provider.</p>
    <ApiKeyDialog provider={apiKeyFor} onOpenChange={(open) => { if (!open) setApiKeyFor(null); }} onSubmit={onSetApiKey} />
    <Dialog open={login.flow !== null} onOpenChange={(open) => { if (!open) void login.cancel(); }}>
      {login.flow ? <DialogContent><SignInFlowView key={login.flow.flowId} flow={login.flow} providerName={loginProvider?.name ?? login.flow.providerId} login={login} onRetry={() => { const providerId = login.flow?.providerId; if (providerId) signIn(providerId); }} /></DialogContent> : null}
    </Dialog>
  </section>;
}
