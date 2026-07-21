import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { MorningAfter } from "./islands/MorningAfter";
import { PromoteRollup } from "./islands/PromoteRollup";

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
  title: "Shipped isn’t done. — gitspace",
  description:
    "Merge is the midpoint of a goal’s life. Cron refreshes the ops dashboard from rolled-up artifacts, and the rubric that shipped a goal is the tripwire that reopens it.",
  image: "https://gitspace.sh/blog/shipped-isnt-done-og.png",
  url: "https://gitspace.sh/blog/shipped-isnt-done",
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 07</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            Shipped isn’t <span className="text-amber-400">done</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            Merge is the midpoint of a goal’s life. The dashboard keeps watching after you stop, and the rubric that shipped the goal is the tripwire
            that reopens it.
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
          Yesterday <Code>remove-checkout-v2</Code> shipped. The review gate passed, the rubric went green, the workspace’s artifacts branch rolled up
          into <Code>main</Code>, and the board moved on. Every tool you use agrees this goal is over: the card is in the done column, the branch is
          merged, the thread is closed.
        </P>
        <P>
          Production did not get the memo. The rollout sat at 62% when you stopped watching. The error rate was clean for exactly as long as the
          canary ran. And nobody opens a dashboard tomorrow for a goal that shipped today. That is not a discipline problem you can fix with a sticky
          note; attention moves to the next goal, because moving on is the whole point of shipping.
        </P>
        <Quote>Merge is the midpoint of a goal’s life.</Quote>
        <P>
          So here is the same goal, the morning after. The dashboard below shipped <em className="text-zinc-100">with</em> it: a mini-app plus a data
          file, living in the goal’s own folder in the artifacts tree, rolled up to <Code>main</Code> with everything else. A nightly cron owns the
          refresh. Run it yourself, then advance a day.
        </P>
        <Wide caption="The dashboard the goal left behind. Fire the cron, then advance a day and read the error tile.">
          <MorningAfter />
        </Wide>
        <P>
          Watch what day two did. The cron refreshed the numbers like every other night. One of them crossed a line, and the goal came back. Not a
          page in a channel. Not a fresh ticket with a two-line description. The <em className="text-zinc-100">shipped goal reopened</em>, amber on
          the board, with the rubric line that shipped it quoted as the reason.
        </P>

        <H2 id="record">The record outlives the workspace</H2>
        <Rule />
        <P>
          This works because of where the dashboard lives. Every goal owns one folder in the project’s artifacts tree:{" "}
          <Code>goals/&lt;goal-id&gt;/</Code>, holding the goal doc, the rubric, evidence, the phase journal, dashboards, data, triggers. While the
          goal is in flight, that folder rides the workspace’s artifacts branch. When the goal ships, <Code>gssh artifacts rollup</Code> merges the
          branch into <Code>main</Code>. Nothing moves and nothing gets renamed, so every reference keeps resolving. Then you delete the workspace,
          and the record does not care.
        </P>
        <P>
          Getting an artifact into that record is one deliberate act. Agents draft freely at <Code>local://</Code> paths; drafts are typeless and
          invisible to the product. <Code>space artifacts promote</Code> gives a draft a typed path, and the type is what surfaces it:{" "}
          <Code>*.dashboard.json</Code> becomes a dashboard tab, <Code>data/*.data.json</Code> feeds it,{" "}
          <Code>triggers/*.trigger.json</Code> runs on a schedule.
        </P>
        <Wide caption="Promote gives a draft a type. Rollup carries the whole folder to main, intact.">
          <PromoteRollup />
        </Wide>

        <H2 id="cron">Cron is the memory</H2>
        <Rule />
        <P>
          The refresh you clicked above is a file. <Code>triggers/nightly.trigger.json</Code> declares a schedule (<Code>every 1 d</Code>), a write
          scope (<Code>data/**</Code>), and a prompt to run. The machine’s daemon fires it unattended. The write scope is enforced, not advisory: if
          a run touches anything outside its globs, the changes revert and the run is marked failed. A cron can refresh the numbers; it cannot
          quietly rewrite the goal.
        </P>
        <P>
          So the numbers nobody remembers to refresh get refreshed anyway, committed like any other artifact change and carried to{" "}
          <Code>main</Code> by sync. To be clear, your observability stack already does the watching part well. Datadog will page you at 3am with the
          best of them. What the page cannot tell you is which goal owns the number, what threshold shipped it, or where the evidence lives. That
          context sits in a PR that merged three weeks ago, written by someone who is currently asleep.
        </P>

        <H2 id="tripwire">The rubric is the tripwire</H2>
        <Rule />
        <P>
          When the goal shipped, requirement R2 said the error rate stays under 0.10%. That line gated the merge. In most shops it dies at the merge:
          someone copies the threshold into an alerting config, the config drifts, and the number loses its author. Here it does not go anywhere. It
          sits in <Code>rubric.json</Code>, in the goal’s folder, on <Code>main</Code>, next to numbers a cron rewrites every night.
        </P>
        <P>
          When the two disagree, the goal reopens. Same folder, same evidence trail, same journal, and the rubric line quoted at the top as the
          reason. The agent that picks it up starts from the whole record of how the goal shipped, not from a blank prompt and a screenshot of a
          graph.
        </P>
        <Quote>The rubric that shipped it is the tripwire that reopens it.</Quote>

        <H2 id="close">Operations is the fleet’s memory</H2>
        <Rule />
        <P>
          Nº 01 argued that the board’s whole job is telling you where to look: answer the ambers, re-engage the blues, drive to green. A reopened
          goal is just a new amber. You already know what to do with ambers. No second tool to check, no dashboard of dashboards, no runbook wiki
          rotting in a corner.
        </P>
        <P>
          Shipped is a state a goal can leave. That sounds like more work, and it is less. The alternative is what you do today: shipping severs the
          link between a change and its consequences, and rebuilding that link at 3am is the most expensive query in software. Keep the record alive
          and the fleet remembers for you.
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
