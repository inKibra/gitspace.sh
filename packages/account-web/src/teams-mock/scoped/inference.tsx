// Inference settings, by placement. Crumb & Co › Inference: the profiles, each edited in the real app's four tabs
// (Models: a model per role; Providers: the team providers it uses and which kinds of personal providers holders may
// pay with; Services: web search, dictation, images, speech, decisions, each Off, Cloudflare Workers AI on GitSpace's
// account, or a model from this profile's credentials; Advanced: other runtime settings), the team's providers (API
// keys, Bedrock and local models; a Claude subscription is always personal) and budgets. Projects apply a profile in
// their settings, and the profile alone decides personal providers. You › Inference: your providers and where each can
// pay. Someone else's (People › person): the same as theirs, revoke only (sign out a provider). Spend is on Usage.
// Every action opens its dialog from `flows/resources.tsx`.
import { glyph } from '../../glyph.js';
import { Select, SelectContent, SelectItem, SelectTrigger, Switch, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import { CoinsStacked01, CpuChip01, Key01, Plus, Server01 } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import type { Principal } from '../data.js';
import { ConfirmFlow, AddProviderFlow, AdvancedFlow, BudgetFlow, ChangeModelFlow, NewProfileFlow, RemoveFromProfileFlow, RemoveLocalFlow, RemoveProviderFlow, ReplaceProviderFlow } from '../flows/resources.js';
import { budgetPolicies, localModels, profiles, providers, type LocalModel } from '../flows/resources-data.js';
import { budgets, MACHINES, PERSONAL_KINDS, personalKindOf, projectSettings, PROVIDER_LABEL, revoked, SERVICES, type Budget, type ModelCredential, type PersonalKind } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from '../settings/parts.js';
import { revokeIn, revokeOnly, whose, type ScopeInfo } from '../scope.js';
import { useMock, useViewer } from '../viewer.js';
import { listNames, providerReach } from './common.js';

const STATE = { available: { tone: 'green', label: 'Available' }, 'rate-limited': { tone: 'amber', label: 'Out · rate-limited' }, exhausted: { tone: 'amber', label: 'Out · exhausted' }, expired: { tone: 'red', label: 'Out · expired' }, failing: { tone: 'red', label: 'Out · failing' } } as const;
const money = (value: number) => `$${value.toFixed(2)}`;
const PROFILE_TABS = ['models', 'providers', 'services', 'advanced'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];
const PROFILE_TAB_LABEL: Readonly<Record<ProfileTab, string>> = { models: 'Models', providers: 'Providers', services: 'Services', advanced: 'Advanced' };

/** The dialog a team inference action opened. */
type TeamFlow =
  | { kind: 'add-provider' } | { kind: 'new-profile' } | { kind: 'model'; role: string } | { kind: 'out-of-profile'; entry: ModelCredential } | { kind: 'advanced'; label: string }
  | { kind: 'replace'; entry: ModelCredential } | { kind: 'remove'; entry: ModelCredential } | { kind: 'remove-local'; entry: LocalModel } | { kind: 'budget'; budget: Budget | null };

/** The team's inference (a team-scope `info`) or a person's providers. */
export function InferenceSettings({ info }: { info: ScopeInfo }) {
  if (info.access === 'team-edit' || info.access === 'team-read') return <TeamInference info={info} />;
  return info.target ? <PersonInference info={info} person={info.target} /> : null;
}

function TeamInference({ info }: { info: ScopeInfo }) {
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const params = new URLSearchParams(window.location.search);
  const all = profiles.use();
  const credentials = providers.use();
  const locals = localModels.use();
  const policies = budgetPolicies.use();
  const settings = projectSettings.use();
  const [selected, setSelected] = useState(() => all.find((profile) => profile.id === params.get('profile'))?.id ?? 'default');
  const [tab, setTab] = useState<ProfileTab>(() => PROFILE_TABS.find((entry) => entry === params.get('ptab')) ?? 'models');
  const [personal, setPersonal] = useState<Readonly<Record<string, readonly PersonalKind[]>>>(() => Object.fromEntries(all.map((profile) => [profile.id, profile.personal])));
  const [services, setServices] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>(() => Object.fromEntries(all.map((profile) => [profile.id, profile.services])));
  const [flow, setFlow] = useState<TeamFlow | null>(null);
  const team = credentials.filter((entry) => entry.owner.scope === 'account');
  const teamLocal = locals.filter((entry) => entry.owner.scope === 'account');
  const profile = all.find((entry) => entry.id === selected) ?? all[0];
  const label = (id: string) => credentials.find((entry) => entry.id === id)?.label ?? id;
  const used = (id: string) => Object.entries(settings).filter(([, entry]) => entry.profile === id).map(([project]) => project);
  if (!profile) return null;
  const allowed = personal[profile.id] ?? profile.personal;
  const close = () => setFlow(null);
  return <>
    <Section title="Profiles" scope="Team" readOnly={edit} description="Projects apply a profile in their settings. The profile decides the model for each role, which team providers pay, which kinds of holders’ own providers may pay, its services and runtime settings."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'new-profile' })}>New profile</Act>}>
      <SettingRows label="Profiles">{all.map((entry) => <SettingRow key={entry.id} media={glyph(CpuChip01)} title={<span data-profile={entry.id} className="inline-flex items-center gap-2">{entry.name}{entry.id === selected ? <Pill tone="blue">Editing</Pill> : null}<Pill>Applied to {listNames(used(entry.id)) || 'no project'}</Pill></span>}
        description={`${entry.models.length} roles · ${entry.teamProviders.map(label).join(', ') || 'no team provider'} · holders’ own: ${(personal[entry.id] ?? entry.personal).join(', ') || 'none'}`}>
        <Act reason={null} variant={entry.id === selected ? 'secondary' : 'ghost'} aria-label={`Open ${entry.name}`} onClick={() => setSelected(entry.id)}>Open</Act>
      </SettingRow>)}</SettingRows>
    </Section>

    <Section title={`${profile.name} profile`} scope="Team" readOnly={edit} description={`Applied to ${listNames(used(profile.id)) || 'no project'}.`}>
      <TabsSubtle selectedIndex={PROFILE_TABS.indexOf(tab)} idPrefix="profile-tab" onSelect={(index) => setTab(PROFILE_TABS[index] ?? 'models')}>
        {PROFILE_TABS.map((entry, index) => <TabsSubtleItem key={entry} index={index} label={PROFILE_TAB_LABEL[entry]} />)}
      </TabsSubtle>
      {tab === 'models' ? <SettingRows label="Models">{profile.models.map((model) => <SettingRow key={model.role} title={<span className="font-mono">{model.role}</span>} description={model.note}>
        <span className="font-mono text-caption text-foreground">{model.model}</span><Act reason={edit} variant="ghost" aria-label={`Change the model for ${model.role}`} onClick={() => setFlow({ kind: 'model', role: model.role })}>Change</Act>
      </SettingRow>)}</SettingRows> : null}
      {tab === 'providers' ? <>
        <SettingRows label="Team providers in this profile">{profile.teamProviders.map((id) => {
          const entry = credentials.find((candidate) => candidate.id === id);
          return entry ? <ProviderRow key={id} entry={entry} actions={<Act reason={edit} variant="ghost" aria-label={`Remove ${entry.label} from ${profile.name}`} onClick={() => setFlow({ kind: 'out-of-profile', entry })}>Remove from profile</Act>} /> : null;
        })}</SettingRows>
        <SettingRows label="Holders’ own providers">
          <SettingRow title="Holders’ own providers may pay" description={allowed.length ? `In every project this profile is applied to, a holder’s own ${allowed.join(' or ')} pays for their turns, in sticky rotation; anything else uses the team’s providers` : 'Off: every turn in its projects uses the team’s providers'} />
          {PERSONAL_KINDS.map((kind) => {
            const count = credentials.filter((entry) => entry.owner.scope === 'user' && personalKindOf(entry) === kind).length;
            return <SettingRow key={kind} title={kind} description={count ? `${count} ${count === 1 ? 'person has' : 'people have'} one` : 'Nobody has one'}>
              <Switch label={kind} checked={allowed.includes(kind)} disabled={edit !== null} onToggle={() => setPersonal((map) => ({ ...map, [profile.id]: allowed.includes(kind) ? allowed.filter((entry) => entry !== kind) : [...allowed, kind] }))} />
            </SettingRow>;
          })}
        </SettingRows>
      </> : null}
      {tab === 'services' ? <SettingRows label="Services">{SERVICES.map((service) => {
        const value = services[profile.id]?.[service.id] ?? profile.services[service.id] ?? 'off';
        const prefixes = profile.teamProviders.flatMap((id) => { const entry = credentials.find((candidate) => candidate.id === id); return entry ? [entry.via === 'Bedrock' ? 'bedrock/' : `${entry.provider}/`] : []; });
        const own = service.models.filter((model) => prefixes.some((prefix) => model.startsWith(prefix)));
        const options = [...new Set(['off', 'workers-ai', ...own, ...(value !== 'off' && value !== 'workers-ai' ? [value] : [])])];
        return <SettingRow key={service.id} title={service.label} description={service.detail}>
          <Select value={value} disabled={edit !== null} onValueChange={(next) => setServices((map) => ({ ...map, [profile.id]: { ...(map[profile.id] ?? {}), [service.id]: next } }))}>
            <SelectTrigger aria-label={service.label} />
            <SelectContent>{options.map((option, index) => <SelectItem key={option} value={option} index={index}>{option === 'off' ? 'Off' : option === 'workers-ai' ? 'Cloudflare Workers AI (GitSpace)' : option}</SelectItem>)}</SelectContent>
          </Select>
        </SettingRow>;
      })}</SettingRows> : null}
      {tab === 'advanced' ? <SettingRows label="Advanced">{profile.advanced.map((entry) => <SettingRow key={entry.label} title={entry.label} description={entry.value}><Act reason={edit} variant="ghost" aria-label={`Edit ${entry.label}`} onClick={() => setFlow({ kind: 'advanced', label: entry.label })}>Edit</Act></SettingRow>)}</SettingRows> : null}
    </Section>

    <Section title="Team providers" scope="Team" readOnly={edit} description="The team’s API keys, Bedrock and local models. A Claude or ChatGPT subscription is always someone’s own: it lives under their You › Inference, never here."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'add-provider' })}>Add provider</Act>}>
      <SettingRows label="Team providers">
        {team.map((entry) => <ProviderRow key={entry.id} entry={entry} actions={<>
          <Act reason={edit} variant="ghost" aria-label={`Replace ${entry.label}`} onClick={() => setFlow({ kind: 'replace', entry })}>Replace</Act>
          <Act reason={edit} variant="ghost" aria-label={`Remove ${entry.label}`} onClick={() => setFlow({ kind: 'remove', entry })}>Remove</Act>
        </>} />)}
        {teamLocal.map((entry) => <LocalRow key={entry.id} entry={entry} actions={<Act reason={edit} variant="ghost" aria-label={`Remove ${entry.label}`} onClick={() => setFlow({ kind: 'remove-local', entry })}>Remove</Act>} />)}
      </SettingRows>
    </Section>

    <Section title={<span className="inline-flex items-center gap-2">Budgets<Pill tone="violet">New</Pill></span>} scope="Team" readOnly={edit} description="A new feature, not in GitSpace yet: limits for the team, a project or a person, with an alert before the limit. Set here; Usage shows them against spend. Each says who’s told and whether reaching it stops new turns or only alerts."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'budget', budget: null })}>Add budget</Act>}>
      <SettingRows label="Budgets">{budgets.use().map((budget) => {
        const policy = policies[budget.id];
        return <SettingRow key={budget.id} media={glyph(CoinsStacked01)} title={<span data-budget={budget.id} className="inline-flex items-center gap-2">{budget.label}<Pill>{budget.scope === 'team' ? 'Team' : budget.scope === 'project' ? 'Project' : 'Person'}</Pill>{policy?.atLimit === 'stop' ? <Pill tone="amber">Stops new turns</Pill> : null}</span>}
          description={`${policy?.period === 'week' ? `${money(budget.monthly * 12 / 52)} a week` : `${money(budget.monthly)} a month`} · alert at ${budget.alertAt}% · covers ${budget.covers}`}>
          <Act reason={edit} variant="ghost" aria-label={`Edit the ${budget.label} budget`} onClick={() => setFlow({ kind: 'budget', budget })}>Edit</Act>
        </SettingRow>;
      })}</SettingRows>
    </Section>

    {flow?.kind === 'add-provider' ? <AddProviderFlow team onClose={close} /> : null}
    {flow?.kind === 'new-profile' ? <NewProfileFlow onClose={close} /> : null}
    {flow?.kind === 'model' ? <ChangeModelFlow profile={profile} role={flow.role} onClose={close} /> : null}
    {flow?.kind === 'out-of-profile' ? <RemoveFromProfileFlow profile={profile} entry={flow.entry} onClose={close} /> : null}
    {flow?.kind === 'advanced' ? <AdvancedFlow profile={profile} label={flow.label} onClose={close} /> : null}
    {flow?.kind === 'replace' ? <ReplaceProviderFlow entry={flow.entry} onClose={close} /> : null}
    {flow?.kind === 'remove' ? <RemoveProviderFlow entry={flow.entry} onClose={close} /> : null}
    {flow?.kind === 'remove-local' ? <RemoveLocalFlow entry={flow.entry} onClose={close} /> : null}
    {flow?.kind === 'budget' ? <BudgetFlow budget={flow.budget} onClose={close} /> : null}
  </>;
}

