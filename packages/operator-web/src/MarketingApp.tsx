import { Badge, Button, Card, CardContent } from '@gitspace/ui';
import { createRelayAuthorization, encodeDeviceInviteToken, signDeviceInvite } from '@gitspace/protocol';
import { credentialProtocolBase64 } from '@gitspace/protocol/credential-vault';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ArrowRight, CheckCircle, Copy01, Server01 } from '@untitledui/icons';
import { useEffect, useRef, useState } from 'react';
import { MarketingFooter, MarketingNav } from './MarketingChrome.js';
import { AskSection, CapabilityMatrix, ChainSection, OmpSection, PricingSection, SelfModificationSection, WorkspaceProductsSection } from './MarketingTour.js';

const installCommand = 'curl -fsSL https://gitspace.sh/install | sh';

export function MarketingApp() {
  const [handle, setHandle] = useState('');
  const [invite, setInvite] = useState(() => new URL(window.location.href).searchParams.get('invite') ?? '');
  const [usingSavedKey, setUsingSavedKey] = useState(false);
  const [savedRecoveryKey, setSavedRecoveryKey] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [identity, setIdentity] = useState<{ handle: string; recoveryKey: string } | null>(null);
  const rootKeyRef = useRef<Uint8Array | null>(null);
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ enrollmentUrl: string | null; expiresAt: number; handle: string } | null>(null);
  const [installCopied, setInstallCopied] = useState(false);
  useEffect(() => {
    const clearRootKey = (): void => {
      rootKeyRef.current?.fill(0);
      rootKeyRef.current = null;
    };
    const clearPage = (): void => {
      clearRootKey();
      setIdentity(null);
      setSavedRecoveryKey('');
      setRecoveryConfirmation('');
      setCreated(null);
    };
    window.addEventListener('pagehide', clearPage);
    return () => {
      clearRootKey();
      window.removeEventListener('pagehide', clearPage);
    };
  }, []);
  useEffect(() => {
    if (!created?.enrollmentUrl) return;
    const timeout = window.setTimeout(() => setCreated((current) => current ? { ...current, enrollmentUrl: null } : null), Math.max(0, created.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [created]);
  useEffect(() => {
    if (!installCopied) return;
    const timeout = window.setTimeout(() => setInstallCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [installCopied]);
  const copyInstall = async (): Promise<void> => {
    await navigator.clipboard.writeText(installCommand);
    setInstallCopied(true);
  };
  const prepareAccount = (): void => {
    if (identity || creatingRef.current) return;
    const normalized = handle.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(normalized)) {
      setError('Use 1 to 30 lowercase letters, numbers, or hyphens.');
      return;
    }
    setError(null);
    try {
      const savedKey = savedRecoveryKey.trim();
      if (usingSavedKey && !/^gsr_[A-Za-z0-9_-]{43}$/u.test(savedKey)) {
        throw new Error('Enter the complete recovery key beginning with gsr_.');
      }
      const rootPrivateKey = usingSavedKey
        ? credentialProtocolBase64.decode(`${savedKey.slice(4).replaceAll('-', '+').replaceAll('_', '/')}=`)
        : ed25519.utils.randomSecretKey();
      const recoveryKey = `gsr_${credentialProtocolBase64.encode(rootPrivateKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
      if (usingSavedKey && recoveryKey !== savedKey) {
        rootPrivateKey.fill(0);
        throw new Error('Recovery key is invalid.');
      }
      rootKeyRef.current = rootPrivateKey;
      setHandle(normalized);
      setIdentity({ handle: normalized, recoveryKey });
      setRecoveryConfirmation(usingSavedKey ? recoveryKey : '');
      setSavedRecoveryKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare recovery key');
    }
  };
  const createAccount = async (): Promise<void> => {
    const rootPrivateKey = rootKeyRef.current;
    if (creatingRef.current || !identity || !rootPrivateKey || recoveryConfirmation.trim() !== identity.recoveryKey) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    const invitation = invite.trim();
    try {
      const { handle: accountHandle } = identity;
      const rootPublicKey = credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey));
      const requestAccount = async (path: string, payload: Record<string, string>) => {
        if (rootKeyRef.current !== rootPrivateKey) throw new Error('Resume with your saved recovery key to open this account.');
        const response = await fetch(path, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            authorization: createRelayAuthorization(rootPrivateKey, path),
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        const body = await response.json() as { status: 'ok'; value: { userId: string; accountUrl: string; apiUrl: string } } | { status: 'error'; error: { code: string; message: string } };
        return { response, body };
      };
      let result = await requestAccount('/v1/accounts/recover', { handle: accountHandle, rootPublicKey });
      if (result.body.status === 'error' && (
        (result.response.status === 401 && result.body.error.code === 'VAULT_UNCONFIGURED')
        || (result.response.status === 404 && result.body.error.code === 'ACCOUNT_NOT_FOUND')
        || (result.response.status === 409 && result.body.error.code === 'ACCOUNT_INCOMPLETE')
      )) {
        if (!invitation) throw new Error('Enter your invitation to finish creating this account.');
        const vaultKey = sha256.create().update(new TextEncoder().encode('gitspace-vault-v1\n')).update(rootPrivateKey).digest();
        try {
          result = await requestAccount('/v1/accounts/bootstrap', {
            handle: accountHandle,
            invite: invitation,
            rootPublicKey,
            vaultKey: credentialProtocolBase64.encode(vaultKey),
          });
        } finally {
          vaultKey.fill(0);
        }
      }
      const { response, body } = result;
      if (!response.ok || body.status === 'error') throw new Error(body.status === 'error' ? body.error.message : `Account request failed with HTTP ${response.status}`);
      if (rootKeyRef.current !== rootPrivateKey) throw new Error('Resume with your saved recovery key to open this account.');
      const now = Date.now();
      const expiresAt = now + 5 * 60_000;
      const browserInvite = signDeviceInvite({
        version: 1,
        userId: body.value.userId,
        inviteId: crypto.randomUUID(),
        kind: 'browser',
        label: 'GitSpace browser',
        scope: { kind: 'user' },
        capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'],
        canDelegate: true,
        issuedAt: now,
        expiresAt,
        grantTtlMs: null,
        enrollUrl: body.value.apiUrl,
      }, rootPrivateKey);
      const accountUrl = new URL(body.value.accountUrl);
      accountUrl.hash = new URLSearchParams({ enroll: encodeDeviceInviteToken(browserInvite) }).toString();
      rootPrivateKey.fill(0);
      rootKeyRef.current = null;
      setIdentity(null);
      setSavedRecoveryKey('');
      setRecoveryConfirmation('');
      setInvite('');
      setCreated({ enrollmentUrl: accountUrl.toString(), expiresAt, handle: accountHandle });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account creation failed');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };
  return <main className="h-dvh overflow-x-hidden overflow-y-auto bg-background text-foreground antialiased">
    <MarketingNav />

    <section className="mx-auto grid w-full max-w-7xl gap-12 px-6 pb-20 pt-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-10 lg:pb-28 lg:pt-28">
      <div className="max-w-3xl">
        <Badge color="gray">Self-modifying workspaces across your fleet</Badge>
        <h1 className="mt-6 text-balance text-[clamp(3rem,7vw,6.75rem)] font-semibold leading-[0.94] tracking-[-0.055em]">A workspace that can modify itself.</h1>
        <p className="mt-7 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">GitSpace spans machines you own and cloud resources you create. You or your agent can change it in place from a GitSpace workspace, without interrupting other accounts or active work.</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <a href="#start"><Button variant="primary" size="lg">Use invitation <ArrowRight width={18} height={18} /></Button></a>
          <a href="https://github.com/inKibra/gitspace.sh" rel="noreferrer"><Button variant="secondary" size="lg">View source</Button></a>
        </div>
      </div>
      <Card className="self-end bg-surface-2 shadow-surface-3">
        <CardContent className="p-6 lg:p-8">
          <div className="flex items-center gap-3 text-body font-medium"><Server01 width={19} height={19} /> Workspace placement</div>
          <div className="mt-7 space-y-3">
            {[
              ['Studio', 'Online', 'docker · production', 'bg-emerald-500'],
              ['Home server', 'Online', 'storage · long-running', 'bg-emerald-500'],
              ['Cloud machine', 'Sleeping', 'managed · resumes your work', 'bg-amber-500'],
            ].map(([machine, state, capabilities, tone]) => <div key={machine} className="flex min-h-14 items-center justify-between gap-4 rounded-lg bg-surface-3 px-4 shadow-surface-1">
              <span className="min-w-0"><strong className="block truncate text-body font-medium">{machine}</strong><span className="block truncate font-mono text-[11px] text-muted-foreground">{capabilities}</span></span><span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground"><span className={`size-1.5 rounded-full ${tone}`} />{state}</span>
            </div>)}
          </div>
          <p className="mt-6 text-pretty text-caption leading-relaxed text-muted-foreground">Closed workspaces persist in cloud storage. Opening one places it on a machine with the capabilities the work requires.</p>
        </CardContent>
      </Card>
    </section>
    <SelfModificationSection />

    <section className="mx-auto w-full max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
      <div className="max-w-3xl">
        <Badge color="gray">From intent to operation</Badge>
        <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">The whole agent workflow stays with the workspace.</h2>
        <p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">GitSpace keeps the goal, context, implementation, review evidence, and running services together. You can see what changed and why without reconstructing the work from chat logs.</p>
      </div>
      <ol className="mt-12 grid gap-px overflow-hidden rounded-xl bg-border shadow-surface-2 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['01', 'Plan', 'Turn intent into a goal, observable requirements, and a review rubric.'],
          ['02', 'Context', 'Keep decisions, dependencies, setup, and durable notes next to the code.'],
          ['03', 'Implement', 'Run a main agent and focused side agents on the machine that holds the workspace.'],
          ['04', 'Review', 'Read the diff with its journal, evidence, review threads, and change guide.'],
          ['05', 'Operate', 'Watch services, events, releases, and ownership after the code is written.'],
        ].map(([number, title, description]) => <li key={title} className="bg-surface-1 p-6">
          <span className="font-mono text-caption text-muted-foreground">{number}</span>
          <h3 className="mt-8 text-title font-semibold tracking-tight">{title}</h3>
          <p className="mt-3 text-pretty text-body leading-relaxed text-muted-foreground">{description}</p>
        </li>)}
      </ol>
    </section>
    <ChainSection />
    <WorkspaceProductsSection />
    <OmpSection />
    <AskSection />

    <section className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-20 lg:grid-cols-[0.85fr_1.15fr] lg:px-10 lg:py-28">
      <div className="max-w-xl">
        <Badge color="gray">Fleet signal</Badge>
        <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">Know where to look before you interrupt anyone.</h2>
        <p className="mt-5 text-pretty text-subtitle leading-relaxed text-muted-foreground">GitSpace reduces a fleet to the states that need a decision: working, waiting, needs attention, or failed. The workspace row also tells you which machine owns the work.</p>
        <p className="mt-6 text-pretty text-body leading-relaxed text-muted-foreground">This view exists because an idle agent hidden in a terminal is wasted time. The browser keeps the signal visible without turning every transcript into a meeting.</p>
      </div>
      <Card className="bg-surface-2 shadow-surface-3">
        <CardContent className="p-3 sm:p-5">
          <div className="flex items-center justify-between px-3 pb-3 pt-1 text-caption text-muted-foreground"><span>Active workspaces</span><span>4 across 3 machines</span></div>
          <div className="space-y-2">
            {[
              ['checkout-redesign', 'Shop', 'Working', 'Darktop', 'bg-emerald-500'],
              ['relay-hardening', 'GitSpace', 'Needs attention', 'Studio', 'bg-orange-500'],
              ['docs-refresh', 'GitSpace', 'Waiting', 'Cloud machine', 'bg-blue-500'],
              ['release-check', 'API', 'Failed', 'Home server', 'bg-red-500'],
            ].map(([workspace, project, state, machine, color]) => <div key={workspace} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-lg bg-surface-3 px-4 shadow-surface-1">
              <span className="min-w-0"><strong className="block truncate text-body font-medium">{workspace}</strong><span className="block truncate text-caption text-muted-foreground">{project} · {machine}</span></span>
              <span className="flex items-center gap-2 whitespace-nowrap text-caption text-muted-foreground"><span className={`size-1.5 rounded-full ${color}`} />{state}</span>
            </div>)}
          </div>
        </CardContent>
      </Card>
    </section>

    <section className="bg-surface-2 py-20 lg:py-28">
      <div className="mx-auto w-full max-w-7xl px-6 lg:px-10">
        <div className="max-w-3xl">
          <Badge color="gray">Evidence, not vibes</Badge>
          <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">A completion claim is not a review.</h2>
          <p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">The goal defines what must be true. Evidence records what was exercised. The journal preserves decisions, and the change guide turns the final diff into a reviewable story.</p>
        </div>
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <Card className="bg-surface-1 shadow-surface-3"><CardContent className="p-6 lg:p-8">
            <div className="flex items-center justify-between"><span className="text-body font-semibold">Goal requirements</span><Badge color="green">2 proven</Badge></div>
            <div className="mt-6 space-y-3">
              {[
                ['Workspace status survives a reload', 'Browser smoke run · 42s'],
                ['Failed services identify their owner', 'Runtime output · service-api'],
              ].map(([requirement, proof]) => <div key={requirement} className="rounded-lg bg-surface-2 p-4 shadow-surface-1">
                <span className="flex items-start gap-2 text-body font-medium"><CheckCircle className="mt-0.5 shrink-0 text-emerald-600" width={17} height={17} />{requirement}</span>
                <span className="mt-2 block pl-6 font-mono text-caption text-muted-foreground">{proof}</span>
              </div>)}
            </div>
          </CardContent></Card>
          <Card className="bg-surface-1 shadow-surface-3"><CardContent className="p-6 lg:p-8">
            <div className="flex items-center justify-between"><span className="text-body font-semibold">Phase journal</span><span className="text-caption text-muted-foreground">append-only narrative</span></div>
            <ol className="mt-6 space-y-5 border-l border-border pl-5">
              {[
                ['PLAN', 'Defined status ownership and reload behavior.'],
                ['CODE', 'Kept placement routing separate from display state.'],
                ['VERIFY', 'Attached the browser run and service failure output.'],
              ].map(([phase, note]) => <li key={phase} className="relative"><span className="absolute -left-[1.45rem] top-1.5 size-2 rounded-full bg-foreground" /><span className="font-mono text-caption text-muted-foreground">{phase}</span><p className="mt-1 text-body leading-relaxed">{note}</p></li>)}
            </ol>
          </CardContent></Card>
        </div>
      </div>
    </section>

    <section className="bg-surface-2 py-20 lg:py-28">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-10">
        <div className="max-w-xl">
          <Badge color="gray">Shipped is not done</Badge>
          <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">The workspace stays useful after the code lands.</h2>
          <p className="mt-5 text-pretty text-subtitle leading-relaxed text-muted-foreground">A merged diff can still leave a failed service, a stale release, or an unanswered review thread. GitSpace keeps those signals attached to the workspace until someone resolves them.</p>
          <p className="mt-6 text-pretty text-body leading-relaxed text-muted-foreground">Move the workspace through plan, code, review, and ship. Archive it when the work is truly quiet, not when an agent prints “done.”</p>
        </div>
        <Card className="bg-surface-1 shadow-surface-3"><CardContent className="p-6 lg:p-8">
          <div className="flex items-center justify-between"><span className="text-body font-semibold">release-check</span><Badge color="orange">Needs attention</Badge></div>
          <div className="mt-6 divide-y divide-border rounded-lg bg-surface-2 px-4 shadow-surface-1">
            {[
              ['Release', 'channel · active'],
              ['Service', 'api · exited'],
              ['Review', '1 unresolved thread'],
              ['Evidence', 'browser run attached'],
            ].map(([label, value]) => <div key={label} className="flex min-h-14 items-center justify-between gap-4"><span className="text-caption text-muted-foreground">{label}</span><span className="text-right font-mono text-caption">{value}</span></div>)}
          </div>
          <div className="mt-5 flex flex-wrap gap-2"><Badge color="gray">Journal</Badge><Badge color="gray">Change guide</Badge><Badge color="gray">Events</Badge><Badge color="gray">Artifacts</Badge></div>
        </CardContent></Card>
      </div>
    </section>

    <section className="mx-auto w-full max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
      <div className="max-w-3xl">
        <Badge color="gray">Built from real work</Badge>
        <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">The workflow came from running agents, not watching demos.</h2>
        <p className="mt-5 max-w-2xl text-pretty text-subtitle leading-relaxed text-muted-foreground">inkibra uses GitSpace to build GitSpace. The rough edges that cost attention become product surfaces.</p>
      </div>
      <div className="mt-12 grid gap-px overflow-hidden rounded-xl bg-border shadow-surface-2 md:grid-cols-3">
        {[
          ['Fleet status', 'because a finished or blocked agent should not disappear inside an old terminal tab.'],
          ['Native questions', 'because a decision should arrive as a clear form, not a prompt buried in streaming output.'],
          ['Change guides', 'because reviewers need the reason and proof behind a diff, not another generated file list.'],
        ].map(([title, reason]) => <article key={title} className="bg-surface-1 p-6 lg:p-8"><h3 className="text-title font-semibold tracking-tight">{title}</h3><p className="mt-3 text-pretty text-body leading-relaxed text-muted-foreground">{reason}</p></article>)}
      </div>
    </section>
    <CapabilityMatrix />

    <section className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-20 lg:grid-cols-2 lg:px-10 lg:py-28">
      <Card className="bg-surface-2 shadow-surface-3"><CardContent className="p-7 lg:p-9">
        <Badge color="gray">Cryptographic authority</Badge>
        <h2 className="mt-5 text-balance text-display font-semibold tracking-tight">Every device proves who authorized it.</h2>
        <p className="mt-5 text-pretty text-body leading-relaxed text-muted-foreground">Your root Ed25519 key signs grants for machines and browsers. Browser keys are non-extractable, requests are signed, credentials are sealed to machine keys, and artifact blobs are encrypted before storage.</p>
        <a href="/docs/security/remote-access" className="mt-8 inline-flex min-h-10 items-center gap-2 text-body font-medium">Read the security boundaries <ArrowRight width={16} height={16} /></a>
      </CardContent></Card>
      <Card className="bg-foreground text-background shadow-surface-3"><CardContent className="p-7 lg:p-9">
        <Badge color="gray">Source available</Badge>
        <h2 className="mt-5 text-balance text-display font-semibold tracking-tight">Run the agent runtime on machines you control.</h2>
        <p className="mt-5 text-pretty text-body leading-relaxed opacity-70">GitSpace is built by inkibra and developed in the open. Read the package code, enroll your own machines, and keep each repository on the machine that owns its workspace.</p>
        <div className="mt-8 flex flex-wrap gap-3"><a href="/docs/getting-started"><Button variant="secondary">Read the docs</Button></a><a href="https://github.com/inKibra/gitspace.sh"><Button variant="secondary">View GitHub</Button></a></div>
      </CardContent></Card>
    </section>
    <PricingSection />

    <section id="start" className="mx-auto w-full max-w-4xl px-6 py-20 lg:py-28">
      <div className="mx-auto max-w-2xl text-center">
        <Badge color="gray">Invite only</Badge>
        <h2 className="mt-5 text-balance text-display font-semibold tracking-tight">Create your GitSpace account.</h2>
        <p className="mt-4 text-pretty text-body text-muted-foreground">Enter your invitation and choose your permanent handle, or recover an account with your saved key. Open GitSpace in this browser, then create a cloud machine or connect a computer when you need one. No installation is required to create your account.</p>
      </div>
      {created
        ? <Card className="mx-auto mt-10 max-w-2xl bg-surface-2 shadow-surface-3"><CardContent className="p-6 lg:p-8">
          <Badge color="green">Account ready</Badge>
          <h3 className="mt-5 text-title font-semibold">{created.handle}.gitspace.sh</h3>
          <p className="mt-2 text-pretty text-body text-muted-foreground">Keep your saved recovery key safe. GitSpace cannot restore it for you. The private root key has been cleared from this page.</p>
          <p className="mt-4 text-pretty text-body text-muted-foreground">{created.enrollmentUrl ? 'Open GitSpace within five minutes to connect this browser. You can set up your account and create a cloud machine without installing the client.' : 'The browser connection link has expired. Use your saved recovery key to get a new one.'}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            {created.enrollmentUrl ? <a href={created.enrollmentUrl} referrerPolicy="no-referrer"><Button variant="primary">Open GitSpace <ArrowRight width={16} height={16} /></Button></a> : <Button variant="primary" onClick={() => { setCreated(null); setUsingSavedKey(true); }}>Use saved recovery key</Button>}
          </div>
        </CardContent></Card>
        : <form className="mx-auto mt-10 max-w-xl space-y-4" onSubmit={(event) => { event.preventDefault(); if (identity) void createAccount(); else prepareAccount(); }}>
          <label className="block">
            <span className="mb-2 block text-caption font-medium">Invitation{usingSavedKey ? ' (only needed to finish signup)' : ''}</span>
            <input value={invite} disabled={creating} onChange={(event) => setInvite(event.target.value.trim())} className="min-h-12 w-full rounded-lg bg-surface-2 px-4 font-mono text-caption outline-none shadow-surface-2 focus:ring-2 focus:ring-[color:var(--focus-ring)]" placeholder="gsi_…" autoComplete="off" spellCheck={false} />
          </label>
          <label className="flex min-h-12 items-center rounded-lg bg-surface-2 px-4 shadow-surface-2 focus-within:ring-2 focus-within:ring-[color:var(--focus-ring)]">
            <span className="sr-only">Account handle</span>
            <input value={handle} disabled={identity !== null || creating} onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, ''))} maxLength={30} className="min-w-0 flex-1 bg-transparent text-body outline-none" placeholder="your-handle" autoComplete="username" />
            <span className="text-caption text-muted-foreground">.gitspace.sh</span>
          </label>
          {identity ? <>
            <div className="space-y-4 rounded-lg bg-surface-2 p-4 shadow-surface-2">
              <h3 className="text-body font-semibold">{usingSavedKey ? 'Saved recovery key loaded' : 'Save your recovery key first'}</h3>
              <p className="text-pretty text-caption text-muted-foreground">Save this key in a password manager with your handle and invitation. Anyone with the key can control your account. It stays in this page until your browser connection link is ready, never in browser storage. If signup is interrupted, resume with the same key.</p>
              {!usingSavedKey ? <>
                <label className="block">
                  <span className="mb-2 block text-caption font-medium">Recovery key</span>
                  <input readOnly value={identity.recoveryKey} onFocus={(event) => event.target.select()} className="min-h-12 w-full rounded-lg bg-surface-3 px-4 font-mono text-caption outline-none focus:ring-2 focus:ring-[color:var(--focus-ring)]" autoComplete="off" spellCheck={false} />
                </label>
                <label className="block">
                  <span className="mb-2 block text-caption font-medium">Paste your saved recovery key to confirm</span>
                  <input type="password" value={recoveryConfirmation} disabled={creating} onChange={(event) => setRecoveryConfirmation(event.target.value)} className="min-h-12 w-full rounded-lg bg-surface-3 px-4 font-mono text-caption outline-none focus:ring-2 focus:ring-[color:var(--focus-ring)]" autoComplete="off" autoCapitalize="none" spellCheck={false} />
                </label>
              </> : null}
              <p className="text-pretty text-caption text-muted-foreground">Preparing or importing a key does not create an account. Continue below when your key is saved. Every retry uses this same key and handle.</p>
            </div>
            <Button variant="primary" type="submit" disabled={creating || recoveryConfirmation.trim() !== identity.recoveryKey || (!usingSavedKey && !invite)} className="w-full">{creating ? 'Checking account…' : usingSavedKey ? 'Recover or finish signup' : 'Create invited account'}</Button>
          </> : <>
            <label className="flex min-h-12 items-center gap-3 text-caption">
              <input type="checkbox" checked={usingSavedKey} onChange={(event) => { setUsingSavedKey(event.target.checked); setSavedRecoveryKey(''); setError(null); }} />
              Resume with a saved recovery key
            </label>
            {usingSavedKey ? <label className="block">
              <span className="mb-2 block text-caption font-medium">Saved recovery key</span>
              <input type="password" value={savedRecoveryKey} onChange={(event) => setSavedRecoveryKey(event.target.value)} className="min-h-12 w-full rounded-lg bg-surface-2 px-4 font-mono text-caption outline-none shadow-surface-2 focus:ring-2 focus:ring-[color:var(--focus-ring)]" placeholder="gsr_…" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </label> : null}
            <Button variant="primary" type="submit" disabled={!handle || (usingSavedKey ? !savedRecoveryKey.trim() : !invite)} className="w-full">{usingSavedKey ? 'Use saved recovery key' : 'Prepare recovery key'}</Button>
          </>}
        </form>}
      {error ? <p role="alert" className="mx-auto mt-4 max-w-xl text-body text-red-600">{error}</p> : null}
      <div className="mx-auto mt-12 max-w-2xl">
        <p className="mb-3 text-caption text-muted-foreground">Optional: install the client to connect a computer. You can create cloud machines from GitSpace without it.</p>
        <div className="flex min-h-14 items-center gap-3 rounded-lg bg-surface-2 py-2 pl-5 pr-2 shadow-surface-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-body"><span className="text-muted-foreground">$ </span>{installCommand}</code>
          <Button variant="secondary" size="compact" onClick={() => void copyInstall()} leadingIcon={installCopied ? CheckCircle : Copy01} aria-live="polite">{installCopied ? 'Copied' : 'Copy'}</Button>
        </div>
      </div>
    </section>
    <MarketingFooter />
  </main>;
}
