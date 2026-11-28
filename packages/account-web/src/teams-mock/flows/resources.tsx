// The dialogs and wizards behind the resource pages' buttons: Inference (add a provider: a subscription sign-in, an API
// key, AWS Bedrock or a local model; replace or remove one; a new profile; a role's model; a provider out of a profile;
// an advanced setting; a budget), Plugins (a team plugin, a personal sign-in or reconnect, the team's Composio account,
// configuring a team plugin and the Slack app's channels, disconnecting), Browsers (pairing a Chrome, its projects,
// unpairing), my own secrets (adding one; stepping up and dropping are in secret-rules.tsx) and Skills (new or imported, edit). Each walks to a
// success state that changes the stores in `resources-data.ts`; team changes are in the audit log.
import { glyph } from '../../glyph.js';
import { StatusDot } from '../../GitSpaceShell.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, ThinkingIndicator } from '@gitspace/ui';
import { ArrowDown, ArrowUp, BookOpen01, Check, Cloud01, Code01, CpuChip01, CreditCard02, Database01, Download01, File06, GitBranch01, Key01, Link03, Lock01, Phone01, Plus, PuzzlePiece01, Server01, Stars01 } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bots, findPrincipal, USERS, visibleProjects, WORKSPACES, type Principal, type User } from '../data.js';
import { ACCOUNT_NAME, ACTIVE_PROJECTS, appCovers, budgets, GITHUB_ACCOUNTS, PERSONAL_KINDS, projectName, projectSettings, recordAudit, type Browser, type Budget, type InferenceProfileMock, type ModelCredential, type Owner, type Plugin, type ProviderId, type Skill } from '../settings/data.js';
import { useHeld } from '../settings/parts.js';
import { passkeyLabel, usePasskey } from '../settings/passkey.js';
import { listNames, pluginReach, providerReach } from '../scoped/common.js';
import { useMock, useViewer } from '../viewer.js';
import { secretRules } from './env-model.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea, type Choice } from './kit.js';
import { PEM_BEGIN, PEM_END, PEM_PRIVATE_KEY, STRIPE_RESTRICTED_LIVE, STRIPE_SECRET_LIVE } from './token-shapes.js';
import { browsers, budgetPolicies, COMPOSIO_CATALOG, LOCAL_MODELS_FOUND, LOCAL_PORT, localModels, machinesOf, modelsOf, NOTIFY_OPTIONS, OWN_SECRET_KINDS, PERSONAL_CATALOG, plugins, profiles, providers, ROLES, skills, slackChannels, TEAM_AUTH_LABEL, TEAM_CATALOG, teamComposio, type BudgetPolicy, type CatalogEntry, type LocalModel, type LocalRuntime, type OwnSecretKind, type TeamAuth } from './resources-data.js';
import { secrets } from './team-data.js';

const money = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Runs `then` after `ms`, with `busy` naming what's running meanwhile (a check, a sign-in, a fetch). */
function useLater(): { busy: string | null; later(key: string, ms: number, then: () => void): void } {
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);
  return { busy, later(key, ms, then) { setBusy(key); timers.current.push(window.setTimeout(() => { setBusy(null); then(); }, ms)); } };
}

/** The projects `userId` is in (all of them for an Owner), as chip options. */
function projectOptions(userId: string): ReadonlyArray<{ id: string; label: string }> {
  const seen = visibleProjects(userId);
  return ACTIVE_PROJECTS.filter((project) => seen.has(project.id)).map((project) => ({ id: project.id, label: project.name }));
}
/** Said under a project picker for an Admin who isn't in every project. */
function UnseenProjects({ userId }: { userId: string }) {
  const unseen = ACTIVE_PROJECTS.filter((project) => !visibleProjects(userId).has(project.id));
  return unseen.length ? <Hint>Projects you’re not in aren’t listed ({unseen.length}); their Leads switch it on in their project settings.</Hint> : null;
}

