import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { ArrowRight } from "lucide-react";

const POSTS = [
  {
    slug: "babysitting-agents-sucks",
    kicker: "The agent fleet · Nº 01",
    title: "Babysitting agents sucks.",
    dek: "Your agent list only knows “spinning or not.” Idle, closed, and asked-you-a-question are different states. Drive the fleet to green.",
    date: "July 2026",
    image: "/blog/babysitting-agents-sucks-og.png",
  },
  { slug: "evidence-not-vibes", kicker: "The agent fleet · Nº 02", title: "Evidence, not vibes.", dek: "“Looks good to me” is not a review when the author is a machine. Rubrics, command judges, and evidence you can replay.", date: "Draft", image: null },
  { slug: "the-change-guide", kicker: "The agent fleet · Nº 03", title: "The change guide.", dek: "Code review as a build-order story: foundations, wiring, surfaces. The analyzer computes it; the agent narrates it.", date: "Draft", image: null },
  { slug: "the-workflow-and-the-goal", kicker: "The agent fleet · Nº 04", title: "The workflow and the goal.", dek: "State the goal and the contract derives: requirements, rubrics, workflow nodes, and an honest phase journal.", date: "Draft", image: null },
  { slug: "the-agent-change", kicker: "The agent fleet · Nº 05", title: "The agent change.", dek: "Blame for the agent age: not who typed the line, but which conceptual change introduced, moved, or refined it.", date: "Draft", image: null },
  { slug: "goals-ship-in-order", kicker: "The agent fleet · Nº 06", title: "Goals ship in order.", dek: "Chains are the plan over goals. Workspaces come and go as execution reaches them.", date: "Draft", image: null },
  { slug: "shipped-isnt-done", kicker: "The agent fleet · Nº 07", title: "Shipped isn’t done.", dek: "Merge is the midpoint. Cron refreshes dashboards from rolled-up artifacts; shipped goals reopen on signals.", date: "Draft", image: null },
];

export default function BlogIndex() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      <header className="border-b border-white/10">
        <div className="container mx-auto px-4 pt-20 pb-14 max-w-4xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">Blog</div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Running a fleet of agents, out loud.</h1>
          <p className="text-lg text-zinc-400 mt-4 max-w-2xl">
            Essays with working demos: what breaks when you run many coding agents at once, and what we’re building to fix it.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-14 max-w-4xl">
        <div className="grid gap-8">
          {POSTS.map((p) => (
            <a
              key={p.slug}
              href={`/blog/${p.slug}`}
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
                  <span>{p.date}</span>
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
