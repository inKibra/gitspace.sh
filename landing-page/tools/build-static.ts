/**
 * Post-build static emitter. Runs after `vite build`, over dist/.
 *
 * Emits, all derived from src/content:
 *   dist/<route>/index.html   real HTML per route, with that route's meta tags
 *   dist/sitemap.xml          indexable routes only
 *   dist/rss.xml              published posts only
 *   dist/robots.txt           points at the sitemap
 *   dist/404.html             so unmatched paths get a real 404 status
 *
 * WHY PRERENDER AT ALL
 * The app sets per-page meta in a useEffect, which only runs after React mounts.
 * Crawlers that execute JS may eventually see it; social unfurlers (Slack, X,
 * LinkedIn, iMessage) never do — they read the raw HTML once and give up. Without
 * this step every URL unfurls with the generic site card, so a blog post shared
 * anywhere looks like the CLI landing page.
 *
 * WHY THIS REPLACES THE SPA FALLBACK
 * Every route is static and known at build time, so each one becomes a real file.
 * That lets us drop the `/* -> /index.html 200` catch-all, which was returning
 * HTTP 200 for literally any path — including garbage — and would have let search
 * engines index unlimited duplicate homepages. With the catch-all gone, Cloudflare
 * Pages serves 404.html with a genuine 404 for anything unrecognised.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SITE, indexablePages, publishedPages } from '../src/content/site';
import { publishedPosts, postUrl, postImageUrl } from '../src/content/posts';

const DIST = join(import.meta.dir, '..', 'dist');
const SHELL = join(DIST, 'index.html');

if (!existsSync(SHELL)) {
  console.error('[static] dist/index.html missing — run `vite build` first.');
  process.exit(1);
}

const shell = readFileSync(SHELL, 'utf8');

/** XML/HTML attribute-safe escaping. Deks contain quotes and ampersands. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Meta = {
  path: string;
  title: string;
  description: string;
  image: string;
  type: 'website' | 'article';
  published?: string | null;
  noindex?: boolean;
};

/**
 * Rewrite the shell's head for one route. Replaces rather than appends, so the
 * generic tags baked into index.html cannot survive and win by document order.
 */
function render(meta: Meta): string {
  const url = `${SITE.origin}${meta.path === '/' ? '/' : meta.path}`;
  let html = shell;

  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(meta.title)}</title>`);

  const set = (attr: 'name' | 'property', key: string, value: string) => {
    const re = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="[^"]*"\\s*/?>`, 'i');
    const tag = `<meta ${attr}="${key}" content="${esc(value)}" />`;
    html = re.test(html) ? html.replace(re, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
  };

  set('name', 'title', meta.title);
  set('name', 'description', meta.description);
  set('property', 'og:type', meta.type);
  set('property', 'og:url', url);
  set('property', 'og:title', meta.title);
  set('property', 'og:description', meta.description);
  set('property', 'og:image', meta.image);
  set('property', 'twitter:url', url);
  set('property', 'twitter:title', meta.title);
  set('property', 'twitter:description', meta.description);
  set('property', 'twitter:image', meta.image);

  if (meta.published) set('property', 'article:published_time', meta.published);

  // In-development pages are public but deliberately kept out of search results.
  if (meta.noindex) {
    html = html.replace('</head>', `    <meta name="robots" content="noindex, follow" />\n  </head>`);
  }

  // Canonical stops the same content ranking under several URLs.
  html = html.replace('</head>', `    <link rel="canonical" href="${url}" />\n  </head>`);
  html = html.replace(
    '</head>',
    `    <link rel="alternate" type="application/rss+xml" title="${esc(SITE.name)}" href="${SITE.origin}/rss.xml" />\n  </head>`,
  );

  return html;
}

function emit(path: string, html: string): void {
  // "/" is dist/index.html; "/notes" is dist/notes.html — deliberately FLAT, not
  // dist/notes/index.html.
  //
  // Cloudflare Pages resolves an extensionless request by trying <path>.html
  // first and <path>/index.html second. The directory form works, but Pages
  // answers it with a 308 to the trailing-slash URL (/notes -> /notes/). That
  // would put a redirect hop on every internal link and, worse, disagree with
  // the canonical tags below, which have no trailing slash. The flat form is
  // served directly at the URL we actually publish.
  const file = path === '/' ? SHELL : join(DIST, `${path.replace(/^\//, '')}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// ── pages ────────────────────────────────────────────────────────────────────

const written: string[] = [];

for (const page of publishedPages()) {
  emit(
    page.path,
    render({
      path: page.path,
      title: page.title,
      description: page.description,
      image: `${SITE.origin}${SITE.ogImage}`,
      type: 'website',
      noindex: page.status === 'in-development',
    }),
  );
  written.push(`${page.path}${page.status === 'in-development' ? '  (noindex)' : ''}`);
}

// ── posts ────────────────────────────────────────────────────────────────────

const posts = publishedPosts();

for (const post of posts) {
  emit(
    `/notes/${post.slug}`,
    render({
      path: `/notes/${post.slug}`,
      title: `${post.title} — ${SITE.name}`,
      description: post.dek,
      image: postImageUrl(post),
      type: 'article',
      published: post.date,
    }),
  );
  written.push(`/notes/${post.slug}`);
}

// ── 404 ──────────────────────────────────────────────────────────────────────

writeFileSync(
  join(DIST, '404.html'),
  render({
    path: '/404',
    title: `Page not found — ${SITE.name}`,
    description: 'That page isn’t here.',
    image: `${SITE.origin}${SITE.ogImage}`,
    type: 'website',
    noindex: true,
  }),
);

// ── sitemap ──────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const urls = [
  ...indexablePages().map((p) => ({ loc: `${SITE.origin}${p.path}`, lastmod: p.updated ?? today })),
  ...posts.map((p) => ({ loc: postUrl(p), lastmod: p.date ?? today })),
];

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join('\n')}
</urlset>
`,
);

// ── rss ──────────────────────────────────────────────────────────────────────

const rssDate = (d: string | null): string =>
  new Date(`${d ?? today}T12:00:00Z`).toUTCString();

writeFileSync(
  join(DIST, 'rss.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)}</title>
    <link>${SITE.origin}/notes</link>
    <description>${esc('Essays with working demos: what breaks when you run many coding agents at once.')}</description>
    <language>${SITE.locale}</language>
    <lastBuildDate>${rssDate(posts[0]?.date ?? today)}</lastBuildDate>
    <atom:link href="${SITE.origin}/rss.xml" rel="self" type="application/rss+xml" />
${posts
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${postUrl(p)}</link>
      <guid isPermaLink="true">${postUrl(p)}</guid>
      <pubDate>${rssDate(p.date)}</pubDate>
      <author>${esc(SITE.author)}</author>
      <description>${esc(p.dek)}</description>
    </item>`,
  )
  .join('\n')}
  </channel>
</rss>
`,
);

// ── robots ───────────────────────────────────────────────────────────────────

writeFileSync(
  join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE.origin}/sitemap.xml\n`,
);

console.log(`[static] ${written.length} routes prerendered:`);
for (const w of written) console.log(`         ${w}`);
console.log(`[static] sitemap.xml (${urls.length} urls) · rss.xml (${posts.length} items) · robots.txt · 404.html`);