/** A provider's or service's page, opened in a new tab: drawn in the dialog so the mock can walk through it. */
function ProviderTab({ url, heading, children }: { url: string; heading: string; children: ReactNode }) {
  return <div data-provider-tab="" className="overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
    <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
      <span aria-hidden className="flex gap-1"><span className="size-2 rounded-full bg-[#ff5f57]" /><span className="size-2 rounded-full bg-[#febc2e]" /><span className="size-2 rounded-full bg-[#28c840]" /></span>
      <Lock01 width={12} height={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{url}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">New tab</span>
    </div>
    <div className="flex flex-col gap-3 px-4 py-3"><span className="text-body font-medium text-foreground">{heading}</span>{children}</div>
  </div>;
}

/** An account the provider's page offers; `problem` is the error signing in with it gives, with the fix. */
export interface SignInAccount { id: string; label: string; detail: string; problem: string | null }

/** The sign-in step, as account-web's SignInFlowView: the sign-in URL (and a device code where the provider uses one),
 * the provider's page, then waiting for authorization. Cancelling on the provider's page, or approving with the wrong
 * account, shows why and lets you open it again. */
function SignInStep({ site, url, code, what, accounts, signedAs, onSignedIn }: { site: string; url: string; code?: string; what: string; accounts: readonly SignInAccount[]; signedAs: SignInAccount | null; onSignedIn(account: SignInAccount | null): void }) {
  const [phase, setPhase] = useState<'start' | 'tab' | 'waiting' | 'cancelled' | 'wrong'>('start');
  const [pick, setPick] = useState(accounts[0]?.id ?? '');
  const [problem, setProblem] = useState('');
  const { later } = useLater();
  if (signedAs) return <div className="flex flex-col gap-2" data-sign-in="done">
    <p role="status" className="flex items-center gap-2 text-body text-foreground"><Check width={16} height={16} className="text-[#079455]" />Signed in to {site} as {signedAs.label}.</p>
    <div><Button variant="ghost" size="compact" onClick={() => { onSignedIn(null); setPhase('start'); }}>Use another account</Button></div>
  </div>;
  const allow = (): void => {
    const account = accounts.find((entry) => entry.id === pick);
    if (!account) return;
    setPhase('waiting');
    later('auth', 1200, () => { if (account.problem) { setProblem(account.problem); setPhase('wrong'); } else onSignedIn(account); });
  };
  return <div className="flex flex-col gap-3" data-sign-in={phase}>
    <p className="text-caption text-muted-foreground">Approve access on {site}. Sign-in continues in the cloud if this browser closes; Cancel stops it.</p>
    {code ? <div className="flex flex-col gap-1"><span className="text-caption text-muted-foreground">Enter this code on the sign-in page</span><span aria-label="Device code" className="font-mono text-title font-semibold tabular-nums tracking-[0.2em] text-foreground">{code}</span></div> : null}
    <InputCopy label="Sign-in URL" value={url} />
    {phase === 'start' || phase === 'cancelled' || phase === 'wrong' ? <div><Button variant={phase === 'start' ? 'primary' : 'secondary'} onClick={() => setPhase('tab')}>{phase === 'start' ? 'Open sign-in page' : 'Open sign-in page again'}</Button></div> : null}
    {phase === 'tab' ? <ProviderTab url={url} heading={`Allow GitSpace to ${what}?`}>
      <ChoiceCards label={`Continue on ${site} as`} choices={accounts.map((account) => ({ id: account.id, title: account.label, detail: account.detail }))} value={pick} onChange={setPick} />
      <div className="flex gap-2"><Button variant="primary" size="compact" onClick={allow}>Allow</Button><Button variant="ghost" size="compact" onClick={() => setPhase('cancelled')}>Cancel</Button></div>
    </ProviderTab> : null}
    {phase === 'waiting' ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Waiting for authorization. This dialog updates automatically after approval.</div> : null}
    {phase === 'cancelled' ? <FlowError>Sign-in was cancelled on {site}: nothing was connected. Open the sign-in page again to retry; the link works for 10 minutes.</FlowError> : null}
    {phase === 'wrong' ? <FlowError>{problem}</FlowError> : null}
  </div>;
}

/** A yes/no action (remove, disconnect, unpair, drop, turn on): what it changes, an optional refusal that keeps it
 * off with the reason, an optional passkey, then its success state. */
export function ConfirmFlow({ id, title, description, children, confirmLabel, refusal = null, passkeyWhat, success, onConfirm, onClose }: {
  id: string; title: ReactNode; description?: ReactNode; children?: ReactNode; confirmLabel: string; refusal?: string | null; passkeyWhat?: string;
  success: { title: ReactNode; body?: ReactNode }; onConfirm(): void; onClose(): void;
}) {
  const viewer = useViewer();
  const passkey = usePasskey();
  const [done, setDone] = useState(false);
  const confirm = (): void => {
    if (passkeyWhat) passkey.confirm(() => { onConfirm(); setDone(true); });
    else { onConfirm(); setDone(true); }
  };
  return <FlowDialog id={id} title={done ? success.title : title} description={done ? undefined : description} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" disabled={passkey.waiting} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={Boolean(refusal) || passkey.waiting} loading={passkey.waiting} onClick={confirm}>{confirmLabel}</Button></>}>
    {done ? <FlowSuccess title={success.title}>{success.body}</FlowSuccess> : <>
      {children}
      {refusal ? <FlowError>{refusal}</FlowError> : null}
      {passkeyWhat && !refusal ? <PasskeyStep userId={viewer.id} what={passkeyWhat} waiting={passkey.waiting} /> : null}
    </>}
  </FlowDialog>;
}

function Rules({ items }: { items: readonly string[] }) {
  return <ul className="flex flex-col gap-1 rounded-xl px-3 py-2.5 text-caption text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
    {items.map((item) => <li key={item} className="flex items-start gap-2"><Check width={14} height={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[#079455]" />{item}</li>)}
  </ul>;
}

// ── Inference: providers ──────────────────────────────────────────────────────────────────────────────────────────

type ProviderOption = 'claude' | 'chatgpt' | KeyOption | 'bedrock' | 'local';
type KeyOption = 'anthropic-key' | 'openai-key' | 'google-key';
const KEY_PROVIDER: Readonly<Record<KeyOption, { provider: ProviderId; prefix: string; console: string; placeholder: string }>> = {
  'anthropic-key': { provider: 'anthropic', prefix: 'sk-ant-', console: 'console.anthropic.com › Settings › API keys', placeholder: 'sk-ant-api03-…' },
  'openai-key': { provider: 'openai', prefix: 'sk-', console: 'platform.openai.com › API keys', placeholder: 'sk-proj-…' },
  'google-key': { provider: 'google', prefix: 'AIza', console: 'aistudio.google.com › Get API key', placeholder: 'AIza…' },
};
function isKeyOption(option: ProviderOption): option is KeyOption { return option === 'anthropic-key' || option === 'openai-key' || option === 'google-key'; }
const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };

/** A pasted key's format problem, or null. */
function keyFormat(option: KeyOption, key: string): string | null {
  const spec = KEY_PROVIDER[option];
  const text = key.trim();
  if (!text) return 'Paste the key';
  if (option === 'openai-key' && text.startsWith('sk-ant-')) return 'That’s an Anthropic key (sk-ant-…): pick Anthropic API key, or paste an OpenAI key';
  if (!text.startsWith(spec.prefix)) return `${PROVIDER_NAME[spec.provider]} keys start with ${spec.prefix}: check you copied the whole key`;
  return null;
}
/** What the provider says when it rejects a well-formed key, with the fix. Keys under 40 characters are rejected. */
function keyRejected(option: KeyOption, key: string): string | null {
  const spec = KEY_PROVIDER[option];
  return key.trim().length < 40 ? `Key rejected by ${PROVIDER_NAME[spec.provider]}: 401 invalid API key. Copy the whole key again from ${spec.console} (keys are about 100 characters); a deleted or revoked key fails the same way.` : null;
}
const BEDROCK_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const REGIONS = ['eu-west-1', 'us-east-1', 'us-west-2'] as const;

/** Add a provider, for the team (API keys, Bedrock, a local model; a subscription is always someone's own) or for
 * yourself or a bot you manage (`principal`; a bot takes keys and local models, never a subscription): provider, then
 * sign in / key / endpoint, then a name and where it may pay, then done. */
export function AddProviderFlow({ team, principal, onClose }: { team: boolean; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const { busy, later } = useLater();
  const who = principal ?? viewer;
  const bot = who.kind === 'bot';
  const owner: Owner = team ? { scope: 'account' } : { scope: 'user', userId: who.id };
  const [option, setOption] = useState<ProviderOption>(team || bot ? 'anthropic-key' : 'claude');
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [signedAs, setSignedAs] = useState<SignInAccount | null>(null);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [arn, setArn] = useState('');
  const [region, setRegion] = useState<string>('eu-west-1');
  const [machines] = useState(() => machinesOf(owner));
  const [machineId, setMachineId] = useState(machines[0]?.id ?? '');
  const [runtime, setRuntime] = useState<LocalRuntime>('Ollama');
  const [url, setUrl] = useState('http://localhost:11434');
  const [found, setFound] = useState<readonly string[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [inProfiles, setInProfiles] = useState<ReadonlySet<string>>(new Set(['default']));
  const [cap, setCap] = useState('');
  const [capError, setCapError] = useState<string | null>(null);
  const kind = option === 'claude' || option === 'chatgpt' ? 'sub' : isKeyOption(option) ? 'key' : option;
  const steps = ['Provider', kind === 'sub' ? 'Sign in' : kind === 'key' ? 'Key' : kind === 'bedrock' ? 'Role' : 'Machine and endpoint', team ? 'Name and profiles' : 'Name and where'];
  const subscription = bot ? `A subscription is a person’s own: ${who.first} pays with an API key or a local model` : 'Subscription sign-in is always someone’s own: each person connects theirs under You › Inference, and a profile decides where it may pay';
  const choices: Choice[] = [
    { id: 'claude', title: 'Claude Pro or Max', detail: 'Sign in at claude.ai. Pays at subscription rates, within its usage windows.', icon: Stars01, badge: <SmallPill>Subscription</SmallPill>, disabled: team || bot ? subscription : null },
    { id: 'chatgpt', title: 'ChatGPT Plus or Pro', detail: 'Sign in with a device code at auth.openai.com.', icon: Stars01, badge: <SmallPill>Subscription</SmallPill>, disabled: team || bot ? subscription : null },
    { id: 'anthropic-key', title: 'Anthropic API key', detail: 'From console.anthropic.com; billed per token to that organisation.', icon: Key01 },
    { id: 'openai-key', title: 'OpenAI API key', detail: 'From platform.openai.com.', icon: Key01 },
    { id: 'google-key', title: 'Google API key', detail: 'Gemini, from aistudio.google.com.', icon: Key01 },
    ...team ? [{ id: 'bedrock', title: 'AWS Bedrock', detail: 'Claude through an AWS account: GitSpace assumes a role you create.', icon: Cloud01 }] : [],
    { id: 'local', title: 'Local model', detail: `Ollama or LM Studio on ${team ? 'a team machine' : bot ? `one of ${who.first}’s machines` : 'one of your machines'}; nothing is billed.`, icon: Server01, badge: machines.length ? undefined : <SmallPill>No machine</SmallPill>, disabled: machines.length ? null : `${team ? 'The team has' : bot ? `${who.first} has` : 'You have'} no machine to run it on: add one under Machines first` },
  ];
  const machine = machines.find((entry) => entry.id === machineId);
  const subFor = option === 'chatgpt' ? { site: 'auth.openai.com', url: 'https://auth.openai.com/codex/device', code: 'WXQK-7HDM', plan: 'ChatGPT Pro', free: 'ChatGPT Free', provider: 'openai' as const }
    : { site: 'claude.ai', url: 'https://claude.ai/oauth/authorize?client_id=gitspace&code=true&state=9f2c71', code: undefined, plan: 'Claude Max', free: 'Claude Free', provider: 'anthropic' as const };
  const personal = `${viewer.first.toLowerCase()}.${viewer.name.split(' ').at(-1)?.toLowerCase() ?? 'me'}@gmail.com`;
  const accounts: readonly SignInAccount[] = [
    { id: 'work', label: viewer.email, detail: `${subFor.plan} · your work account`, problem: null },
    { id: 'personal', label: personal, detail: subFor.free, problem: `You signed in as ${personal}, which has ${subFor.free}: it can’t be used from GitSpace. Open the sign-in page again and pick the account with ${subFor.plan === 'Claude Max' ? 'Pro or Max' : 'Plus or Pro'} (${viewer.email}), or upgrade that account first.` },
  ];
  const provider: ProviderId = kind === 'sub' ? subFor.provider : isKeyOption(option) ? KEY_PROVIDER[option].provider : 'anthropic';
  const via: ModelCredential['via'] = kind === 'sub' ? 'Subscription' : kind === 'bedrock' ? 'Bedrock' : 'API key';
  const baseName = kind === 'local' ? `${runtime} on ${machine?.label ?? 'a machine'}` : kind === 'bedrock' ? `AWS Bedrock (${region})` : kind === 'sub' ? `${viewer.first}’s ${signedAs?.detail.split(' · ')[0] ?? subFor.plan}` : `${team ? 'Team' : `${who.first}’s`} ${PROVIDER_NAME[provider]} key`;
  const defaultName = providers.get().some((entry) => entry.label === baseName) || localModels.get().some((entry) => entry.label === baseName) ? `${baseName} 2` : baseName;
  const draft: ModelCredential = { id: 'draft', provider, label: name, owner, via, state: 'available', spentToday: 0, lastUsed: 'never' };
  const reach = team ? null : providerReach(who.id, draft);
  const allProfiles = profiles.get();

  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) {
      if (kind === 'key' && isKeyOption(option)) {
        const problem = keyFormat(option, key);
        setKeyError(problem); setRejected(null);
        if (problem) return;
        later('check', 1100, () => { const no = keyRejected(option, key); setRejected(no); if (!no) { setName(defaultName); setStep(2); } });
        return;
      }
      if (kind === 'bedrock') {
        if (!BEDROCK_ARN.test(arn.trim())) { setKeyError('A role ARN looks like arn:aws:iam::123456789012:role/gitspace-bedrock'); return; }
        setKeyError(null); setRejected(null);
        later('check', 1100, () => {
          if (region === 'us-west-2') { setRejected('AccessDeniedException: model access isn’t granted in us-west-2. In the Bedrock console › Model access, request Claude in that region, or pick the region where you have it.'); return; }
          setName(defaultName); setStep(2);
        });
        return;
      }
      setName(defaultName); setStep(2);
      return;
    }
    const trimmed = name.trim();
    const taken = providers.get().some((entry) => entry.label === trimmed) || localModels.get().some((entry) => entry.label === trimmed);
    const nameProblem = !trimmed ? 'Give it a name' : taken ? `${trimmed} is taken: names tell providers apart in Usage` : null;
    const capProblem = cap.trim() && !/^\d+(\.\d{1,2})?$/.test(cap.trim()) ? 'A daily cap is dollars, like 40 or 40.50' : null;
    setNameError(nameProblem); setCapError(capProblem);
    if (nameProblem || capProblem) return;
    const save = (): void => {
      const id = `${team ? 'team' : who.id}-${Date.now().toString(36)}`;
      if (kind === 'local') {
        const entry: LocalModel = { id, label: trimmed, owner, runtime, machineId, url: url.trim(), models: [...picked], profiles: team ? [...inProfiles] : [] };
        localModels.set([...localModels.get(), entry]);
      } else providers.set([...providers.get(), { id, provider, label: trimmed, owner, via, state: 'available', spentToday: 0, lastUsed: 'never' }]);
      if (team && kind !== 'local') profiles.set(profiles.get().map((profile) => inProfiles.has(profile.id) ? { ...profile, teamProviders: [...profile.teamProviders, id] } : profile));
      if (team || bot) recordAudit({ actor: viewer.id, kind: 'setting', text: team ? `Added team provider ${trimmed} (${kind === 'local' ? `${runtime} on ${machine?.label}` : via})${inProfiles.size ? ` to ${[...inProfiles].map((profile) => allProfiles.find((entry) => entry.id === profile)?.name ?? profile).join(', ')}` : ''} · confirmed with ${passkeyLabel(viewer.id)}` : `Added provider ${trimmed} (${kind === 'local' ? `${runtime} on ${machine?.label}` : via}) to ${who.name}` });
      say(`${trimmed} added`);
      setDone(true);
    };
    if (team) passkey.confirm(save); else save();
  };
  const ready = step === 0 ? true : step === 1 ? (kind === 'sub' ? signedAs !== null : kind === 'local' ? found !== null && picked.size > 0 : true) : true;
  const fetchModels = (): void => {
    const text = url.trim();
    if (!/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(text)) { setKeyError('An endpoint looks like http://localhost:11434'); return; }
    setKeyError(null); setRejected(null); setFound(null);
    later('fetch', 1000, () => {
      if (machine && machine.state !== 'online') { setRejected(`${machine.label} is ${machine.state}: GitSpace reaches a local model through its machine. Wake it in Machines, then fetch again.`); return; }
      const port = Number(/:(\d+)\/?$/.exec(text)?.[1] ?? '80');
      if (port !== LOCAL_PORT[runtime]) { setRejected(`Nothing answered at ${text} on ${machine?.label ?? 'that machine'}: connection refused. Is ${runtime} running? ${runtime === 'Ollama' ? 'Start it with ollama serve; it listens on 11434.' : 'Start its server in LM Studio › Developer; it listens on 1234.'}`); return; }
      const list = LOCAL_MODELS_FOUND[runtime];
      setFound(list); setPicked(new Set(list.slice(0, 2)));
    });
  };

  return <FlowDialog id="add-provider" title={done ? `${name.trim()} is ready` : team ? 'Add a team provider' : bot ? `Connect a provider for ${who.first}` : 'Connect a provider'} steps={steps} step={step} done={done} onClose={onClose}
    description={done ? undefined : team ? 'API keys and Bedrock accounts are the team’s; profiles decide which projects pay with them. Encrypted in the team’s credential vault; machines never receive provider keys.' : bot ? `${who.first}’s own key. It pays only for turns ${who.first} starts, in projects whose inference profile allows its kind.` : 'Your own subscription or key. It pays only for turns started in workspaces you hold, in projects whose inference profile allows its kind.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setStep(step - 1); setRejected(null); setKeyError(null); }} onCancel={onClose} next={next} disabled={!ready} busy={busy !== null || passkey.waiting}
      nextLabel={step === 0 ? 'Continue' : step === 1 ? (kind === 'key' ? 'Check key' : kind === 'bedrock' ? 'Check role' : 'Continue') : team ? 'Save with passkey' : 'Connect'} />}>
    {done ? <FlowSuccess title={`${name.trim()} ${kind === 'sub' ? 'is signed in' : 'is added'}`}>
      {team ? (kind === 'local' ? `Profiles can map roles to its models (${[...picked].join(', ')}) while ${machine?.label} is online.` : inProfiles.size ? `Last in the fallback order of ${[...inProfiles].map((id) => allProfiles.find((profile) => profile.id === id)?.name ?? id).join(' and ')}; reorder it in a profile’s Providers tab. In the audit log.` : 'In no profile yet: add it in a profile’s Providers tab.')
        : kind === 'local' ? `Used for roles a profile maps to it, in workspaces you hold, while ${machine?.label} is online.`
        : reach?.on.length ? (bot ? `Pays for turns ${who.first} starts in ${listNames(reach.on)}. Sign it out here any time.` : `Pays for turns you start in workspaces you hold in ${listNames(reach.on)}. Never for a co-holder’s turns. Sign it out here any time.`) : `It can’t pay anywhere yet: no profile of a project ${bot ? `${who.first} is` : 'you’re'} in allows its kind. A Lead or Admin can allow it in the profile.`}
    </FlowSuccess> : null}

    {!done && step === 0 ? <ChoiceCards label="Provider" columns={2} choices={choices} value={option} onChange={(id) => { const choice = choices.find((entry) => entry.id === id); if (choice && !choice.disabled && isProviderOption(id)) { setOption(id); setSignedAs(null); setKey(''); setKeyError(null); setRejected(null); } }} /> : null}

    {!done && step === 1 && kind === 'sub' ? <SignInStep site={subFor.site} url={subFor.url} code={subFor.code} what={`use your ${subFor.plan === 'Claude Max' ? 'Claude' : 'ChatGPT'} subscription`} accounts={accounts} signedAs={signedAs} onSignedIn={setSignedAs} /> : null}

    {!done && step === 1 && isKeyOption(option) ? <>
      <InputGroup className="w-full"><InputField index={0} label="API key" type="password" autoComplete="off" value={key} onChange={(value) => { setKey(value); setKeyError(null); setRejected(null); }} placeholder={KEY_PROVIDER[option].placeholder} error={keyError ?? undefined} /></InputGroup>
      <Hint>Make one at {KEY_PROVIDER[option].console}. GitSpace checks it with {PROVIDER_NAME[KEY_PROVIDER[option].provider]} before saving; only the last four characters show afterwards.</Hint>
      {busy === 'check' ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Checking with {PROVIDER_NAME[KEY_PROVIDER[option].provider]}…</div> : null}
      {rejected ? <FlowError>{rejected}</FlowError> : null}
    </> : null}

    {!done && step === 1 && kind === 'bedrock' ? <>
      <InputGroup className="w-full"><InputField index={0} label="Role ARN" value={arn} onChange={(value) => { setArn(value); setKeyError(null); setRejected(null); }} placeholder="arn:aws:iam::123456789012:role/gitspace-bedrock" error={keyError ?? undefined} /></InputGroup>
      <Field label="Region"><Select value={region} onValueChange={(value) => { setRegion(value); setRejected(null); }}><SelectTrigger aria-label="Region" /><SelectContent>{REGIONS.map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{entry}</SelectItem>)}</SelectContent></Select></Field>
      <InputCopy label="External ID for the role’s trust policy" value="gs-crumbco-7f3a91" />
      <Hint>Create a role GitSpace’s AWS account may assume with this external ID, allowed bedrock:InvokeModel. GitSpace stores no AWS keys.</Hint>
      {busy === 'check' ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Assuming the role and listing models…</div> : null}
      {rejected ? <FlowError>{rejected}</FlowError> : null}
    </> : null}

    {!done && step === 1 && kind === 'local' ? <>
      <Field label="Machine"><Select value={machineId} onValueChange={(value) => { setMachineId(value); setFound(null); setRejected(null); }}><SelectTrigger aria-label="Machine" /><SelectContent>{machines.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{`${entry.label} · ${entry.state}`}</SelectItem>)}</SelectContent></Select></Field>
      <ChoiceCards label="Runs" columns={2} value={runtime} onChange={(id) => { if (id === 'Ollama' || id === 'LM Studio') { setRuntime(id); setUrl(`http://localhost:${LOCAL_PORT[id]}`); setFound(null); setRejected(null); } }}
        choices={[{ id: 'Ollama', title: 'Ollama', detail: 'Listens on port 11434', icon: Server01 }, { id: 'LM Studio', title: 'LM Studio', detail: 'Its local server listens on 1234', icon: Server01 }]} />
      <div className="flex items-end gap-2">
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Endpoint on that machine" value={url} onChange={(value) => { setUrl(value); setFound(null); setRejected(null); setKeyError(null); }} error={keyError ?? undefined} /></InputGroup>
        <Button variant="secondary" loading={busy === 'fetch'} disabled={busy !== null} onClick={fetchModels}>Fetch models</Button>
      </div>
      <Hint>GitSpace reaches it through the machine’s own connection; nothing is opened to the internet.</Hint>
      {rejected ? <FlowError>{rejected}</FlowError> : null}
      {found ? <div className="flex flex-col gap-2"><span className="text-caption font-medium text-foreground">{found.length} models found · offer these</span><ChipPicker label="Models" options={found.map((model) => ({ id: model, label: model }))} picked={picked} onChange={setPicked} />{picked.size ? null : <FlowError>Pick at least one model to offer.</FlowError>}</div> : null}
    </> : null}

    {!done && step === 2 ? <>
      <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={(value) => { setName(value); setNameError(null); }} error={nameError ?? undefined} /></InputGroup>
      {team ? <>
        <div className="flex flex-col gap-2"><span className="text-caption font-medium text-foreground">Add to profiles (last in their fallback order)</span>
          <ChipPicker label="Profiles" options={allProfiles.map((profile) => ({ id: profile.id, label: profile.name }))} picked={inProfiles} onChange={setInProfiles} />
          <Hint>{allProfiles.filter((profile) => inProfiles.has(profile.id)).map((profile) => `${profile.name}: ${listNames(Object.entries(projectSettings.get()).filter(([, settings]) => settings.profile === profile.id).map(([id]) => id)) || 'no project'}`).join(' · ') || 'In no profile: no project pays with it until a profile adds it.'}</Hint>
        </div>
        {kind !== 'local' ? <InputGroup className="w-full"><InputField index={1} label="Daily spend cap in USD (optional)" value={cap} onChange={(value) => { setCap(value); setCapError(null); }} placeholder="No cap" error={capError ?? undefined} /></InputGroup> : null}
      </> : kind === 'local' ? <Rules items={['Used for the roles a profile maps to a local model, in workspaces you hold', `Only while ${machine?.label ?? 'the machine'} is online`, 'Never billed; never used for a co-holder’s turns']} /> : <>
        <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Where it may pay</span>
          <ul className="flex flex-col gap-1 rounded-xl px-3 py-2.5 text-caption shadow-[inset_0_0_0_1px_var(--border)]" data-reach="">
            {reach?.on.map((id) => <li key={id} className="flex items-center gap-2 text-foreground"><Check width={14} height={14} className="text-[#079455]" />{projectName(id)}: its profile allows {PROVIDER_NAME[provider]} {via === 'Subscription' ? 'subscription' : 'API key'}s</li>)}
            {reach?.off.map((item) => <li key={item.id} className="text-muted-foreground">Not in {projectName(item.id)}: {item.why}</li>)}
          </ul>
        </div>
        <Rules items={bot ? [`Pays only for turns ${who.first} starts`, 'Never for anyone else’s turns in a workspace it holds', 'Stops when its sponsor, an Owner or an Admin signs it out here'] : ['Pays only while you hold the workspace’s handle, for turns you start', 'Never for a co-holder’s turns, even while you hold together', 'Stops when you sign it out here']} />
      </>}
      {team && passkey.waiting ? <PasskeyStep userId={viewer.id} what={`adding ${name.trim()}`} waiting /> : null}
    </> : null}
  </FlowDialog>;
}
function isProviderOption(id: string): id is ProviderOption { return ['claude', 'chatgpt', 'anthropic-key', 'openai-key', 'google-key', 'bedrock', 'local'].includes(id); }
function SmallPill({ children }: { children: ReactNode }) { return <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">{children}</span>; }
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">{label}</span>{children}</div>;
}

/** Replace a team provider's key (or Bedrock role): checked with the provider, saved with a passkey; the old one stops
 * at the next turn. */
export function ReplaceProviderFlow({ entry, onClose }: { entry: ModelCredential; onClose(): void }) {
  const viewer = useViewer();
  const passkey = usePasskey();
  const { busy, later } = useLater();
  const option: KeyOption = entry.provider === 'openai' ? 'openai-key' : entry.provider === 'google' ? 'google-key' : 'anthropic-key';
  const bedrock = entry.via === 'Bedrock';
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const replace = (): void => {
    const problem = bedrock ? (BEDROCK_ARN.test(value.trim()) ? null : 'A role ARN looks like arn:aws:iam::123456789012:role/gitspace-bedrock') : keyFormat(option, value);
    setError(problem); setRejected(null);
    if (problem) return;
    later('check', 1100, () => {
      const no = bedrock ? null : keyRejected(option, value);
      setRejected(no);
      if (no) return;
      passkey.confirm(() => {
        providers.set(providers.get().map((candidate) => candidate.id === entry.id ? { ...candidate, state: 'available', stateDetail: undefined } : candidate));
        recordAudit({ actor: viewer.id, kind: 'setting', text: `Replaced the ${bedrock ? 'role' : 'key'} of team provider ${entry.label} · confirmed with ${passkeyLabel(viewer.id)}` });
        setDone(true);
      });
    });
  };
  return <FlowDialog id="replace-provider" title={done ? `${entry.label} replaced` : `Replace ${entry.label}`} wide={false} done={done} onClose={onClose}
    description={done ? undefined : `Profiles keep using ${entry.label} under its name; the ${bedrock ? 'old role' : 'old key'} stops at the next turn. Revoke the old one at ${bedrock ? 'AWS' : KEY_PROVIDER[option].console} afterwards.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" disabled={busy !== null || passkey.waiting} onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy !== null || passkey.waiting} disabled={busy !== null || passkey.waiting} onClick={replace}>Check and replace</Button></>}>
    {done ? <FlowSuccess title={`${entry.label} uses the new ${bedrock ? 'role' : 'key'}`}>Turns started from now pay with it. In the audit log.</FlowSuccess> : <>
      <InputGroup className="w-full"><InputField index={0} label={bedrock ? 'New role ARN' : 'New API key'} type={bedrock ? 'text' : 'password'} autoComplete="off" value={value} onChange={(next) => { setValue(next); setError(null); setRejected(null); }} placeholder={bedrock ? 'arn:aws:iam::…:role/…' : KEY_PROVIDER[option].placeholder} error={error ?? undefined} /></InputGroup>
      {rejected ? <FlowError>{rejected}</FlowError> : null}
      {passkey.waiting ? <PasskeyStep userId={viewer.id} what={`replacing ${entry.label}`} waiting /> : null}
    </>}
  </FlowDialog>;
}

/** Remove a team provider: refused while a profile has no other team provider; otherwise it leaves every profile. */
export function RemoveProviderFlow({ entry, onClose }: { entry: ModelCredential; onClose(): void }) {
  const viewer = useViewer();
  const using = profiles.get().filter((profile) => profile.teamProviders.includes(entry.id));
  const only = using.find((profile) => profile.teamProviders.length === 1);
  return <ConfirmFlow id="remove-provider" title={`Remove ${entry.label}?`} confirmLabel="Remove with passkey" passkeyWhat={`removing ${entry.label}`} onClose={onClose}
    description="Its key is deleted from the team’s vault. Turns already running finish; new ones use the next provider in their profile’s order."
    refusal={only ? `${only.name} has no other team provider, so its projects would have nothing to pay with. Add another provider to ${only.name} first (its Providers tab), or apply a different profile to its projects.` : null}
    success={{ title: `${entry.label} removed`, body: using.length ? `It left ${using.map((profile) => profile.name).join(' and ')}. In the audit log.` : 'In the audit log.' }}
    onConfirm={() => {
      providers.set(providers.get().filter((candidate) => candidate.id !== entry.id));
      profiles.set(profiles.get().map((profile) => ({ ...profile, teamProviders: profile.teamProviders.filter((id) => id !== entry.id) })));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Removed team provider ${entry.label} · confirmed with ${passkeyLabel(viewer.id)}` });
    }}>
    <Summary rows={[['Spent today', money(entry.spentToday)], ['Last used', entry.lastUsed], ['In profiles', using.map((profile) => profile.name).join(', ') || 'none']]} />
  </ConfirmFlow>;
}

