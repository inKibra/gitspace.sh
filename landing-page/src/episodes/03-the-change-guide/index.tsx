import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { ChangeGuideExplorer } from "./islands/ChangeGuideExplorer";

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
  title: "The change guide. — gitspace",
  description:
    "A diff is not a story. The change guide retells your agent’s change in the order it was built: foundations, then wiring, then what users touch.",
  image: "https://gitspace.sh/blog/the-change-guide-og.png",
  url: "https://gitspace.sh/blog/the-change-guide",
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 03</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            The change <span className="text-green-400">guide</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            A diff is not a story. Read the change in the order it was built.
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
          Your agent finishes removing the <Code>checkout_v2</Code> flag. You open the PR: fourteen files, sorted by name.{" "}
          <Code>api/middleware/flag-guard.ts</Code> comes first because <em className="text-zinc-100">a</em> comes first, so you read a guard
          collapsing before you know the flag it guarded is gone. The registry change that explains everything sits at file six, between an e2e
          spec and a type union.
        </P>
        <P>
          That order isn’t neutral. Alphabetical is the one order nobody ever built anything in. So you reconstruct the change in your head while
          reading it in the wrong sequence, and the reconstruction is the tiring part. The diff has all the facts and none of the story.
        </P>
        <Quote>A diff is not a story. It’s the story’s pages, shuffled by filename.</Quote>

        <H2 id="build-order">The order the change was built</H2>
        <Rule />
        <P>
          gitspace ships a review skill built on one idea: retell the change as construction. An analyzer (<Code>gssh space guide analyze</Code>)
          reads the diff and computes its structure: <strong className="text-white">foundations</strong> first, the files nothing else in the
          change depends on. Then the code that <strong className="text-white">wires</strong> them through. Then the{" "}
          <strong className="text-white">surfaces</strong> users touch. Then the tests. Clusters arrive in reader order, and when one component is
          too big to read at once, the analyzer pre-splits it into build-order beats: <Code>signals.beat = {"{ component, seq, of }"}</Code>. Beat 1
          is the foundation layer; every later beat consumes the ones before it.
        </P>
        <P>
          Then an agent narrates. Two or three sentences per beat: what this step adds on top of the previous ones, what the next steps will do
          with it, where to slow down. Here’s the checkout_v2 removal, told both ways. Flip the toggle to feel the difference.
        </P>
        <Wide caption="The same 14-file diff, twice: as a build-order guide, and as the flat list a PR page gives you.">
          <ChangeGuideExplorer />
        </Wide>
        <P>
          Notice what the guide did to the sweep. Beat 2 is the same edit three times, once per transport, so it tells you: read the api guard,
          skim the rest. A flat list can’t say that, because a flat list doesn’t know the three files are the same idea.
        </P>

        <H2 id="journal">The journal keeps the narration honest</H2>
        <Rule />
        <P>
          An agent narrating its own diff has an obvious failure mode: it invents motives after the fact, and the prose reads like a cover letter.
          The narrator isn’t allowed to. Each beat’s prose is grounded in the <strong className="text-white">phase journal</strong>, the intent and
          outcome the agent declared while the work happened. The skill’s rule is blunt: quote or paraphrase, <em className="text-zinc-100">never
          invent motives</em>. If the journal is empty, the guide describes what changed and marks every motive claim as uncertain.
        </P>
        <P>
          That’s why beat 2 above quotes “canary: api first, watch errors 10m.” It isn’t the narrator’s guess about rollout strategy. It’s the
          answer you gave in the ask form, recorded when you gave it, now anchoring the prose. Declared intent, not reconstructed memory. Commit
          messages are written at the end, when the author already knows how the story goes; the journal is written in the middle, when they
          don’t.
        </P>

        <H2 id="reading">Reading is not judging</H2>
        <Rule />
        <P>
          Nº 02 was about judging the outcome: rubrics, command judges, evidence you can replay. The change guide is the other half of review:
          actually reading the code. The two meet in the same place. The analyzer commits its worksheet to{" "}
          <Code>.gitspace/artifacts/goals/*/review/analysis.json</Code> in the goal’s folder, the narrator submits its sections against it, and
          coverage of every stale cluster is enforced at submit. Re-run the analyzer after new commits and only the clusters that changed get
          re-narrated; the rest of the story carries over.
        </P>
        <P>
          And nothing is hidden. Every line of the diff is still there, every beat links the real files. The guide changes the order of the lines,
          not their number.
        </P>

        <H2 id="close">Fourteen files, four beats</H2>
        <Rule />
        <P>
          The flat file list makes review a chore you defer, and deferred review is how agent code ships unread. A guide makes it something you
          can start: beat 1, then next, next, done. You know where the load-bearing change is, where the sweep is, and which test guards the
          risky part.
        </P>
        <P>You’ll be reviewing more agent diffs next quarter, not fewer. Read them in the order they were built.</P>

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
