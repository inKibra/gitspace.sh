// Machines dialogs, for You › Machines and Crumb & Co › Machines: pair a computer (choose whose, run the installer with
// a pairing code, wait for it, name it and pick the projects that may use it), create a Cell container, connect a
// cloud VM or fleet, edit a machine's notes, remove a team machine, and rotate the team SSH key. Team machines need an
// Owner or Admin and a passkey, and land in the audit log; personal ones join a workspace only while their owner
// holds its handle.
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch } from '@gitspace/ui';
import { Cloud01, Laptop01, Users01 } from '@untitledui/icons';
import { useState } from 'react';
import { PROJECTS, TEAM, visibleProjects, WORKSPACES, type Principal } from '../data.js';
import { MACHINE_KIND_LABEL, MACHINES, projectName, recordAudit, revoked, type Machine, type MachineKind } from '../settings/data.js';
import { machineProfiles } from './env-model.js';
import { usePasskey } from '../settings/passkey.js';
import { whyAccount } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea } from './kit.js';
import { addedMachines, fakeCode, fakeFingerprint, machineEdits, teamKey } from './you-data.js';
import { ConfirmFlow, MockOutcome, useCountdown, Waiting } from './you.js';

type Scope = 'mine' | 'team';

/** Every machine label in use (seed and added, not removed), lower-cased. */
function takenLabels(): ReadonlySet<string> {
  const gone = revoked.get();
  return new Set([...MACHINES, ...addedMachines.get()].filter((machine) => !gone.has(machine.id)).map((machine) => machine.label.toLowerCase()));
}

/** Why a machine name won't do, or null. */
function labelError(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return 'Name the machine';
  if (trimmed.length > 40) return 'At most 40 characters';
  return takenLabels().has(trimmed.toLowerCase()) ? `There’s already a machine named ${trimmed}; pick another name` : null;
}

/** Adds a machine at `scope`, owned by `ownerId` when it isn't the team's, and records it (team machines and a bot's in
 * the audit log, by `actorId`). */