/** Remove a local model. */
export function RemoveLocalFlow({ entry, onClose }: { entry: LocalModel; onClose(): void }) {
  const viewer = useViewer();
  return <ConfirmFlow id="remove-local" title={`Remove ${entry.label}?`} confirmLabel="Remove" onClose={onClose}
    description={`Roles mapped to its models fall back to the profile’s next provider. ${entry.runtime} keeps running on the machine.`}
    success={{ title: `${entry.label} removed` }}
    onConfirm={() => {
      localModels.set(localModels.get().filter((candidate) => candidate.id !== entry.id));
      if (entry.owner.scope === 'account') recordAudit({ actor: viewer.id, kind: 'setting', text: `Removed local model ${entry.label}` });
    }} />;
}

// ── Inference: profiles ───────────────────────────────────────────────────────────────────────────────────────────

/** The models a profile with these team providers can pick (and the team's local models). */
function offered(order: readonly string[]): readonly string[] {
  const all = providers.get();
  const remote = order.flatMap((id) => { const entry = all.find((candidate) => candidate.id === id); return entry ? modelsOf(entry) : []; });
  const local = localModels.get().filter((entry) => entry.owner.scope === 'account').flatMap((entry) => entry.models.map((model) => `${entry.runtime === 'Ollama' ? 'ollama' : 'lmstudio'}/${model}`));
  return [...new Set([...remote, ...local])];
}
function suggest(role: string, options: readonly string[]): string {
  const cheap = options.find((model) => /haiku|mini|flash/.test(model));
  const strong = options.find((model) => /:max|:high|pro/.test(model));
  return (role === 'smol' || role === 'commit' ? cheap : role === 'slow' || role === 'plan' || role === 'review' ? strong : undefined) ?? options[0] ?? '';
}

/** The team providers of a profile in fallback order: move up or down, remove, or add one of the rest. */
function ProviderOrder({ order, onChange }: { order: readonly string[]; onChange(next: readonly string[]): void }) {
  const all = providers.get().filter((entry) => entry.owner.scope === 'account');
  const rest = all.filter((entry) => !order.includes(entry.id));
  const move = (index: number, by: -1 | 1): void => { const next = [...order]; const [item] = next.splice(index, 1); if (item) next.splice(index + by, 0, item); onChange(next); };
  return <div className="flex flex-col gap-2">
    <ol aria-label="Team providers in fallback order" className="flex flex-col divide-y divide-border rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
      {order.map((id, index) => {
        const entry = all.find((candidate) => candidate.id === id);
        return entry ? <li key={id} data-order={index + 1} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1 text-body text-foreground">{entry.label} <span className="text-caption text-muted-foreground">· {entry.via}</span></span>
          <Button variant="ghost" size="icon-compact" aria-label={`Move ${entry.label} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-compact" aria-label={`Move ${entry.label} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
          <Button variant="ghost" size="compact" onClick={() => onChange(order.filter((candidate) => candidate !== id))}>Remove</Button>
        </li> : null;
      })}
      {order.length ? null : <li className="px-3 py-2 text-caption text-muted-foreground">No team providers yet.</li>}
    </ol>
    {rest.length ? <div className="flex flex-wrap items-center gap-2"><span className="text-caption text-muted-foreground">Add</span>{rest.map((entry) => <Button key={entry.id} variant="secondary" size="compact" leadingIcon={glyph(Plus)} onClick={() => onChange([...order, entry.id])}>{entry.label}</Button>)}</div> : null}
  </div>;
}

/** New inference profile: name, team providers in fallback order and holders' own kinds, a model per role, the projects
 * that use it and the budget it counts against, a review, then done. */
export function NewProfileFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState('');
  const [order, setOrder] = useState<readonly string[]>(['team-anthropic']);
  const [own, setOwn] = useState<ReadonlySet<string>>(new Set());
  const [models, setModels] = useState<Readonly<Record<string, string>>>({});
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set());
  const [budget, setBudget] = useState('none');
  const options = offered(order);
  const modelOf = (role: string): string => models[role] ?? suggest(role, options);
  const trimmed = name.trim();
  const nameError = !trimmed ? 'Give the profile a name' : trimmed.length > 160 ? 'Up to 160 characters' : profiles.get().some((profile) => profile.name.toLowerCase() === trimmed.toLowerCase()) ? `There’s a profile called ${trimmed} already` : null;
  const orderError = order.length ? null : 'Pick at least one team provider: turns in its projects need one to pay with when no holder’s own provider may.';
  const missing = ROLES.filter((role) => !options.includes(modelOf(role.role)));
  const steps = ['Name', 'Providers', 'Models', 'Projects and budget', 'Review'];
  const current = profiles.get();
  const now = (id: string): string => current.find((profile) => profile.id === projectSettings.get()[id]?.profile)?.name ?? '—';
  const errors = [step === 0 ? nameError : null, step === 1 ? orderError : null, step === 2 && missing.length ? `${missing.map((role) => role.role).join(', ')}: ${missing.length === 1 ? 'its model isn’t' : 'their models aren’t'} offered by this profile’s providers; pick another.` : null];
  const next = (): void => {
    if (errors[step]) { setTried(true); return; }
    setTried(false);
    if (step < 4) { setStep(step + 1); return; }
    const id = `p-${Date.now().toString(36)}`;
    const ownKinds = PERSONAL_KINDS.filter((kind) => own.has(kind));
    const profile: InferenceProfileMock = { id, name: trimmed, teamProviders: order, personal: ownKinds, services: { search: 'off', dictation: 'workers-ai', images: 'off', speech: 'off', decisions: 'workers-ai' },
      models: ROLES.map((role) => ({ role: role.role, model: modelOf(role.role), note: role.note })), advanced: [{ label: 'Compaction', value: 'At 80% of context' }, { label: 'Retries', value: '3, then the next credential in rotation' }] };
    profiles.set([...profiles.get(), profile]);
    if (projects.size) { const all = projectSettings.get(); projectSettings.set(Object.fromEntries(Object.entries(all).map(([project, settings]) => [project, projects.has(project) ? { ...settings, profile: id } : settings]))); }
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Created inference profile ${trimmed}${projects.size ? ` and applied it to ${listNames([...projects])}` : ''}` });
    say(`Created ${trimmed}`);
    setDone(true);
  };
  const budgetLabel = budget === 'none' ? 'None' : budgets.get().find((entry) => entry.id === budget)?.label ?? budget;
  return <FlowDialog id="new-profile" title={done ? `${trimmed} created` : 'Create inference profile'} steps={steps} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'A model for each role, the team providers that pay in order, which kinds of holders’ own providers may pay, and the projects that apply it.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setStep(step - 1); setTried(false); }} onCancel={onClose} next={next} nextLabel={step === 4 ? 'Create profile' : 'Continue'} />}>
    {done ? <FlowSuccess title={`${trimmed} is ready`}>{projects.size ? `${listNames([...projects])} ${projects.size === 1 ? 'uses' : 'use'} it from the next turn.` : 'No project uses it yet: apply it in a project’s settings › Inference.'} Edit its services and advanced settings from its Open button. In the audit log.</FlowSuccess> : null}
    {!done && step === 0 ? <>
      <InputGroup className="w-full"><InputField index={0} label="Profile name" placeholder="Profile name" value={name} onChange={setName} error={tried ? nameError ?? undefined : undefined} /></InputGroup>
      <Hint>For example “Field notes (cheap)” or “Prod work (Bedrock only)”. Projects and people see it by this name.</Hint>
    </> : null}
    {!done && step === 1 ? <>
      <Field label="Team providers, in fallback order"><ProviderOrder order={order} onChange={setOrder} /></Field>
      <Hint>A turn pays with the first one that’s available; when it’s rate-limited or out, the next.</Hint>
      <Field label="Holders’ own providers may pay"><ChipPicker label="Holders’ own providers" options={PERSONAL_KINDS.map((kind) => ({ id: kind, label: kind }))} picked={own} onChange={setOwn} /></Field>
      <Hint>{own.size ? `A holder’s own ${[...own].join(' or ')} pays for their turns first, in sticky rotation.` : 'None: every turn in its projects uses the team’s providers.'}</Hint>
      {tried && orderError ? <FlowError>{orderError}</FlowError> : null}
    </> : null}
    {!done && step === 2 ? <div className="flex flex-col divide-y divide-border rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
      {ROLES.map((role) => <div key={role.role} className="flex flex-wrap items-center gap-3 px-3 py-2">
        <span className="flex min-w-40 flex-1 flex-col"><span className="font-mono text-body text-foreground">{role.role}</span><span className="text-caption text-muted-foreground">{role.note}</span></span>
        <div className="w-72 max-w-full"><Select value={modelOf(role.role)} onValueChange={(value) => setModels({ ...models, [role.role]: value })}>
          <SelectTrigger aria-label={`Model for ${role.role}`} /><SelectContent>{[...new Set([...options, modelOf(role.role)])].map((model, index) => <SelectItem key={model} value={model} index={index}>{model}</SelectItem>)}</SelectContent>
        </Select></div>
      </div>)}
    </div> : null}
    {!done && step === 2 && tried && errors[2] ? <FlowError>{errors[2]}</FlowError> : null}
    {!done && step === 3 ? <>
      <Field label="Apply to projects"><ChipPicker label="Projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      <Hint>{projects.size ? [...projects].map((id) => `${projectName(id)} moves from ${now(id)}`).join(' · ') : 'None: apply it later in a project’s settings.'}</Hint>
      <UnseenProjects userId={viewer.id} />
      <Field label="Counts against budget"><Select value={budget} onValueChange={setBudget}><SelectTrigger aria-label="Budget" /><SelectContent>
        {[{ id: 'none', label: 'No budget of its own' }, ...budgets.get().map((entry) => ({ id: entry.id, label: `${entry.label} · ${money(entry.monthly)} a month` }))].map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.label}</SelectItem>)}
      </SelectContent></Select></Field>
      <Hint>Spend in its projects counts against the team budget and each project’s own either way; this links it on Usage.</Hint>
    </> : null}
    {!done && step === 4 ? <Summary rows={[['Name', trimmed], ['Team providers', order.map((id, index) => `${index + 1}. ${providers.get().find((entry) => entry.id === id)?.label ?? id}`).join('  ')], ['Holders’ own', [...own].join(', ') || 'None'],
      ['Models', <span key="m" className="font-mono text-caption">{ROLES.map((role) => `${role.role} ${modelOf(role.role)}`).join(' · ')}</span>], ['Projects', projects.size ? listNames([...projects]) : 'None yet'], ['Budget', budgetLabel]]} /> : null}
  </FlowDialog>;
}

/** Change the model of one role in a profile. */
export function ChangeModelFlow({ profile, role, onClose }: { profile: InferenceProfileMock; role: string; onClose(): void }) {
  const viewer = useViewer();
  const current = profile.models.find((entry) => entry.role === role)?.model ?? '';
  const options = [...new Set([...offered(profile.teamProviders), current])];
  const [value, setValue] = useState(current);
  const [done, setDone] = useState(false);
  return <FlowDialog id="change-model" title={done ? `${role} uses ${value}` : `Model for ${role}`} wide={false} done={done} onClose={onClose}
    description={done ? undefined : `${profile.name} · ${profile.models.find((entry) => entry.role === role)?.note ?? ''}. Models come from this profile’s team providers.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={value === current} onClick={() => {
      profiles.set(profiles.get().map((entry) => entry.id === profile.id ? { ...entry, models: entry.models.map((model) => model.role === role ? { ...model, model: value } : model) } : entry));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Set ${role} to ${value} in profile ${profile.name}` });
      setDone(true);
    }}>Save model</Button></>}>
    {done ? <FlowSuccess title={`${profile.name} · ${role} → ${value}`}>From the next turn in its projects. In the audit log.</FlowSuccess>
      : <ChoiceCards label="Model" value={value} onChange={setValue} choices={options.map((model) => ({ id: model, title: model, detail: model === current ? 'Current' : model.startsWith('ollama/') || model.startsWith('lmstudio/') ? 'Local model' : `Through ${model.split('/')[0]}`, icon: CpuChip01 }))} />}
  </FlowDialog>;
}

/** Take a team provider out of a profile: refused when it's the profile's last one. */
export function RemoveFromProfileFlow({ profile, entry, onClose }: { profile: InferenceProfileMock; entry: ModelCredential; onClose(): void }) {
  const viewer = useViewer();
  return <ConfirmFlow id="remove-from-profile" title={`Remove ${entry.label} from ${profile.name}?`} confirmLabel="Remove from profile" onClose={onClose}
    description={`Its projects stop paying with it from the next turn; ${entry.label} stays a team provider.`}
    refusal={profile.teamProviders.length === 1 ? `It’s ${profile.name}’s only team provider, so its projects would have nothing to pay with. Add another provider to the profile first.` : null}
    success={{ title: `${entry.label} left ${profile.name}`, body: 'In the audit log.' }}
    onConfirm={() => {
      profiles.set(profiles.get().map((candidate) => candidate.id === profile.id ? { ...candidate, teamProviders: candidate.teamProviders.filter((id) => id !== entry.id) } : candidate));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Removed ${entry.label} from profile ${profile.name}` });
    }} />;
}