function ProviderRow({ entry, actions, extra }: { entry: ModelCredential; actions: ReactNode; extra?: ReactNode }) {
  return <SettingRow media={glyph(Key01)} title={<span data-provider={entry.id} className="inline-flex items-center gap-2">{entry.label}<Pill>{entry.via}</Pill><Pill tone={STATE[entry.state].tone}>{STATE[entry.state].label}</Pill></span>}
    description={<>{PROVIDER_LABEL[entry.provider]} · {money(entry.spentToday)} today · last used {entry.lastUsed}{entry.stateDetail ? ` · ${entry.stateDetail}` : ''}</>} extra={extra}>{actions}</SettingRow>;
}

function LocalRow({ entry, actions }: { entry: LocalModel; actions: ReactNode }) {
  const machine = MACHINES.find((candidate) => candidate.id === entry.machineId);
  return <SettingRow media={glyph(Server01)} title={<span data-local-model={entry.id} className="inline-flex items-center gap-2">{entry.label}<Pill>Local · {entry.runtime}</Pill><Pill tone={machine?.state === 'online' ? 'green' : 'gray'}>{machine?.state === 'online' ? 'Available' : `Out · ${machine?.state ?? 'no machine'}`}</Pill></span>}
    description={<>{machine?.label} · <span className="font-mono">{entry.url}</span> · {entry.models.join(', ')} · not billed</>}>{actions}</SettingRow>;
}

