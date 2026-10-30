// Throwaway design mock: the Inference page's Providers tab, built from the app's components. "Proposed" regroups each
// provider around its accounts (state, usage and actions on the account they belong to); "Today" renders the real
// ProvidersSection with the same data. Static data only; not part of the app.
import type { ProviderAccount, ProviderUsage, ProviderUsageLimit, ProviderView } from '@gitspace/protocol';
import {
  Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, DropdownContent, DropdownMenu, DropdownTrigger,
  IconProvider, MenuItem, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarInsetTopbar, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider,
  TabsSubtle, TabsSubtleItem, TooltipProvider, untitledIcons, WorkspaceTile, type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import { Activity, AlertCircle, ChevronDown, Columns03, DotsHorizontal, FolderClosed, Key01, PuzzlePiece01, RefreshCcw01, Stars01, Zap } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';
import { ProvidersSection } from './ProvidersSection.js';
import { formatRelativeTime } from './relative-time.js';
import { restoreAppearance } from './appearance.js';

type Mode = 'proposed' | 'today';

const NOW = Date.now();
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const account = (id: string, type: ProviderAccount['type'], label: string, extra: Partial<ProviderAccount> = {}): ProviderAccount => ({ id, type, label, email: type === 'oauth' ? label : null, disabled: false, outUntil: null, outReason: null, ...extra });
const provider = (id: string, name: string, extra: Partial<ProviderView>): ProviderView => ({
  id, credentialProvider: id, name, available: true, loginable: true, supportsOAuth: true, supportsApiKey: false, authKind: 'none', hasAuth: false, source: null, accounts: [], hasUsage: false, ...extra,
});

const PROVIDERS: readonly ProviderView[] = [
  provider('anthropic', 'Anthropic', { supportsApiKey: true, authKind: 'oauth', hasAuth: true, hasUsage: true, accounts: [
    account('a1', 'oauth', 'brad@inkibra.com'),
    account('a2', 'oauth', 'ops@inkibra.com'),
    account('a3', 'api_key', 'API key ····41aa', { disabled: true }),
  ] }),
  provider('openai-codex', 'OpenAI Codex (ChatGPT)', { authKind: 'oauth', hasAuth: true, hasUsage: true, accounts: [
    account('c1', 'oauth', 'brad@inkibra.com', { outUntil: at(134), outReason: 'Weekly usage limit reached' }),
  ] }),
  provider('openrouter', 'OpenRouter', { supportsOAuth: false, supportsApiKey: true, loginable: false, authKind: 'api_key', hasAuth: true, accounts: [account('o1', 'api_key', 'API key ····8f2c')] }),
  provider('google-gemini-cli', 'Google Gemini CLI', {}),
  provider('github-copilot', 'GitHub Copilot', {}),
  provider('xai', 'xAI', { supportsOAuth: false, supportsApiKey: true, loginable: false }),
  provider('groq', 'Groq', { supportsOAuth: false, supportsApiKey: true, loginable: false }),
];

const limit = (id: string, label: string, used: number, resetsInMinutes: number, window: string | null = null): ProviderUsageLimit => ({
  id, label, scope: 'account', window, unit: 'percent', used, limit: 100, remaining: 100 - used, remainingFraction: (100 - used) / 100, resetsAt: at(resetsInMinutes), status: null,
});
const USAGE: ProviderUsage = {
  generatedAt: at(-3),
  reports: [
    { credentialId: 'a1', provider: 'anthropic', account: 'brad@inkibra.com', fetchedAt: at(-3), notes: [], limits: [limit('5h', '5-hour', 62, 134), limit('7d', 'Weekly', 41, 3 * 1440 + 200), limit('7d-opus', 'Weekly · Opus', 91, 3 * 1440 + 200)] },
    { credentialId: 'c1', provider: 'openai-codex', account: 'brad@inkibra.com', fetchedAt: at(-3), notes: [], limits: [limit('5h', '5-hour', 18, 260), limit('7d', 'Weekly', 100, 134)] },
  ],
  errors: [{ credentialId: 'a2', provider: 'anthropic', account: 'ops@inkibra.com', message: 'The provider refused the usage read (HTTP 403, permission_error: needs scope user:profile). Sign in again to grant it.' }],
};

function monogram(name: string): IconComponent {
  return function Monogram({ className }: IconComponentProps) { return <span className={`text-[12px] font-semibold leading-none ${className ?? ''}`}>{name.slice(0, 1)}</span>; };
}

/** One usage window: how much is used, as a bar that fills toward the limit. */
function UsageMeter({ limit: window }: { limit: ProviderUsageLimit }): ReactElement {
  const used = Math.round(window.used ?? 0);
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : null;
  return <div className="flex min-w-0 flex-col gap-1">
    <div className="flex items-baseline justify-between gap-2 text-caption">
      <span className="truncate text-foreground">{window.label}</span>
      <span className={`shrink-0 tabular-nums ${used >= 90 ? 'text-destructive' : 'text-muted-foreground'}`}>{used}%</span>
    </div>
    <div role="meter" aria-label={`${window.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${used >= 90 ? 'bg-destructive' : 'bg-foreground'}`} style={{ width: `${used}%` }} />
    </div>
    {reset !== null ? <span className="text-[11px] text-muted-foreground">{reset - NOW < 60_000 ? 'resets now' : `resets ${formatRelativeTime(new Date(reset), NOW)}`}</span> : null}
  </div>;
}

function AccountState({ value }: { value: ProviderAccount }): ReactElement {
  if (value.disabled) return <Badge variant="dot" size="compact" color="gray">Off</Badge>;
  const until = value.outUntil === null ? null : Date.parse(value.outUntil);
  if (until !== null && until > NOW) return <Badge variant="dot" size="compact" color="amber">Paused · back {new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Badge>;
  return <Badge variant="dot" size="compact" color="green">In use</Badge>;
}

/** An account: who it is, whether inference uses it now, its usage windows, and its actions. */
function AccountRow({ provider: owner, value, usage }: { provider: ProviderView; value: ProviderAccount; usage: ProviderUsage }): ReactElement {
  const report = usage.reports.find(item => item.credentialId === value.id);
  const missing = usage.errors.some(item => item.credentialId === value.id);
  const until = value.outUntil === null ? null : Date.parse(value.outUntil);
  const paused = !value.disabled && until !== null && until > NOW;
  return <li className={`flex flex-col gap-3 border-t border-border py-3 first:border-t-0 ${value.disabled ? 'opacity-60' : ''}`} data-account={value.id}>
    <div className="flex items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-foreground">{value.label}</span>
        <span className="text-caption text-muted-foreground">{value.type === 'oauth' ? 'Subscription sign-in' : 'API key'}</span>
      </span>
      <AccountState value={value} />
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="ghost" size="icon-compact" type="button" aria-label={`Actions for ${value.label}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
        <DropdownContent align="end">
          <MenuItem index={0} label={value.disabled ? 'Turn on' : 'Turn off'} onSelect={() => undefined} />
          {value.type === 'oauth' ? <MenuItem index={1} label="Sign in again" onSelect={() => undefined} /> : <MenuItem index={1} label="Replace key" onSelect={() => undefined} />}
          <MenuItem index={2} label="Remove…" onSelect={() => undefined} />
        </DropdownContent>
      </DropdownMenu>
    </div>
    {paused && value.outReason ? <p className="text-caption text-muted-foreground">{value.outReason}. Inference skips this account until then.</p> : null}
    {value.disabled ? null
      : report ? <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">{report.limits.map(item => <UsageMeter key={item.id} limit={item} />)}</div>
      : missing ? <p className="flex items-start gap-1.5 text-caption text-muted-foreground"><AlertCircle className="mt-px shrink-0" width={14} height={14} strokeWidth={1.5} />{owner.name} didn’t share usage for this account (HTTP 403). Inference still uses it.</p>
      : !owner.hasUsage ? <p className="text-caption text-muted-foreground">{owner.name} doesn’t report usage for {value.type === 'api_key' ? 'API keys' : 'this account'}.</p>
      : null}
  </li>;
}

function AddAccount({ value }: { value: ProviderView }): ReactElement {
  const methods = [...value.supportsOAuth ? [`Sign in with ${value.name}`] : [], ...value.supportsApiKey ? ['Add API key'] : []];
  const label = value.accounts.length ? 'Add account' : methods.length > 1 ? 'Connect' : methods[0] ?? 'Connect';
  if (methods.length < 2) return <Button variant="secondary" size="compact" type="button">{value.accounts.length ? label : value.supportsOAuth ? 'Sign in' : 'Add API key'}</Button>;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" trailingIcon={glyph(ChevronDown)}>{label}</Button>} />
    <DropdownContent align="end">{methods.map((method, index) => <MenuItem key={method} index={index} label={method} onSelect={() => undefined} />)}</DropdownContent>
  </DropdownMenu>;
}

function ConnectedProvider({ value, usage, index }: { value: ProviderView; usage: ProviderUsage; index: number }): ReactElement {
  const using = value.accounts.filter(item => !item.disabled && !(item.outUntil !== null && Date.parse(item.outUntil) > NOW)).length;
  return <Card size="compact" index={index} className="flex-wrap" data-provider={value.id}>
    <CardMedia icon={monogram(value.name)} />
    <CardHeader>
      <span className="text-body font-medium text-foreground">{value.name}</span>
      <CardDescription>{using === 0 ? 'No account available right now' : `${using} of ${value.accounts.length} account${value.accounts.length === 1 ? '' : 's'} in use`}</CardDescription>
    </CardHeader>
    <CardFooter><AddAccount value={value} /></CardFooter>
    <ul aria-label={`${value.name} accounts`} className="flex basis-full flex-col pb-1 pl-[42px] pr-3">
      {value.accounts.map(item => <AccountRow key={item.id} provider={value} value={item} usage={usage} />)}
    </ul>
  </Card>;
}

function ProposedProviders(): ReactElement {
  const connected = PROVIDERS.filter(item => item.hasAuth);
  const others = PROVIDERS.filter(item => !item.hasAuth);
  return <section className="flex flex-col gap-8" aria-label="Model providers">
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-subtitle font-semibold text-foreground">Connected</h2>
        <span className="flex items-center gap-2 text-caption text-muted-foreground">
          Usage as of {new Date(USAGE.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          <Button variant="ghost" size="icon-compact" type="button" aria-label="Refresh usage"><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button>
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {connected.map((item, index) => <CardGroup key={item.id} orientation="inline" border="outlined" proximityHover={false}><ConnectedProvider value={item} usage={USAGE} index={index} /></CardGroup>)}
      </div>
    </div>
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-subtitle font-semibold text-foreground">Add a provider</h2>
        <p className="text-caption text-muted-foreground">Sign in with a subscription, or add an API key. Each account you add joins the rotation.</p>
      </div>
      <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
        {others.map((item, index) => <Card key={item.id} size="compact" index={index} data-provider={item.id}>
          <CardMedia icon={monogram(item.name)} />
          <CardHeader><span className="text-body font-medium text-foreground">{item.name}</span><CardDescription>{item.supportsOAuth ? 'Subscription sign-in' : 'API key'}</CardDescription></CardHeader>
          <CardFooter><AddAccount value={item} /></CardFooter>
        </Card>)}
      </CardGroup>
    </div>
    <p className="text-caption text-muted-foreground">Credentials are encrypted in this inference profile’s vault. Other profiles cannot use them. Removing credentials may interrupt active work, but does not recall requests already sent to a provider.</p>
  </section>;
}

function MockSidebar(): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon} isActive={item.label === 'Inference'}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

function ProvidersMock(): ReactElement {
  const [mode, setMode] = useState<Mode>('proposed');
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar />
      <SidebarInset className="min-w-0">
        <SidebarInsetTopbar><span className="text-body font-medium">Inference</span></SidebarInsetTopbar>
        <PageCanvas>
          <PageHeader title="Default" description="Independent configuration and credentials · revision 14" />
          <div className="pb-6"><TabsSubtle selectedIndex={1} idPrefix="mock-tabs" onSelect={() => undefined}>{['Models', 'Providers', 'Advanced'].map((label, index) => <TabsSubtleItem key={label} index={index} label={label} />)}</TabsSubtle></div>
          {mode === 'proposed' ? <ProposedProviders /> : <ProvidersSection
            providers={PROVIDERS} usage={USAGE} usageStatus="ready" onShow={() => undefined}
            onRefreshUsage={async () => undefined} onSignIn={async () => undefined} onDisableAccount={async () => undefined} onEnableAccount={async () => undefined}
            onRemoveAccount={async () => undefined} onSetApiKey={async () => undefined}
            login={{ flow: null, respond: async () => undefined, cancel: async () => undefined }} />}
        </PageCanvas>
      </SidebarInset>
    </SidebarProvider>
    <div className="fixed right-4 top-3 z-50">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{mode === 'proposed' ? 'Proposed' : 'Today'} (mock)</Button>} />
        <DropdownContent align="end" className="w-[240px] min-w-[240px]">
          <MenuItem index={0} label="Proposed: accounts carry usage" onSelect={() => setMode('proposed')} />
          <MenuItem index={1} label="Today: current Providers tab" onSelect={() => setMode('today')} />
        </DropdownContent>
      </DropdownMenu>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <ProvidersMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
