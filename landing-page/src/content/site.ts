/**
 * Site-wide content manifest — the single source of truth for what exists,
 * what is public, and what search engines are allowed to see.
 *
 * Four things derive from the `status` field and nothing else:
 *   - visibility        (drafts are dev-only; they 404 in production)
 *   - nav grouping      (in-development pages sit under their own heading)
 *   - sitemap.xml       (published only — a sitemap is an invitation to crawl)
 *   - rss.xml           (published posts only)
 *
 * Promoting a page or post is a one-word change here. That is the point: if
 * promotion were a chore, "in development" would become where work goes to die.
 */

export type Status =
  /** Unfinished. Visible in dev, absent in prod. Never indexed. */
  | 'draft'
  /** Public on purpose, but still moving. Indexed: no. In the nav: yes, under its own heading. */
  | 'in-development'
  /** Done. Indexed, in the sitemap, in the feed. */
  | 'published';

export const SITE = {
  origin: 'https://gitspace.sh',
  name: 'gitspace',
  title: 'GitSpace — run a fleet of coding agents without babysitting them',
  description:
    'Git worktrees, a board that tells you which agent needs you, and evidence you can replay. Secure remote terminal access over an E2E encrypted relay.',
  author: 'Bradley Leatherwood',
  /** Site-wide OG card, used by any page without its own. Must exist in public/. */
  ogImage: '/og-image.png',
  locale: 'en',
} as const;

export type Page = {
  path: string;
  title: string;
  description: string;
  status: Status;
  /**
   * Nav heading this page sits under. Pages with no group are reachable but
   * unlisted — the homepage and the blog index are linked from the chrome
   * itself, so they do not need a nav entry.
   */
  navGroup?: string;
  /** Last meaningful edit, ISO date. Feeds sitemap <lastmod>. */
  updated?: string;
};

/**
 * Static pages. Blog posts live in posts.ts — they have their own shape
 * (kicker, dek, OG card) and their own ordering rules.
 */
export const PAGES: Page[] = [
  {
    path: '/',
    title: SITE.title,
    description: SITE.description,
    status: 'published',
    updated: '2026-08-17',
  },
  {
    path: '/notes',
    title: 'Notes — running a fleet of agents, out loud',
    description:
      'Essays with working demos: what breaks when you run many coding agents at once, and what we are building to fix it.',
    status: 'published',
    updated: '2026-08-17',
  },
  {
    path: '/docs',
    title: 'Docs — GitSpace CLI, remote access, and identity',
    description:
      'Install GitSpace, create workspaces from git worktrees, and set up E2E encrypted remote terminal access.',
    status: 'published',
    navGroup: 'Documentation',
    updated: '2026-08-17',
  },
  {
    path: '/enterprise',
    title: 'Enterprise rollout — an agent factory, stood up for you',
    description:
      'inkibra stands up the harness on your infrastructure, tunes it to your codebase, and runs it with your team.',
    status: 'published',
    navGroup: 'Documentation',
    updated: '2026-08-17',
  },
  {
    path: '/specs',
    title: 'Specs — open standards and design docs in progress',
    description:
      'Design docs and open standards we are building in the open. Public on purpose, and still moving.',
    status: 'published',
    navGroup: 'Documentation',
    updated: '2026-08-17',
  },
  {
    path: '/agent-rubric',
    title: 'Agent Rubric — an open standard for typed proof graphs',
    description:
      'A canonical proof-and-judgment graph for agent work: what evidence to collect, which judges to run, and which artifacts decide.',
    status: 'in-development',
    navGroup: 'In development',
    updated: '2026-08-17',
  },
];

/**
 * Specs listed on /specs. Each one is a real page in PAGES above — this adds
 * the shelf copy: what it is, and how settled it is.
 *
 * The index page itself is 'published' (it should be found), while the specs on
 * it are usually 'in-development' (they should be read, not ranked). Promoting a
 * spec means flipping its status in PAGES and moving it out of the
 * In-development nav group.
 */
export type Spec = {
  path: string;
  name: string;
  summary: string;
  /** Where it is in its life, in plain words. Shown as a badge. */
  stage: 'Draft' | 'Proposed' | 'Stable';
  updated: string;
};

export const SPECS: Spec[] = [
  {
    path: '/agent-rubric',
    name: 'Agent Rubric',
    summary:
      'A canonical proof-and-judgment graph for agent work. Declare what evidence to collect, which judges rule on it, and which typed artifacts decide or rank a candidate.',
    stage: 'Draft',
    updated: '2026-08-17',
  },
];

/** Pages that ship to production. Drafts are stripped from the prod bundle. */
export const publishedPages = (): Page[] => PAGES.filter((p) => p.status !== 'draft');

/** Pages a crawler may index. In-development work is deliberately excluded. */
export const indexablePages = (): Page[] => PAGES.filter((p) => p.status === 'published');

/**
 * Nav sections, in declaration order, skipping ungrouped and draft pages.
 * Returns [] for a group with no visible members rather than an empty heading.
 */
export const navSections = (isDev: boolean): Array<{ group: string; pages: Page[] }> => {
  const visible = PAGES.filter((p) => (isDev ? true : p.status !== 'draft') && p.navGroup);
  const order: string[] = [];
  for (const p of visible) if (p.navGroup && !order.includes(p.navGroup)) order.push(p.navGroup);
  return order.map((group) => ({ group, pages: visible.filter((p) => p.navGroup === group) }));
};
