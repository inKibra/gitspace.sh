import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { VibesVsEvidence } from "./islands/VibesVsEvidence";
import { RunTheRubric } from "./islands/RunTheRubric";

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
function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="font-mono text-[13px] leading-relaxed text-zinc-300 bg-[#0c0c0c] border border-[#1a1a1a] p-4 overflow-x-auto my-8">
      {children}
    </pre>
  );
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
  title: "Evidence, not vibes. — gitspace",
  description:
    "“Looks good to me” is not a review when the author is a machine. Declare what done means before the work, run the judges, quote the readiness sentence.",
  image: "https://gitspace.sh/blog/evidence-not-vibes-og.png",
  url: "https://gitspace.sh/blog/evidence-not-vibes",
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 02</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            Evidence, not <span className="text-amber-400">vibes</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            “Looks good to me” is not a review when the author is a machine.
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
          An agent finished the checkout refactor while you were in a meeting. The diff is 400 lines. The summary says the tests pass. You skim it,
          nothing jumps out, and you approve it. <Code>LGTM</Code>.
        </P>
        <P>
          That reflex made sense when the author was a person. A colleague who writes “tests pass” staked something on it: their memory of running
          them, their name on the commit. An agent that writes “tests pass” produced a plausible sentence. Maybe the tests ran. Maybe they exist. The
          sentence looks identical either way.
        </P>
        <P>
          You could read every line yourself. For one agent, maybe.{" "}
          <a href="/blog/babysitting-agents-sucks" className="text-green-400 hover:text-green-300 underline underline-offset-4">
            Nº 01
          </a>{" "}
          made the case that you run a fleet now, and a fleet produces more diff per day than you can read. Reading harder is not the answer.
        </P>
        <Quote>Human review doesn’t scale to a fleet. Evidence does.</Quote>

        <P>
          Here is the same pull request twice. Once as it reaches you today, once as a validation contract. Flip between them and notice what the
          second one can answer that the first one can’t: what ran, what judged it, and what artifact backs each checkmark.
        </P>
        <Wide caption="One of these is a record. The other is a mood.">
          <VibesVsEvidence />
        </Wide>

        <H2 id="declare">Declare done before the work</H2>
        <Rule />
        <P>
          The fix starts before the agent writes a line. In gitspace, a goal carries a <strong className="text-white">validation contract</strong>: a
          list of requirements, each one a claim about the finished state with a rubric attached. A requirement declares its evidence kind (test
          output, screenshot, video, file, url), how the evidence gets generated, and who judges it. You author it in one command:
        </P>
        <CodeBlock>
          {`$ space goal requirement add \\
    --title "Checkout tests pass" \\
    --kind test-output \\
    --rubric "Suite completes with 0 failures. Exit code 0." \\
    --gen command --gen-command "bun test src/checkout" \\
    --expect exit-zero

$ space goal requirement add \\
    --title "Checkout screenshot" \\
    --kind screenshot \\
    --rubric "Order summary shows subtotal, tax, and total. Pay button enabled." \\
    --gen manual --judge human`}
        </CodeBlock>
        <P>
          The rubric works both directions. The implementer reads it to know what to produce. The judge reads it to apply acceptance criteria. Same
          words, two jobs. The agent building checkout knows before it starts that done means an exit-zero test run and a screenshot with totals
          visible. Nobody negotiates the definition of done after the work exists.
        </P>

        <H2 id="judge">Judgment is a run, not an opinion</H2>
        <Rule />
        <P>
          Each requirement names its judge. Anything with an exit code gets a <strong className="text-white">command judge</strong>: the generation
          run is the judged run, and <Code>--expect exit-zero</Code> is the acceptance criterion. One execution, one verdict, output captured as
          evidence. Taste-based artifacts (screenshots, videos, design notes) get a <strong className="text-white">human judge</strong>: pass, needs
          changes, or fail, with a note. You can also label a requirement llm-judged; the verdict still closes through the same rubric, with grounding
          notes required. In every case the verdict attaches to evidence you can replay, not to a feeling.
        </P>
        <P>
          Run the contract below yourself. Three requirements guard the checkout goal. The two command judges stream their output and attach it as
          evidence; the screenshot takes an attach and a recorded review. The type check <strong className="text-white">fails on the first run</strong>
          , and that is the point. A judge that cannot fail is theater.
        </P>
        <Wide caption="Statuses move missing → review → accepted. Only a judgment moves them.">
          <RunTheRubric />
        </Wide>
        <P>
          Look at what the failure did. The requirement stayed in <Code>review</Code>, the red output stayed attached, and readiness reported{" "}
          <Code>1 requirement failed review.</Code> Nothing merged and nobody argued. When the fix landed you re-ran the judgment, and the same
          command that rejected the work accepted it. The judge never changed its mind. The work changed.
        </P>

        <H2 id="readiness">Readiness is a sentence you can quote</H2>
        <Rule />
        <P>
          When every required artifact passes judgment, you do not get a dashboard or a confidence score. You get a sentence:
        </P>
        <CodeBlock>
          {`$ space goal status
Validation readiness for checkout-refactor: ready
`}
          <span className="text-green-400">Ready: all required artifacts passed judgment.</span>
          {`
accepted: 3
Required: 3 · missing: 0 · review: 0 · accepted: 3`}
        </CodeBlock>
        <P>
          The summary line is computed from requirement state and nothing else. Nobody types it. The other things it can say are just as blunt:{" "}
          <Code>3 required artifacts missing.</Code> <Code>1 requirement failed review.</Code> <Code>2 artifacts attached but not judged.</Code>{" "}
          <Code>No required artifacts declared.</Code> Each one names the next action, and none of them can be wished into the green one.
        </P>
        <P>
          That sentence is the review. Paste it in the PR, in the standup note, in the message to the person waiting on the feature. Nobody asks “but
          did you check it,” because the sentence exists only if the checks ran.
        </P>
        <Quote>Readiness is computed, not claimed.</Quote>

        <H2 id="close">What your review time is for</H2>
        <Rule />
        <P>
          “LGTM” answered a social question: do I trust this author. Machines do not earn trust; runs do. Once the contract holds the mechanical
          checks, your review time goes where it counts: writing rubrics that actually describe done, and judging the artifacts only a human can
          judge. The fleet produces evidence. You produce judgment.
        </P>
        <P>
          Judging the outcome tells you whether the work is done. Reading the code is a different job, and Nº 03 covers it: a change guide that turns
          an agent’s diff into a build-order story you can follow.
        </P>

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
