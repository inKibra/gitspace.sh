import { Accordion, Button, ThinkingIndicator } from '@gitspace/ui';
import { repositoryDiffViewSchema, sharedGuideDeniedSchema, sharedGuideSchema, type SharedGuide as SharedGuideView, type SharedGuideDenied } from '@gitspace/protocol/inspector-contract';
import { useEffect, useState } from 'react';
import { EmptyState } from './GitSpaceShell.js';
import { GuideWalkthroughSection } from './inspector/Inspector.js';

/** Diffs load as they near the browser viewport: the page itself scrolls. */
const VIEWPORT = { current: null };
type Loaded = { kind: 'loading' } | { kind: 'ready'; guide: SharedGuideView } | { kind: 'denied'; denied: SharedGuideDenied } | { kind: 'error'; message: string };

async function readError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `The link answered ${response.status}`;
}

/** The read-only page behind a Change Guide share link: the guide pinned at one revision, with each exhibit's diff. */
export function SharedGuide() {
  const api = `/v1${window.location.pathname}`;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [open, setOpen] = useState<string[]>([]);
  const [done, setDone] = useState(new Set<string>());
  const [openedGates, setOpenedGates] = useState(new Set<string>());
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch(api, { credentials: 'same-origin', cache: 'no-store' });
      const next: Loaded = response.ok ? { kind: 'ready', guide: sharedGuideSchema.parse(await response.json()) }
        : response.status === 401 || response.status === 403 ? { kind: 'denied', denied: sharedGuideDeniedSchema.parse(await response.json()) }
          : { kind: 'error', message: await readError(response) };
      if (!active) return;
      setLoaded(next);
      if (next.kind === 'ready') {
        document.title = `${next.guide.title} · Change Guide`;
        setOpen(next.guide.sections.slice(0, 1).map((section) => section.id));
      }
    })().catch((cause: unknown) => { if (active) setLoaded({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [api]);
  const loadDiff = async (path: string) => {
    const response = await fetch(`${api}/diff?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response));
    return repositoryDiffViewSchema.parse(await response.json());
  };
  if (loaded.kind === 'loading') return <div className="flex min-h-dvh items-center justify-center"><ThinkingIndicator aria-label="Loading Change Guide" /></div>;
  if (loaded.kind === 'error') return <div className="mx-auto max-w-xl p-8"><EmptyState title="Change Guide unavailable" description={loaded.message} /></div>;
  if (loaded.kind === 'denied') {
    const { denied } = loaded;
    return <div className="mx-auto max-w-xl p-8"><EmptyState
      title={denied.denied === 'sign-in' ? 'Sign in with GitHub to read this Change Guide' : 'No access to this Change Guide'}
      description={denied.denied === 'sign-in'
        ? `It describes changes to the private repository ${denied.repository}. Anyone who can read that repository on GitHub can read the guide.`
        : `${denied.login ?? 'This GitHub account'} cannot read ${denied.repository}. Ask for access to the repository, or sign in with another GitHub account.`}
      action={denied.signIn ? <Button variant="primary" asChild><a href={denied.signIn}>{denied.denied === 'sign-in' ? 'Sign in with GitHub' : 'Sign in again'}</a></Button> : undefined}
    /></div>;
  }
  const { guide } = loaded;
  return <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-6">
    <header className="flex flex-col gap-1">
      <span className="text-caption text-muted-foreground">Change Guide · {guide.repository}</span>
      <h1 className="text-title font-semibold">{guide.title}</h1>
      <span className="text-caption text-muted-foreground tabular-nums">
        {guide.baseRef} · {guide.baseCommit.slice(0, 7)}…{guide.headCommit.slice(0, 7)} · {done.size} / {guide.sections.length} phases read · shared {new Date(guide.sharedAt).toLocaleDateString()}
      </span>
    </header>
    <Accordion type="multiple" value={open} onValueChange={setOpen} className="w-full">
      {guide.sections.map((section, index) => <GuideWalkthroughSection
        key={section.id} section={section} index={index} root={VIEWPORT} done={done.has(section.id)} openedGates={openedGates}
        onToggleDone={() => setDone((current) => new Set(current).add(section.id))}
        onGateOpen={(path) => setOpenedGates((current) => new Set(current).add(path))}
        onLoadDiff={loadDiff}
        review={null}
      />)}
    </Accordion>
  </div>;
}