/** Edit one advanced setting of a profile. */
export function AdvancedFlow({ profile, label, onClose }: { profile: InferenceProfileMock; label: string; onClose(): void }) {
  const viewer = useViewer();
  const current = profile.advanced.find((entry) => entry.label === label)?.value ?? '';
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return <FlowDialog id="advanced" title={done ? `${label} saved` : label} wide={false} done={done} onClose={onClose} description={done ? undefined : `${profile.name} profile · Advanced`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => {
      if (!value.trim()) { setError(`${label} needs a value`); return; }
      profiles.set(profiles.get().map((entry) => entry.id === profile.id ? { ...entry, advanced: entry.advanced.map((item) => item.label === label ? { ...item, value: value.trim() } : item) } : entry));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Set ${label} to “${value.trim()}” in profile ${profile.name}` });
      setDone(true);
    }}>Save</Button></>}>
    {done ? <FlowSuccess title={`${label}: ${value.trim()}`}>From the next turn in {profile.name}’s projects. In the audit log.</FlowSuccess>
      : <InputGroup className="w-full"><InputField index={0} label={label} value={value} onChange={(next) => { setValue(next); setError(null); }} error={error ?? undefined} /></InputGroup>}
  </FlowDialog>;
}

// ── Inference: budgets ────────────────────────────────────────────────────────────────────────────────────────────

/** Add or edit a budget (new, not in GitSpace yet): scope (team, a project, a person or bot), amount and period with an
 * alert level, what happens at the limit and who's told, a review, then done. */
export function BudgetFlow({ budget, onClose }: { budget: Budget | null; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const policy = budget ? budgetPolicies.get()[budget.id] : undefined;
  const [step, setStep] = useState(budget ? 1 : 0);
  const [done, setDone] = useState(false);
  const [tried, setTried] = useState(false);
  const [scope, setScope] = useState<Budget['scope']>(budget?.scope ?? 'project');
  const [target, setTarget] = useState(budget?.target ?? 'field-notes');
  const [period, setPeriod] = useState<BudgetPolicy['period']>(policy?.period ?? 'month');
  const [amount, setAmount] = useState(budget ? String(policy?.period === 'week' ? Math.round(budget.monthly * 12 / 52 * 100) / 100 : budget.monthly) : '');
  const [alertAt, setAlertAt] = useState(String(budget?.alertAt ?? 80));
  const [atLimit, setAtLimit] = useState<BudgetPolicy['atLimit']>(policy?.atLimit ?? 'warn');
  const [notify, setNotify] = useState<ReadonlySet<string>>(new Set(policy?.notify ?? ['owners', 'admins', 'leads']));
  const people = [...USERS, ...bots.get()];
  const targets = scope === 'team' ? [{ id: 'team', label: ACCOUNT_NAME }] : scope === 'project' ? projectOptions(viewer.id) : people.map((principal) => ({ id: principal.id, label: principal.kind === 'bot' ? `${principal.name} (bot)` : principal.name }));
  const targetId = targets.some((entry) => entry.id === target) ? target : targets[0]?.id ?? '';
  const label = scope === 'team' ? ACCOUNT_NAME : scope === 'project' ? projectName(targetId) : findPrincipal(targetId)?.name ?? targetId;
  const team = budgets.get().find((entry) => entry.scope === 'team' && entry.id !== budget?.id);
  const value = Number(amount.trim());
  const monthly = period === 'week' ? value * 52 / 12 : value;
  const exists = budgets.get().find((entry) => entry.scope === scope && entry.target === targetId && entry.id !== budget?.id);
  const scopeError = exists ? `${label} has a budget already (${money(exists.monthly)} a month): close this and edit that one.` : null;
  const amountError = !amount.trim() ? 'Enter an amount' : !/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? 'Dollars, like 250 or 250.50' : value <= 0 ? 'A budget must be more than $0' : value > 100000 ? 'Up to $100,000' : scope !== 'team' && team && monthly > team.monthly ? `More than the team’s whole budget (${money(team.monthly)} a month): raise the team budget first, or lower this one` : null;
  const alertError = !/^\d{1,3}$/.test(alertAt.trim()) || Number(alertAt) < 1 || Number(alertAt) > 100 ? 'A whole percentage from 1 to 100' : null;
  const notifyError = notify.size ? null : 'Pick at least one: a budget nobody hears about can’t help';
  const errors = [scopeError, amountError ?? alertError, notifyError, null];
  const covers = scope === 'team' ? 'inference, services and compute' : scope === 'project' ? `turns and compute in ${label}’s workspaces` : findPrincipal(targetId)?.kind === 'bot' ? 'turns it starts' : 'turns they start';
  const next = (): void => {
    if (errors[step]) { setTried(true); return; }
    setTried(false);
    if (step < 3) { setStep(step + 1); return; }
    const id = budget?.id ?? `b-${Date.now().toString(36)}`;
    const entry: Budget = { id, scope, target: targetId, label, monthly: Math.round(monthly * 100) / 100, alertAt: Number(alertAt), covers, spent: budget?.spent ?? 0 };
    budgets.set(budget ? budgets.get().map((candidate) => candidate.id === id ? entry : candidate) : [...budgets.get(), entry]);
    budgetPolicies.set({ ...budgetPolicies.get(), [id]: { period, atLimit, notify: [...notify] } });
    recordAudit({ actor: viewer.id, kind: 'setting', text: `${budget ? 'Changed' : 'Set'} the ${label} budget: ${money(value)} a ${period}, alert at ${alertAt}%, ${atLimit === 'stop' ? 'stops new turns' : 'alerts only'} at the limit` });
    say(`${label} budget saved`);
    setDone(true);
  };
  const notifyNames = NOTIFY_OPTIONS.filter((option) => notify.has(option.id)).map((option) => option.label).join(', ');
  return <FlowDialog id="budget" title={done ? `${label} budget saved` : budget ? `Edit the ${budget.label} budget` : 'Add a budget'} steps={['Scope', 'Amount', 'At the limit', 'Review']} step={step} done={done} onClose={onClose}
    description={done ? undefined : <span className="inline-flex flex-wrap items-center gap-1.5"><SmallPill>New · not in GitSpace yet</SmallPill>A limit on spend (inference, services and compute) for the team, a project or a person, with an alert before it.</span>}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={budget && step === 1 ? 0 : step} onBack={() => { setStep(step - 1); setTried(false); }} onCancel={onClose} next={next} nextLabel={step === 3 ? 'Save budget' : 'Continue'} />}>
    {done ? <FlowSuccess title={`${money(value)} a ${period} for ${label}`}>Usage shows it against spend. At {alertAt}% {notifyNames} {notify.size === 1 ? 'is' : 'are'} told; at the limit {atLimit === 'stop' ? 'new turns it covers wait until the period resets or someone raises it' : 'turns keep running'}. In the audit log.</FlowSuccess> : null}
    {!done && step === 0 ? <>
      <ChoiceCards label="Scope" columns={2} value={scope} onChange={(id) => { if (id === 'team' || id === 'project' || id === 'person') { setScope(id); setTried(false); } }} choices={[
        { id: 'team', title: 'The team', detail: 'Everything Crumb & Co spends' },
        { id: 'project', title: 'A project', detail: 'Turns and compute in its workspaces' },
        { id: 'person', title: 'A person or bot', detail: 'Turns they start, wherever they paid with the team’s providers' },
      ]} />
      {scope !== 'team' ? <Field label={scope === 'project' ? 'Project' : 'Person or bot'}><Select value={targetId} onValueChange={(next2) => { setTarget(next2); setTried(false); }}><SelectTrigger aria-label={scope === 'project' ? 'Project' : 'Person or bot'} />
        <SelectContent>{targets.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.label}</SelectItem>)}</SelectContent></Select></Field> : null}
      {tried && scopeError ? <FlowError>{scopeError}</FlowError> : null}
    </> : null}
    {!done && step === 1 ? <>
      <div className="flex flex-wrap items-end gap-2">
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Amount (USD)" value={amount} onChange={setAmount} placeholder="250" error={tried ? amountError ?? undefined : undefined} /></InputGroup>
        <div className="w-36"><Select value={period} onValueChange={(next2) => { if (next2 === 'month' || next2 === 'week') setPeriod(next2); }}><SelectTrigger aria-label="Period" /><SelectContent><SelectItem value="month" index={0}>a month</SelectItem><SelectItem value="week" index={1}>a week</SelectItem></SelectContent></Select></div>
      </div>
      <InputGroup className="w-full"><InputField index={1} label="Alert at (% of the budget)" value={alertAt} onChange={setAlertAt} error={tried ? alertError ?? undefined : undefined} /></InputGroup>
      <Hint>{team && scope !== 'team' ? `The team’s budget is ${money(team.monthly)} a month; this one counts inside it.` : 'Months start on the 1st; weeks on Monday.'}</Hint>
    </> : null}
    {!done && step === 2 ? <>
      <ChoiceCards label="At the limit" value={atLimit} onChange={(id) => { if (id === 'warn' || id === 'stop') setAtLimit(id); }} choices={[
        { id: 'warn', title: 'Alert only', detail: 'Turns keep running; the people below are told at the alert level and again at the limit.' },
        { id: 'stop', title: 'Stop new turns', detail: `New turns the team would pay for in ${label} wait; running ones finish. Holders’ own providers still pay where their profile allows. An Owner or Admin can raise it.` },
      ]} />
      <Field label="Who’s told"><ChipPicker label="Who’s told" options={NOTIFY_OPTIONS} picked={notify} onChange={setNotify} /></Field>
      {tried && notifyError ? <FlowError>{notifyError}</FlowError> : null}
    </> : null}
    {!done && step === 3 ? <Summary rows={[['Scope', scope === 'team' ? 'The team' : scope === 'project' ? `Project · ${label}` : `Person · ${label}`], ['Amount', `${money(value)} a ${period}${period === 'week' ? ` (≈ ${money(Math.round(monthly))} a month)` : ''}`], ['Alert', `At ${alertAt}%`], ['At the limit', atLimit === 'stop' ? 'Stop new turns' : 'Alert only'], ['Told', notifyNames], ['Covers', covers]]} /> : null}
  </FlowDialog>;
}

// ── Plugins ───────────────────────────────────────────────────────────────────────────────────────────────────────

function urlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return 'Enter the server’s URL';
  if (!/^[a-z]+:\/\/[^\s/]+/i.test(text)) return 'That isn’t a URL: it looks like https://mcp.example.com/mcp';
  if (!text.startsWith('https://')) return 'GitSpace calls MCP servers over HTTPS only: use an https:// URL';
  return null;
}
function unreachable(value: string): boolean {
  const host = /^https:\/\/([^/:]+)/.exec(value.trim())?.[1] ?? '';
  return host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan') || /^(10|127|192\.168)\./.test(host);
}

/** A custom MCP server's URL, checked: the format, then whether it answers from GitSpace's side. */
function ServerCheck({ url, onUrl, ok, onOk }: { url: string; onUrl(value: string): void; ok: boolean; onOk(value: boolean): void }) {
  const { busy, later } = useLater();
  const [error, setError] = useState<string | null>(null);
  const [down, setDown] = useState(false);
  const check = (): void => {
    const problem = urlProblem(url);
    setError(problem); setDown(false);
    if (problem) return;
    later('check', 1200, () => { if (unreachable(url)) setDown(true); else onOk(true); });
  };
  return <div className="flex flex-col gap-2">
    <div className="flex items-end gap-2">
      <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Server URL" value={url} onChange={(value) => { onUrl(value); onOk(false); setError(null); setDown(false); }} placeholder="https://mcp.example.com/mcp" error={error ?? undefined} /></InputGroup>
      <Button variant="secondary" loading={busy !== null} disabled={busy !== null} onClick={check}>Check server</Button>
    </div>
    {down ? <FlowError>The server didn’t answer: {url.trim()} timed out after 10 s. GitSpace calls it from Cloudflare’s network, not yours: put it behind a Cloudflare Tunnel or give it a public address, then check again.</FlowError> : null}
    {ok ? <p role="status" className="flex items-center gap-2 text-caption text-foreground"><Check width={14} height={14} className="text-[#079455]" />It answered: MCP 2025-06-18 · 12 tools · offers OAuth sign-in.</p> : null}
  </div>;
}

function teamAccounts(entry: CatalogEntry, viewer: User): readonly SignInAccount[] {
  const own = GITHUB_ACCOUNTS[viewer.id] ?? viewer.first.toLowerCase();
  switch (entry.id) {
    case 'github': return [{ id: 'org', label: 'crumb-co (organisation)', detail: 'Install on crumb-co · all repositories', problem: null }, { id: 'me', label: `${own} (your own account)`, detail: 'Personal account', problem: `That installs it on ${own}, your personal account: the team plugin would act as you and stop when you leave. Open the sign-in page again and pick the crumb-co organisation.` }];
    case 'linear': return [{ id: 'team', label: 'Crumb & Co workspace', detail: 'linear.app/crumbco · you’re an admin', problem: null }, { id: 'me', label: `${viewer.first}’s sandbox`, detail: 'Your own Linear workspace', problem: `That’s ${viewer.first}’s own Linear workspace. The team plugin needs the Crumb & Co workspace: open the sign-in page again and switch workspace at the top of Linear’s page.` }];
    case 'slack-app': return [{ id: 'team', label: 'crumbco.slack.com', detail: 'Crumb & Co · you can install apps', problem: null }, { id: 'other', label: 'bakers-guild.slack.com', detail: 'Bakers Guild', problem: 'That’s the Bakers Guild workspace. GitSpace for Slack belongs in crumbco.slack.com: switch workspace on Slack’s page and install again.' }];
    case 'hubspot': return [{ id: 'team', label: 'Crumb & Co (portal 4471020)', detail: 'Super admin', problem: null }, { id: 'test', label: 'Crumb & Co test portal', detail: 'Developer test account', problem: 'That’s HubSpot’s developer test portal, with no real customers. Pick the Crumb & Co portal (4471020).' }];
    default: return entry.tab === 'composio'
      ? [{ id: 'team', label: 'ops@crumbco.example', detail: 'The team’s service account', problem: null }, { id: 'me', label: viewer.email, detail: 'Your own account', problem: `That links ${viewer.email}, your own account: the team’s toolkit would see your mail and files and stop when you leave. Sign in as ops@crumbco.example.` }]
      : [{ id: 'team', label: 'gitspace-bot@crumbco.example', detail: 'The team’s service account', problem: null }, { id: 'me', label: viewer.email, detail: 'Yourself', problem: `That signs it in as you: when you leave or lose access it stops for the team. Sign in as the service account, gitspace-bot@crumbco.example.` }];
  }
}

/** Add a team plugin or connection: pick from the catalog (or a custom MCP URL), how it signs in (an OAuth app as the
 * team, an API token, no sign-in), which projects may use it, a review, then done. Composio toolkits need the team's
 * Composio account on. */
export function TeamPluginFlow({ tab, onClose }: { tab: 'composio' | 'mcp'; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const { busy, later } = useLater();
  const composioOn = teamComposio.use();
  const existing = plugins.use().filter((plugin) => plugin.owner.scope === 'account');
  const catalog = tab === 'composio' ? COMPOSIO_CATALOG : TEAM_CATALOG;
  const taken = (entry: CatalogEntry): string | null => {
    if (entry.id === 'slack-app' && existing.some((plugin) => plugin.id === 'slack-app')) return 'Installed in crumbco.slack.com by Theo on Nov 14: change its channels with Configure.';
    return entry.id !== 'custom' && existing.some((plugin) => plugin.name === entry.name) ? 'Connected already' : null;
  };
  const [pick, setPick] = useState(catalog.find((entry) => !taken(entry))?.id ?? '');
  const entry = catalog.find((candidate) => candidate.id === pick);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [auth, setAuth] = useState<TeamAuth>('oauth');
  const [url, setUrl] = useState('');
  const [serverOk, setServerOk] = useState(false);
  const [signedAs, setSignedAs] = useState<SignInAccount | null>(null);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenOk, setTokenOk] = useState(false);
  const [checks, setChecks] = useState(0);
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(['crumb']));
  const name = entry?.id === 'custom' ? (/^https:\/\/([^/:]+)/.exec(url.trim())?.[1] ?? 'Custom MCP server') : entry?.name ?? '';
  const modes = entry?.auth ?? [];
  const mode = modes.includes(auth) ? auth : modes[0] ?? 'oauth';
  const checkToken = (): void => {
    if (!entry) return;
    const text = token.trim();
    const problem = !text ? 'Paste the token' : entry.tokenPrefix && !entry.tokenPrefix.some((prefix) => text.startsWith(prefix)) ? `${entry.name} tokens start with ${entry.tokenPrefix.join(' or ')}: check you copied the whole token` : null;
    setTokenError(problem); setTokenOk(false);
    if (problem) return;
    later('token', 1100, () => {
      if (text.length < 24) { setTokenError(`${entry.name || 'The server'} rejected the token (401): it was revoked, expired or mistyped. Make a new one and paste it.`); return; }
      const last = entry.scopes?.at(-1);
      if (last && checks === 0) { setChecks(1); setTokenError(`The token is missing the ${last} scope, which ${entry.name} needs to ${last.startsWith('event') ? 'read errors' : last.startsWith('read:org') ? 'list the organisation’s repositories' : 'see the organisation'}. Edit the token’s permissions on ${entry.site}, add ${last}, then check again: the token stays the same.`); return; }
      setTokenOk(true);
    });
  };
  const signReady = entry?.id === 'custom' && !serverOk ? false : mode === 'oauth' ? signedAs !== null : mode === 'token' ? tokenOk : true;
  const blocked = tab === 'composio' && !composioOn;
  const next = (): void => {
    if (step < 3) { setStep(step + 1); return; }
    const id = `team-${pick}-${Date.now().toString(36)}`;
    const plugin: Plugin = { id, name, tab, owner: { scope: 'account' }, auth: tab === 'composio' ? 'Team Composio account' : mode === 'oauth' ? `Signed in as ${signedAs?.label ?? 'the team'}` : mode === 'token' ? 'Service token' : 'No sign-in',
      detail: entry?.id === 'custom' ? url.trim() : entry?.detail ?? '', status: 'connected', lastUsed: 'never', calls: 0 };
    plugins.set([...plugins.get(), plugin]);
    const all = projectSettings.get();
    projectSettings.set(Object.fromEntries(Object.entries(all).map(([project, settings]) => [project, projects.has(project) ? { ...settings, teamPlugins: [...settings.teamPlugins, id] } : settings])));
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Added team plugin ${name} (${plugin.auth})${projects.size ? ` · on in ${listNames([...projects])}` : ''}` });
    say(`${name} connected for the team`);
    setDone(true);
  };
  return <FlowDialog id="team-plugin" title={done ? `${name} is connected` : tab === 'composio' ? 'Connect a toolkit as the team' : 'Add a team plugin'} steps={['Pick', 'Sign-in', 'Projects', 'Review']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Set up once for the team; each project’s settings switch it on. Its tools act as the team, never as whoever holds the handle.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} nextLabel={step === 3 ? 'Connect' : 'Continue'}
      disabled={step === 0 ? !entry || Boolean(taken(entry)) || blocked : step === 1 ? !signReady : false} busy={busy !== null} />}>
    {done ? <FlowSuccess title={`${name} is on for the team`}>{projects.size ? `On in ${listNames([...projects])}: workspaces there get its tools at their next turn.` : 'On in no project yet.'} Other projects’ Leads switch it on in their settings › Plugins. In the audit log.</FlowSuccess> : null}
    {!done && step === 0 ? <>
      {blocked ? <div className="flex flex-col gap-2" data-composio-off="">
        <FlowError>The team’s Composio account is off, so no toolkit connects through it. Turn it on (Owners and Admins), then pick a toolkit.</FlowError>
        <div><Button variant="secondary" size="compact" onClick={() => { teamComposio.set(true); recordAudit({ actor: viewer.id, kind: 'setting', text: 'Turned on the team’s Composio account' }); }}>Turn on the team Composio account</Button></div>
      </div> : null}
      <ChoiceCards label="Plugin" columns={2} value={pick} onChange={setPick} choices={catalog.map((candidate) => ({ id: candidate.id, title: candidate.name, detail: candidate.detail, icon: candidate.id === 'custom' ? Code01 : tab === 'composio' ? PuzzlePiece01 : Link03, disabled: taken(candidate) }))} />
    </> : null}
    {!done && step === 1 && entry ? <>
      {entry.id === 'custom' ? <ServerCheck url={url} onUrl={setUrl} ok={serverOk} onOk={setServerOk} /> : null}
      {entry.id !== 'custom' || serverOk ? <>
        {modes.length > 1 ? <ChoiceCards label="How it signs in" value={mode} onChange={(id) => { if (id === 'oauth' || id === 'token' || id === 'none') { setAuth(id); setSignedAs(null); } }}
          choices={modes.map((candidate) => ({ id: candidate, title: TEAM_AUTH_LABEL[candidate], detail: candidate === 'oauth' ? `${entry.id === 'github' ? 'Install GitSpace for Crumb & Co on the organisation' : 'An admin signs in once, as the team'}; tokens refresh themselves` : candidate === 'token' ? 'A service account’s token, stored write-only in the team vault' : 'Anyone who can reach the URL can call it. Only for servers that are public by design.', icon: candidate === 'oauth' ? Link03 : candidate === 'token' ? Key01 : Lock01 }))} /> : null}
        {mode === 'oauth' ? <SignInStep site={entry.site || (/^https:\/\/([^/]+)/.exec(url.trim())?.[1] ?? 'the server')} url={entry.id === 'custom' ? `${url.trim().replace(/\/mcp$/, '')}/authorize?client_id=gitspace-crumbco` : entry.id === 'slack-app' ? 'https://slack.com/oauth/v2/authorize?client_id=gitspace' : `https://${entry.site}/oauth/authorize?client_id=gitspace-crumbco`}
          what={entry.id === 'slack-app' ? 'post in channels it’s invited to and answer @GitSpace' : `act for ${ACCOUNT_NAME}`} accounts={teamAccounts(entry, viewer)} signedAs={signedAs} onSignedIn={setSignedAs} /> : null}
        {mode === 'token' ? <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <InputGroup className="min-w-0 flex-1"><InputField index={1} label={`${entry.name || 'Server'} token`} type="password" autoComplete="off" value={token} onChange={(value) => { setToken(value); setTokenError(null); setTokenOk(false); }} placeholder={entry.tokenPrefix ? `${entry.tokenPrefix[0]}…` : 'Bearer token'} /></InputGroup>
            <Button variant="secondary" loading={busy === 'token'} disabled={busy !== null} onClick={checkToken}>{checks ? 'Check again' : 'Check token'}</Button>
          </div>
          {entry.scopes ? <Hint>Needs {entry.scopes.join(', ')}. Make it for a service account, not a person, so it survives people leaving.</Hint> : null}
          {tokenError ? <FlowError>{tokenError}</FlowError> : null}
          {tokenOk ? <p role="status" className="flex items-center gap-2 text-caption text-foreground"><Check width={14} height={14} className="text-[#079455]" />Token works{entry.scopes ? `: ${entry.scopes.join(', ')}` : ''}.</p> : null}
        </div> : null}
        {mode === 'none' ? <Hint>No credential is stored. GitSpace calls {url.trim()} from Cloudflare with no Authorization header.</Hint> : null}
      </> : null}
    </> : null}
    {!done && step === 2 ? <>
      <Field label="On in projects"><ChipPicker label="Projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      <UnseenProjects userId={viewer.id} />
      <Hint>{projects.size ? `${listNames([...projects])}: switched on in ${projects.size === 1 ? 'its' : 'their'} settings › Plugins, which ${projects.size === 1 ? 'its' : 'their'} Leads can change.` : 'None: it’s set up for the team but no project uses it until one switches it on.'}</Hint>
    </> : null}
    {!done && step === 3 ? <Summary rows={[['Plugin', name], ['Sign-in', tab === 'composio' ? `Composio link as ${signedAs?.label ?? 'the team'}` : mode === 'oauth' ? `OAuth as ${signedAs?.label ?? 'the team'}` : mode === 'token' ? 'Service token (write-only)' : 'None'], ['Projects', projects.size ? listNames([...projects]) : 'None yet'], ['Acts as', `${ACCOUNT_NAME}; actions read “${name} via GitSpace”`]]} /> : null}
  </FlowDialog>;
}

