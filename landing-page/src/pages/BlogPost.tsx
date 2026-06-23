import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import FaultyTerminal from "../components/landing/FaultyTerminal";
import { Button } from "../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { FindTheOne } from "../components/blog/FindTheOne";
import { AxesPeel } from "../components/blog/AxesPeel";
import { WordsVsColor } from "../components/blog/WordsVsColor";
import { ResolveFleet } from "../components/blog/ResolveFleet";

/* small typographic helpers ------------------------------------------------ */
function H2({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-3xl md:text-4xl font-bold tracking-tight mt-20 mb-2 scroll-mt-24">
      {children}
    </h2>
  );
}
function Rule() {
  return <div className="text-green-500/60 tracking-[0.5em] mb-8 select-none">———</div>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-zinc-300 text-lg leading-relaxed mb-6">{children}</p>;
}
function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[0.85em] text-green-400 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5">{children}</code>;
}
function Quote({ children }: { children: React.ReactNode }) {
  return <blockquote className="border-l-2 border-green-500 pl-5 my-10 text-2xl md:text-3xl text-zinc-100 leading-snug italic">{children}</blockquote>;
}
function Wide({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <div className="my-10 -mx-4 sm:mx-0">
      <div className="lg:-mx-24">{children}</div>
      {caption && <div className="text-center text-[12px] text-zinc-500 mt-3 font-mono">{caption}</div>}
    </div>
  );
}

const Legend = () => (
  <div className="flex flex-wrap gap-x-6 gap-y-2 my-8 text-sm font-mono">
    {[
      ["bg-green-500", "green — working"],
      ["bg-blue-500", "blue — idle, waiting on you"],
      ["bg-amber-400", "amber — escalation"],
      ["bg-zinc-600", "dim — closed, handled"],
    ].map(([c, l]) => (
      <span key={l} className="flex items-center gap-2 text-zinc-400">
        <span className={`h-2.5 w-2.5 rounded-full ${c}`} />
        {l}
      </span>
    ))}
  </div>
);