function addMachine(actorId: string, ownerId: string, scope: Scope, label: string, kind: MachineKind, notes: string, projects: readonly string[], os: string): Machine {
  const machine: Machine = { id: `added-${addedMachines.get().length + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label, kind, owner: scope === 'team' ? { scope: 'account' } : { scope: 'user', userId: ownerId }, state: 'online', notes };
  addedMachines.set([...addedMachines.get(), machine]);
  machineEdits.set({ ...machineEdits.get(), [machine.id]: { projects: scope === 'team' ? projects : undefined, os } });
  if (scope === 'team') recordAudit({ actor: actorId, kind: 'resource', text: `Added team machine ${label} (${MACHINE_KIND_LABEL[kind]}${projects.length ? ` · ${projects.map(projectName).join(', ')}` : ''})` });
  else if (ownerId !== actorId) recordAudit({ actor: actorId, kind: 'bot', text: `Added machine ${label} (${MACHINE_KIND_LABEL[kind]}) for ${ownerId}` });
  return machine;
}

/** The team projects picker: projects the viewer is in (an Admin doesn't see the rest). */
function ProjectsField({ viewerId, picked, onChange, tried }: { viewerId: string; picked: ReadonlySet<string>; onChange(next: ReadonlySet<string>): void; tried: boolean }) {
  const mine = PROJECTS.filter((project) => !project.archived && visibleProjects(viewerId).has(project.id));
  return <div className="flex flex-col gap-1.5">
    <span className="text-caption font-medium text-foreground">Projects that may use it</span>
    <ChipPicker label="Projects that may use it" picked={picked} onChange={onChange} options={mine.map((project) => ({ id: project.id, label: project.name }))} />
    <Hint>Their workspaces may run on it whoever holds the handle; bots too. Only projects you’re in are listed.</Hint>
    {tried && picked.size === 0 ? <FlowError>Pick at least one project, or nothing can use it.</FlowError> : null}
  </div>;
}

/** Whose machine: mine, or the team's (Owners and Admins only). */
function ScopeChoice({ viewerId, value, onChange, what }: { viewerId: string; value: Scope; onChange(next: Scope): void; what: string }) {
  const refusal = whyAccount(viewerId, 'account.resources');
  return <ChoiceCards label={`Whose ${what}`} value={value} onChange={(id) => onChange(id === 'team' ? 'team' : 'mine')} choices={[
    { id: 'mine', title: 'Mine', detail: 'Joins a workspace only while you hold its handle; uses your own SSH key and GitHub setup (You › Git identity), never the team key', icon: Laptop01 },
    { id: 'team', title: 'The team’s', detail: 'Runs the work of the projects you pick, whoever holds the handle; uses the team SSH key and GitHub App', icon: Users01, disabled: refusal ? `${refusal}: Owners and Admins add team machines` : null },
  ]} />;
}

const OS_CHOICES = [
  { id: 'macos', title: 'macOS', detail: 'Installer package, or the command in Terminal' },
  { id: 'linux', title: 'Linux', detail: 'The command in a shell; systemd service' },
  { id: 'windows', title: 'Windows', detail: 'Installer, or the command in PowerShell' },
];

/** Pair a computer: whose → install with a pairing code → wait for it → name it (and its projects) → paired. */
export function AddComputerFlow({ initialScope, onClose }: { initialScope: Scope; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const teamRefusal = whyAccount(viewer.id, 'account.resources');
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<Scope>(teamRefusal ? 'mine' : initialScope);
  const [os, setOs] = useState('macos');
  const [attempt, setAttempt] = useState(1);
  const [phase, setPhase] = useState<'waiting' | 'expired' | 'elsewhere'>('waiting');
  const [found, setFound] = useState<{ kind: MachineKind; os: string; host: string } | null>(null);
  const [label, setLabel] = useState('');
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<Machine | null>(null);
  const check = usePasskey();
  const code = fakeCode(`${viewer.id}-${scope}-pair-${attempt}`);
  const countdown = useCountdown(900, step === 1 || (step === 2 && phase === 'waiting') ? code : null);
  const command = os === 'windows' ? `irm https://${TEAM.host}/install.ps1 | iex; gitspace-machine pair ${code}` : `curl -fsSL https://${TEAM.host}/install | sh -s -- --pair ${code}`;
  const nameError = labelError(label);
  const appear = (kind: MachineKind): void => {
    const next = kind === 'computer' ? { kind, os: 'macOS 15.2 · Apple M3 Pro · 36 GB', host: scope === 'team' ? 'Front-counter iMac' : `${viewer.first}’s Mac Studio` }
      : { kind, os: 'Ubuntu 24.04 · 8 vCPU · 32 GB · EC2 detected (eu-west-1)', host: scope === 'team' ? 'crumb-build-1' : `${viewer.id}-build` };
    setFound(next);
    setLabel(next.host);
    setStep(3);
  };
  const finish = (): void => {
    if (!found) return;
    const machine = addMachine(viewer.id, viewer.id, scope, label.trim(), found.kind, '', [...projects], found.os);
    setDone(machine);
    say(`${machine.label} paired`);
  };
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) { setPhase('waiting'); setStep(2); return; }
    if (step === 2) { setAttempt((value) => value + 1); setPhase('waiting'); setStep(1); return; }
    setTried(true);
    if (nameError || (scope === 'team' && projects.size === 0)) return;
    if (scope === 'team') check.confirm(finish); else finish();
  };
  return <FlowDialog id="add-computer" title="Add a computer" steps={['Whose', 'Install', 'Pair', 'Name it']} step={step} done={done !== null} onClose={onClose}
    description={done ? undefined : `Install the GitSpace machine agent and pair it with ${TEAM.name}. The pairing code works once, for 15 minutes.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : <StepButtons step={step} onBack={() => setStep(step === 3 ? 1 : step - 1)} onCancel={onClose} next={next} busy={check.waiting} disabled={step === 2 && phase === 'waiting'}
        nextLabel={step === 1 ? 'I ran it' : step === 2 ? 'New code' : step === 3 ? (scope === 'team' ? 'Add with passkey' : 'Add machine') : 'Continue'} />}>
    {done ? <FlowSuccess title={`${done.label} is paired`}>
      {MACHINE_KIND_LABEL[done.kind]} · {found?.os} · {scope === 'team' ? `team machine for ${[...projects].map(projectName).join(', ')}; it’s in the audit log` : 'yours; it joins a workspace while you hold its handle'}. Its load and what runs on it show on Machines.
    </FlowSuccess>
      : step === 0 ? <ScopeChoice viewerId={viewer.id} value={scope} onChange={setScope} what="computer" />
      : step === 1 ? <>
        <ChoiceCards label="Operating system" value={os} onChange={setOs} columns={2} choices={OS_CHOICES} />
        {os !== 'linux' ? <div className="flex items-center gap-2"><Button variant="secondary" onClick={() => say(`Downloading GitSpace-Machine.${os === 'macos' ? 'pkg' : 'msi'}`)}>Download installer ({os === 'macos' ? '.pkg' : '.msi'})</Button><Hint>then enter the pairing code when it asks, or run:</Hint></div> : null}
        <InputCopy label={os === 'windows' ? 'In PowerShell' : 'In a terminal'} value={command} />
        <InputCopy label="Pairing code" value={code} />
        <p className="text-caption tabular-nums text-muted-foreground">Expires in {countdown} · works once · pairs as {scope === 'team' ? `a team machine of ${TEAM.name}` : `${viewer.first}’s machine`}</p>
      </>
      : step === 2 ? <>
        {phase === 'waiting' ? <>
          <Waiting>Waiting for the machine to connect with {code}… (expires in {countdown})</Waiting>
          <MockOutcome what="The machine:" outcomes={[{ id: 'computer', label: 'A Mac connects' }, { id: 'vm', label: 'A Linux VM connects' }, { id: 'expired', label: 'Code expires' }, { id: 'elsewhere', label: 'Already paired elsewhere' }]}
            onPick={(outcome) => { if (outcome === 'computer' || outcome === 'vm') appear(outcome); else setPhase(outcome === 'expired' ? 'expired' : 'elsewhere'); }} />
        </> : null}
        {phase === 'expired' ? <FlowError>The pairing code expired before the machine used it, so nothing was paired. Press New code and run the new command within 15 minutes.</FlowError> : null}
        {phase === 'elsewhere' ? <FlowError>This computer is already paired with acme.gitspace.sh (Acme Studio). A machine pairs with one team at a time: unpair it there first (run gitspace-machine unpair on it, or remove it on that team’s Machines page), then press New code and run the command again.</FlowError> : null}
      </>
      : found ? <>
        <Summary rows={[['Kind', `${MACHINE_KIND_LABEL[found.kind]}${found.kind === 'vm' ? ' (the agent found cloud metadata)' : ''}`], ['System', found.os], ['Pairs as', scope === 'team' ? 'Team machine' : `${viewer.first}’s machine`]]} />
        <InputGroup className="w-full"><InputField index={0} label="Name" value={label} onChange={setLabel} error={tried && nameError ? nameError : undefined} /></InputGroup>
        {scope === 'team' ? <ProjectsField viewerId={viewer.id} picked={projects} onChange={setProjects} tried={tried} /> : <Hint>It joins a workspace only while you hold its handle, with your own SSH key and GitHub setup.</Hint>}
        {scope === 'team' ? <PasskeyStep userId={viewer.id} what="adding a team machine" waiting={check.waiting} /> : null}
      </> : null}
  </FlowDialog>;
}

const SIZES = [
  { id: 'small', title: 'Small', detail: '2 vCPU · 4 GB · 40 GB disk · about $0.06 an hour while awake' },
  { id: 'medium', title: 'Medium', detail: '4 vCPU · 16 GB · 80 GB disk · about $0.19 an hour while awake' },
  { id: 'large', title: 'Large', detail: '8 vCPU · 32 GB · 160 GB disk · about $0.38 an hour while awake' },
];
const SERVICES = [{ id: 'postgres', label: 'Postgres 16' }, { id: 'redis', label: 'Redis 7' }, { id: 'chrome', label: 'Chrome (headless)' }];
const SLUG = /^[a-z][a-z0-9-]{2,31}$/;

/** Create a Cell container, for the team, yourself or a bot you manage (`principal`): name and size → image and
 * services → projects (team) or review → created. */
export function CellContainerFlow({ scope, principal, onClose }: { scope: Scope; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const who = principal ?? viewer;
  const { say } = useMock();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(scope === 'team' ? 'crumb-cell-2' : `${who.id}-cell`);
  const [size, setSize] = useState('medium');
  const [sleep, setSleep] = useState('1h');
  const images = machineProfiles.use().filter((profile) => profile.image !== null);
  const [image, setImage] = useState(images[0]?.id ?? 'ubuntu');
  const picked = images.find((profile) => profile.id === image);
  const imageLabel = picked ? `${picked.image} (${picked.name} profile built in)` : 'Ubuntu 24.04 base';
  const [services, setServices] = useState<ReadonlySet<string>>(new Set(['postgres', 'redis']));
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const nameError = !name.trim() ? 'Name the container' : SLUG.test(name.trim()) ? labelError(name) : 'Lower-case letters, digits and dashes, 3 to 32, starting with a letter';
  const sizeLabel = SIZES.find((entry) => entry.id === size)?.title ?? '';
  const create = (): void => {
    setCreating(true);
    window.setTimeout(() => {
      setCreating(false);
      addMachine(viewer.id, who.id, scope, name.trim(), 'container', `${sizeLabel} · ${imageLabel} · ${[...services].map((id) => SERVICES.find((entry) => entry.id === id)?.label).join(', ')}`, [...projects], `${sizeLabel} Cell container`);
      setDone(true);
      say(`${name.trim()} created`);
    }, 1200);
  };
  const next = (): void => {
    if (step === 0) { setTried(true); if (!nameError) { setTried(false); setStep(1); } return; }
    if (step === 1) { setStep(2); return; }
    setTried(true);
    if (scope === 'team' && projects.size === 0) return;
    if (scope === 'team') check.confirm(create); else create();
  };
  return <FlowDialog id="cell-container" title="New Cell container" steps={['Name and size', 'Image', scope === 'team' ? 'Projects' : 'Review']} step={step} done={done} onClose={onClose}
    description={done ? undefined : `GitSpace runs it for ${scope === 'team' ? TEAM.name : who.kind === 'bot' ? who.name : 'you'}; it sleeps when idle and wakes when a workspace needs it.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} busy={check.waiting || creating} nextLabel={step < 2 ? 'Continue' : scope === 'team' ? 'Create with passkey' : 'Create container'} />}>
    {done ? <FlowSuccess title={`${name.trim()} is ready`}>Cell container · {sizeLabel} · {scope === 'team' ? `for ${[...projects].map(projectName).join(', ')}; it’s in the audit log` : who.kind === 'bot' ? `${who.first}’s; it joins a workspace while ${who.first} holds its handle; in the audit log` : 'yours; it joins a workspace while you hold its handle'}. It sleeps after {sleep === 'never' ? 'never' : sleep === '15m' ? '15 minutes' : 'an hour'} idle.</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} /></InputGroup>
        <ChoiceCards label="Size" value={size} onChange={setSize} choices={SIZES} />
        <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Sleep when idle for</span>
          <Select value={sleep} onValueChange={setSleep}><SelectTrigger aria-label="Sleep when idle for" /><SelectContent><SelectItem value="15m" index={0}>15 minutes</SelectItem><SelectItem value="1h" index={1}>1 hour</SelectItem><SelectItem value="never" index={2}>Never (billed while awake)</SelectItem></SelectContent></Select>
        </div>
      </>
      : step === 1 ? <>
        <ChoiceCards label="Image" value={image} onChange={setImage} choices={[
          ...images.map((profile) => ({ id: profile.id, title: profile.image ?? profile.name, detail: `The ${profile.name} machine profile built in (${profile.summary}): ready for ${profile.name} without running its setup` })),
          { id: 'ubuntu', title: 'Ubuntu 24.04 base', detail: 'Plain image; each machine profile a project needs runs its setup script here once approved' },
        ]} />
        <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Services baked in</span>
          <ChipPicker label="Services baked in" picked={services} onChange={setServices} options={SERVICES} />
        </div>
      </>
      : <>
        <Summary rows={[['Name', name.trim()], ['Size', SIZES.find((entry) => entry.id === size)?.detail ?? ''], ['Image', imageLabel], ['Services', [...services].map((id) => SERVICES.find((entry) => entry.id === id)?.label).join(', ') || 'None']]} />
        {scope === 'team' ? <><ProjectsField viewerId={viewer.id} picked={projects} onChange={setProjects} tried={tried} /><PasskeyStep userId={viewer.id} what="creating a team machine" waiting={check.waiting} /></> : null}
        {creating ? <Waiting>Creating {name.trim()}…</Waiting> : null}
      </>}
  </FlowDialog>;
}

