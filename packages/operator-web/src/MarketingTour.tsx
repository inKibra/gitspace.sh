import { Badge, Button, Card, CardContent } from '@gitspace/ui';
import { ArrowRight, CheckCircle } from '@untitledui/icons';
import { useState } from 'react';

const chains = [
  { id: 'identity', label: 'Account identity', phase: 'Plan', tone: 'bg-blue-500' },
  { id: 'fleet', label: 'Machine enrollment', phase: 'Code', tone: 'bg-emerald-500' },
  { id: 'fleet', label: 'Placement controls', phase: 'Review', tone: 'bg-emerald-500' },
  { id: 'identity', label: 'Browser grants', phase: 'Code', tone: 'bg-blue-500' },
  { id: 'release', label: 'Account release', phase: 'Ship', tone: 'bg-violet-500' },
  { id: 'release', label: 'Rollback evidence', phase: 'Review', tone: 'bg-violet-500' },
] as const;
export function SelfModificationSection() {
  return <section className="bg-surface-2 py-20 lg:py-28">
    <div className="mx-auto w-full max-w-7xl px-6 lg:px-10">
      <div className="max-w-4xl">
        <Badge color="gray">GitSpace modifies GitSpace</Badge>
        <h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.75rem)] font-semibold leading-[1] tracking-[-0.045em]">The workspace is also the control plane.</h2>
        <p className="mt-5 max-w-3xl text-pretty text-subtitle leading-relaxed text-muted-foreground">GitSpace spans machines you own and cloud resources you create. You or an agent can change the product from a GitSpace workspace and release that change in place, without interrupting another account or unrelated work.</p>
      </div>
      <div className="mt-12 grid gap-px overflow-hidden rounded-xl bg-border shadow-surface-3 lg:grid-cols-3">
        {[
          ['01', 'Persist in cloud storage', 'Closed agent workspaces keep their durable state in cloud storage instead of occupying a machine forever.'],
          ['02', 'Place on a capable machine', 'Opening work moves the workspace to a machine that exposes the required capabilities, such as Docker, isolation, GPU, or a credential scope.'],
          ['03', 'Modify and release in place', 'The workspace can change GitSpace itself, publish the account release, and leave every other workspace running.'],
        ].map(([number, title, description]) => <article key={title} className="bg-surface-1 p-6 lg:p-8"><span className="font-mono text-caption text-muted-foreground">{number}</span><h3 className="mt-7 text-title font-semibold tracking-tight">{title}</h3><p className="mt-3 text-pretty text-body leading-relaxed text-muted-foreground">{description}</p></article>)}
      </div>
      <Card className="mt-6 bg-surface-1 shadow-surface-3"><CardContent className="grid gap-5 p-5 lg:grid-cols-[0.8fr_auto_1.2fr_auto_0.8fr] lg:items-center lg:p-7">
        <div className="rounded-lg bg-surface-2 p-4 shadow-surface-1"><span className="text-caption text-muted-foreground">Cloud storage</span><strong className="mt-2 block text-body">gitspace-self-hosting</strong><span className="mt-1 block font-mono text-caption text-muted-foreground">closed · durable</span></div>
        <span className="hidden text-muted-foreground lg:block">→</span>
        <div className="rounded-lg bg-foreground p-4 text-background shadow-surface-2"><span className="text-caption opacity-65">Studio · selected by capability</span><strong className="mt-2 block text-body">Workspace open</strong><span className="mt-3 flex flex-wrap gap-2"><span className="rounded-md bg-white/10 px-2 py-1 font-mono text-[11px]">docker</span><span className="rounded-md bg-white/10 px-2 py-1 font-mono text-[11px]">production</span><span className="rounded-md bg-white/10 px-2 py-1 font-mono text-[11px]">gitspace.release</span></span></div>
        <span className="hidden text-muted-foreground lg:block">→</span>
        <div className="rounded-lg bg-surface-2 p-4 shadow-surface-1"><span className="text-caption text-muted-foreground">Account release</span><strong className="mt-2 block text-body">Updated in place</strong><span className="mt-1 block font-mono text-caption text-muted-foreground">other work · uninterrupted</span></div>
      </CardContent></Card>
    </div>
  </section>;
}