function personalAccounts(entry: CatalogEntry, viewer: User): readonly SignInAccount[] {
  const gmail = `${viewer.first.toLowerCase()}.${viewer.name.split(' ').at(-1)?.toLowerCase() ?? 'me'}@gmail.com`;
  if (entry.id === 'slack') return [{ id: 'work', label: `${viewer.email} · Crumb & Co`, detail: 'crumbco.slack.com', problem: null }, { id: 'other', label: `${gmail} · Bakers Guild`, detail: 'bakers-guild.slack.com', problem: 'That’s the Bakers Guild workspace. Plugins in Crumb & Co projects need your Crumb & Co Slack (crumbco.slack.com): switch workspace on Slack’s page and approve again.' }];
  if (entry.id === 'github') return [{ id: 'work', label: GITHUB_ACCOUNTS[viewer.id] ?? viewer.first.toLowerCase(), detail: 'Your GitHub account', problem: null }];
  if (entry.id === 'figma' || entry.id === 'custom') return [{ id: 'work', label: viewer.email, detail: 'Your work account', problem: null }];
  return [{ id: 'work', label: viewer.email, detail: 'Your work account', problem: null }, { id: 'personal', label: gmail, detail: 'Personal account', problem: `You signed in as ${gmail}, a personal account: its ${entry.name} isn’t Crumb & Co’s. Open the sign-in page again and pick ${viewer.email}.` }];
}

/** Your own plugin sign-in, or one made as a bot you manage (`principal`), or a reconnect: pick, sign in as the owner,
 * see where it joins workspaces, then done. */