function PersonInference({ info, person }: { info: ScopeInfo; person: Principal }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const all = providers.use();
  const locals = localModels.use();
  const [adding, setAdding] = useState(false);
  const [signingOut, setSigningOut] = useState<ModelCredential | null>(null);
  const [removing, setRemoving] = useState<LocalModel | null>(null);
  const mine = all.filter((entry) => entry.owner.scope === 'user' && entry.owner.userId === person.id && !gone.has(entry.id));
  const myLocal = locals.filter((entry) => entry.owner.scope === 'user' && entry.owner.userId === person.id);
  const onlyRevoke = revokeOnly(info, viewer);
  const own = info.access === 'own';
  const bot = person.kind === 'bot' ? person : null;
  return <>
    <Section title={own ? 'My providers' : `${person.first}’s providers`} scope="You" description={bot ? `${bot.name}’s own keys (a subscription is a person’s, so never a bot’s). Each pays only for turns ${bot.name} starts, in projects whose inference profile allows its kind; the team’s profiles apply to it as to anyone, and without its own key its turns use the team’s providers.` : `${own ? 'Your' : `${person.first}’s`} own subscriptions and keys. Each pays only for turns started in workspaces ${own ? 'you hold' : `${person.first} holds`}, in projects whose inference profile allows its kind (an Anthropic subscription, an OpenAI API key…). The profile alone decides.`}
      actions={<Act reason={onlyRevoke} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>Connect a provider</Act>}>
      {mine.length || myLocal.length ? <SettingRows label={`${whose(info)} providers`}>
        {mine.map((entry) => {
          const reach = providerReach(person.id, entry);
          return <ProviderRow key={entry.id} entry={entry}
            extra={<div className="mt-1 flex flex-col gap-0.5 text-caption">
              <span className="text-foreground">{reach.on.length ? `Can pay in ${listNames(reach.on)}` : 'Can’t pay in any project now'}</span>
              {reach.off.map((item) => <span key={item.id} className="text-muted-foreground">Not in {listNames([item.id])}: {item.why}</span>)}
            </div>}
            actions={<Act reason={null} variant="ghost" aria-label={`Sign out ${entry.label}`} onClick={() => setSigningOut(entry)}>Sign out</Act>} />;
        })}
        {myLocal.map((entry) => <LocalRow key={entry.id} entry={entry} actions={<Act reason={null} variant="ghost" aria-label={`Remove ${entry.label}`} onClick={() => setRemoving(entry)}>Remove</Act>} />)}
      </SettingRows> : <Note>{bot ? `No providers of its own; turns ${bot.name} starts use the team’s.` : <>No providers of {own ? 'your' : 'their'} own; turns {own ? 'you start' : 'they start'} use another holder’s or the team’s.</>}</Note>}
    </Section>
    <Note>Spend and subscription windows are on Usage.</Note>
    {adding ? <AddProviderFlow team={false} principal={bot ?? undefined} onClose={() => setAdding(false)} /> : null}
    {removing ? <RemoveLocalFlow entry={removing} onClose={() => setRemoving(null)} /> : null}
    {signingOut ? <ConfirmFlow id="sign-out-provider" title={`Sign out ${signingOut.label}?`} confirmLabel="Sign out" onClose={() => setSigningOut(null)}
      description={own ? `Turns you start stop paying with it at the next turn; they use another holder’s or the team’s. Its sign-in is deleted; signing in again takes the provider’s page.` : bot ? `Turns ${bot.name} starts stop paying with it at the next turn and use the team’s providers. The key is deleted. It’s in the audit log.` : `${person.first}’s turns stop paying with it. ${person.first} is told in their Inbox and it’s in the audit log. You never see or use the credential.`}
      success={{ title: `${signingOut.label} signed out`, body: own ? 'Connect it again any time.' : bot ? 'In the audit log.' : `${person.first} is told; in the audit log.` }}
      onConfirm={() => revokeIn(info, viewer, signingOut.id, `${PROVIDER_LABEL[signingOut.provider]} provider (${signingOut.label})`, 'signed out', say)} /> : null}
  </>;
}