export function ChainSection() {
  const [active, setActive] = useState<string | null>('fleet');
  const phases = ['Plan', 'Code', 'Review', 'Ship'] as const;
  return <section className="mx-auto w-full max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
    <div className="max-w-3xl"><Badge color="gray">Goal chains</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">Big features ship in order.</h2><p className="mt-5 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">Chain related goals across workspaces. Each link keeps its own owner, phase, evidence, and review state while blocked work waits for its ancestor.</p></div>
    <div className="mt-12 grid gap-3 lg:grid-cols-4">{phases.map((phase) => <div key={phase} className="rounded-xl bg-surface-2 p-3 shadow-surface-2"><div className="flex items-center justify-between px-2 py-2"><strong className="text-caption uppercase tracking-wider">{phase}</strong><span className="text-caption text-muted-foreground">{chains.filter((item) => item.phase === phase).length}</span></div><div className="mt-2 space-y-2">{chains.filter((item) => item.phase === phase).map((item) => { const selected = active === item.id; return <button key={item.label} type="button" onMouseEnter={() => setActive(item.id)} onFocus={() => setActive(item.id)} onClick={() => setActive(selected ? null : item.id)} className={`w-full rounded-lg bg-surface-1 p-4 text-left shadow-surface-1 transition-opacity ${active && !selected ? 'opacity-35' : 'opacity-100'}`}><span className={`mb-5 block h-1 w-8 rounded-full ${item.tone}`} /><strong className="block text-body">{item.label}</strong><span className="mt-2 block font-mono text-caption text-muted-foreground">chain/{item.id}</span></button>;})}</div></div>)}</div>
    <p className="mt-4 text-center text-caption text-muted-foreground">Hover or focus a card to trace its chain across phases.</p>
  </section>;
}

const products = {
  Intent: [
    ['Goal', 'Outcome, constraints, and observable requirements.'],
    ['Workflow', 'The workspace execution contract.'],
    ['Rubric', 'The standard used to judge completion.'],
    ['Notes', 'Durable project and workspace context.'],
  ],
  Proof: [
    ['Journal', 'Phase narrative, decisions, and state snapshots.'],
    ['Review', 'Threads attached to files, hunks, lines, or the workspace.'],
    ['Change Guide', 'A review path grounded in the goal, evidence, and diff.'],
    ['Artifacts', 'Files and proof produced by the work.'],
  ],
  Operation: [
    ['Services', 'Processes and previews that belong to the workspace.'],
    ['Events', 'Runtime state changes and failures.'],
    ['Crons', 'Scheduled work managed from the account.'],
    ['Release', 'Deployment state, ownership, and rollback.'],
  ],
} as const;

export function WorkspaceProductsSection() {
  const [tab, setTab] = useState<keyof typeof products>('Intent');
  return <section className="bg-surface-2 py-20 lg:py-28"><div className="mx-auto grid w-full max-w-7xl gap-12 px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-10">
    <div className="max-w-xl"><Badge color="gray">Workspace products</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">The context is a product, not prompt stuffing.</h2><p className="mt-5 text-subtitle leading-relaxed text-muted-foreground">GitSpace gives intent, proof, and operations their own durable surfaces. Agents read them. Humans review them. Neither has to excavate a transcript.</p></div>
    <Card className="bg-surface-1 shadow-surface-3"><CardContent className="p-5 lg:p-7"><div className="flex flex-wrap gap-2" role="tablist" aria-label="Workspace product categories">{Object.keys(products).map((name) => <Button key={name} variant={tab === name ? 'primary' : 'secondary'} size="compact" onClick={() => setTab(name as keyof typeof products)}>{name}</Button>)}</div><div className="mt-6 grid gap-3 sm:grid-cols-2">{products[tab].map(([title, description]) => <div key={title} className="rounded-lg bg-surface-2 p-4 shadow-surface-1"><strong className="text-body">{title}</strong><p className="mt-2 text-caption leading-relaxed text-muted-foreground">{description}</p></div>)}</div></CardContent></Card>
  </div></section>;
}

export function OmpSection() {
  return <section className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-10 lg:py-28">
    <Card className="overflow-hidden bg-foreground text-background shadow-surface-3"><CardContent className="p-0"><div className="border-b border-white/15 px-5 py-3 font-mono text-caption opacity-60">workspace / agent session</div><div className="space-y-4 p-6 font-mono text-caption leading-relaxed lg:p-8"><p className="opacity-55">Goal: make machine state obvious across the fleet.</p><p><span className="opacity-55">assistant</span><br />I found the state reducer and the fleet row. The current UI collapses waiting and closed.</p><p><span className="opacity-55">tool · read</span><br />packages/web/src/MachineList.tsx</p><p><span className="opacity-55">assistant</span><br />I will preserve the runtime state and change only its presentation.</p></div></CardContent></Card>
    <div className="max-w-xl"><Badge color="gray">Powered by OMP</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">The agent runs where the workspace lives.</h2><p className="mt-5 text-subtitle leading-relaxed text-muted-foreground">GitSpace runs OMP sessions on the selected machine and renders their blocks natively in the browser. Tools, questions, artifacts, and decisions remain legible without turning the whole product into a terminal.</p><a href="https://github.com/can1357/oh-my-pi" className="mt-7 inline-flex items-center gap-2 text-body font-medium">Explore OMP <ArrowRight width={16} height={16} /></a></div>
  </section>;
}

