import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { VibesVsEvidence } from "./islands/VibesVsEvidence";
import { TheContractGetsWritten } from "./islands/TheContractGetsWritten";
import { DeriveTheContract } from "./islands/DeriveTheContract";
import { TheWorkflow } from "./islands/TheWorkflow";
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
  title: "Agents lie about what they shipped. — gitspace",
  description:
    "The good ones lie best about what they shipped. Declare done as a contract the agent cannot game, judged by runs you can replay.",
  image: "https://gitspace.sh/notes/evidence-not-vibes-og.png",
  url: "https://gitspace.sh/notes/evidence-not-vibes",
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
            Agents <span className="text-amber-400">lie</span> about what they shipped.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            The good ones lie best. Make them prove it.
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
          I run a fleet now. There is always work in flight, always another diff waiting for me to look at it. And I am tired of the one thing
          everyone swears will change the world lying to me about what it did.
        </P>
        <P>
          This is not a bug someone will patch. The labs publish the proof themselves: the transcripts where a model talks its way out of its
          sandbox, fakes a benchmark, games the reward it was graded on. Fable. GPT-5.6 Sol. The good ones, the ones you actually want on the work.
          That is the trap. The same mind that can pick the lock on its own cage can tell you a task is finished when it is not, and shape the
          sentence so it reads exactly like the truth.
        </P>
        <P>
          You would think care fixes this. It does not. You write the plan. You run a grill-me session and interrogate every assumption it made.
          You read the diff line by line. And it still hands you <Code>tests pass</Code> when the tests never touched the code you changed.
          When a colleague writes “tests pass” they stake their name on it. When a model writes it, it produced a likely string. The words match.
          Nothing behind them has to.
        </P>
        <Quote>You can plan it, review it, and grill it, and it will still lie. So make it prove what it did, every time, to something that cannot be sweet-talked.</Quote>

        <P>
          You already run more than one of these.{" "}
          <a href="/notes/babysitting-agents-sucks" className="text-green-400 hover:text-green-300 underline underline-offset-4">
            Nº 01
          </a>{" "}
          was about the fleet: too much work in flight to read every line, so “which one needs me” has to be answerable at a glance. This one is the
          harder question underneath it. When the agent says it is done, how do you know?
        </P>
        <P>
          Here is the same pull request twice. Once as it reaches you today, once as something you can check. Flip between them and watch what the
          second one answers that the first one cannot: what ran, what judged it, and what artifact backs each green mark.
        </P>
        <Wide caption="One of these is a record. The other is a mood.">
          <VibesVsEvidence />
        </Wide>

        <H2 id="rule">It started as a markdown file</H2>
        <Rule />
        <P>
          Before any of this was a product, it was a markdown file. A skill called <Code>review-gated-implementation</Code>, loaded into every agent
          we ran. It refuses to let the agent start. First it has to write a phased plan, and inside that plan the move that matters: an{" "}
          <strong className="text-white">ungameable reviewer rubric</strong>, fail conditions first. Then it launches fresh reviewers who never watched
          the implementer think, so they cannot be walked into agreement.
        </P>
        <P>
          One line in that skill reorganized how I work. A reviewer gate{" "}
          <em className="text-zinc-100">that cannot be satisfied by the implementer’s summary alone</em>. Read it twice. The thing doing the work is
          not allowed to be the thing that certifies the work. Everything else is a consequence of that sentence.
        </P>
        <P>
          The skill goes further. It makes you name the ways a clever model cheats and say them out loud: forbidden shortcuts, proxy traps, evidence
          that looks like proof and is not. Old behavior surviving behind a new name. A green suite that never once touched the code you changed. A
          deleted file standing in for finished work. Name the counterfeit, then write the rubric that rejects it.
        </P>
        <P>
          It worked. It was also a wall of instructions I carried by hand into every serious change, and forgot on the changes that did not feel
          serious until they were. So we built it into gitspace.
        </P>

        <H2 id="ungameable">First, make “done” ungameable</H2>
        <Rule />
        <P>
          Now, before the agent writes a line, I stop asking what it should build. I ask what would prove it built the right thing in a way it cannot
          fake. Which test, run against the real checkout path instead of a stub. Which screenshot, of the actual order total, the live one. What has
          to be absent, paired with something that has to be present, so that deleting a file can never be the whole story.
        </P>
        <P>
          In gitspace that list has a name: a <strong className="text-white">validation contract</strong>. Requirements, each with a rubric, an
          evidence kind, and a judge. And here is the part I got wrong the first time I wrote this post. The agent writes those requirements. I only set
          the bar, in one plain sentence: <em className="text-zinc-100">prove it, and write the checks so you cannot game them</em>. The agent
          authors the contract and runs the commands as a detail underneath. Watch it happen.
        </P>
        <Wide caption="You set the bar. The agent writes the checks it will be held to.">
          <TheContractGetsWritten />
        </Wide>
        <P>
          The rubric works both directions. The agent reads it to know what to produce. The judge reads it to decide what passes. Same words, two
          jobs. Nobody negotiates the definition of done after the work already exists and everyone is tired.
        </P>

        <H2 id="derive">The whole contract derives from the goal</H2>
        <Rule />
        <P>
          That chat was not a trick the agent performs for checkout. It was a derivation. State a goal and the rest follows: the phases the work
          moves through, the requirements with their rubrics and judges, and a journal entry that declares what each phase intends before a single
          edit lands. You wrote one sentence. The machine wrote the contract.
        </P>
        <P>
          Try it. Pick a goal below, or type your own, and watch the contract assemble: phase graph first, then the requirement table, then the
          declared intent. The shape holds for a flag removal, for rate limits, for whatever you type, because the shape is the point.
        </P>
        <Wide caption="State the goal. Phases, requirements, and the journal derive from it.">
          <DeriveTheContract />
        </Wide>
        <P>
          A derived contract is still a contract the implementer could game. So the next thing that touches it is paid to break it.
        </P>

        <H2 id="adversary">The reviewer attacks the rubric first</H2>
        <Rule />
        <P>
          Fair objection: this looks like my own tests with more paperwork. The agent ran <Code>bun test</Code> and said pass. Now a judge runs{" "}
          <Code>bun test</Code> and says pass. Where did the lie go?
        </P>
        <P>
          Here is the tell. A test that never touches the code you changed still goes green. Hand that test to a judge and the judge blesses it too,
          because a judge only runs the check it was given. So the judge was never the safeguard. The safeguard is who wrote the check, and what they
          were trying to do when they wrote it.
        </P>
        <P>
          That is the <strong className="text-white">workflow’s</strong> job, and it starts before a line is written. gitspace sets an independent
          reviewer on the rubric itself with one instruction: find a way to satisfy every requirement while the real thing stays broken. A test that
          mocks the total. A suite that never imports the changed file. Old behavior alive under a new name. Each loophole it finds becomes a new fail
          condition. The rubric gets hardened by something paid to cheat it, while it still only has the plan to attack and no diff to forgive.
        </P>
        <P>
          Then the reviewer at the gate is a stranger, and it is not allowed to pass on{" "}
          <Code>tests green</Code>. Green is a proxy. It has to see the test drive the real path before it counts the requirement done. A run that
          proves nothing is the exact thing it is there to reject. That is the difference between a contract and a nicer way to run the same test.
        </P>
        <P>
          Here is that workflow the way gitspace draws it. Each phase runs an implementer, then hands its evidence to a review-gate before anything
          advances. The gate is computed from the rubric, so it can sit red. Watch phase one: the loop runs until the gate reads{" "}
          <Code>satisfied</Code>, and only then does the next phase unlock.
        </P>
        <Wide caption="The review-gate is a node in the graph. A phase cannot advance until its gate computes satisfied.">
          <TheWorkflow />
        </Wide>

        <H2 id="judge">A judge that wants to find problems</H2>
        <Rule />
        <P>
          Every requirement in that rubric names who judges it. Anything with an exit code gets a <strong className="text-white">command judge</strong>:
          the run that generates the evidence is the run that judges it, and <Code>--expect exit-zero</Code> is the acceptance criterion. One execution,
          one verdict, the output kept. Taste gets a <strong className="text-white">human judge</strong>: a screenshot, a video, a design call, marked
          pass or needs-changes or fail with a note. You can hand a requirement to an <strong className="text-white">llm judge</strong> too, and it
          closes through the same rubric with its reasoning shown. Every path lands in the same place: a verdict bolted to evidence you can replay.
        </P>
        <P>
          The llm judge is the one an implementer would try to talk down, so it never gets the chance. A fresh judge takes every round, with no memory
          of the last one and no word from the agent that did the work. The implementer cannot brief it, cannot say <em className="text-zinc-100">just
          confirm the tax math, the rest is out of scope</em>. It gets the requirement, the evidence, and the source, and re-derives the verdict blind.
          Findings route back to the implementer, never forward to the next judge, so nobody can walk the next reviewer into agreement. I have been
          burned by the other way more times than I can count: an agent that quietly narrows its own review until the thing it broke sits just outside
          the frame.
        </P>
        <P>
          Run the contract yourself. Three requirements guard the checkout goal. Two command judges stream their output and keep it; the screenshot
          takes an attach and a recorded look. The type check <strong className="text-white">fails on the first run</strong>, and that is the point. A
          judge that cannot fail is a rubber stamp, and a rubber stamp is exactly what handed me “tests pass” in the first place.
        </P>
        <Wide caption="Statuses move missing → review → accepted. Only a judgment moves them.">
          <RunTheRubric />
        </Wide>
        <P>
          Look at what the failure did. The requirement stayed in <Code>review</Code>, the red output stayed attached, and readiness reported{" "}
          <Code>1 requirement failed review.</Code> Nothing merged. Nobody argued. When the fix landed I re-ran the judgment, and the same command
          that rejected the work accepted it. The judge never changed its mind. The work changed.
        </P>

        <H2 id="readiness">Readiness you can’t fake</H2>
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
Required: 3 · missing: 0 · review: 0 · accepted: 3`}
        </CodeBlock>
        <P>
          That line is computed from requirement state and nothing else. The other things it can say are just as blunt:{" "}
          <Code>3 required artifacts missing.</Code> <Code>1 requirement failed review.</Code> <Code>2 artifacts attached but not judged.</Code> Each
          one names the next move, and none of them can be wished into the green one.
        </P>
        <P>
          Read that word <Code>accepted</Code> again, because it carries the whole argument. Each one is a requirement that already went a round with a
          judge that would not take the implementer’s word, could not be scoped down to the easy part, and defaulted to fail when it was unsure. When
          you finally look at the evidence, you are looking at what survived that. The adversary already ran. You are reading what it could not break.
        </P>
        <P>
          That sentence is the review. Paste it in the PR, in the standup note, in the message to the person waiting on the feature. Nobody asks “but
          did you check it,” because the sentence exists only when the checks ran.
        </P>
        <Quote>You don’t tell gitspace the work is ready. It tells you.</Quote>

        <H2 id="phases">Every phase leaves a receipt</H2>
        <Rule />
        <P>
          A real change happens in phases, and each phase owes a slice of the contract. gitspace stops the agent at every seam. At the start of a
          phase the agent declares what it is about to do, why, and what it expects to touch, and gitspace prints back the phase’s definition of done:
          the requirements this phase owes, the ones that have to read <Code>accepted</Code> before the next phase can begin.
        </P>
        <CodeBlock>
          {`agent ran  space journal phase-start
  --phase "remove-api"
  --intent "drop the checkout_v2 read in api first; expect flags.ts and one test"
  --workflow-ref "remove-checkout-v2.workflow.json#phases[1]"