export default function BlogPost() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      {/* hero */}
      <header className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 w-full h-full z-0 opacity-[0.12]">
          <FaultyTerminal scale={2} gridMul={[2, 1]} digitSize={1.2} timeScale={0.4} pause={false} scanlineIntensity={0.3} glitchAmount={1} flickerAmount={1} noiseAmp={1} chromaticAberration={0} dither={1} curvature={0} tint="#22c55e" mouseReact={false} pageLoadAnimation={false} brightness={0.4} />
        </div>
        <div className="relative z-10 container mx-auto px-4 pt-24 pb-20 max-w-3xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet, part one</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            Babysitting agents <span className="text-amber-400">sucks</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">And here’s how to make it better.</p>
          <div className="flex items-center gap-3 text-sm text-zinc-500">
            <div className="h-8 w-8 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center text-green-400 font-mono text-xs">BL</div>
            <span>Bradley Leatherwood</span>
            <span className="text-zinc-700">·</span>
            <span>gitspace.sh</span>
          </div>
        </div>
      </header>

      {/* article */}
      <article className="container mx-auto px-4 py-16 max-w-3xl">
        <P>
          First, some love. The <strong className="text-white">Codex app</strong> is open-source and refreshingly un-precious about it — point it at
          whatever model you like. Ours is <strong className="text-white">GPT-5.5</strong>, which is a joy for rapid prototyping. None of what follows is
          about the model, or really about Codex.
        </P>
        <P>
          It’s about one screen. Open the app and you get a side panel of threads, sorted by when you last touched them, each with a little spinner when
          it’s busy. Fine when you have two or three things going. But you don’t run two or three agents anymore — you run a whole fleet, and a list that
          only knows “spinning or not” can’t answer the only question that matters:
        </P>
        <Quote>Which one needs me right now?</Quote>

        <P>
          Try it. Some of these agents are still working. Three have stopped — and one of those is <em className="text-zinc-100">idle</em>, waiting on
          your next move (the others you closed, or are escalating). Codex only knows whether a thread is spinning. Find the idle one on the left.
        </P>
        <Wide caption="“Spinning or not” isn’t a status. Working, idle, escalating, and closed are four different things.">
          <FindTheOne />
        </Wide>

        <P>
          The list knows one bit about each agent: spinning, or not. Everything that’s stopped — idle and waiting on you, closed and done, escalating
          for an answer — looks identical. To tell them apart you open them, one by one. That’s the tax, and it’s paid in the one currency you can’t
          print more of.
        </P>

        <H2 id="missing">Two things the list throws away</H2>
        <Rule />
        <P>
          The wall of words isn’t missing information so much as <em className="text-zinc-100">organization</em>. The panel knows one thing — spinning or
          not — and collapses two that matter. Add them back:
        </P>
        <Wide>
          <AxesPeel />
        </Wide>
        <P>
          The big one is the distinction nobody else draws: <strong className="text-white">idle vs. closed</strong>. Codex shows “active.” But the moment
          an agent stops, you’re blind — is it idle and waiting on your next move, or did you already close it? In gitspace those are different states.
          Idle means <Code>it’s your turn</Code>; closed means <Code>handled — out of my head.</Code> Knowing which is which is the difference between
          calm and dread.
        </P>
        <P>
          The second is <strong className="text-white">stage</strong> — plan, code, review, ship, maintenance. Not “does it need me,” but “where is it in
          its life.” Together they tell you what to do <em className="text-zinc-100">and</em> in what order.
        </P>

        <H2 id="glance">Your eyes vs. a list of words</H2>
        <Rule />
        <P>
          State and stage are the <em className="text-zinc-100">information</em>. Color is the <em className="text-zinc-100">enrichment</em> that makes it
          glanceable — and that part isn’t taste, it’s how vision works. Reading words is serial; your brain does them one at a time. Spotting an odd
          color is <em className="text-zinc-100">pre-attentive</em> — about 200ms, in parallel, before you’re even “looking.” Time yourself reading the
          tiles, then time yourself just looking. The gap is the whole point.
        </P>
        <Wide>
          <WordsVsColor />
        </Wide>
        <Legend />

        <H2 id="bottleneck">Your attention is the bottleneck</H2>
        <Rule />
        <P>
          Step back and look at where your day actually goes. You’re reviewing agent slop. You’re deciding which workflow to reach for, and which
          skills to write — or to have an agent write. You’re drafting plans as HTML so humans and agents read from the same page, arguing definition
          of done, standing up reviewer agents to check the work. The work got <em className="text-zinc-100">deeper</em>, not lighter.
        </P>
        <P>
          So the last thing you can afford to spend cognition on is <strong className="text-white">“what do I look at next.”</strong> That’s pure
          overhead — and it’s the exact tax that ends in burnout. When the answer to “where do I look” is itself hard, you don’t look. You drift.
        </P>
        <Quote>Compute is cheap. Your attention is the scarce resource. Don’t spend it figuring out where to spend it.</Quote>

        <H2 id="green">Green is the goal</H2>
        <Rule />
        <P>
          The fix is to give the whole job a shape you can win: one low-tax visual, one objective. Drive the blues and ambers to green. That’s it.
          Resolve the fleet below — approve the ambers, re-engage the blues — and watch the bar fill.
        </P>
        <Wide>
          <ResolveFleet />
        </Wide>
        <P>
          Superhuman didn’t make email more powerful; it made <em className="text-zinc-100">getting to zero</em> a game you could win, and that changed
          how it felt to do the work. Inbox zero, for your fleet. A wall of green means every agent is either working for you or parked by you — fully
          utilized, fully attended.
        </P>

        <H2 id="close">Babysitting agents shouldn’t suck</H2>
        <Rule />
        <P>
          Plenty of tools nailed quick-switching between threads. Nobody has nailed the <em className="text-zinc-100">organization</em> — telling you, at
          a glance and without thinking, which workspace is humming along and which one is standing there waiting for you. That’s the part we obsess
          over, because it’s the part that decides whether running a fleet of agents feels like flow or like drowning.
        </P>
        <P>You’re going to be running more agents next year, not fewer. The bar is how you keep your head above them.</P>

        <div className="mt-12 flex flex-col sm:flex-row gap-4">
          <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
            <Button size="lg" className="bg-white text-black hover:bg-gray-200 h-12 px-8 text-base">
              <Github className="w-5 h-5 mr-2" /> Star on GitHub
            </Button>
          </a>
          <a href="/docs">
            <Button variant="outline" size="lg" className="h-12 px-8 text-base border-white/10 hover:bg-white/5">
              Read the Docs <ArrowRight className="ml-2 w-4 h-4" />
            </Button>
          </a>
        </div>
      </article>

      <Footer />
    </div>
  );
}