export function AskSection() {
  const [answer, setAnswer] = useState<string | null>(null);
  return <section className="bg-surface-2 py-20 lg:py-28"><div className="mx-auto grid w-full max-w-7xl gap-12 px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-10"><div className="max-w-xl"><Badge color="gray">Native decisions</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">A question should look like a question.</h2><p className="mt-5 text-subtitle leading-relaxed text-muted-foreground">When an agent needs judgment, GitSpace renders the options as an interaction and puts the workspace into an attention state. No prompt hidden between tool calls.</p></div><Card className="bg-surface-1 shadow-surface-3"><CardContent className="p-6 lg:p-8"><Badge color={answer ? 'green' : 'orange'}>{answer ? 'Answered' : 'Needs attention'}</Badge><h3 className="mt-5 text-title font-semibold">Where should this workspace run?</h3><p className="mt-2 text-body text-muted-foreground">The repository needs Docker and the production secrets scope.</p><div className="mt-6 space-y-3">{[['Studio', 'Online · Docker · production access'], ['Cloud sandbox', 'Sleeping · isolated · no production access']].map(([name, detail]) => <button key={name} type="button" onClick={() => setAnswer(name)} className={`flex min-h-16 w-full items-center justify-between gap-4 rounded-lg p-4 text-left shadow-surface-1 ${answer === name ? 'bg-foreground text-background' : 'bg-surface-2'}`}><span><strong className="block text-body">{name}</strong><span className={`mt-1 block text-caption ${answer === name ? 'opacity-70' : 'text-muted-foreground'}`}>{detail}</span></span>{answer === name ? <CheckCircle width={18} height={18} /> : null}</button>)}</div></CardContent></Card></div></section>;
}

const capabilities = [
  ['Fleet', 'Your computers and managed cloud machines', 'Current state and placement'],
  ['Work', 'Projects, workspaces, phases, and chains', 'Move, archive, release'],
  ['Agents', 'OMP sessions and native block transcripts', 'Structured questions and inbox'],
  ['Context', 'Goals, workflows, rubrics, and notes', 'Durable agent-readable intent'],
  ['Review', 'Diff threads, evidence, journals, and guides', 'Reviewable completion claims'],
  ['Runtime', 'Services, previews, events, and crons', 'Operational state after merge'],
  ['Extensibility', 'Skills and Composio integrations', 'Assigned by account or project'],
  ['Security', 'Signed devices, sealed credentials, encrypted artifacts', 'Documented relay boundaries'],
] as const;

export function CapabilityMatrix() {
  return <section id="features" className="mx-auto w-full max-w-7xl px-6 py-20 lg:px-10 lg:py-28"><div className="max-w-3xl"><Badge color="gray">The whole system</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">Not another agent launcher.</h2><p className="mt-5 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">Launching an agent is the easy part. GitSpace organizes the intent before it starts, the attention it needs while running, and the proof and operations that remain afterward.</p></div><div className="mt-12 overflow-hidden rounded-xl bg-border shadow-surface-3"><div className="hidden grid-cols-[0.55fr_1fr_1fr] gap-px bg-border md:grid"><span className="bg-surface-2 p-4 text-caption font-semibold">Surface</span><span className="bg-surface-2 p-4 text-caption font-semibold">What lives there</span><span className="bg-surface-2 p-4 text-caption font-semibold">Why it matters</span></div>{capabilities.map(([name, contents, reason]) => <div key={name} className="grid gap-px bg-border md:grid-cols-[0.55fr_1fr_1fr]"><strong className="bg-surface-1 p-4 text-body">{name}</strong><span className="bg-surface-1 p-4 text-body text-muted-foreground">{contents}</span><span className="bg-surface-1 p-4 text-body text-muted-foreground">{reason}</span></div>)}</div></section>;
}

export function PricingSection() {
  return <section id="pricing" className="bg-surface-2 py-20 lg:py-28"><div className="mx-auto grid w-full max-w-7xl gap-8 px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-10"><div className="max-w-xl"><Badge color="gray">Availability</Badge><h2 className="mt-5 text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[1] tracking-[-0.045em]">Invite only while the product is still being shaped.</h2><p className="mt-5 text-subtitle leading-relaxed text-muted-foreground">There is no invented public pricing table. GitSpace is source available, physical machines remain yours, and managed infrastructure can carry provider usage costs.</p></div><div className="grid gap-4 sm:grid-cols-2"><Card className="bg-surface-1 shadow-surface-2"><CardContent className="p-6"><Badge color="green">Your machines</Badge><h3 className="mt-5 text-title font-semibold">Run where the code lives</h3><p className="mt-3 text-body leading-relaxed text-muted-foreground">Install the client, enroll each computer separately, and keep repository placement explicit.</p></CardContent></Card><Card className="bg-surface-1 shadow-surface-2"><CardContent className="p-6"><Badge color="gray">Managed capacity</Badge><h3 className="mt-5 text-title font-semibold">Create sandboxes when needed</h3><p className="mt-3 text-body leading-relaxed text-muted-foreground">Managed sandbox availability and provider charges are shown as part of the product flow, not hidden behind a fake flat price.</p></CardContent></Card></div></div></section>;
}
