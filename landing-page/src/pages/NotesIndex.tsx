import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { ArrowRight } from "lucide-react";
import { visiblePosts, type Post } from "../content/posts";

/** Human-readable date for a card. Drafts have no date yet, so they say so. */
function cardDate(p: Post): string {
  if (!p.date) return "Draft";
  return new Date(`${p.date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function BlogIndex() {
  // Drafts are visible while developing and stripped from the production build.
  const posts = visiblePosts(import.meta.env.DEV);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      <header className="border-b border-white/10">
        <div className="container mx-auto px-4 pt-20 pb-14 max-w-4xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">Notes</div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Running a fleet of agents, out loud.</h1>
          <p className="text-lg text-zinc-400 mt-4 max-w-2xl">
            Essays with working demos: what breaks when you run many coding agents at once, and what we’re building to fix it.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-14 max-w-4xl">
        <div className="grid gap-8">
          {posts.map((p) => (
            <a
              key={p.slug}
              href={`/notes/${p.slug}`}
              className="group rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden hover:border-zinc-600 transition-colors"
            >
              {p.image ? (
                <img src={p.image} alt={p.title} className="w-full border-b border-[#1a1a1a]" />
              ) : (
                <div className="flex items-center justify-between px-6 py-8 border-b border-[#1a1a1a] font-mono">
                  <span className="text-4xl font-black text-zinc-800">{p.kicker.slice(-5)}</span>
                  <span className="text-[11px] uppercase tracking-widest text-zinc-600">draft · read it, demos inside</span>
                </div>
              )}
              <div className="p-6">
                <div className="text-[12px] font-mono text-green-500/80 uppercase tracking-widest mb-2">{p.kicker}</div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-2">{p.title}</h2>
                <p className="text-zinc-400 mb-4">{p.dek}</p>
                <div className="flex items-center gap-3 text-sm text-zinc-500">
                  <span>Bradley Leatherwood</span>
                  <span className="text-zinc-700">·</span>
                  <span>{cardDate(p)}</span>
                  <span className="ml-auto flex items-center gap-1 text-green-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    Read <ArrowRight className="w-4 h-4" />
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