export function PersonalPluginFlow({ tab, reconnect, principal, onClose }: { tab: 'composio' | 'mcp'; reconnect?: Plugin; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const who = principal ?? viewer;
  const bot = who.kind === 'bot';
  const mine = plugins.use().filter((plugin) => plugin.owner.scope === 'user' && plugin.owner.userId === who.id);
  const catalog = PERSONAL_CATALOG.filter((entry) => entry.tab === tab);
  const taken = (entry: CatalogEntry): string | null => entry.id !== 'custom' && mine.some((plugin) => plugin.name === entry.name && plugin.status === 'connected') ? 'Connected already' : null;
  const [pick, setPick] = useState(reconnect ? (catalog.find((entry) => entry.name === reconnect.name)?.id ?? 'custom') : catalog.find((entry) => !taken(entry))?.id ?? '');
  const entry = catalog.find((candidate) => candidate.id === pick);
  const [step, setStep] = useState(reconnect ? 1 : 0);
  const [done, setDone] = useState(false);
  const [url, setUrl] = useState('');
  const [serverOk, setServerOk] = useState(false);
  const [signedAs, setSignedAs] = useState<SignInAccount | null>(null);
  const reach = pluginReach(who.id);
  const accounts: readonly SignInAccount[] = bot ? [{ id: 'bot', label: `${who.id}@bots.crumbco.gitspace.sh`, detail: `${who.name}’s own account, made for it`, problem: null }] : entry ? personalAccounts(entry, viewer) : [];
  const name = reconnect?.name ?? (entry?.id === 'custom' ? (/^https:\/\/([^/:]+)/.exec(url.trim())?.[1] ?? 'MCP server') : entry?.name ?? '');
  const site = entry?.site || (/^https:\/\/([^/]+)/.exec(url.trim())?.[1] ?? 'the server');
  const next = (): void => {
    if (step < 2) { setStep(step + 1); return; }
    if (reconnect) plugins.set(plugins.get().map((plugin) => plugin.id === reconnect.id ? { ...plugin, status: 'connected' } : plugin));
    else plugins.set([...plugins.get(), { id: `${who.id}-${pick}-${Date.now().toString(36)}`, name, tab, owner: { scope: 'user', userId: who.id }, auth: tab === 'composio' ? 'Composio link' : `OAuth as ${who.first}`, detail: `${signedAs?.label ?? (bot ? who.id : viewer.email)} · ${entry?.detail ?? ''}`, status: 'connected', lastUsed: 'never', calls: 0 }]);
    if (bot) recordAudit({ actor: viewer.id, kind: 'bot', text: `${reconnect ? 'Reconnected' : 'Signed in to'} ${name} as ${who.name}` });
    say(`${name} ${reconnect ? 'reconnected' : 'connected'}`);
    setDone(true);
  };
  return <FlowDialog id="personal-plugin" title={done ? `${name} ${reconnect ? 'reconnected' : 'connected'}` : reconnect ? `Reconnect ${reconnect.name}` : tab === 'composio' ? 'Link a Composio toolkit' : 'Sign in to an MCP server'} steps={['Pick', 'Sign in', 'Where']} step={step} done={done} onClose={onClose}
    description={done ? undefined : reconnect ? `${reconnect.name}’s sign-in expired or was revoked on ${site}; sign in again to keep it.` : bot ? `A sign-in made as ${who.name}, with its own account. It joins turns ${who.first} starts, and nobody else’s.` : 'Your own sign-in. It joins a workspace only while you hold its handle, and leaves when you let go.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={reconnect && step === 1 ? 0 : step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} nextLabel={step === 2 ? (reconnect ? 'Reconnect' : 'Connect') : 'Continue'}
      disabled={step === 0 ? !entry || Boolean(taken(entry)) : step === 1 ? signedAs === null : false} />}>
    {done ? <FlowSuccess title={`${name} is ${bot ? `${who.first}’s` : 'yours'}${reconnect ? ' again' : ''}`}>{reach.on.length ? `Used while ${bot ? `${who.first} holds` : 'you hold'} the handle in ${listNames(reach.on)}.` : `No project ${bot ? `${who.first} is` : 'you’re'} in allows holders’ own plugins yet.`} Disconnect it here any time.</FlowSuccess> : null}
    {!done && step === 0 ? <ChoiceCards label="Plugin" columns={2} value={pick} onChange={setPick} choices={catalog.map((candidate) => ({ id: candidate.id, title: candidate.name, detail: candidate.detail, icon: candidate.id === 'custom' ? Code01 : tab === 'composio' ? PuzzlePiece01 : Link03, disabled: taken(candidate) }))} /> : null}
    {!done && step === 1 && entry ? <>
      {entry.id === 'custom' && !reconnect ? <ServerCheck url={url} onUrl={setUrl} ok={serverOk} onOk={setServerOk} /> : null}
      {entry.id !== 'custom' || serverOk || reconnect ? <SignInStep site={site} url={tab === 'composio' ? `https://connect.composio.dev/link/${entry.id}?user=${who.id}` : `https://${site}/oauth/authorize?client_id=gitspace&user=${who.id}`}
        what={`use ${entry.name === 'Custom MCP server' ? name : entry.name} as ${bot ? who.name : 'you'}`} accounts={accounts} signedAs={signedAs} onSignedIn={setSignedAs} /> : null}
    </> : null}
    {!done && step === 2 ? <>
      <ul className="flex flex-col gap-1 rounded-xl px-3 py-2.5 text-caption shadow-[inset_0_0_0_1px_var(--border)]" data-reach="">
        {reach.on.map((id) => <li key={id} className="flex items-center gap-2 text-foreground"><Check width={14} height={14} className="text-[#079455]" />{projectName(id)}: its settings allow holders’ own plugins</li>)}
        {reach.off.map((id) => <li key={id} className="text-muted-foreground">Not in {projectName(id)}: its settings don’t allow holders’ own plugins</li>)}
      </ul>
      <Rules items={bot ? [`Joins a workspace only while ${who.first} holds its handle`, `Its tools act as ${who.name}; co-holders’ turns don’t get it`, `Its sponsor, Owners and Admins can disconnect it`] : ['Joins a workspace only while you hold its handle', 'Its tools act as you; co-holders’ turns don’t get it', 'Leaves when you let go']} />
    </> : null}
  </FlowDialog>;
}

/** Turn the team's Composio account on or off. */
export function ComposioSwitchFlow({ on, onClose }: { on: boolean; onClose(): void }) {
  const viewer = useViewer();
  return <ConfirmFlow id="team-composio" title={on ? 'Turn off the team’s Composio account?' : 'Turn on the team’s Composio account?'} confirmLabel={on ? 'Turn off' : 'Turn on'} onClose={onClose}
    description={on ? 'Toolkits connected through it stop in every project at the next turn. Their links are kept for when it’s on again.' : 'crumbco on composio.dev. Owners and Admins can then connect toolkits as the team; each project’s settings switch them on.'}
    success={{ title: on ? 'The team’s Composio account is off' : 'The team’s Composio account is on', body: on ? 'In the audit log.' : 'Connect a toolkit as the team next. In the audit log.' }}
    onConfirm={() => { teamComposio.set(!on); recordAudit({ actor: viewer.id, kind: 'setting', text: `Turned ${on ? 'off' : 'on'} the team’s Composio account` }); }} />;
}

/** Configure a team plugin: replace its service token and choose the projects it's on in. */
export function ConfigurePluginFlow({ plugin, onClose }: { plugin: Plugin; onClose(): void }) {
  const viewer = useViewer();
  const { busy, later } = useLater();
  const settings = projectSettings.get();
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(Object.entries(settings).filter(([, entry]) => entry.teamPlugins.includes(plugin.id)).map(([id]) => id)));
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = (): void => {
    const text = token.trim();
    if (text && text.length < 24) { setError('The server rejected that token (401): it’s too short to be a whole token. Paste all of it, or leave this empty to keep the current one.'); return; }
    later('save', text ? 1000 : 200, () => {
      const all = projectSettings.get();
      projectSettings.set(Object.fromEntries(Object.entries(all).map(([id, entry]) => {
        if (!visibleProjects(viewer.id).has(id)) return [id, entry];
        const rest = entry.teamPlugins.filter((candidate) => candidate !== plugin.id);
        return [id, { ...entry, teamPlugins: projects.has(id) ? [...rest, plugin.id] : rest }];
      })));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Configured team plugin ${plugin.name}${text ? ' · replaced its service token' : ''} · on in ${listNames([...projects]) || 'no project'}` });
      setDone(true);
    });
  };
  return <FlowDialog id="configure-plugin" title={done ? `${plugin.name} saved` : `Configure ${plugin.name}`} wide={false} done={done} onClose={onClose} description={done ? undefined : `${plugin.detail} · ${plugin.auth}`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" disabled={busy !== null} onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy !== null} disabled={busy !== null} onClick={save}>Save</Button></>}>
    {done ? <FlowSuccess title={`${plugin.name}: on in ${listNames([...projects]) || 'no project'}`}>Workspaces pick up the change at their next turn. In the audit log.</FlowSuccess> : <>
      <InputGroup className="w-full"><InputField index={0} label="Replace service token (optional)" type="password" autoComplete="off" value={token} onChange={(value) => { setToken(value); setError(null); }} placeholder="Leave empty to keep the current token" error={error ?? undefined} /></InputGroup>
      <Field label="On in projects"><ChipPicker label="Projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      <UnseenProjects userId={viewer.id} />
    </>}
  </FlowDialog>;
}

const SLACK_MEMBER_OF = ['#general', '#design', '#kitchen-dev', '#releases', '#ledger', '#ops'];
/** The Slack app's channels: which projects post to each, add a channel (GitSpace must be in it) or remove one. */
export function SlackAppFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const [channels, setChannels] = useState(slackChannels.get());
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const options = projectOptions(viewer.id);
  const add = (): void => {
    const text = adding.trim().startsWith('#') ? adding.trim() : `#${adding.trim()}`;
    if (!/^#[a-z0-9][a-z0-9_-]{0,79}$/.test(text)) { setError('Slack channel names are lowercase letters, numbers, - and _, like #kitchen-dev'); return; }
    if (channels.some((channel) => channel.name === text)) { setError(`${text} is listed already`); return; }
    if (!SLACK_MEMBER_OF.includes(text)) { setError(`GitSpace isn’t in ${text}: in Slack, open ${text} and type /invite @GitSpace, then add it again. Private channels need the invite too.`); return; }
    setChannels([...channels, { name: text, projects: [], posts: 'Phase moves and questions waiting on someone' }]); setAdding(''); setError(null);
  };
  return <FlowDialog id="slack-app" title={done ? 'Slack channels saved' : 'GitSpace for Slack'} done={done} onClose={onClose}
    description={done ? undefined : 'Installed once for the team in crumbco.slack.com by Theo on Nov 14. Each channel gets posts from the projects ticked; anyone in it can ask @GitSpace.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => {
      slackChannels.set(channels);
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Changed the Slack app’s channels: ${channels.map((channel) => channel.name).join(', ')}` });
      setDone(true);
    }}>Save channels</Button></>}>
    {done ? <FlowSuccess title={channels.map((channel) => channel.name).join(', ')}>Posts follow the projects ticked for each channel. In the audit log.</FlowSuccess> : <>
      <div className="flex flex-col divide-y divide-border rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
        {channels.map((channel) => <div key={channel.name} data-channel={channel.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
          <span className="flex min-w-40 flex-1 flex-col"><span className="font-mono text-body text-foreground">{channel.name}</span><span className="text-caption text-muted-foreground">{channel.posts}</span></span>
          <div className="flex flex-wrap items-center gap-2">
            <ChipPicker label={`Projects posting to ${channel.name}`} options={options} picked={new Set(channel.projects)} onChange={(next) => setChannels(channels.map((candidate) => candidate.name === channel.name ? { ...candidate, projects: [...next] } : candidate))} />
            <Button variant="ghost" size="compact" aria-label={`Remove ${channel.name}`} onClick={() => setChannels(channels.filter((candidate) => candidate.name !== channel.name))}>Remove</Button>
          </div>
        </div>)}
      </div>
      <div className="flex items-end gap-2">
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Add a channel" value={adding} onChange={(value) => { setAdding(value); setError(null); }} placeholder="#design" error={error ?? undefined} /></InputGroup>
        <Button variant="secondary" leadingIcon={glyph(Plus)} onClick={add}>Add</Button>
      </div>
      <Hint>@GitSpace answers in any channel it’s in: “what’s waiting on me?”, “status of slot-holds”. It only says what the asker could see in GitSpace.</Hint>
    </>}
  </FlowDialog>;
}

/** Disconnect a team plugin from every project. */
export function DisconnectTeamPluginFlow({ plugin, onClose }: { plugin: Plugin; onClose(): void }) {
  const viewer = useViewer();
  const on = Object.entries(projectSettings.get()).filter(([, entry]) => entry.teamPlugins.includes(plugin.id)).map(([id]) => id);
  return <ConfirmFlow id="disconnect-team-plugin" title={`Disconnect ${plugin.name}?`} confirmLabel="Disconnect" onClose={onClose}
    description={`${on.length ? `It’s on in ${listNames(on)}; workspaces there lose its tools at their next turn.` : 'No project uses it.'} ${plugin.id === 'slack-app' ? 'GitSpace leaves crumbco.slack.com; installing it again takes an Admin.' : 'Its token is deleted from the team vault.'}`}
    success={{ title: `${plugin.name} disconnected`, body: 'In the audit log.' }}
    onConfirm={() => {
      plugins.set(plugins.get().filter((candidate) => candidate.id !== plugin.id));
      const all = projectSettings.get();
      projectSettings.set(Object.fromEntries(Object.entries(all).map(([id, entry]) => [id, { ...entry, teamPlugins: entry.teamPlugins.filter((candidate) => candidate !== plugin.id) }])));
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Disconnected team plugin ${plugin.name}${on.length ? ` from ${listNames(on)}` : ''}` });
    }} />;
}

