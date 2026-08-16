import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
// island moved to ep02 (its permanent home); this episode is pending cancellation
import { DeriveTheContract } from "../02-evidence-not-vibes/islands/DeriveTheContract";

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
function Cmd({ children }: { children: string }) {
  return (
    <pre className="my-8 overflow-x-auto border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-300">
      {children}
    </pre>
  );
}

const META = {
  title: "The workflow and the goal. — gitspace",
  description:
    "Agents don’t need more instructions; they need a contract. State the goal once and everything derives: requirements with rubrics, a workflow of phases, a journal that keeps intent honest.",
  image: "https://gitspace.sh/blog/the-workflow-and-the-goal-og.png",
  url: "https://gitspace.sh/blog/the-workflow-and-the-goal",
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 04</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            The workflow and the <span className="text-green-400">goal</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">Agents don’t need more instructions. They need a contract.</p>
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
          You wrote the plan. Two thousand words: context, constraints, numbered steps, a definition of done in bold. The agent read it once, folded
          it into its context window, and started. Forty minutes later it was doing something the plan never mentioned, and the doc sat there,
          unchanged and unread.
        </P>
        <P>
          The instinct is to write a better doc. More detail, more capital letters, one more <Code>IMPORTANT</Code>. It doesn’t help, because the doc
          has no mechanism. Nothing checks the agent against it while the work happens. Nothing stops the work when a step gets skipped. A plan that
          nothing executes is a hope.
        </P>
        <Quote>The plan is not a doc you hope the agent reads. It is structure both sides execute.</Quote>

        <H2 id="derive">State the goal once</H2>
        <Rule />
        <P>
          In gitspace, the goal is the single input. State it once and the rest derives from it:
        </P>
        <ul className="text-zinc-300 text-lg leading-relaxed mb-6 space-y-2 list-none pl-0">
          <li>
            <strong className="text-white">Requirements with rubrics.</strong> Each names its evidence (a test run, a screenshot, a note) and the
            rubric that decides acceptance. This is what done means.
          </li>
          <li>
            <strong className="text-white">A workflow.</strong> Phases in order, including which ones run in parallel. This is when work happens.
          </li>
          <li>
            <strong className="text-white">A phase journal.</strong> Intent declared before each phase, outcome recorded after. This is what actually
            happened.
          </li>
        </ul>
        <P>
          Every requirement belongs to a phase. The system’s word for it is <em className="text-zinc-100">owing</em>: the phase owes the requirement,
          and the phase cannot end until everything it owes is accepted. That one word turns a plan into a contract.
        </P>
        <P>
          Watch it happen. Pick a goal, or type your own. Then start the first phase, try to end it early, and see what the gate does.
        </P>
        <Wide caption="Derivation is mechanical and instant. That’s the point: none of this depends on the agent’s mood.">
          <DeriveTheContract />
        </Wide>
        <P>
          Try ending the phase before the evidence exists. The gate blocks it and reprints the unmet contract. There’s nothing to argue with and
          nothing to edit: the gate is computed from requirement statuses. An agent can’t talk its way past it. Neither can you.
        </P>

        <H2 id="rubric">The rubric is read twice</H2>
        <Rule />
        <P>
          Each requirement carries one rubric and two readers. The implementer reads it to know what to produce. The judge reads it to decide whether
          to accept. Same words, both roles. When what-to-build and what-passes are the same text, they can’t drift apart. Declaring one is a single
          command:
        </P>
        <Cmd>{`space goal requirement add \\
  --title "Checkout suite passes" \\
  --kind test-output \\
  --rubric "Suite completes with 0 failures. No skipped tests. Exit code 0." \\
  --gen command --gen-command "bun test src/checkout" \\
  --expect exit-zero`}</Cmd>
        <P>
          For command-judged requirements the loop closes itself. The generation run <em className="text-zinc-100">is</em> the judged run: one
          execution, one verdict, auto-accepted when the expectation holds. A screenshot takes the manual path instead: attach it, and a human applies
          the same rubric with a <Code>pass</Code>, <Code>changes</Code>, or <Code>fail</Code>.
        </P>

        <H2 id="journal">The journal keeps intent honest</H2>
        <Rule />
        <P>
          <Code>phase-start</Code> does something small and useful: it prints the phase’s owed contract. Every requirement this phase owes, with its
          rubric, its commands, and its current status. That printout is the phase’s definition of done. Not a summary of it. The thing itself, at the
          moment work begins. And <Code>--workflow-ref</Code> pins the entry to the exact spec location it implements, like{" "}
          <Code>checkout-v2.workflow.json#phases[1]</Code>, so the journal points at the contract instead of just naming it.
        </P>
        <P>
          Intent gets written before the work, and the review guide later quotes it verbatim. The ordering matters. An intent written after the fact
          is a press release. An intent written before is a prediction, and the gap between prediction and outcome is exactly what a reviewer needs to
          see. When the phase ends, the outcome’s first line becomes the commit headline: the narrative and the git history are the same artifact.
        </P>
        <P>
          Sometimes the contract itself is wrong. That has an exit too: revert the phase with a reason, and the workflow returns to plan for a
          requirement rewrite. The gate stays red in the record. What you cannot do is quietly redefine done.
        </P>

        <H2 id="close">Derivation beats instruction</H2>
        <Rule />
        <P>
          Notice what you never did in the demo: you never told the agent how to behave. No “always run the tests,” no “remember to check the
          config.” You stated a goal, and the mechanisms fell out of it. Instructions pile up, contradict each other, and get summarized away.
          Derived structure stays attached to the goal that produced it.
        </P>
        <P>
          The output at the end is a sentence, not a feeling: <Code>Ready: all required artifacts passed judgment.</Code> Readiness is computed from
          required requirements only, and you quote it as printed. Not “looks done.” Not “I think we’re good.”
        </P>
        <P>More instructions make an agent read more. A contract makes it accountable to something. Only one of those scales with the fleet.</P>

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
