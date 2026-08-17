import { SITE, type Status } from './site';

/**
 * The blog manifest. One entry per post, ordered newest-first for display.
 *
 * A post's `status` decides everything downstream — see site.ts. To publish
 * Nº 02, set its status to 'published' and give it a real `date`. Nothing else
 * needs to change: the route mounts, the index lists it, the sitemap and the
 * feed pick it up, and the prerender emits its meta tags.
 */

export type Post = {
  slug: string;
  kicker: string;
  title: string;
  dek: string;
  /**
   * Publication date, ISO (YYYY-MM-DD). Required once published: RSS needs a
   * real pubDate and the sitemap needs a lastmod. Null while drafting.
   */
  date: string | null;
  /** OG card for this post, absolute from site root. Falls back to SITE.ogImage. */
  image: string | null;
  status: Status;
};

const PUBLISHED: Post[] = [
  {
    slug: 'babysitting-agents-sucks',
    kicker: 'The agent fleet · Nº 01',
    title: 'Babysitting agents sucks.',
    dek: 'Your agent list only knows “spinning or not.” Idle, closed, and asked-you-a-question are different states. Drive the fleet to green.',
    date: '2026-08-17',
    image: '/notes/babysitting-agents-sucks-og.png',
    status: 'published',
  },
];

/**
 * Draft entries, dev-only — and the guard is load-bearing.
 *
 * Vite replaces `import.meta.env.DEV` with the literal `false` in a production
 * build, so Rollup drops this array as dead code. Filtering at runtime would
 * NOT work: the object literals would still sit in the bundle, leaking the
 * titles and deks of unpublished posts to anyone who opens devtools.
 *
 * To publish one, move its entry up into PUBLISHED and give it a real date.
 */
const DRAFTS: Post[] = import.meta.env.DEV
  ? [
  {
    slug: 'evidence-not-vibes',
    kicker: 'The agent fleet · Nº 02',
    title: 'Agents lie about what they shipped.',
    dek: 'The good ones lie best. State the goal and the contract derives; a reviewer hunts fake-green tests; judges rule on runs you can replay.',
    date: null,
    image: null,
    status: 'draft',
  },
  {
    slug: 'the-change-guide',
    kicker: 'The agent fleet · Nº 03',
    title: 'The change guide.',
    dek: 'Code review as a build-order story, and blame for the agent age: which conceptual change put this line here, and what was it trying to do.',
    date: null,
    image: null,
    status: 'draft',
  },
  {
    slug: 'shipped-isnt-done',
    kicker: 'The agent fleet · Nº 04',
    title: 'Shipped isn’t done.',
    dek: 'Chains are the plan over goals; workspaces come and go as execution reaches them. Merge is the midpoint, and shipped goals reopen on signals.',
    date: null,
    image: null,
    status: 'draft',
  },
    ]
  : [];

export const POSTS: Post[] = [...PUBLISHED, ...DRAFTS];

/** Live posts, newest first. The only set that reaches production. */
export const publishedPosts = (): Post[] =>
  POSTS.filter((p) => p.status === 'published').sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

/**
 * What the blog index renders. Drafts show while developing so you can keep
 * working on them locally, and vanish in the production build.
 */
export const visiblePosts = (isDev: boolean): Post[] => (isDev ? POSTS : publishedPosts());

/** Absolute URL for a post — needed by RSS and the sitemap, which cannot use relative paths. */
export const postUrl = (p: Post): string => `${SITE.origin}/notes/${p.slug}`;

/** OG card for a post, falling back to the site-wide card. Always absolute. */
export const postImageUrl = (p: Post): string => `${SITE.origin}${p.image ?? SITE.ogImage}`;