// ── Browsers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const PAIR_MS = 5 * 60 * 1000;
const FINGERPRINT = 'A1F3 9C2E 7B40 D58A';
function clock(ms: number): string { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

/** Pair a Chrome, as account-web's PairChromeDialog: install the extension, type the pairing code into its popup (it
 * expires after five minutes), check the fingerprint it reports, then name it and approve it for projects. */
export function PairChromeFlow({ team, onClose }: { team: boolean; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const { busy, later } = useLater();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [code, setCode] = useState<{ value: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [typed, setTyped] = useState('');
  const [popupError, setPopupError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(['crumb']));
  const live = code !== null && now < code.expiresAt;
  useEffect(() => {
    if (!code || step !== 1) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [code, step]);
  const newCode = (): void => { setNow(Date.now()); setCode({ value: code?.value === 'K7P2QX' ? 'M4R8TZ' : 'K7P2QX', expiresAt: Date.now() + PAIR_MS }); setTyped(''); setPopupError(null); setMismatch(false); };
  const pair = (): void => {
    if (!code) return;
    if (Date.now() >= code.expiresAt) { setNow(Date.now()); setPopupError('This code expired. Get a new code in GitSpace.'); return; }
    if (typed.replace(/[-\s]/g, '').toUpperCase() !== code.value) { setPopupError('That code didn’t match. Check it and try again; after 5 wrong tries the code stops working.'); return; }
    setPopupError(null);
    later('answer', 900, () => setStep(2));
  };
  const finish = (): void => {
    const trimmed = name.trim();
    const problem = !trimmed ? 'Name it so you can tell your Chromes apart' : browsers.get().some((entry) => entry.label === trimmed) ? `There’s a Chrome called ${trimmed} already` : null;
    setNameError(problem);
    if (problem) return;
    const entry: Browser = { id: `chrome-${Date.now().toString(36)}`, label: trimmed, detail: 'Chrome 142 · macOS · extension 5.9.0', owner: team ? { scope: 'account' } : { scope: 'user', userId: viewer.id }, online: true, projects: [...projects], lastUsed: 'never' };
    browsers.set([...browsers.get(), entry]);
    if (team) recordAudit({ actor: viewer.id, kind: 'resource', text: `Paired team Chrome ${trimmed}${projects.size ? ` · approved in ${listNames([...projects])}` : ''}` });
    say(`${trimmed} paired`);
    setDone(true);
  };
  const steps = ['Install', 'Pairing code', 'Check it’s your Chrome', 'Name and projects'];
  return <FlowDialog id="pair-chrome" title={done ? `${name.trim()} is paired` : team ? 'Pair a Chrome for the team' : 'Pair a Chrome'} steps={steps} step={step} done={done} onClose={onClose}
    description={done ? undefined : `One pass from install to an agent-ready Chrome. Nothing is usable until you confirm the fingerprint.${team ? ' A team Chrome is signed in to the team’s sites; every approved project’s agents can use it.' : ''}`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      {step === 0 ? <Button variant="primary" onClick={() => setStep(1)}>It’s installed</Button> : null}
      {step === 3 ? <Button variant="primary" onClick={finish}>Finish</Button> : null}
    </>}>
    {done ? <FlowSuccess title={`${name.trim()} is ready`}>{projects.size ? `Approved in ${listNames([...projects])}. ` : 'Approved in no project yet. '}{team ? 'Agents there use it in a tab group of their own.' : 'Agents use it only in workspaces you hold, in a tab group of their own.'} Unpair it here any time.</FlowSuccess> : null}
    {!done && step === 0 ? <>
      <p className="text-caption text-muted-foreground">On the computer with that Chrome, run this. It puts the extension in the gitspace/chrome-extension folder in your home folder and shows it to you. Then in Chrome: ⋮ menu, Extensions, Manage Extensions, turn on Developer mode, Load unpacked, and choose that folder.</p>
      <InputCopy value="gitspace browser install" label="Install command" />
      <InputCopy value="chrome://extensions" label="Chrome’s extensions page" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="compact" leadingIcon={glyph(Download01)} onClick={() => setDownloaded(true)}>{downloaded ? 'Downloaded gitspace-chrome-5.9.0.zip' : 'Download extension'}</Button>
        <span className="text-caption text-muted-foreground">Elsewhere, download it, unzip it and load that folder the same way. A download is not kept up to date.</span>
      </div>
    </> : null}
    {!done && step === 1 ? <>
      {code ? <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-label="Pairing code" data-pairing-code={live ? 'live' : 'expired'} className={`font-mono text-title font-semibold tracking-[0.2em] ${live ? 'text-foreground' : 'text-muted-foreground line-through'}`}>{code.value.slice(0, 3)}-{code.value.slice(3)}</span>
          <span className="text-caption tabular-nums text-muted-foreground">{live ? `expires in ${clock(code.expiresAt - now)}` : 'expired'}</span>
          {live ? null : <Button variant="secondary" size="compact" onClick={newCode}>Get a new code</Button>}
        </div>
        <p className="text-caption text-muted-foreground">In Chrome, open the GitSpace extension, then Identity &amp; pairing. The code works once.</p>
        {live ? <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="blue" pulse />Waiting for a Chrome to answer…</p> : <FlowError>The code expired before a Chrome answered. Get a new code and type it into the extension within 5 minutes.</FlowError>}
      </div> : <div><Button variant="primary" onClick={newCode}>Get pairing code</Button></div>}
      {code ? <ProviderTab url="chrome-extension://gitspace/popup.html" heading="GitSpace extension · Identity & pairing">
        <div className="flex items-end gap-2">
          <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Pairing code" value={typed} onChange={(value) => { setTyped(value); setPopupError(null); }} placeholder="ABC-123" /></InputGroup>
          <Button variant="primary" size="compact" loading={busy === 'answer'} disabled={busy !== null} onClick={pair}>Pair</Button>
        </div>
        {popupError ? <FlowError>{popupError}</FlowError> : null}
      </ProviderTab> : null}
    </> : null}
    {!done && step === 2 ? <>
      {mismatch ? <><FlowError>Unpaired. GitSpace forgot that Chrome, so it can’t be used. If someone else typed the code, they got nothing. Start again with a new code.</FlowError>
        <div><Button variant="secondary" onClick={() => { setStep(1); newCode(); }}>Start again</Button></div></> : <>
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-body text-foreground">A Chrome answered. Its popup should show <span className="font-mono font-semibold">{FINGERPRINT}</span></span>
          <Button variant="primary" size="compact" onClick={() => { setName(team ? 'Shop counter Chrome' : `${viewer.first}’s work Chrome`); setStep(3); }}>It matches</Button>
          <Button variant="ghost" size="compact" onClick={() => setMismatch(true)}>It doesn’t match</Button>
        </div>
        <ProviderTab url="chrome-extension://gitspace/popup.html" heading="GitSpace extension · Paired, waiting for confirmation"><span className="font-mono text-title font-semibold tracking-[0.1em] text-foreground">{FINGERPRINT}</span></ProviderTab>
      </>}
    </> : null}
    {!done && step === 3 ? <>
      <InputGroup className="w-full"><InputField index={0} label="Name this Chrome" value={name} onChange={(value) => { setName(value); setNameError(null); }} placeholder="For example, Work Chrome" error={nameError ?? undefined} /></InputGroup>
      <Field label="Approve for projects"><ChipPicker label="Approve for projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      {team ? <UnseenProjects userId={viewer.id} /> : <Hint>Agents use it only in workspaces you hold in these projects, and only where the project’s settings allow holders’ own plugins.</Hint>}
    </> : null}
  </FlowDialog>;
}

/** Which projects a team browser is approved in. */
export function BrowserProjectsFlow({ browser, onClose }: { browser: Browser; onClose(): void }) {
  const viewer = useViewer();
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(browser.projects));
  const [done, setDone] = useState(false);
  return <FlowDialog id="browser-projects" title={done ? `${browser.label} saved` : `${browser.label} · projects`} wide={false} done={done} onClose={onClose} description={done ? undefined : browser.detail}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => {
      const unseen = browser.projects.filter((id) => !visibleProjects(viewer.id).has(id));
      const next = [...unseen, ...projects];
      browsers.set(browsers.get().map((entry) => entry.id === browser.id ? { ...entry, projects: next } : entry));
      recordAudit({ actor: viewer.id, kind: 'resource', text: `Approved ${browser.label} in ${listNames(next) || 'no project'}` });
      setDone(true);
    }}>Save</Button></>}>
    {done ? <FlowSuccess title={`Approved in ${listNames([...projects]) || 'no project'}`}>Agents in other projects stop using it at their next turn. In the audit log.</FlowSuccess> : <>
      <Field label="Approved in"><ChipPicker label="Approved in" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      <UnseenProjects userId={viewer.id} />
    </>}
  </FlowDialog>;
}

/** Unpair a team browser. */
export function UnpairTeamBrowserFlow({ browser, onClose }: { browser: Browser; onClose(): void }) {
  const viewer = useViewer();
  return <ConfirmFlow id="unpair-browser" title={`Unpair ${browser.label}?`} confirmLabel="Unpair" onClose={onClose}
    description={`Agents in ${listNames(browser.projects) || 'every project'} stop using it; tabs in their groups close. Using it again means pairing it again.`}
    success={{ title: `${browser.label} unpaired`, body: 'In the audit log.' }}
    onConfirm={() => { browsers.set(browsers.get().filter((entry) => entry.id !== browser.id)); recordAudit({ actor: viewer.id, kind: 'resource', text: `Unpaired team Chrome ${browser.label}` }); }} />;
}

// ── My own secrets ────────────────────────────────────────────────────────────────────────────────────────────────

const OWN_SECRET_ICON: Readonly<Record<OwnSecretKind['id'], typeof Database01>> = { db: Database01, stripe: CreditCard02, appstore: Phone01, aws: Cloud01 };

/** Add one of my own secrets: what it unlocks, the secret or sign-in (checked), its rule (only me, only while holding,
 * in a cleared shell for N minutes after my passkey), my passkey, then done. */
export function AddOwnSecretFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const { busy, later } = useLater();
  const mine = secrets.use().filter((entry) => entry.scope === viewer.id);
  const has = (kind: OwnSecretKind): string | null => mine.some((entry) => entry.name === kind.env) ? 'You have it already' : null;
  const [kindId, setKindId] = useState<OwnSecretKind['id']>(OWN_SECRET_KINDS.find((kind) => !has(kind))?.id ?? 'db');
  const kind = OWN_SECRET_KINDS.find((entry) => entry.id === kindId) ?? OWN_SECRET_KINDS[0];
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [secret, setSecret] = useState('');
  const [issuer, setIssuer] = useState('');
  const [keyId, setKeyId] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const [signedAs, setSignedAs] = useState<SignInAccount | null>(null);
  const [minutes, setMinutes] = useState<string>('30');
  const [scope, setScope] = useState('');
  const [env, setEnv] = useState('');
  const [policyError, setPolicyError] = useState<string | null>(null);
  if (!kind) return null;
  const reset = (): void => { setFieldError(null); setFailure(null); setVerified(null); };
  const check = (): void => {
    reset();
    const text = secret.trim();
    if (kind.id === 'db') {
      const match = /^postgres(?:ql)?:\/\/([^:@\s/]+):([^@\s]+)@([\w.-]+)(?::\d+)?\/(\w+)/.exec(text);
      if (!match) { setFieldError('A connection string looks like postgres://user:password@host:5432/database'); return; }
      later('check', 1200, () => {
        const user = match[1] ?? '';
        if ((match[2] ?? '').length < 8) { setFailure(`Couldn’t connect: password authentication failed for user “${user}”. Copy the password again from your password manager; it’s case-sensitive.`); return; }
        if (!/read|ro\b|_ro/.test(user)) { setFailure(`Connected, but the role ${user} can write. Your own production database secret is read only: use a role with SELECT only (for example crumb_readonly), or ask an Owner to make one.`); return; }
        setVerified(`Connected as ${user} · SELECT only · 42 tables on ${match[3]}`);
      });
      return;
    }
    if (kind.id === 'stripe') {
      if (text.startsWith(STRIPE_SECRET_LIVE)) { setFieldError('That’s a full secret key: it can do anything in live mode. Make a restricted key at dashboard.stripe.com › Developers › API keys with only Charges: Read and Refunds: Read, and paste that.'); return; }
      if (text.startsWith('rk_test_') || text.startsWith('sk_test_')) { setFieldError(`That’s a test-mode key; this secret is for live mode (${STRIPE_RESTRICTED_LIVE}…). Test keys belong in project secrets.`); return; }
      if (!text.startsWith(STRIPE_RESTRICTED_LIVE)) { setFieldError(`A restricted live key starts with ${STRIPE_RESTRICTED_LIVE}`); return; }
      later('check', 1100, () => { if (text.length < 30) { setFailure('Stripe rejected the key: Invalid API Key provided. Copy it again; Stripe shows a restricted key in full only once, so you may need to roll it.'); return; } setVerified('Stripe accepted it · live mode · Charges: Read, Refunds: Read'); });
      return;
    }
    if (kind.id === 'appstore') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer.trim())) { setFieldError('The Issuer ID is a UUID, shown above the keys list in App Store Connect › Users and Access › Integrations'); return; }
      if (!/^[A-Z0-9]{10}$/.test(keyId.trim())) { setFieldError('A Key ID is 10 capital letters and digits, like 2X9R4HXF34'); return; }
      if (!text.includes(`BEGIN ${PEM_PRIVATE_KEY}`) || !text.includes(`END ${PEM_PRIVATE_KEY}`)) { setFieldError(`Paste the whole .p8 file, from ${PEM_BEGIN} to ${PEM_END}`); return; }
      later('check', 1200, () => setVerified('Apple accepted it · role App Manager · Crumb iOS'));
    }
  };
  const ready1 = kind.id === 'aws' ? signedAs !== null : verified !== null;
  const next = (): void => {
    if (step === 0) { setScope(kind.scope); setEnv(kind.env); setStep(1); return; }
    if (step === 1) { setStep(2); return; }
    if (step === 2) {
      const count = Number(minutes);
      const problem = !scope.trim() ? 'Say what it unlocks; your co-holders and the audit log see this'
        : !/^[A-Z][A-Z0-9_]*$/.test(env.trim()) ? 'A name is capitals, digits and _, like PROD_DATABASE_URL'
        : mine.some((entry) => entry.name === env.trim()) ? `You have ${env.trim()} already: rotate it from its row`
        : !/^\d+$/.test(minutes.trim()) || count < 1 || count > 60 ? 'Between 1 and 60 minutes: for longer, ask for an approved script instead' : null;
      setPolicyError(problem);
      if (!problem) setStep(3);
      return;
    }
    passkey.confirm(() => {
      const name = env.trim();
      secrets.set([...secrets.get(), { id: `own-${Date.now().toString(36)}`, name, scope: viewer.id, kind: kind.id === 'aws' ? 'session' : 'token', detail: `${kind.name} · ${scope.trim()}`, site: kind.target, signIn: kind.id === 'aws', sensitive: true, expires: null, updated: 'just now', lastUsed: 'never' }]);
      secretRules.set({ ...secretRules.get(), [`${viewer.id}:${name}`]: { accountRoles: [], projectRoles: [], whileHolding: true, delivery: { kind: 'shell', minutes: Number(minutes) }, shellForbidden: false } });
      recordAudit({ actor: viewer.id, kind: 'resource', text: `Added their own secret ${name} (${scope.trim()}): cleared shell for ${minutes} min with a passkey · confirmed with ${passkeyLabel(viewer.id)}` });
      say(`${name} added`);
      setDone(true);
    });
  };
  return <FlowDialog id="add-own-secret" title={done ? `${env.trim()} added` : 'Add one of my own secrets'} steps={['What it unlocks', kind.id === 'aws' ? 'Sign in' : 'Secret', 'Rule', 'Passkey']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Yours alone. It opens in a cleared shell for a set time after your passkey, in a workspace you hold, for your own turns only. The team’s and each project’s secrets are in their settings.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setStep(step - 1); reset(); }} onCancel={onClose} next={next} busy={busy !== null || passkey.waiting}
      disabled={step === 0 ? Boolean(has(kind)) : step === 1 ? !ready1 : false} nextLabel={step === 3 ? 'Save with passkey' : 'Continue'} />}>
    {done ? <FlowSuccess title={`Only you · only while holding · in a cleared shell for ${minutes} min with a passkey`}>Open its cleared shell with Step up on My secrets or in a workspace you hold. It never opens by itself, and nobody else’s turns get it. In the audit log.</FlowSuccess> : null}
    {!done && step === 0 ? <ChoiceCards label="What it unlocks" columns={2} value={kindId} onChange={(id) => { const found = OWN_SECRET_KINDS.find((entry) => entry.id === id); if (found) { setKindId(found.id); setSecret(''); reset(); setSignedAs(null); } }}
      choices={OWN_SECRET_KINDS.map((entry) => ({ id: entry.id, title: entry.name, detail: `${entry.target} · ${entry.detail}`, icon: OWN_SECRET_ICON[entry.id], disabled: has(entry) }))} /> : null}
    {!done && step === 1 ? <>
      {kind.id === 'aws' ? <SignInStep site="crumbco.awsapps.com" url="https://crumbco.awsapps.com/start/#/device" code="WDJB-MJHT" what="use your AWS SSO session" signedAs={signedAs} onSignedIn={setSignedAs}
        accounts={[{ id: 'ro', label: `${viewer.first.toLowerCase()} · crumb-prod · ReadOnlyAccess`, detail: 'Permission set ReadOnlyAccess', problem: null },
          { id: 'admin', label: `${viewer.first.toLowerCase()} · crumb-prod · AdministratorAccess`, detail: 'Permission set AdministratorAccess', problem: 'AdministratorAccess is more than your own secret should carry, even in a cleared shell: an agent could change production. Open the sign-in page again and pick the ReadOnlyAccess permission set.' }]} /> : <>
        {kind.id === 'appstore' ? <>
          <InputGroup className="w-full"><InputField index={0} label="Issuer ID" value={issuer} onChange={(value) => { setIssuer(value); reset(); }} placeholder="69a6de7e-…" /></InputGroup>
          <InputGroup className="w-full"><InputField index={1} label="Key ID" value={keyId} onChange={(value) => { setKeyId(value); reset(); }} placeholder="2X9R4HXF34" /></InputGroup>
          <TextArea label="Private key (.p8)" mono rows={5} value={secret} onChange={(value) => { setSecret(value); reset(); }} placeholder={`${PEM_BEGIN}\n…\n${PEM_END}`} />
        </> : <InputGroup className="w-full"><InputField index={0} label={kind.id === 'db' ? 'Connection string' : 'Restricted key'} type="password" autoComplete="off" value={secret} onChange={(value) => { setSecret(value); reset(); }} placeholder={kind.id === 'db' ? 'postgres://crumb_readonly:…@replica.crumb-prod.internal:5432/crumb' : `${STRIPE_RESTRICTED_LIVE}…`} /></InputGroup>}
        {fieldError ? <FlowError>{fieldError}</FlowError> : null}
        <div><Button variant="secondary" loading={busy === 'check'} disabled={busy !== null} onClick={check}>{kind.id === 'db' ? 'Test connection' : kind.id === 'stripe' ? 'Check with Stripe' : 'Check with Apple'}</Button></div>
        {failure ? <FlowError>{failure}</FlowError> : null}
        {verified ? <p role="status" className="flex items-center gap-2 text-caption text-foreground"><Check width={14} height={14} className="text-[#079455]" />{verified}</p> : null}
        <Hint>Stored write-only, encrypted to you. Nobody sees it again, you included; an Owner or Admin can only drop it.</Hint>
      </>}
    </> : null}
    {!done && step === 2 ? <>
      <InputGroup className="w-full"><InputField index={2} label="Minutes in a cleared shell after each passkey (1–60)" inputMode="numeric" value={minutes} onChange={(value) => { setMinutes(value); setPolicyError(null); }} /></InputGroup>
      <InputGroup className="w-full"><InputField index={0} label="What it unlocks (shown to co-holders and in the audit log)" value={scope} onChange={(value) => { setScope(value); setPolicyError(null); }} /></InputGroup>
      <InputGroup className="w-full"><InputField index={1} label="Name agents and approved scripts ask for it by" value={env} onChange={(value) => { setEnv(value); setPolicyError(null); }} /></InputGroup>
      {policyError ? <FlowError>{policyError}</FlowError> : null}
      <Rules items={['Only you: never a co-holder’s turns, even while you hold together', 'Only while you hold the workspace its shell opens in; letting go closes the shell', 'In a cleared shell: a fresh shell with only this secret added, closed when the time runs out or you Drop it', 'Each opening asks your passkey and is in the audit log']} />
    </> : null}
    {!done && step === 3 ? <>
      <Summary rows={[['Name', env.trim()], ['What', kind.name], ['For', kind.target], ['Unlocks', scope.trim()], ['Rule', `Only you · only while holding · in a cleared shell for ${minutes} min with a passkey`]]} />
      <PasskeyStep userId={viewer.id} what={`saving ${kind.name}`} waiting={passkey.waiting} />
    </> : null}
  </FlowDialog>;
}

