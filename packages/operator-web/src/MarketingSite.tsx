import { Badge, Button, Card, CardContent } from '@gitspace/ui';
import { ArrowRight, CheckCircle, Server01 } from '@untitledui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { MarketingApp } from './MarketingApp.js';
import { MarketingFooter, MarketingNav } from './MarketingChrome.js';

const githubUrl = 'https://github.com/inKibra/gitspace.sh';


function Page({ children }: { children: ReactNode }) {
  return <main className="h-dvh overflow-x-hidden overflow-y-auto bg-background text-foreground antialiased"><MarketingNav />{children}<MarketingFooter /></main>;
}

function usePageTitle(title: string, description?: string, image?: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const updates = [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', `${title} · GitSpace`],
      ['meta[property="og:description"]', description],
      ['meta[property="og:image"]', image],
      ['meta[property="og:url"]', window.location.href],
    ] as const;
    const previous = updates.map(([selector, value]) => {
      const element = value ? document.head.querySelector<HTMLMetaElement>(selector) : null;
      const content = element?.content;
      if (element && value) element.content = value;
      return [element, content] as const;
    });
    document.title = `${title} · GitSpace`;
    return () => {
      document.title = previousTitle;
      previous.forEach(([element, content]) => { if (element && content !== undefined) element.content = content; });
    };
  }, [description, image, title]);
}

function FleetExercise() {
  const seed = [
    ['release-notes', 'Working'], ['auth-cleanup', 'Waiting'], ['docs-launch', 'Asked'], ['billing-spec', 'Closed'],
    ['relay-audit', 'Working'], ['mobile-pass', 'Waiting'], ['machine-setup', 'Working'], ['artifact-proof', 'Asked'],
  ] as const;
  const [resolved, setResolved] = useState<string[]>([]);
  const actionable = seed.filter(([, state]) => state === 'Waiting' || state === 'Asked');
  const done = actionable.filter(([name]) => resolved.includes(name)).length;
  return <Card className="my-10 bg-surface-2 shadow-surface-3"><CardContent className="p-5 lg:p-7">
    <div className="flex flex-wrap items-center justify-between gap-3"><strong className="text-body">Drive the fleet to green</strong><Badge color={done === actionable.length ? 'green' : 'blue'}>{done}/{actionable.length} handled</Badge></div>
    <div className="mt-5 grid gap-2 sm:grid-cols-2">{seed.map(([name, state]) => {
      const handled = resolved.includes(name);
      const current = handled ? 'Working' : state;
      const color = current === 'Working' ? 'bg-emerald-500' : current === 'Waiting' ? 'bg-blue-500' : current === 'Asked' ? 'bg-amber-500' : 'bg-gray-400';
      const canResolve = state === 'Waiting' || state === 'Asked';
      return <button key={name} type="button" disabled={!canResolve || handled} onClick={() => setResolved((value) => [...value, name])} className="flex min-h-14 items-center justify-between gap-4 rounded-lg bg-surface-3 px-4 text-left shadow-surface-1 disabled:cursor-default"><span className="truncate text-body font-medium">{name}</span><span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground"><span className={`size-2 rounded-full ${color}`} />{current}</span></button>;
    })}</div>
  </CardContent></Card>;
}

export function NotesIndex() {
  usePageTitle('Notes');
  return <Page><section className="mx-auto w-full max-w-5xl px-6 pb-24 pt-20 lg:px-10 lg:pt-28"><Badge color="gray">Notes from building GitSpace</Badge><h1 className="mt-5 text-balance text-[clamp(3rem,7vw,6rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Work in public, with the rough edges left in.</h1><p className="mt-6 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">Essays and interactive product arguments from running real fleets of coding agents.</p>
    <a href="/notes/babysitting-agents-sucks" className="mt-14 block"><Card className="bg-surface-2 shadow-surface-3"><CardContent className="grid gap-8 p-7 md:grid-cols-[1fr_auto] md:items-end lg:p-10"><div><Badge color="green">Published · Nº 01</Badge><h2 className="mt-5 text-display font-semibold tracking-tight">Babysitting agents sucks.</h2><p className="mt-4 max-w-2xl text-body leading-relaxed text-muted-foreground">An agent list that only knows “spinning or not” throws away the states that decide where your attention goes.</p></div><span className="inline-flex items-center gap-2 text-body font-medium">Read note <ArrowRight width={17} height={17} /></span></CardContent></Card></a>
  </section></Page>;
}