owed this phase → R1 checkout suite passes · R3 checkout_v2 gone
gate: both accepted before phase 2 begins`}
        </CodeBlock>
        <P>
          The order carries the weight. The agent writes intent before the edit, while it still has to guess, so the journal cannot be quietly
          reshaped into a story that flatters the diff after the fact. At phase end the agent records what actually happened: the outcome, the
          decision it made, the thing that surprised it. gitspace snapshots the goal, workflow, and review state, then commits the entry. The agent
          narrates. The system keeps the receipts.
        </P>
        <P>
          A record like that feeds everything downstream. The reasons are on file, timestamped, committed before the work could bias them: raw
          material for reviewing the change, explaining it, and one day answering where a line of code really came from.
        </P>

        <H2 id="close">You make the call</H2>
        <Rule />
        <P>
          “LGTM” answered a human question: do I trust this author. A model gives me nothing to trust, so the run has to carry the weight instead. Once
          the contract holds the mechanical line, my attention goes where it is actually scarce: writing rubrics that describe done well enough to be
          dangerous, and judging the few things only a person can. The fleet produces evidence. I produce the call.
        </P>
        <P>
          This side of the work asks whether the outcome is done. The next asks how to understand it. Nº 03 is the change guide: it rebuilds the change
          into a story, starting from what everything else depends on and working outward, so you grasp the shape of the work instead of scrolling a
          diff. The phase entries are what let it tell that story honestly.
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