// ── Skills ────────────────────────────────────────────────────────────────────────────────────────────────────────

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function skillBody(name: string, description: string): string { return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n1. …\n`; }

/** A new skill, for the team, yourself or a bot you manage (`principal`): write it, import it from a repository, or
 * paste a SKILL.md; its name, description and instructions; where it applies; then done. */
export function SkillFlow({ team, principal, onClose }: { team: boolean; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const who = principal ?? viewer;
  const bot = who.kind === 'bot';
  const { say } = useMock();
  const { busy, later } = useLater();
  const [how, setHow] = useState<'write' | 'import' | 'paste'>('write');
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [tried, setTried] = useState(false);
  const [path, setPath] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(['crumb']));
  const trimmed = name.trim();
  const nameError = !trimmed ? 'Name it' : !SKILL_NAME.test(trimmed) ? 'Lowercase words joined by -, like release-checklist' : trimmed.length > 64 ? 'Up to 64 characters' : skills.get().some((skill) => skill.name === trimmed && (team ? skill.owner.scope === 'account' : skill.owner.scope === 'user' && skill.owner.userId === who.id)) ? `There’s a skill called ${trimmed} already` : null;
  const descriptionError = !description.trim() ? 'Say when agents should use it: they read this to decide' : description.length > 1024 ? 'Up to 1,024 characters' : null;
  const bodyError = !body.trim() ? 'Write its instructions' : how === 'paste' && !/^---\n[\s\S]*?name:[\s\S]*?\n---/.test(body.trim()) ? 'A SKILL.md starts with front matter: ---, name: and description:, then ---' : null;
  const reach = pluginReach(who.id);
  const importIt = (): void => {
    const match = /^(?:https:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([\w.-]+)\/(.+)$/.exec(path.trim());
    setImportError(null); setImported(false);
    if (!match) { setImportError('A repository path looks like github.com/crumb-co/skills/tree/main/release-checklist'); return; }
    later('import', 1100, () => {
      const repository = `github.com/${match[1]}/${match[2]}`;
      const org = match[1] ?? '';
      if (org !== 'crumb-co' && org !== 'crumb-labs') { setImportError(`GitSpace for Crumb & Co isn’t installed on ${org}, so it can’t read ${repository}. Install it on that organisation (Settings › GitHub), or copy the skill into a crumb-co repository.`); return; }
      if (!appCovers(repository) && match[2] !== 'skills') { setImportError(`GitSpace for Crumb & Co can’t see ${repository}: add it to the app’s repositories on GitHub, then import again.`); return; }
      const folder = (match[4] ?? '').split('/').filter(Boolean).at(-1) ?? '';
      if (!SKILL_NAME.test(folder)) { setImportError(`No SKILL.md in ${match[4]}: point at the folder that holds it.`); return; }
      setName(folder); setDescription('Imported from the repository; edit to say when agents should use it'); setBody(skillBody(folder, 'Imported from the repository')); setImported(true);
    });
  };
  const errors = [how === 'import' && !imported ? 'Import the skill first' : null, nameError ?? descriptionError ?? bodyError, null];
  const next = (): void => {
    if (step === 0 && how === 'paste') {
      const fm = /name:\s*([^\n]+)/.exec(body)?.[1]?.trim();
      const desc = /description:\s*([^\n]+)/.exec(body)?.[1]?.trim();
      if (fm && !name) setName(fm);
      if (desc && !description) setDescription(desc);
    }
    if (step === 0 && how === 'write' && !body) setBody(skillBody('my-skill', 'When to use it'));
    if (step > 0 && errors[step]) { setTried(true); return; }
    if (step === 0 && errors[0]) { setTried(true); return; }
    setTried(false);
    if (step < 2) { setStep(step + 1); return; }
    const skill: Skill = { id: `skill-${Date.now().toString(36)}`, name: trimmed, owner: team ? { scope: 'account' } : { scope: 'user', userId: who.id }, description: description.trim(), projects: team ? [...projects] : undefined, updated: `just now by ${viewer.first}` };
    skills.set([...skills.get(), skill]);
    if (team) recordAudit({ actor: viewer.id, kind: 'setting', text: `Added team skill ${trimmed}${projects.size ? ` · on in ${listNames([...projects])}` : ''}` });
    if (bot) recordAudit({ actor: viewer.id, kind: 'bot', text: `Added skill ${trimmed} to ${who.name}` });
    say(`${trimmed} added`);
    setDone(true);
  };
  return <FlowDialog id="new-skill" title={done ? `${trimmed} added` : team ? 'New team skill' : bot ? `New skill for ${who.first}` : 'New skill'} steps={['How', 'Skill', team ? 'Projects' : 'Where']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Instructions (and scripts) agents load when the description matches the task.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setStep(step - 1); setTried(false); }} onCancel={onClose} next={next} busy={busy !== null} nextLabel={step === 2 ? 'Add skill' : 'Continue'} />}>
    {done ? <FlowSuccess title={`${trimmed} is ${team ? 'the team’s' : bot ? `${who.first}’s` : 'yours'}`}>{team ? (projects.size ? `On in ${listNames([...projects])}; agents there load it from their next turn.` : 'On in no project yet.') : `It travels with ${bot ? who.first : 'you'} into workspaces ${bot ? 'it holds' : 'you hold'}${reach.on.length ? ` in ${listNames(reach.on)}` : ''}.`}{team || bot ? ' In the audit log.' : ''}</FlowSuccess> : null}
    {!done && step === 0 ? <>
      <ChoiceCards label="How" value={how} onChange={(id) => { if (id === 'write' || id === 'import' || id === 'paste') { setHow(id); setTried(false); } }} choices={[
        { id: 'write', title: 'Write it here', detail: 'Name, description and instructions', icon: File06 },
        { id: 'import', title: 'Import from a repository', detail: 'A folder with a SKILL.md, through the GitHub app', icon: GitBranch01 },
        { id: 'paste', title: 'Paste a SKILL.md', detail: 'Front matter and all', icon: BookOpen01 },
      ]} />
      {how === 'import' ? <>
        <div className="flex items-end gap-2">
          <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Repository path" value={path} onChange={(value) => { setPath(value); setImportError(null); setImported(false); }} placeholder="github.com/crumb-co/skills/tree/main/release-checklist" /></InputGroup>
          <Button variant="secondary" loading={busy === 'import'} disabled={busy !== null} onClick={importIt}>Import</Button>
        </div>
        {importError ? <FlowError>{importError}</FlowError> : null}
        {imported ? <p role="status" className="flex items-center gap-2 text-caption text-foreground"><Check width={14} height={14} className="text-[#079455]" />Found {name}/SKILL.md · 1 script</p> : null}
        {tried && errors[0] ? <FlowError>{errors[0]}</FlowError> : null}
      </> : null}
      {how === 'paste' ? <TextArea label="SKILL.md" mono rows={8} value={body} onChange={setBody} placeholder={skillBody('release-checklist', 'Use for the Friday release')} /> : null}
    </> : null}
    {!done && step === 1 ? <>
      <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} placeholder="release-checklist" error={tried ? nameError ?? undefined : undefined} /></InputGroup>
      <InputGroup className="w-full"><InputField index={1} label="Description (when agents should use it)" value={description} onChange={setDescription} error={tried ? descriptionError ?? undefined : undefined} /></InputGroup>
      <TextArea label="SKILL.md" mono rows={8} value={body} onChange={setBody} error={tried ? bodyError ?? undefined : undefined} />
    </> : null}
    {!done && step === 2 ? team ? <>
      <Field label="On in projects"><ChipPicker label="Projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field>
      <UnseenProjects userId={viewer.id} />
    </> : <Rules items={[`Travels with ${bot ? who.first : 'you'} into workspaces ${bot ? 'it holds' : 'you hold'}`, reach.on.length ? `Loads in ${listNames(reach.on)}` : `No project ${bot ? `${who.first} is` : 'you’re'} in allows holders’ own skills yet`, 'Co-holders’ agents don’t load it']} /> : null}
  </FlowDialog>;
}

/** Edit a skill's description and instructions (and, for the team's, its projects). */
export function EditSkillFlow({ skill, onClose }: { skill: Skill; onClose(): void }) {
  const viewer = useViewer();
  const team = skill.owner.scope === 'account';
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skillBody(skill.name, skill.description));
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(skill.projects ?? []));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return <FlowDialog id="edit-skill" title={done ? `${skill.name} saved` : `Edit ${skill.name}`} done={done} onClose={onClose} description={done ? undefined : `Updated ${skill.updated}`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => {
      if (!description.trim()) { setError('Say when agents should use it: they read this to decide'); return; }
      const unseen = (skill.projects ?? []).filter((id) => !visibleProjects(viewer.id).has(id));
      skills.set(skills.get().map((entry) => entry.id === skill.id ? { ...entry, description: description.trim(), projects: team ? [...unseen, ...projects] : entry.projects, updated: `just now by ${viewer.first}` } : entry));
      if (team) recordAudit({ actor: viewer.id, kind: 'setting', text: `Edited team skill ${skill.name}` });
      setDone(true);
    }}>Save</Button></>}>
    {done ? <FlowSuccess title={`${skill.name} saved`}>Agents load the new version from their next turn.{team ? ' In the audit log.' : ''}</FlowSuccess> : <>
      <InputGroup className="w-full"><InputField index={0} label="Description (when agents should use it)" value={description} onChange={(value) => { setDescription(value); setError(null); }} error={error ?? undefined} /></InputGroup>
      <TextArea label="SKILL.md" mono rows={8} value={body} onChange={setBody} />
      {team ? <><Field label="On in projects"><ChipPicker label="Projects" options={projectOptions(viewer.id)} picked={projects} onChange={setProjects} /></Field><UnseenProjects userId={viewer.id} /></> : null}
    </>}
  </FlowDialog>;
}