export function BabysittingAgentsNote() {
  usePageTitle('Babysitting agents sucks', 'Your agent list only knows spinning or not. Idle, closed, and asked-you-a-question are different states.', 'https://gitspace.sh/notes/babysitting-agents-sucks-og.png');
  return <Page>
    <header className="border-y border-border bg-surface-2"><div className="mx-auto w-full max-w-4xl px-6 py-20 lg:px-10 lg:py-28"><Badge color="gray">The agent fleet · Nº 01</Badge><h1 className="mt-6 text-balance text-[clamp(3.25rem,8vw,6.5rem)] font-semibold leading-[0.92] tracking-[-0.055em]">Babysitting agents sucks.</h1><p className="mt-6 text-subtitle text-muted-foreground">It does not have to.</p><p className="mt-8 text-caption text-muted-foreground">Bradley Leatherwood · inkibra</p></div></header>
    <article className="mx-auto w-full max-w-3xl px-6 py-16 text-[1.08rem] leading-8 lg:px-10">
      <video controls playsInline preload="metadata" poster="/notes/fleet-green-poster.jpg" className="mb-12 w-full rounded-xl bg-black shadow-surface-3"><source src="/notes/fleet-green.mp4" type="video/mp4" /></video>
      <p className="mb-6">First, some love. The Codex app is open source and refreshingly un-precious about it: point it at whatever model you like. This is not an argument about the model. It is about the screen around it.</p>
      <p className="mb-6">A side panel of threads works when two or three things are running. A fleet changes the question. A list that only knows “spinning or not” cannot answer the one thing that matters:</p>
      <blockquote className="my-12 border-l-2 border-foreground pl-6 text-display font-medium leading-tight">Which one needs me right now?</blockquote>
      <p className="mb-6">Working, idle, asking, and closed are four different states. When every stopped thread looks identical, you open them one by one. That is the tax, and you pay it in attention.</p>
      <h2 className="mb-5 mt-16 text-display font-semibold tracking-tight">Two things the list throws away</h2>
      <p className="mb-6">The first is the distinction nobody else draws: idle versus closed. Idle means it is your turn. Closed means handled, out of my head. The second is stage: plan, code, review, ship, and maintenance. Together they tell you what to do and in what order.</p>
      <h2 className="mb-5 mt-16 text-display font-semibold tracking-tight">Your attention is the bottleneck</h2>
      <p className="mb-6">You are reviewing agent output, choosing workflows, writing skills, arguing about definition of done, and checking the work. The work got deeper. The last thing you can afford to think about is “what do I look at next?”</p>
      <blockquote className="my-12 border-l-2 border-foreground pl-6 text-display font-medium leading-tight">Compute is cheap. Your attention is the scarce resource. Do not spend it figuring out where to spend it.</blockquote>
      <h2 className="mb-5 mt-16 text-display font-semibold tracking-tight">Green is the goal</h2>
      <p className="mb-6">Give the fleet one low-tax visual and one objective. Re-engage the waiting work, answer the questions, and drive the board to green.</p>
      <FleetExercise />
      <p className="mb-6">A wall of green means every agent still on the board is working and nothing is sitting there waiting on you. Quick switching is solved. Organization is the part that decides whether running a fleet feels like flow or drowning.</p>
      <div className="mt-12 flex flex-wrap gap-3"><a href="/#features"><Button variant="primary">See the product <ArrowRight width={16} height={16} /></Button></a><a href={githubUrl}><Button variant="secondary">View source</Button></a></div>
    </article>
  </Page>;
}

const specs = [
  ['Identity and device authority', 'Ed25519 account roots, root-signed machine grants, and revocable browser devices.', '/docs/security/remote-access'],
  ['Machine and browser connection', 'Production relay routing, signed RPC requests, and explicit confidentiality boundaries.', '/docs/remote-access'],
  ['Workspace lifecycle', 'Goals, phases, journals, review evidence, releases, services, and archives.', '/docs/agent-workflow'],
  ['Production client', 'The current gitspace command surface for account, machine, browser, and maintenance.', '/docs/cli-reference'],
] as const;

