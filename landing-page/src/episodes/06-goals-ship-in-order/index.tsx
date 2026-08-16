import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { ChainKanbanShot } from "../../components/landing/ChainKanbanShot";
// island moved to 07 (the surviving merged post); this episode is pending deletion
import { ChainBuilder } from "../07-shipped-isnt-done/islands/ChainBuilder";

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
  return <code className="font-mono text-[0.85em] text-green-400 bg-[#0c0c0c] border border-[#1a1a1a] px-1.5 py-0.5">{children}</code>;
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

const META = {
  title: "Goals ship in order. — gitspace",
  description:
    "Big features don’t fit in one branch, and parallel agents make ordering harder. Chains encode the order: each goal stacks on its ancestor, blocked goals wait, and the board shows the whole line.",
  image: "https://gitspace.sh/blog/goals-ship-in-order-og.png",
  url: "https://gitspace.sh/blog/goals-ship-in-order",
};

export default function BlogPost() {
  // per-post meta (SPA swap; prerender at deploy for crawler coverage)
  useEffect(() => {
    const prevTitle = document.title;
    document.title = META.title;
    const prev: Array<[Element, string | null]> = [];
    const set = (selector: string, content: string) => {
      const el = document.head.querySelector(selector);
      if (el) {
        prev.push([el, el.getAttribute("content")]);
        el.setAttribute("content", content);
      }
    };
    set('meta[name="title"]', META.title);
    set('meta[name="description"]', META.description);
    set('meta[property="og:title"]', META.title);
    set('meta[property="og:description"]', META.description);
    set('meta[property="og:image"]', META.image);
    set('meta[property="og:url"]', META.url);
    set('meta[property="og:type"]', "article");
    set('meta[property="twitter:title"]', META.title);
    set('meta[property="twitter:description"]', META.description);
    set('meta[property="twitter:image"]', META.image);
    set('meta[property="twitter:url"]', META.url);
    return () => {
      document.title = prevTitle;
      prev.forEach(([el, v]) => v != null && el.setAttribute("content", v));
    };
  }, []);

  // dev-only: track-changes overlay (tools/track-changes.ts on :5191)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const s = document.createElement("script");
    s.src = "http://localhost:5191/overlay.js";
    s.async = true;
    s.onerror = () => s.remove();
    document.body.appendChild(s);
    return () => {
      s.remove();
      (window as unknown as { __tcCleanup?: () => void }).__tcCleanup?.();
    };
  }, []);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      {/* hero */}
      <header className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 w-full h-full z-0 opacity-[0.12]">
          <FaultyTerminal scale={2} gridMul={[2, 1]} digitSize={1.2} timeScale={0.4} pause={false} scanlineIntensity={0.3} glitchAmount={1} flickerAmount={1} noiseAmp={1} chromaticAberration={0} dither={1} curvature={0} tint="#22c55e" mouseReact={false} pageLoadAnimation={false} brightness={0.4} />
        </div>
        <div className="relative z-10 container mx-auto px-4 pt-24 pb-20 max-w-3xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 06</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            Goals ship <span className="text-green-400">in order</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            A chain is the plan over goals. Workspaces come and go as execution reaches them. The board shows the whole line.
          </p>
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
          Some features fit in one branch. The ones that matter don’t. A checkout cutover is a schema change, then a backfill job, then the
          flag flip, then an e2e pass that proves the whole thing. Four goals, one order. The backfill can’t start until the schema lands.
          The flags mean nothing until the backfill finishes.
        </P>
        <P>
          The tempting move is to throw four agents at it at once. Now you have four branches, each assuming a world the others haven’t
          built yet. Parallel agents don’t make ordering easier. They make it harder: every agent moves at its own pace, and none of them
          can see the line.
        </P>
        <Quote>The order is part of the plan. It has to live somewhere you and the agents can both read it.</Quote>

        <H2 id="plan">A chain is a plan over goals</H2>
        <Rule />
        <P>
          In gitspace that somewhere is a <strong className="text-white">chain</strong>: an ordered list of goals.{" "}
          <Code>billing-schema → backfill-job → checkout-flags → checkout-e2e</Code>. Each goal stacks on its ancestor. Each goal climbs
          the same ladder: <Code>plan → code → review → ship</Code>. And a descendant can never outpace its ancestor: while{" "}
          <Code>checkout-flags</Code> is still in code, <Code>checkout-e2e</Code> cannot enter review. Blocked goals wait.
        </P>
        <P>
          Here’s the part that takes a minute to sink in: <strong className="text-white">a goal is not a branch</strong>. A goal only
          holds a workspace while an agent is actively working it. Before that it’s <Code>planned · no workspace yet</Code>: a real goal
          you can author, order, and attach requirements to, with zero worktrees on disk. After it merges, the workspace gets deleted.
          The chain keeps the goal; the checkout disappears.
        </P>
        <P>
          So at any moment a chain is mostly plan. One or two goals have live workspaces with agents in them. Everything behind them is
          merged and gone. Everything ahead is queued and weightless.
        </P>

        <H2 id="board">The board shows the line</H2>
        <Rule />
        <P>
          This is what it looks like. Two surfaces, and they answer different questions. The strip along the top is{" "}
          <strong className="text-white">active workspaces and their agent status</strong>, nothing else: it answers “who needs me right
          now.” Chains never appear there, because a chain isn’t running anything; it’s a plan. The board underneath is goals. Hover any
          chained card and the lens lights up its whole line: order badges, guide lines, everything else dimmed.
        </P>
        <Wide caption="Hover or tap a chained card to trace its chain. The strip is workspaces; the board is the plan.">
          <ChainKanbanShot />
        </Wide>
        <P>
          Trace <Code>checkout-cutover</Code>. <Code>billing-schema</Code> already shipped: its card reads{" "}
          <Code>merged · workspace removed</Code>, yet it still holds slot 1 of 4 in the lens. <Code>backfill-job</Code> sits in review.{" "}
          <Code>checkout-flags</Code> holds the only live workspace, agent running. And <Code>checkout-e2e</Code> is queued:{" "}
          <Code>planned · no workspace yet</Code>, blocked by <Code>checkout-flags</Code>. One chain, four goals, exactly one workspace.
        </P>

        <H2 id="build">One verb: add-after</H2>
        <Rule />
        <P>
          Planning a chain is one verb. Pick a goal, say what comes after it. Try it below: the seed goal already has an agent on it. Add
          the next goal after it, then the one after that. Watch the track and the order badges grow, and watch the command each click
          stands for.
        </P>
        <Wide caption="Every click is a real command. The mono log is what you (or an agent) would run.">
          <ChainBuilder />
        </Wide>
        <P>
          Mark the active goal done and two things happen at once. Its workspace goes away, and the next goal stops being paper: it binds
          a workspace, branching from its ancestor’s HEAD, and the agent starts. That handoff is the whole point. Finishing a goal is
          what unblocks the next one.
        </P>
        <P>
          The order isn’t advice, either. Try adding a goal after one that already merged while its descendant is mid-flight. The chain
          refuses: a brand-new goal reads as phase <Code>plan</Code>, and you can’t insert plan-phase work in front of code-phase work.
          Not a warning. A refusal.
        </P>

        <H2 id="durable">Workspaces are execution. The chain is the plan.</H2>
        <Rule />
        <P>
          Because each goal branches from its ancestor’s HEAD, the chain is also a git contract. <Code>space stack status</Code> walks
          adjacent workspaces and reports each edge: <Code>aligned</Code> when the child’s HEAD descends from the parent’s,{" "}
          <Code>needs-rebase</Code> when it doesn’t. When an ancestor moves, you know exactly which goal has rebase work to do before its
          review means anything.
        </P>
        <P>
          And when everything ships, nothing is left running. Every workspace deleted, every branch merged, and the chain still reads top
          to bottom as what happened, in the order it happened.
        </P>

        <H2 id="close">Big features are lines, not piles</H2>
        <Rule />
        <P>
          A fleet without order is a pile of branches racing each other toward a merge conflict. Chains give the fleet a line: each goal
          stacks on the last, blocked goals wait their turn, and the board shows how far along the line you are at a glance.
        </P>
        <P>Spin up as many agents as you want. Goals still ship in order.</P>

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
