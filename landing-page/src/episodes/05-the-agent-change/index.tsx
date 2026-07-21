import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";
import { BlameExplorer } from "./islands/BlameExplorer";

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

/* the three kinds, ep-01 Legend style -------------------------------------- */
const KindLegend = () => (
  <div className="flex flex-wrap gap-x-6 gap-y-2 my-8 text-sm font-mono">
    {[
      ["bg-blue-400", "introduced · the idea enters the file"],
      ["bg-orange-400", "moved · it relocates"],
      ["bg-purple-400", "refined · reworked in place"],
    ].map(([c, l]) => (
      <span key={l} className="flex items-center gap-2 text-zinc-400">
        <span className={`h-2.5 w-2.5 ${c}`} />
        {l}
      </span>
    ))}
  </div>
);

/* static compare: the dead question vs. the live one ------------------------ */
const BLAME_ROWS = [
  "const WINDOW_MS = 60_000;",
  "export function rateLimit(req, res, next) {",
  '  const limit = planLimits[req.auth?.plan ?? "free"];',
  "  if (!bucket.take()) {",
  '    res.setHeader("Retry-After", …);',
  "    throw new RateLimitError(key, …);",
];

function WhoVsWhy() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-zinc-300">git blame</span>
          <span className="text-[11px] text-zinc-600 uppercase tracking-wider truncate">who typed this</span>
        </div>
        <div className="p-4 font-mono text-[12px] leading-7 overflow-x-auto">
          {BLAME_ROWS.map((code) => (
            <div key={code} className="whitespace-pre min-w-max">
              <span className="text-zinc-600">9f31c2d </span>
              <span className="text-zinc-400">(agent 2026-06-18) </span>
              <span className="text-zinc-300">{code}</span>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px] text-zinc-500">
          Six lines. One author, one commit. Nothing learned.
        </div>
      </div>

      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-zinc-300">agent blame</span>
          <span className="text-[11px] text-zinc-600 uppercase tracking-wider truncate">which change put it here</span>
        </div>
        <div className="p-4 text-[13px] space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-blue-400/10 text-blue-300">Introduced</span>
            <span className="text-zinc-200">Token-bucket limiter</span>
            <span className="font-mono text-[11px] text-zinc-500">goal: Rate-limit the public API</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-orange-400/10 text-orange-300">Moved</span>
            <span className="text-zinc-200">into shared middleware</span>
            <span className="font-mono text-[11px] text-zinc-500">phase: extract</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-purple-400/10 text-purple-300">Refined</span>
            <span className="text-zinc-200">the 429 contract</span>
            <span className="font-mono text-[11px] text-zinc-500">phase: review-fixes</span>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px] text-zinc-500">
          Same lines. Three concepts, two goals, five journal entries.
        </div>
      </div>
    </div>
  );
}

const META = {
  title: "The agent change. — gitspace",
  description:
    "Blame for the agent age: not who typed the line, but which conceptual change introduced, moved, or refined it.",
  image: "https://gitspace.sh/blog/the-agent-change-og.png",
  url: "https://gitspace.sh/blog/the-agent-change",
};

export default function Episode05() {
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 05</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            The agent <span className="text-green-400">change</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            Blame for the agent age: not who typed the line, but which conceptual change introduced, moved, or refined it.
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
          Run <Code>git blame</Code> on a repo your agents built. Every line comes back the same:{" "}
          <Code>agent · 2026-06-18</Code>. The command works fine. The question it answers is dead. “Who typed this”
          has exactly one answer now, and it never helps you.
        </P>
        <P>
          That’s no failure of git’s. For twenty years “who” was a good proxy for “why.” You blamed a line, got a
          name, and went and asked. The name pointed at a person who remembered. Agents broke the proxy: the typist
          remembers nothing, and you run forty of them.
        </P>

        <Wide caption="The author column has stopped carrying information. The right panel is what the file should say back.">
          <WhoVsWhy />
        </Wide>

        <Quote>Stop asking who typed the line. Ask which change put it there, and what that change was trying to do.</Quote>

        <H2 id="verbs">Three verbs, one commit</H2>
        <Rule />
        <P>
          gitspace answers with the <strong className="text-white">conceptual change</strong>: one idea landing in
          the code. A change has a kind. <strong className="text-white">Introduced</strong> means the idea entered
          the file. <strong className="text-white">Moved</strong> means it relocated.{" "}
          <strong className="text-white">Refined</strong> means it got reworked in place.
        </P>
        <KindLegend />
        <P>
          An afternoon of agent work produces several of these, and a squash merge lands them all as one hash. The
          rate limiter below went through all three. The limiter itself was introduced under the goal “Rate-limit
          the public API,” moved into shared middleware during an extraction phase, and its 429 response was refined
          after review feedback. A second goal, “Per-plan quotas,” introduced the config lookups later. Plain git
          shows one author and one commit for all of it.
        </P>

        <H2 id="demo">Ask the file</H2>
        <Rule />
        <P>
          Click any line. The panel shows the change that owns it: the kind, the concept, the goal it served, and the
          intent the agent declared in its phase journal. Then flip <strong className="text-white">x-ray</strong> to
          tint the whole file by concept, and the code sorts itself into three ideas. Line 14 is the one to find: two
          changes deep, introduced and then refined.
        </P>
        <Wide caption="Every quote in the panel was written before the code it explains.">
          <BlameExplorer />
        </Wide>

        <H2 id="journal">Written before the code</H2>
        <Rule />
        <P>
          A “why” invented after the fact is a story. The panel above quotes something stronger. At{" "}
          <Code>phase-start</Code>, before its first edit, the agent declares intent: what it is about to do, why,
          and what it expects to touch. At <Code>phase-end</Code> it records what actually happened. The system
          snapshots and commits both.
        </P>
        <Wide caption="The declaration behind the “Moved” entry in the demo, as the agent wrote it.">
          <pre className="border border-[#1a1a1a] bg-[#050505] p-5 font-mono text-[13px] leading-relaxed text-zinc-300 overflow-x-auto">
            <span className="text-zinc-600">$ </span>gssh space journal phase-start --phase{" "}
            <span className="text-green-400">"extract"</span> \{"\n"}
            {"    "}--intent <span className="text-green-400">"Pull the limiter out of api.ts into shared{"\n"}
            {"              "}middleware. The partner routes need the same{"\n"}
            {"              "}guard and I will not duplicate it."</span>
          </pre>
        </Wide>
        <P>
          The ordering is the whole trick. Because intent goes on record before the edit, the quote can’t be a
          rationalization. Blame doesn’t ask the agent to remember; it replays what the agent promised next to what
          it did. When the two disagree, that gap is exactly where review attention belongs.{" "}
          <a href="/blog/the-workflow-and-the-goal" className="text-green-400 underline underline-offset-2 hover:text-green-300">
            Nº 04
          </a>{" "}
          covers the journal and its gates in full.
        </P>

        <Quote>Provenance per keystroke is noise. Provenance per concept is memory.</Quote>

        <H2 id="payoff">What this buys you</H2>
        <Rule />
        <P>
          Review gets a new unit: you approve or push back on three concepts, not four hundred changed lines.
          Debugging gets a witness: when line 14 throws at 2 a.m., blame hands you the goal that wanted it and the
          review note that shaped it. Onboarding gets receipts: a new teammate asks the file why it exists, and the
          file answers.
        </P>
        <P>
          You’ll run more agents next year, not fewer. All of them type; none of them remember. The history has to
          live somewhere that isn’t a person, and a commit hash was never going to be enough.
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