const PROVIDERS = [
  { id: 'aws', title: 'AWS EC2', detail: 'An IAM role GitSpace assumes, with an external ID' },
  { id: 'gcp', title: 'Google Compute Engine', detail: 'A service account, through workload identity federation' },
  { id: 'azure', title: 'Azure', detail: 'An app registration in your tenant' },
];
const REGIONS: Readonly<Record<string, readonly string[]>> = { aws: ['eu-west-1', 'us-east-1', 'ap-southeast-2'], gcp: ['europe-west1', 'us-central1'], azure: ['westeurope', 'eastus'] };
const TYPES: Readonly<Record<string, readonly string[]>> = { aws: ['c7g.xlarge', 'g6.xlarge', 'm7i.2xlarge'], gcp: ['c3-standard-8', 'g2-standard-8'], azure: ['Standard_D8s_v5', 'Standard_NC8as_T4_v3'] };
const ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID = 'gs-crumbco-7Q4M2XD';

/** Connect a cloud VM or a fleet, for the team, yourself or a bot you manage (`principal`): provider → account access
 * (checked) → machines → projects (team) or review. */
export function CloudVmFlow({ scope, principal, onClose }: { scope: Scope; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const who = principal ?? viewer;
  const { say } = useMock();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState('aws');
  const [identity, setIdentity] = useState('');
  const [tenant, setTenant] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fleet, setFleet] = useState(scope === 'team');
  const [count, setCount] = useState('2');
  const [region, setRegion] = useState('eu-west-1');
  const [type, setType] = useState('c7g.xlarge');
  const [name, setName] = useState(scope === 'team' ? 'crumb-loadtest fleet' : `${who.id}-vm`);
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const providerLabel = PROVIDERS.find((entry) => entry.id === provider)?.title ?? '';
  const identityError = !identity.trim() ? (provider === 'aws' ? 'Paste the role ARN' : provider === 'gcp' ? 'Enter the service account email' : 'Enter the application (client) ID')
    : provider === 'aws' ? (ARN.test(identity.trim()) ? null : 'A role ARN looks like arn:aws:iam::123456789012:role/GitSpaceMachines')
    : provider === 'gcp' ? (SERVICE_ACCOUNT.test(identity.trim()) ? null : 'A service account email looks like gitspace@my-project.iam.gserviceaccount.com')
    : GUID.test(identity.trim()) ? null : 'The client ID is a GUID (8-4-4-4-12 hex digits)';
  const tenantError = provider !== 'azure' ? null : !tenant.trim() ? 'Enter the directory (tenant) ID' : GUID.test(tenant.trim()) ? null : 'The tenant ID is a GUID (8-4-4-4-12 hex digits)';
  const countNumber = Number(count);
  const countError = !fleet ? null : Number.isInteger(countNumber) && countNumber >= 1 && countNumber <= 10 ? null : 'A fleet has 1 to 10 machines';
  const nameError = labelError(name);
  const pickProvider = (id: string): void => { setProvider(id); setRegion(REGIONS[id]?.[0] ?? ''); setType(TYPES[id]?.[0] ?? ''); setIdentity(''); setCheckError(null); };
  const connect = (): void => {
    addMachine(viewer.id, who.id, scope, name.trim(), 'vm', `${providerLabel} ${region} · ${fleet ? `${count} × ` : ''}${type}`, [...projects], `${providerLabel} · ${type}`);
    setDone(true);
    say(`${name.trim()} connected`);
  };
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) {
      setTried(true);
      if (identityError || tenantError) return;
      setChecking(true);
      setCheckError(null);
      window.setTimeout(() => {
        setChecking(false);
        if (provider === 'aws' && /readonly/i.test(identity)) { setCheckError('GitSpace assumed the role, but it can’t launch instances: ec2:RunInstances is denied. Attach the GitSpaceMachines policy to the role (aws iam attach-role-policy …), then press Check access again.'); return; }
        setTried(false);
        setStep(2);
      }, 1000);
      return;
    }
    if (step === 2) { setTried(true); if (!countError && !nameError) { setTried(false); setStep(3); } return; }
    setTried(true);
    if (scope === 'team' && projects.size === 0) return;
    if (scope === 'team') check.confirm(connect); else connect();
  };
  return <FlowDialog id="cloud-vm" title="Connect a cloud VM" steps={['Provider', 'Access', 'Machines', scope === 'team' ? 'Projects' : 'Review']} step={step} done={done} onClose={onClose}
    description={done ? undefined : `GitSpace starts and stops them in ${scope === 'team' ? 'the team’s' : who.kind === 'bot' ? `${who.name}’s` : 'your'} cloud account; ${who.kind === 'bot' && scope !== 'team' ? 'that account' : 'you'} pay${who.kind === 'bot' && scope !== 'team' ? 's' : ''} the provider.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setCheckError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={checking || check.waiting}
      nextLabel={step === 1 ? 'Check access' : step === 3 ? (scope === 'team' ? 'Connect with passkey' : 'Connect') : 'Continue'} />}>
    {done ? <FlowSuccess title={`${name.trim()} is connected`}>{providerLabel} {region} · {fleet ? `${count} × ` : ''}{type} · {scope === 'team' ? `for ${[...projects].map(projectName).join(', ')}; it’s in the audit log` : who.kind === 'bot' ? `${who.first}’s; it joins a workspace while ${who.first} holds its handle; in the audit log` : 'yours; it joins a workspace while you hold its handle'}. GitSpace starts {fleet ? 'them' : 'it'} when a workspace needs {fleet ? 'them' : 'it'}.</FlowSuccess>
      : step === 0 ? <ChoiceCards label="Provider" value={provider} onChange={pickProvider} choices={PROVIDERS.map((entry) => ({ ...entry, icon: Cloud01 }))} />
      : step === 1 ? <>
        {provider === 'aws' ? <><InputCopy label="External ID (put it in the role’s trust policy)" value={EXTERNAL_ID} /><Hint>Trust GitSpace’s AWS account 431902117744 with this external ID, and attach the GitSpaceMachines policy (ec2:RunInstances, StartInstances, StopInstances, DescribeInstances on tagged instances).</Hint></> : null}
        {provider === 'gcp' ? <Hint>Grant the service account roles/compute.instanceAdmin.v1 and let GitSpace’s workload identity pool (gitspace-machines) impersonate it.</Hint> : null}
        {provider === 'azure' ? <Hint>Register an app in your tenant and give it Virtual Machine Contributor on the resource group the machines go in.</Hint> : null}
        <InputGroup className="w-full">
          {provider === 'azure' ? <InputField index={0} label="Directory (tenant) ID" value={tenant} onChange={(value) => { setTenant(value); setCheckError(null); }} error={tried && tenantError ? tenantError : undefined} /> : null}
          <InputField index={provider === 'azure' ? 1 : 0} label={provider === 'aws' ? 'Role ARN' : provider === 'gcp' ? 'Service account' : 'Application (client) ID'} value={identity} onChange={(value) => { setIdentity(value); setCheckError(null); }}
            placeholder={provider === 'aws' ? 'arn:aws:iam::123456789012:role/GitSpaceMachines' : provider === 'gcp' ? 'gitspace@crumb-prod.iam.gserviceaccount.com' : '00000000-0000-0000-0000-000000000000'} error={tried && identityError ? identityError : undefined} />
        </InputGroup>
        {checking ? <Waiting>Checking access in {providerLabel}…</Waiting> : null}
        {checkError ? <FlowError>{checkError}</FlowError> : null}
      </>
      : step === 2 ? <>
        <Switch label="A fleet: several identical machines, one per workspace" checked={fleet} onToggle={() => setFleet((value) => !value)} />
        <InputGroup className="w-full">
          <InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} />
          {fleet ? <InputField index={1} label="Machines in the fleet" value={count} onChange={setCount} inputMode="numeric" error={tried && countError ? countError : undefined} /> : null}
        </InputGroup>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Region</span>
            <Select value={region} onValueChange={setRegion}><SelectTrigger aria-label="Region" /><SelectContent>{(REGIONS[provider] ?? []).map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{entry}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Instance type</span>
            <Select value={type} onValueChange={setType}><SelectTrigger aria-label="Instance type" /><SelectContent>{(TYPES[provider] ?? []).map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{entry}</SelectItem>)}</SelectContent></Select></div>
        </div>
      </>
      : <>
        <Summary rows={[['Provider', `${providerLabel} · ${identity.trim()}`], ['Machines', `${fleet ? `${count} × ` : ''}${type} in ${region}`], ['Name', name.trim()], ['Stopped', 'When no workspace needs it; you pay the provider while it runs']]} />
        {scope === 'team' ? <><ProjectsField viewerId={viewer.id} picked={projects} onChange={setProjects} tried={tried} /><PasskeyStep userId={viewer.id} what="connecting a team machine" waiting={check.waiting} /></> : null}
      </>}
  </FlowDialog>;
}

export function MachineNotesFlow({ machine, onClose }: { machine: Machine; onClose(): void }) {
  const viewer = useViewer();
  const edits = machineEdits.use();
  const [notes, setNotes] = useState(edits[machine.id]?.notes ?? machine.notes);
  const [done, setDone] = useState(false);
  const error = notes.length > 200 ? `At most 200 characters (${notes.length} now)` : undefined;
  return <FlowDialog id="machine-notes" title={`Notes on ${machine.label}`} description={done ? undefined : 'What the team should know: what’s installed, what it’s for, what’s plugged in. Agents read them when picking a machine.'} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={error !== undefined} onClick={() => {
      machineEdits.set({ ...machineEdits.get(), [machine.id]: { ...machineEdits.get()[machine.id], notes: notes.trim() } });
      recordAudit({ actor: viewer.id, kind: 'resource', text: `Edited notes on team machine ${machine.label}` });
      setDone(true);
    }}>Save</Button></>}>
    {done ? <FlowSuccess title="Notes saved">{notes.trim() || 'No notes'}</FlowSuccess> : <TextArea label="Notes" value={notes} onChange={setNotes} rows={4} error={error} />}
  </FlowDialog>;
}

/** Remove a team machine: what runs on it now, then a passkey. */
export function MachineRemoveFlow({ machine, onClose }: { machine: Machine; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const runs = WORKSPACES.filter((workspace) => !workspace.archived && (workspace.machine === machine.id || (machine.id === 'crumb-cloud-1' && workspace.machine === 'cloud'))).map((workspace) => workspace.id);
  return <ConfirmFlow id="machine-remove" title={`Remove ${machine.label}`} confirmLabel="Remove with passkey" onClose={onClose}
    description={`${MACHINE_KIND_LABEL[machine.kind]} · team machine`}
    passkey={{ userId: viewer.id, what: `removing ${machine.label}` }}
    onConfirm={() => { revoked.set(new Set([...revoked.get(), machine.id])); recordAudit({ actor: viewer.id, kind: 'resource', text: `Removed team machine ${machine.label}` }); say(`Removed ${machine.label}`); }}
    success={{ title: `${machine.label} removed`, body: `${runs.length ? `${runs.join(', ')} move to the default Cell container on their next turn. ` : ''}${machine.kind === 'computer' ? 'Its machine agent is unpaired; uninstall it on the computer if you like.' : 'GitSpace stopped it.'} It’s in the audit log.` }}>
    <Summary rows={[['Runs now', runs.length ? runs.join(', ') : 'No workspace'], ['Then', runs.length ? 'They stop and move to the default Cell container on their next turn; nothing in them is lost' : 'Nothing runs on it'], ['Keys', 'The team SSH key and GitHub App token are wiped from it']]} />
  </ConfirmFlow>;
}

/** Rotate the team SSH key: make a new key → register it where the old one is → retire the old one (or keep both). */
export function TeamKeyRotateFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const current = teamKey.use();
  const [old] = useState(current);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(`${old.name.replace(/-\d+$/, '')}-2`);
  const [tried, setTried] = useState(false);
  const [registered, setRegistered] = useState<ReadonlySet<string>>(new Set());
  const [retire, setRetire] = useState('keep');
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const fingerprint = fakeFingerprint(`team-${name}`);
  const publicKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fingerprint.slice(7, 47)} ${name}@${TEAM.host}`;
  const nameError = !name.trim() ? 'Name the key' : /^[A-Za-z0-9._-]+$/.test(name.trim()) ? (name.trim() === old.name ? 'That’s the current key’s name' : null) : 'Letters, digits, dots, dashes and underscores only';
  const missing = old.registered.filter((place) => !registered.has(place));
  const next = (): void => {
    if (step === 0) {
      setTried(true);
      if (nameError) return;
      check.confirm(() => { teamKey.set({ ...old, name: name.trim(), fingerprint, created: 'Just now', previous: old.fingerprint }); recordAudit({ actor: viewer.id, kind: 'resource', text: `Made a new team SSH key ${name.trim()} (${fingerprint.slice(0, 16)}…)` }); setStep(1); });
      return;
    }
    if (step === 1) { setStep(2); return; }
    teamKey.set({ ...teamKey.get(), previous: retire === 'retire' ? null : old.fingerprint });
    if (retire === 'retire') recordAudit({ actor: viewer.id, kind: 'resource', text: `Retired the old team SSH key (${old.fingerprint.slice(0, 16)}…)` });
    setDone(true);
    say(retire === 'retire' ? 'Team SSH key rotated; the old one is retired' : 'New team SSH key in use; the old one still works');
  };
  return <FlowDialog id="team-key-rotate" title="Rotate the team SSH key" steps={['New key', 'Register it', 'Retire the old key']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Team machines use it for origins the GitHub App doesn’t cover. The old key keeps working until you retire it.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step === 2 ? 1 : 0} onBack={() => setStep(1)} onCancel={onClose} next={next} busy={check.waiting}
      nextLabel={step === 0 ? 'Make key with passkey' : step === 1 ? 'Continue' : retire === 'retire' ? 'Retire old key' : 'Keep both for now'} />}>
    {done ? <FlowSuccess title={`${name.trim()} is the team key`}><span className="font-mono">{fingerprint}</span> · on every team machine. {retire === 'retire' ? `The old key ${old.fingerprint.slice(0, 20)}… is wiped from them.` : 'The old key still works too; retire it here when every place has the new one.'}</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} /></InputGroup>
        <Summary rows={[['Type', 'ed25519, generated by GitSpace; the private key never leaves team machines'], ['Current key', <span key="old" className="font-mono text-caption">{old.name} · {old.fingerprint}</span>]]} />
        <PasskeyStep userId={viewer.id} what="making a new team SSH key" waiting={check.waiting} />
      </>
      : step === 1 ? <>
        <InputCopy label="New public key" value={publicKey} />
        <div className="flex flex-col gap-2"><span className="text-caption font-medium text-foreground">Add it where the old key is</span>
          {old.registered.map((place) => <Switch key={place} label={`${place}: added`} checked={registered.has(place)} onToggle={() => { const nextSet = new Set(registered); if (nextSet.has(place)) nextSet.delete(place); else nextSet.add(place); setRegistered(nextSet); }} />)}
        </div>
        <Hint>Origins the GitHub App covers need nothing. Mark each place once you’ve added the key there.</Hint>
      </>
      : <>
        <ChoiceCards label="The old key" value={retire} onChange={setRetire} choices={[
          { id: 'retire', title: 'Retire the old key now', detail: 'Wiped from every team machine; places that still have only the old key stop working for them', disabled: missing.length ? `Add the new key at ${missing.join(' and ')} first, or those origins stop working on team machines` : null },
          { id: 'keep', title: 'Keep both for now', detail: 'Team machines carry both keys until you retire the old one here' },
        ]} />
        {missing.length ? <Hint>Not yet added: {missing.join('; ')}.</Hint> : null}
      </>}
  </FlowDialog>;
}
