import { Button } from '@gitspace/ui';
import { ArrowRight } from '@untitledui/icons';

const githubUrl = 'https://github.com/inKibra/gitspace.sh';

export function MarketingNav() {
  return <>
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-5 lg:px-10">
      <a href="/" className="shrink-0 text-title font-semibold tracking-tight">GitSpace</a>
      <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Site navigation">
        <a href="/#features" className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">Features</a>
        <a href="/#pricing" className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">Pricing</a>
        <a href="/notes" className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">Notes</a>
        <a href="/docs/" className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">Docs</a>
        <a href="/specs" className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">Specs</a>
        <a href={githubUrl} className="flex min-h-10 items-center rounded-lg px-3 text-body text-muted-foreground hover:bg-surface-2 hover:text-foreground">GitHub</a>
      </nav>
      <a href="/#start"><Button variant="primary">Use invitation <ArrowRight width={16} height={16} /></Button></a>
    </header>
    <nav className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-4 pb-3 lg:hidden" aria-label="Mobile site navigation">
      {[['Features', '/#features'], ['Notes', '/notes'], ['Docs', '/docs/'], ['Specs', '/specs'], ['Pricing', '/#pricing']].map(([label, href]) => <a key={label} href={href} className="flex min-h-9 shrink-0 items-center rounded-lg px-3 text-caption text-muted-foreground hover:bg-surface-2 hover:text-foreground">{label}</a>)}
    </nav>
  </>;
}

export function MarketingFooter() {
  const groups = [
    ['Product', [['Features', '/#features'], ['Pricing', '/#pricing'], ['Enterprise', '/enterprise'], ['Agent rubric', '/agent-rubric']]],
    ['Resources', [['Docs', '/docs/'], ['Specs', '/specs'], ['Notes', '/notes'], ['Security', '/docs/security/remote-access']]],
    ['Company', [['About inkibra', 'https://inkibra.com'], ['GitHub', githubUrl], ['Discord', 'https://discord.gg/gitspace']]],
  ] as const;
  return <footer className="border-t border-border bg-surface-2">
    <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-10">
      <div><a href="/" className="text-title font-semibold tracking-tight">GitSpace</a><p className="mt-4 max-w-xs text-body leading-relaxed text-muted-foreground">The browser workspace for coding agents running across your machines.</p><p className="mt-6 text-caption text-muted-foreground">Built by inkibra.</p></div>
      {groups.map(([label, links]) => <div key={label}><h2 className="text-caption font-semibold uppercase tracking-wider text-foreground">{label}</h2><ul className="mt-4 space-y-3">{links.map(([name, href]) => <li key={name}><a href={href} className="text-body text-muted-foreground hover:text-foreground">{name}</a></li>)}</ul></div>)}
    </div>
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 border-t border-border px-6 py-6 text-caption text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-10"><span>© {new Date().getFullYear()} inkibra. Source available.</span><span>Signed devices · encrypted artifacts · explicit security boundaries</span></div>
  </footer>;
}