export function SpecsPage() {
  usePageTitle('Specs');
  return <Page><section className="mx-auto w-full max-w-6xl px-6 pb-24 pt-20 lg:px-10 lg:pt-28"><Badge color="gray">Product specifications</Badge><h1 className="mt-5 max-w-4xl text-balance text-[clamp(3rem,7vw,6rem)] font-semibold leading-[0.96] tracking-[-0.05em]">The contracts behind the interface.</h1><p className="mt-6 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">Current behavior, current commands, and honest security boundaries. No 0.x architecture.</p><div className="mt-14 grid gap-5 md:grid-cols-2">{specs.map(([title, description, href]) => <a key={title} href={href}><Card className="h-full bg-surface-2 shadow-surface-2"><CardContent className="p-7"><h2 className="text-title font-semibold">{title}</h2><p className="mt-3 text-body leading-relaxed text-muted-foreground">{description}</p><span className="mt-8 inline-flex items-center gap-2 text-body font-medium">Read specification <ArrowRight width={16} height={16} /></span></CardContent></Card></a>)}</div></section></Page>;
}

export function AgentRubricPage() {
  usePageTitle('Agent rubric');
  const criteria = [['Intent', 'The result satisfies the declared goal and every observable requirement.'], ['Correctness', 'The implementation fixes the source problem and preserves relevant invariants.'], ['Evidence', 'Each completion claim points to a run, artifact, test, or observed behavior.'], ['Reviewability', 'The diff, journal, review threads, and change guide explain what changed and why.'], ['Operation', 'Services, releases, failures, ownership, and rollback remain visible after merge.']];
  return <Page><section className="mx-auto w-full max-w-5xl px-6 pb-24 pt-20 lg:px-10 lg:pt-28"><Badge color="gray">Agent rubric</Badge><h1 className="mt-5 text-balance text-[clamp(3rem,7vw,6rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Done is an evidence standard.</h1><p className="mt-6 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">GitSpace makes the review contract visible before and after an agent changes the code.</p><ol className="mt-14 divide-y divide-border rounded-xl bg-surface-2 px-7 shadow-surface-3">{criteria.map(([title, description], index) => <li key={title} className="grid gap-3 py-7 sm:grid-cols-[3rem_12rem_1fr]"><span className="font-mono text-caption text-muted-foreground">0{index + 1}</span><strong className="text-title">{title}</strong><span className="text-body leading-relaxed text-muted-foreground">{description}</span></li>)}</ol></section></Page>;
}

export function EnterprisePage() {
  usePageTitle('Enterprise');
  return <Page><section className="mx-auto grid w-full max-w-6xl gap-12 px-6 pb-24 pt-20 lg:grid-cols-[1fr_0.8fr] lg:px-10 lg:pt-28"><div><Badge color="gray">Enterprise</Badge><h1 className="mt-5 text-balance text-[clamp(3rem,7vw,6rem)] font-semibold leading-[0.96] tracking-[-0.05em]">Bring the fleet model to your engineering organization.</h1><p className="mt-6 max-w-2xl text-subtitle leading-relaxed text-muted-foreground">GitSpace is currently invite only. Talk to inkibra about account rollout, managed sandboxes, machine placement, identity boundaries, and the product roadmap.</p><a href="mailto:hello@inkibra.com" className="mt-9 inline-block"><Button variant="primary" size="lg">Contact inkibra <ArrowRight width={18} height={18} /></Button></a></div><Card className="self-start bg-surface-2 shadow-surface-3"><CardContent className="p-7"><div className="flex items-center gap-3"><Server01 width={20} height={20} /><strong className="text-body">Deployment conversation</strong></div><ul className="mt-6 space-y-4">{['Physical machines and managed sandboxes', 'Root-signed device authority', 'Per-account Worker, relay, state, and storage', 'Workspace review and operational evidence', 'Current limits and security boundaries'].map((item) => <li key={item} className="flex gap-3 text-body text-muted-foreground"><CheckCircle className="mt-0.5 shrink-0 text-foreground" width={17} height={17} />{item}</li>)}</ul></CardContent></Card></section></Page>;
}

function NotFoundPage() {
  usePageTitle('Not found');
  return <Page><section className="mx-auto w-full max-w-3xl px-6 py-28 text-center"><Badge color="gray">404</Badge><h1 className="mt-5 text-display font-semibold">That page does not exist.</h1><a href="/" className="mt-8 inline-block"><Button variant="primary">Back to GitSpace</Button></a></section></Page>;
}

export function MarketingRouter() {
  const path = window.location.pathname.replace(/\/$/u, '') || '/';
  if (path === '/') return <MarketingApp />;
  if (path === '/notes') return <NotesIndex />;
  if (path === '/notes/babysitting-agents-sucks') return <BabysittingAgentsNote />;
  if (path === '/specs') return <SpecsPage />;
  if (path === '/agent-rubric') return <AgentRubricPage />;
  if (path === '/enterprise') return <EnterprisePage />;
  return <NotFoundPage />;
}
