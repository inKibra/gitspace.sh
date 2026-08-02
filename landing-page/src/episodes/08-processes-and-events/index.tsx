import { useEffect } from "react";
import { LandingNavbar } from "../../components/layout/LandingNavbar";
import { Footer } from "../../components/layout/Footer";
import FaultyTerminal from "../../components/landing/FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowRight } from "lucide-react";

/* small typographic helpers ------------------------------------------------ */
function H2({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-3xl md:text-4xl font-bold tracking-tight mt-20 mb-2 scroll-mt-24">
      {children}
    </h2>
  );
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xl md:text-2xl font-semibold tracking-tight mt-10 mb-3 text-zinc-100">{children}</h3>;
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

const META = {
  title: "What's running, and what happened. — gitspace",
  description:
    "A per-workspace process manager and a four-channel event capture system for coding agents. The rule behind both: watching never changes what you watch.",
  image: "https://gitspace.sh/blog/processes-and-events-og.png",
  url: "https://gitspace.sh/blog/processes-and-events",
};

export default function BlogPost() {
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
          <div className="text-[13px] font-mono text-green-500/80 mb-5 uppercase tracking-widest">The agent fleet · Nº 08</div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[0.95] mb-6">
            What's running, and what <span className="text-amber-400">happened</span>.
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 mb-8">
            A process manager and an event system for agents. Watching never changes what you watch.
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
          When you hand a task to a coding agent, it does more than write code. It starts a dev server. It runs a worker. It prints a wall of logs.
          Then it tells you it is done, and you are left with a terminal you did not open and output you never read. Run one agent and you can squint at
          it. Run a fleet and you have no idea what is running or what just happened.
        </P>
        <P>
          gitspace treats both as first-class: the processes your agents run, and the events those processes throw off. Here is how, and the one rule
          that holds it together.
        </P>

        <H2 id="service">A service is a tracked thing</H2>
        <Rule />
        <P>
          A service starts life as a declaration in <Code>.gitspace/processes.json</Code>: a name, a command, its ports, a restart policy. You start it
          with a command, not by typing <Code>npm run dev</Code> into a shell and hoping.
        </P>
        <CodeBlock>
          {`$ gssh space service start --name web
web#1 started

$ gssh space service list
web#1 running
  http (http:31847)
    local:  http://localhost:31847
    remote: https://acme.gitspace.sh`}
        </CodeBlock>
        <P>
          It runs inside the tmux-lite daemon, not as a loose child of your shell, so it outlives the terminal, carries a name, and you can attach to it
          later. Four details make it more than a wrapper around spawn.
        </P>
        <P>
          <strong className="text-white">Its port is stable.</strong> The port is not random. It is seeded from a hash of the workspace, the service, and
          the port name, searched over the 17000 to 47000 range. So <Code>web</Code> in this workspace lands on the same port every run. Your local URL
          stops moving between restarts.
        </P>
        <P>
          <strong className="text-white">Stopping it kills the whole group.</strong> A dev server spawns node, which spawns esbuild. Kill node the naive
          way and esbuild lives on, holding your port. gitspace reads the POSIX process group and signals the group, so the orphan never happens.
        </P>
        <P>
          <strong className="text-white">It restarts on your terms.</strong> A policy of <Code>never</Code>, <Code>on-failure</Code>, or <Code>always</Code>,
          with exponential backoff, and a watchdog that reconciles every five seconds. An <Code>on-failure</Code> service that exits clean stays down; one
          that crashes comes back.
        </P>
        <P>
          <strong className="text-white">It knows your process from a stranger's.</strong> If the port is already taken, gitspace walks the offending
          process up its parent chain. If the squatter is another gitspace service, it offers to stop it. If it is some unmanaged process, it offers to
          kill that pid, then waits for the port to actually free before it starts. No blind <Code>EADDRINUSE</Code>.
        </P>

        <H2 id="snapshot-rule">The rule: a snapshot never writes</H2>
        <Rule />
        <P>
          Here is the principle underneath all of it. Reading the state of the fleet must never change the fleet.
        </P>
        <P>
          It sounds obvious until you watch it get violated. Just <em className="text-zinc-100">listing</em> your services could steal a running server's
          port, if the list path allocated ports the way the start path does. So gitspace splits them: one function allocates and may move a port, and
          only <Code>start</Code> calls it. A second function only reads, and every reporting and routing path uses that one. The read path never probes
          with <Code>lsof</Code> and never writes a file.
        </P>
        <P>
          That last point is not fussiness. The daemon is single threaded. One unbounded <Code>lsof</Code> inside a snapshot build freezes the whole
          server, and then nothing connects. So the port reader bounds <Code>lsof</Code> to two seconds and treats a timeout as "no listener." The same
          rule shows up in the port allocator, the workspace snapshot, and the trace log: watching stays cheap, and it cannot wedge the thing it watches.
        </P>
        <Quote>Know what your fleet is doing, and never disturb it to find out.</Quote>

        <H2 id="events">Four ways to capture an event</H2>
        <Rule />
        <P>
          gitspace does not run everything through one event bus. It has four channels, because each one has a different worst case, and a design tuned
          for capturing history is the wrong design for surviving a freeze.
        </P>

        <H3>Wide events: print, and it is captured</H3>
        <P>
          The runner reads a service's stdout one line at a time. Print plain text and you get a log event. Print a JSON object and you get a structured
          event. Add a <Code>requestId</Code> and every line sharing that id folds into one evolving snapshot with a keyed timeline. Same pipe, three
          levels of structure, and nothing is thrown away for a missing field. gitspace calls it graceful fidelity: you never install a logging SDK to
          get structured logs, you just print better.
        </P>
        <P>
          Events land as NDJSON under <Code>.gitspace/events/processes/</Code>, and each file ships with an index sidecar recording its time span, its
          levels, and its event names, so a query can skip whole files instead of scanning them. You read it back with a filter:
        </P>
        <CodeBlock>{`$ gssh space events tail --follow --level error --since 30m`}</CodeBlock>

        <H3>Agent events: the live mirror</H3>
        <P>
          A second channel lives only in memory, per workspace: which agent sessions are running, which are blocked on a permission, which asked you a
          question. This is what colors the fleet green, amber, and blue.
        </P>
        <P>
          Every field is capped the moment it comes in. That is not housekeeping. The whole agent state gets serialized into each machine snapshot, and
          one unbounded field once turned that serialization into a multi-second stall that wedged the daemon. So an error caps at 4000 characters, a
          queued message at 2000, the queue at 20 messages, the todo list at 200. A small data bug had become a systemic failure, and the fix was a cap.
        </P>

        <H3>The runtime trace: forensics that survive a freeze</H3>
        <P>
          Thirty-four points inside the daemon each write a single JSON line to <Code>.agent/gitspace-runtime-trace.jsonl</Code> on command, snapshot, and
          agent boundaries, and also push it to a 400-entry ring in memory. The write is synchronous on purpose. It lands on disk before a freeze can
          strand a buffered async write, and because it only fires on boundaries and not on every keystroke, the cost is under a millisecond.
        </P>
        <P>
          When the daemon still answers, "report a problem" reads the ring. When the daemon is wedged, the relay tails the file from the outside. This is
          the one channel built to be readable at the exact moment everything else has stopped responding.
        </P>

        <H3>The phase journal and edit breadcrumbs: provenance you did not write</H3>
        <P>
          The last channel is durable and committed to git. You do not author the record. The agent supplies its intent and its outcome; the system
          snapshots the rest, which requirements advanced, which reviews resolved, which files changed, and then commits the code repo with the outcome as
          the headline. Commit order becomes the story of the work by construction.
        </P>
        <P>
          Underneath it, every mutating tool call an agent makes, every write and edit and bash and patch, drops a breadcrumb: a timestamp, the session,
          the file. At the end of the turn it flushes append-only to <Code>blame/edits.jsonl</Code> on the artifacts branch. So when you later ask which
          change first touched a line, attribution is a lookup, not a fuzzy guess after the fact.
        </P>

        <H2 id="answers">What you can answer now</H2>
        <Rule />
        <P>
          What is running: <Code>service list</Code>. What happened: <Code>events tail</Code>. Why it broke: the trace. Where a line came from: the journal
          and the breadcrumbs.
        </P>
        <P>
          None of those answers moved a port, killed a server, or wedged the daemon. That is the whole design in one sentence: know what your fleet is
          doing, and never disturb it to find out.
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
