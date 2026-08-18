import { Terminal, Copy, Check } from "lucide-react";
import { highlightBash, highlightJson } from "./highlight";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../../app/components/ui/badge";

/**
 * Copy control shared by both block types.
 *
 * The visible glyph is 14px, so the button is padded out to a 40x40 hit area —
 * below that it is genuinely hard to hit on a trackpad. It stays at low opacity
 * rather than hidden until hover, because a control that appears only on hover
 * is undiscoverable on touch.
 */
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="grid h-10 w-10 place-items-center text-zinc-500 hover:text-zinc-200 opacity-60 group-hover:opacity-100 active:scale-[0.96] transition-[color,opacity,scale] duration-150"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Terminal chrome: a label bar over a black body, matching the code style used in Notes. */
function Chrome({ label, code, children }: { label: string; code: string; children: React.ReactNode }) {
  return (
    <div className="group mt-4 mb-6 border border-[#1a1a1a] bg-[#0c0c0c]">
      <div className="flex items-center gap-2.5 border-b border-[#1a1a1a] px-3 py-1.5">
        <span className="h-2 w-2 bg-green-500" />
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-600">{label}</span>
        <span className="ml-auto -my-1.5 -mr-2">
          <CopyButton code={code} />
        </span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function CodeBlock({ code, language = "bash", multiLine = false }: { code: string; language?: string; multiLine?: boolean }) {
  const lines = multiLine ? code.split("\n") : [code];
  const isShell = language === "bash";

  return (
    <Chrome label={isShell ? "terminal" : language} code={code}>
      {lines.map((line, i) => {
        const isComment = line.startsWith("#") || line.startsWith("//");
        // Blank lines separate stanzas; keep the height, drop the prompt.
        if (!line.trim()) return <div key={i}>&nbsp;</div>;
        return (
          <div key={i} className="flex">
            {isShell && !isComment && <span className="mr-2 select-none text-zinc-700">$</span>}
            <span className="min-w-0 whitespace-pre">{isShell ? highlightBash(line) : line}</span>
          </div>
        );
      })}
    </Chrome>
  );
}

function JsonBlock({ code }: { code: string }) {
  return (
    <Chrome label="json" code={code}>
      <pre className="text-zinc-300">{highlightJson(code)}</pre>
    </Chrome>
  );
}

export function DocsContent({ section }: { section: string }) {
  switch (section) {
    case "getting-started":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Getting Started</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">You use GitSpace in a browser. The terminal is only for setup: install the package, create an identity, then start the stack. After that, the app opens and you can leave the terminal alone.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Before you start</h3>
          <p className="text-zinc-400 mb-4">Git is the only hard requirement. GitSpace checks for it on first run and when you add a project, and it stops if Git is missing.</p>
          <p className="text-zinc-400 mb-8">The GitHub CLI (<code className="text-zinc-300">gh</code>) is optional. If it is installed, adding a project offers <code className="text-zinc-300">Choose GitHub repository</code> alongside <code className="text-zinc-300">Enter git remote URL</code>. Without it you can still add a project from a git remote URL.</p>

          <h3 className="text-xl font-semibold text-white mb-4">1. Install</h3>
          <p className="text-zinc-400 mb-4">The npm package is <code className="text-zinc-300">gitspace</code>. The command it installs is <code className="text-zinc-300">gssh</code>.</p>
          <CodeBlock code={`npm install -g gitspace`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">2. Create your identity</h3>
          <p className="text-zinc-400 mb-4">Your user root identity is the key everything else hangs off. Creating it generates a 24-word mnemonic. Write the words down. They are how you recover the identity on another machine.</p>
          <CodeBlock code={`gssh user identity init`} multiLine />
          <p className="text-zinc-400 mb-8">If you already have a mnemonic from a previous machine, use <code className="text-zinc-300">gssh user identity recover</code> instead.</p>

          <h3 className="text-xl font-semibold text-white mb-4">3. Create a device identity</h3>
          <p className="text-zinc-400 mb-4">Each machine also needs a local device identity, protected by a password. <code className="text-zinc-300">gssh web</code> refuses to start without one.</p>
          <p className="text-zinc-400 mb-4">Logging in to gitspace.sh with GitHub is the usual way to get one. If no device identity exists yet, the command asks <code className="text-zinc-300">No local device identity found. Create one now?</code> and then asks you to set a password for it.</p>
          <CodeBlock code={`gssh user auth login`} multiLine />
          <p className="text-zinc-400 mb-8">The GitHub login itself is only needed if you want a gitspace.sh subdomain later. The local stack does not require it.</p>

          <h3 className="text-xl font-semibold text-white mb-4">4. Start the app</h3>
          <p className="text-zinc-400 mb-4">One command brings up the whole local stack and opens your browser on it.</p>
          <CodeBlock code={`gssh web`} multiLine />
          <p className="text-zinc-400 mb-4">What it does, in order: checks your two identities, asks for your device identity password and unlocks with it, starts a local relay on port 4480, starts machine serve and waits for it to connect to that relay, registers a one-time browser enrollment, then opens your browser.</p>
          <p className="text-zinc-400 mb-8">Leave it running. It prints <code className="text-zinc-300">Press Ctrl+C to stop the local web stack.</code> and stopping it takes the app down with it.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Let it open the browser</h3>
          <p className="text-zinc-400 mb-4">The URL <code className="text-zinc-300">gssh web</code> opens looks like this:</p>
          <CodeBlock code={`http://127.0.0.1:4480/?enroll=<token>`} multiLine />
          <p className="text-zinc-400 mb-4">That <code className="text-zinc-300">enroll</code> token is minted fresh on every run and can be redeemed exactly once. The browser trades it for an identity, the relay deletes the token, and the app strips the parameter out of the address bar.</p>
          <p className="text-zinc-400 mb-4">The browser keeps that identity, so afterwards you can open <code className="text-zinc-300">http://127.0.0.1:4480</code> in the same browser with no token and go straight to the app. Use a different browser and you will need a fresh run of <code className="text-zinc-300">gssh web</code> to enroll it.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 font-mono text-xs mb-8">
            <div className="text-zinc-500 mb-3">what a run prints</div>
            <div className="text-zinc-400">Starting local relay on port 4480...</div>
            <div className="text-zinc-400">Starting machine serve...</div>
            <div className="text-zinc-300">Local web UI: http://127.0.0.1:4480/?enroll=…</div>
            <div className="text-zinc-600">Press Ctrl+C to stop the local web stack.</div>
            <div className="mt-3 pt-3 border-t border-[#1a1a1a] text-zinc-600">token valid for one redemption, this run only</div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Flags for <code className="text-zinc-300">gssh web</code></h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">--port &lt;port&gt;</code> local relay and web port. Defaults to 4480.</li>
            <li><code className="text-zinc-300">--relay</code> start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain.</li>
            <li><code className="text-zinc-300">-y, --yes</code> auto-confirm prompts.</li>
            <li><code className="text-zinc-300">--takeover</code> reclaim the local relay and serve daemons for the current identity. Use it when startup refuses because ownership or relay trust is mismatched.</li>
            <li><code className="text-zinc-300">--password-stdin</code> read the device identity password from stdin instead of prompting.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Reaching this machine from somewhere else</h3>
          <p className="text-zinc-400 mb-4">Plain <code className="text-zinc-300">gssh web</code> binds the relay to 127.0.0.1, so it is this machine only. To reach it from a laptop or a phone you need <code className="text-zinc-300">--relay</code>, which requires cloudflared installed and a reserved gitspace.sh subdomain. If no subdomain is configured, the command tells you to run <code className="text-zinc-300">gssh user auth login</code> then <code className="text-zinc-300">gssh user host reserve &lt;name&gt;</code>.</p>
          <p className="text-zinc-400 mb-8">Start local. Subdomains, remote access, and adding a second machine are covered later in these docs.</p>

          <h3 className="text-xl font-semibold text-white mb-4">What you see when it opens</h3>
          <p className="text-zinc-400 mb-4">With no workspace selected you land on the board: a <code className="text-zinc-300">Projects</code> strip across the top, and below it the kanban with four columns, <code className="text-zinc-300">Plan</code>, <code className="text-zinc-300">Code</code>, <code className="text-zinc-300">Review</code>, and <code className="text-zinc-300">Ship</code>. A fresh install has nothing in it and the strip reads <code className="text-zinc-300">No projects yet</code>.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-8">
            <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[#1a1a1a]">
              <span className="text-[10px] uppercase tracking-widest text-zinc-600">Projects</span>
              <span className="border border-[#1a1a1a] px-2 py-1 text-[11px] text-zinc-600 font-mono">filter projects…</span>
              <span className="ml-auto text-[11px] text-zinc-300">＋ New</span>
            </div>
            <div className="text-[11px] italic text-zinc-600 mb-4">No projects yet</div>
            <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
              <div className="border border-[#1a1a1a] p-3 text-zinc-400">Plan</div>
              <div className="border border-[#1a1a1a] p-3 text-zinc-400">Code</div>
              <div className="border border-[#1a1a1a] p-3 text-zinc-400">Review</div>
              <div className="border border-[#1a1a1a] p-3 text-zinc-400">Ship</div>
            </div>
          </div>

          <p className="text-zinc-400 mb-4">Press <code className="text-zinc-300">＋ New</code> in the Projects strip. With no projects yet it goes straight into creating one. Once you have projects, it asks first: <code className="text-zinc-300">Workspace</code>, <code className="text-zinc-300">Goal</code>, or <code className="text-zinc-300">Project</code>.</p>
          <p className="text-zinc-400 mb-4">Once a project is in, you are in the app. The Board section takes it from there.</p>
        </div>
      );

    case "concepts":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">What a space contains</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">A workspace is not just a checkout. As an agent works, it writes things down: what it is about to do, what it produced, what proves the work is done. Those records are the things you read. You almost never write them yourself.</p>

          <p className="text-zinc-400 mb-8">This page names them once. Everything else in these docs assumes you know what they are.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Who does what</h3>
          <p className="text-zinc-400 mb-4">The split is worth stating plainly, because it is the whole shape of the product.</p>
          <div className="border border-[#1a1a1a] bg-[#0c0c0c] mb-8">
            <div className="grid grid-cols-2 border-b border-[#1a1a1a] font-mono text-[11px] uppercase tracking-widest text-zinc-600">
              <div className="px-4 py-2.5 border-r border-[#1a1a1a]">The agent writes</div>
              <div className="px-4 py-2.5">You read and decide</div>
            </div>
            {[
              ["Declares intent before editing", "Whether the intent was right"],
              ["Produces the diff", "Whether to accept it"],
              ["Collects evidence for each requirement", "The calls only a person can make"],
              ["Narrates the change in build order", "Where to slow down"],
            ].map(([a, b]) => (
              <div key={a} className="grid grid-cols-2 border-b border-[#1a1a1a] last:border-b-0 text-sm">
                <div className="px-4 py-3 border-r border-[#1a1a1a] text-zinc-400">{a}</div>
                <div className="px-4 py-3 text-zinc-300">{b}</div>
              </div>
            ))}
          </div>
          <p className="text-zinc-400 mb-8">The boundary is enforced, not a convention. An agent cannot close a phase while that phase still owes an unmet requirement, and it cannot wave the gate through on its own: waiving is human only, and only in the app.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The goal</h3>
          <p className="text-zinc-400 mb-4">A goal is a piece of work with a written definition of done. It holds the goal doc, which says what is being attempted and why, and a validation contract: a list of requirements, each with a rubric describing what would prove it, and a judge that rules on the evidence.</p>
          <p className="text-zinc-400 mb-8">A goal outlives the workspace that executed it. Before work starts it is planned, with no checkout on disk. While an agent is on it, it holds a workspace. After it merges, the workspace is deleted and the goal remains.</p>
        <div className="border border-[#1a1a1a] bg-[#0c0c0c] mb-8 font-mono text-sm overflow-x-auto">
            <div className="flex items-center gap-2 border-b border-[#1a1a1a] px-4 py-2.5 text-[11px] uppercase tracking-widest text-zinc-600">
              <span className="h-2 w-2 bg-green-500" />checkout-flags · validation contract
            </div>
            {[
              ["R1", "checkout suite passes", "command", "accepted", "text-green-400"],
              ["R2", "error rate stays under 0.10%", "command", "accepted", "text-green-400"],
              ["R3", "screenshot of the live order total", "human", "review", "text-amber-300"],
            ].map(([id, rubric, judge, state, tone]) => (
              <div key={id} className="flex items-center gap-4 border-b border-[#1a1a1a] px-4 py-2.5 last:border-b-0">
                <span className="w-6 flex-none text-zinc-600">{id}</span>
                <span className="min-w-0 flex-1 text-zinc-300">{rubric}</span>
                <span className="w-16 flex-none text-zinc-600">{judge}</span>
                <span className={`w-20 flex-none text-right ${tone}`}>{state}</span>
              </div>
            ))}
            <div className="px-4 py-2.5 text-[13px] text-zinc-500">2 accepted · 1 awaiting review · not ready</div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">The journal</h3>
          <p className="text-zinc-400 mb-4">Work happens in phases, and the journal records both ends of each one. At the start of a phase the agent writes down what it intends to do and why, before it edits anything. At the end it records what actually happened, and the system snapshots the goal, workflow, and review state alongside it.</p>
          <p className="text-zinc-400 mb-8">The order is the point. Intent is on record before the code exists, so it cannot be quietly rewritten afterwards into a story that flatters the diff. When you want to know why a change was made, this is the honest answer rather than a reconstruction.</p>
        <div className="border border-[#1a1a1a] bg-[#0c0c0c] mb-8 font-mono text-sm overflow-x-auto">
            <div className="flex items-center gap-2 border-b border-[#1a1a1a] px-4 py-2.5 text-[11px] uppercase tracking-widest text-zinc-600">
              <span className="h-2 w-2 bg-blue-500" />phase journal
            </div>
            {[
              ["09:14", "phase start", "remove-api", "intent", "drop the checkout_v2 read in api first; expect flags.ts and one test", "text-blue-400"],
              ["09:41", "phase end", "remove-api", "outcome", "guard removed, one test added; the registry was the load-bearing part", "text-green-400"],
            ].map(([time, kind, phase, field, body, tone]) => (
              <div key={time} className="border-b border-[#1a1a1a] px-4 py-3 last:border-b-0">
                <div className="flex items-center gap-3 text-[13px]">
                  <span className="text-zinc-600">{time}</span>
                  <span className={tone}>{kind}</span>
                  <span className="text-zinc-500">{phase}</span>
                </div>
                <div className="mt-1.5 text-zinc-400">
                  <span className="text-zinc-600">{field}: </span>{body}
                </div>
              </div>
            ))}
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">The change guide</h3>
          <p className="text-zinc-400 mb-8">A diff arrives sorted by filename, which is the one order nobody built anything in. The guide retells the same change in build order: foundations first, then the code that wires them together, then the surfaces you touch. Each step is narrated, and the narration is grounded in the journal rather than invented after the fact. You read the change as a story instead of reconstructing it in your head.</p>
        <div className="grid gap-4 sm:grid-cols-2 mb-8 font-mono text-[13px]">
            <div className="border border-[#1a1a1a] bg-[#0c0c0c] overflow-x-auto">
              <div className="border-b border-[#1a1a1a] px-4 py-2.5 text-[11px] uppercase tracking-widest text-zinc-600">the diff · by filename</div>
              {["api/middleware/flag-guard.ts", "checkout/cart.tsx", "e2e/checkout.spec.ts", "flags/registry.ts", "types/flags.ts", "worker/handler.ts"].map((f) => (
                <div key={f} className="border-b border-[#1a1a1a] px-4 py-2 text-zinc-500 last:border-b-0">{f}</div>
              ))}
            </div>
            <div className="border border-[#1a1a1a] bg-[#0c0c0c] overflow-x-auto">
              <div className="border-b border-[#1a1a1a] px-4 py-2.5 text-[11px] uppercase tracking-widest text-zinc-600">the guide · by build order</div>
              {[
                ["1", "the registry", "what everything else reads"],
                ["2", "the transports", "same edit, three times"],
                ["3", "the surfaces", "what users touch"],
                ["4", "the tests", "what guards the risky part"],
              ].map(([n, title, note]) => (
                <div key={n} className="flex gap-3 border-b border-[#1a1a1a] px-4 py-2 last:border-b-0">
                  <span className="text-zinc-700">{n}</span>
                  <span className="text-zinc-300">{title}</span>
                  <span className="ml-auto text-zinc-600">{note}</span>
                </div>
              ))}
            </div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">The chain and the stack</h3>
          <p className="text-zinc-400 mb-4">Some work does not fit in one goal. A chain is an ordered list of goals where each one builds on the last, and a later goal cannot outrun an earlier one. The chain is the plan; workspaces appear and disappear underneath it as execution reaches each goal.</p>
          <p className="text-zinc-400 mb-8">The stack is the git side of the same idea: whether each workspace is still sitting on top of its ancestor, or has drifted and needs a rebase.</p>
        <div className="border border-[#1a1a1a] bg-[#0c0c0c] mb-8 p-4 overflow-x-auto">
            <div className="flex items-stretch gap-0 font-mono text-[13px] min-w-[560px]">
              {[
                ["1/4", "billing-schema", "merged", "text-zinc-600", "workspace removed"],
                ["2/4", "backfill-job", "merged", "text-zinc-600", "workspace removed"],
                ["3/4", "checkout-flags", "running", "text-green-400", "agent working"],
                ["4/4", "checkout-e2e", "planned", "text-zinc-700", "no workspace yet"],
              ].map(([n, id, state, tone, note], i) => (
                <div key={id} className="flex items-center">
                  <div className="border border-[#1a1a1a] px-3 py-2.5 min-w-[130px]">
                    <div className="text-[11px] text-zinc-700">{n}</div>
                    <div className="mt-0.5 text-zinc-300">{id}</div>
                    <div className={`mt-1 ${tone}`}>{state}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-700">{note}</div>
                  </div>
                  {i < 3 && <span className="px-2 text-zinc-700">&rarr;</span>}
                </div>
              ))}
            </div>
            <div className="mt-3 text-[13px] text-zinc-500 font-mono">a later goal cannot outrun an earlier one</div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Artifacts</h3>
          <p className="text-zinc-400 mb-8">Anything the work produces that is worth keeping: evidence attached to a requirement, a dashboard, a captured run. Artifacts live in the project's artifacts repository rather than in the code, so they survive the workspace being deleted. A goal that shipped last month still has its evidence.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Where you see them</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Goals, contracts, and readiness: the goal panel, covered in <span className="text-zinc-300">Goals and Chains</span></li>
            <li>The guide and the diff: the review view, covered in <span className="text-zinc-300">Reviewing Changes</span></li>
            <li>Evidence, dashboards, and scheduled runs: covered in <span className="text-zinc-300">Artifacts and Operations</span></li>
          </ul>
          <p className="text-zinc-400 mb-8">Each of these has a command behind it, and agents use those commands constantly. You do not have to. If you ever want to see what a screen is doing, the CLI reference lists them.</p>
        </div>
      );

    case "the-board":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">The Board</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">The board is what GitSpace opens to. Every project, every workspace, every agent, on one screen. You read it to answer one question: which one needs me right now.</p>

          <h3 className="text-xl font-semibold text-white mb-4">What is on the screen</h3>
          <p className="text-zinc-400 mb-4">Three bands, top to bottom.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>The chrome bar. <code className="text-zinc-300">GitSpace</code> on the left takes you back here from anywhere. Next to it is the project switcher, then a strip of chips for workspaces that are currently doing something.</li>
            <li>The projects strip, labelled <code className="text-zinc-300">Projects</code>. One card per project.</li>
            <li>The phase columns. This is the board proper.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Projects</h3>
          <p className="text-zinc-400 mb-4">Each project card shows its name and a line like <code className="text-zinc-300">3 chains · 7 workspaces</code>. If anything in the project has an agent running or an agent waiting on your permission, the count picks up <code className="text-zinc-300">· 2 active</code> and the name gets a small pulsing accent dot. Click the card and you go to that project's own home page. Under the card it says <code className="text-zinc-300">enter project home →</code>.</p>
          <p className="text-zinc-400 mb-4">There is a <code className="text-zinc-300">filter projects…</code> box if you have a lot of them. The <code className="text-zinc-300">＋ New</code> button opens a <code className="text-zinc-300">Create</code> menu with three choices: <code className="text-zinc-300">Workspace</code>, <code className="text-zinc-300">Goal</code> and <code className="text-zinc-300">Project</code>.</p>
          <p className="text-zinc-400 mb-8">Projects with no workspaces yet still appear. A fresh project is not hidden.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Workspaces, grouped by phase</h3>
          <p className="text-zinc-400 mb-4">A workspace is one branch, one worktree, one piece of work. Every workspace sits in exactly one of four columns, in this order:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">Plan</code> &mdash; author the spec: goal, rubric, review-gated workflow. Not editing the repo.</li>
            <li><code className="text-zinc-300">Code</code> &mdash; run the implementation workflow and guide it.</li>
            <li><code className="text-zinc-300">Review</code> &mdash; code review: commit staging and the narrative arc of the change.</li>
            <li><code className="text-zinc-300">Ship</code> &mdash; post-merge ops: monitor, deploy, crons, roll-up.</li>
          </ul>
          <p className="text-zinc-400 mb-4">Those descriptions are printed under each column heading in the app, so you do not have to remember them. Beside each heading is a count of everything in that column, including planned goals and workspaces still being created. An empty column says so plainly, for example <code className="text-zinc-300">No workspaces in review</code>.</p>
          <p className="text-zinc-400 mb-8">The board spans every project at once. The kicker above the columns reads <code className="text-zinc-300">All workspaces · across projects</code>. To work inside one project, click its card in the projects strip and you land on that project's home.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Reading a card</h3>
          <p className="text-zinc-400 mb-4">A card is a workspace. It carries a coloured dot and a matching coloured left edge, the workspace name in mono, the goal title underneath (or the branch name if there is no goal), and then chips for whatever is live: agents, terminals, services, pull request state, Linear issue. The footer shows which machine it is on, <code className="text-zinc-300">local</code> for this one, and if the goal has validation gates a tally like <code className="text-zinc-300">3/5 gates</code>.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-4 overflow-x-auto">
            <div className="min-w-[520px] font-mono text-[11px]">
              <div className="flex items-center gap-3 border-b border-[#1a1a1a] pb-2 mb-3 text-zinc-500">
                <span className="text-zinc-300 font-semibold">GitSpace</span>
                <span className="border-l border-[#1a1a1a] pl-3">⊞ acme-api ▾</span>
                <span className="flex items-center gap-1.5 border-l border-[#1a1a1a] pl-3"><span className="h-[6px] w-[6px] bg-[#ffcc00]" />auth-refresh <span className="text-zinc-600">CODE</span></span>
                <span className="ml-auto text-zinc-500">⚑ <span className="text-zinc-300">2</span></span>
                <span className="border border-[#1a1a1a] px-1.5 text-zinc-600">⌘K</span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-baseline justify-between border-b border-[#1a1a1a] pb-1.5 mb-2">
                    <span className="text-zinc-300 font-semibold">Code</span><span className="text-zinc-600">3</span>
                  </div>
                  <div className="space-y-2">
                    <div className="border border-[#1a1a1a] border-l-2 border-l-[#ffcc00] p-2">
                      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#ffcc00]" /><span className="text-zinc-300">auth-refresh</span></div>
                      <div className="text-zinc-500 mt-1">Rotate refresh tokens</div>
                      <div className="text-[#ffcc00] mt-1.5">1 agent ⚡</div>
                    </div>
                    <div className="border border-[#1a1a1a] border-l-2 border-l-[#00ff66] p-2">
                      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#00ff66]" /><span className="text-zinc-300">import-csv</span></div>
                      <div className="text-zinc-500 mt-1">Bulk contact import</div>
                      <div className="text-[#00ff66] mt-1.5">2 agents busy</div>
                    </div>
                    <div className="border border-dashed border-[#1a1a1a] p-2">
                      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#282828]" /><span className="text-zinc-500">rate-limits</span></div>
                      <div className="text-zinc-600 mt-1">Per-key rate limiting</div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-baseline justify-between border-b border-[#1a1a1a] pb-1.5 mb-2">
                    <span className="text-zinc-300 font-semibold">Review</span><span className="text-zinc-600">2</span>
                  </div>
                  <div className="space-y-2">
                    <div className="border border-[#1a1a1a] border-l-2 border-l-[#4488ff] p-2">
                      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#4488ff]" /><span className="text-zinc-300">webhook-retry</span></div>
                      <div className="text-zinc-500 mt-1">Retry failed deliveries</div>
                      <div className="text-[#4488ff] mt-1.5">1 agent idle</div>
                    </div>
                    <div className="border border-[#1a1a1a] border-l-2 border-l-[#282828] p-2">
                      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#282828]" /><span className="text-zinc-400">docs-pass</span></div>
                      <div className="text-zinc-500 mt-1">Tidy the API reference</div>
                      <div className="text-zinc-600 mt-1.5">local · 4/4 gates</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="text-zinc-500 text-sm mb-8">A sketch of the board, not a screenshot.</p>

          <h3 className="text-xl font-semibold text-white mb-4">What the colours mean</h3>
          <p className="text-zinc-400 mb-4">One dot per workspace, and it is always about agents first. The order below is the exact precedence: the first thing that is true wins.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><span className="text-[#ffcc00]">Amber</span> &mdash; an agent is asking for permission and is stopped until you answer. This outranks everything, because it is the only state where work is blocked on you.</li>
            <li><span className="text-[#00ff66]">Green</span> &mdash; an agent is running. The dot pulses so it reads as live rather than resting.</li>
            <li><span className="text-[#4488ff]">Blue</span> &mdash; an agent is open and waiting. Nothing is moving, nothing is broken.</li>
            <li><span className="text-[#ff5555]">Red</span> &mdash; something failed: an agent error worth acting on, a service that exited badly, a terminal that exited non-zero.</li>
            <li><span className="text-zinc-600">Grey</span> &mdash; nothing live. Closed, dormant and archived sessions all count as nothing, so a workspace you finished with fades out instead of crowding the board.</li>
          </ul>
          <p className="text-zinc-400 mb-8">So amber is the colour you scan for. Green means it is handling itself. Blue and grey can wait. Exact shades follow whichever theme you have picked.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Cards that are not workspaces yet</h3>
          <p className="text-zinc-400 mb-4">A dashed card with faint diagonal stripes is a planned goal: a spec with no workspace behind it. Its dot is always grey, because there is nothing running to report. When the goal before it in its chain has shipped, the card grows a striped green left edge, marked <code className="text-zinc-300">ready — predecessor shipped</code>. Click the card to open the goal.</p>
          <p className="text-zinc-400 mb-8">You will also see short-lived cards marked <code className="text-zinc-300">creating</code> or <code className="text-zinc-300">deleting</code> with a moving progress bar while a workspace is being made or torn down. Those are not clickable until they settle.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Chains</h3>
          <p className="text-zinc-400 mb-4">Goals that stack on each other form a chain. A bar above the columns lists them, labelled <code className="text-zinc-300">Goal Chains</code>, one chip per chain reading <code className="text-zinc-300">⛓ name · 1-4</code>. Hover a chain and its cards light up while the rest dim, with lines drawn between them so you can see the order across columns. Click a chain to open <code className="text-zinc-300">Edit chain order</code>, where <code className="text-zinc-300">↑</code> and <code className="text-zinc-300">↓</code> buttons reorder the goals. Nothing touches git until you press <code className="text-zinc-300">Save order</code>, and the panel says so: <code className="text-zinc-300">Save updates planning order only.</code></p>
          <p className="text-zinc-400 mb-4">The toggle above the columns switches the whole board between <code className="text-zinc-300">Workspaces</code> and <code className="text-zinc-300">Chains</code>. The Chains view drops the columns and lays each chain out as a left-to-right lane of goals, one node per goal with its status dot, its phase, and an alignment chip: <code className="text-zinc-300">aligned</code>, <code className="text-zinc-300">needs-rebase</code>, <code className="text-zinc-300">dirty-worktree</code>, <code className="text-zinc-300">missing-branch</code> or <code className="text-zinc-300">missing-workspace</code>. The node you are currently in is marked <code className="text-zinc-300">here</code>. A goal with no workspace yet carries a <code className="text-zinc-300">＋ Create workspace</code> button.</p>
          <p className="text-zinc-400 mb-8">Back on the cards, the same alignment reads in words: <code className="text-zinc-300">aligned</code>, <code className="text-zinc-300">needs rebase</code>, <code className="text-zinc-300">dirty worktree</code>, <code className="text-zinc-300">missing branch</code>, <code className="text-zinc-300">not created</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The inbox</h3>
          <p className="text-zinc-400 mb-4">The board tells you what is happening now. The inbox tells you what happened while you were not looking. Open it with the <code className="text-zinc-300">⚑</code> button in the chrome bar; a blue badge on it counts unread items.</p>
          <p className="text-zinc-400 mb-4">Items are grouped project, then workspace, then session, and each one is typed:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">Permission Request</code> &mdash; an agent wants approval. Same thing the amber dot is telling you.</li>
            <li><code className="text-zinc-300">Agent Done</code> and <code className="text-zinc-300">Agent Error</code>.</li>
            <li><code className="text-zinc-300">Completed</code> or <code className="text-zinc-300">Exit code N</code> for a command that finished.</li>
            <li><code className="text-zinc-300">Activity Complete</code>, <code className="text-zinc-300">Title Change</code>, <code className="text-zinc-300">OSC Notification</code>, <code className="text-zinc-300">Bell</code> from terminals.</li>
          </ul>
          <p className="text-zinc-400 mb-8">Click an item to read every notification for that session, each with the captured output. From there you get <code className="text-zinc-300">Attach</code> and <code className="text-zinc-300">Delete All</code>. In the list view, <code className="text-zinc-300">Clear All</code> empties the inbox.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Getting into a workspace</h3>
          <p className="text-zinc-400 mb-4">Click a card. The board is replaced by that workspace, with its agents, terminals, diffs and artifacts. Click <code className="text-zinc-300">GitSpace</code> in the chrome bar to come back.</p>
          <p className="text-zinc-400 mb-4">Two other ways in, both from the chrome bar. The chips beside the project switcher are the workspaces that have a live session or a non-grey status, plus the one you are looking at, each with its status dot and phase, so you can jump straight between the ones that are running. The switcher itself has two halves: click the project name to open that project's home, or click the <code className="text-zinc-300">▾</code> to pick a project and narrow the chip strip to it. <code className="text-zinc-300">all projects</code> in that menu puts every chip back.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">Cmd</code> or <code className="text-zinc-300">Ctrl</code> plus <code className="text-zinc-300">K</code> opens the command palette from anywhere.</li>
            <li>With a card selected, <code className="text-zinc-300">Shift</code> plus <code className="text-zinc-300">←</code> or <code className="text-zinc-300">→</code> moves that workspace to the previous or next phase column. It does nothing while you are typing in a field.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Long-running jobs</h3>
          <p className="text-zinc-400 mb-4">Creating and removing workspaces runs scripts, which takes time. A bar pinned to the bottom of the window shows the running job: a status dot, the job name, step pills for <code className="text-zinc-300">prepare</code>, <code className="text-zinc-300">setup</code>, <code className="text-zinc-300">select</code> and <code className="text-zinc-300">remove</code> with the current step lit while it runs, and elapsed time. Click the bar to expand its log. If more jobs are waiting you get a <code className="text-zinc-300">+N queued</code> chip. It disappears on its own about eight seconds after the job succeeds.</p>
        </div>
      );

    case "workspaces-and-agents":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Workspaces and Agents</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">A workspace is a git worktree on its own branch. Open one in the app and you get a sidebar of everything living in it, a dock of panes in the middle, and a rail on the right. Agents and terminals both run as panes.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The workspace screen</h3>
          <p className="text-zinc-400 mb-4">Three columns. The left sidebar lists what exists in this workspace, grouped under headings: <code className="text-zinc-300">Agent</code>, <code className="text-zinc-300">Agent Tasks</code>, <code className="text-zinc-300">Terminals</code>, <code className="text-zinc-300">Surfaces</code>, <code className="text-zinc-300">Dashboards</code>, <code className="text-zinc-300">Services</code>, <code className="text-zinc-300">Replays</code>, <code className="text-zinc-300">Notes</code>, <code className="text-zinc-300">PM Links</code>, and a pinned <code className="text-zinc-300">Workspace</code> footer. <code className="text-zinc-300">Agent</code>, <code className="text-zinc-300">Terminals</code> and <code className="text-zinc-300">Surfaces</code> are always there; an empty one says so, like <code className="text-zinc-300">No agents</code>. The rest appear only when they have something in them.</p>
          <p className="text-zinc-400 mb-4">Drag the divider to resize the sidebar. Its width is remembered in your browser. On a phone the sidebar becomes a bottom sheet opened from <code className="text-zinc-300">☰</code> in the header, and it closes itself after you pick something.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-8 font-mono text-[11px] leading-relaxed">
            <div className="flex gap-2">
              <div className="w-40 shrink-0 border border-[#1a1a1a] p-2">
                <div className="text-zinc-600 uppercase tracking-widest text-[9px] mb-1">Agent</div>
                <div className="text-zinc-300"><span className="text-green-500">▸</span> fix login <span className="text-zinc-600">2m</span></div>
                <div className="text-zinc-400"><span className="text-amber-400">▸</span> migrate db</div>
                <div className="text-zinc-600">＋ New thread</div>
                <div className="text-zinc-600 uppercase tracking-widest text-[9px] mt-3 mb-1">Terminals</div>
                <div className="text-zinc-400"><span className="text-green-500">⌗</span> shell <span className="text-zinc-600">attached</span></div>
                <div className="text-zinc-600">＋ New terminal</div>
              </div>
              <div className="flex-1 border border-[#1a1a1a]">
                <div className="flex items-center gap-3 border-b border-[#1a1a1a] px-2 py-1">
                  <span className="text-zinc-300"><span className="text-green-500">●</span> fix login <span className="text-zinc-600">×</span></span>
                  <span className="text-zinc-600">migrate db ×</span>
                  <span className="ml-auto text-zinc-600">⇆ Split</span>
                </div>
                <div className="px-2 py-2 text-zinc-500">transcript / terminal</div>
                <div className="border-t border-[#1a1a1a] px-2 py-2 text-zinc-600">Message agent...</div>
              </div>
              <div className="w-20 shrink-0 border border-[#1a1a1a] p-2 text-zinc-600">rail</div>
            </div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Panes</h3>
          <p className="text-zinc-400 mb-4">Everything you open lands in the dock as a tab. The button at the right of the tab strip is labelled <code className="text-zinc-300">⇆ Split</code> and moves the active tab into a pane on the right. A tab shows a pulsing green dot while its agent is running, and an <code className="text-zinc-300">×</code> to close it. The arrangement you build is kept as you move between workspaces and come back.</p>
          <p className="text-zinc-400 mb-8">Clicking a sidebar row that is already open focuses its pane instead of opening a second copy. That matters for agents: every extra pane takes its own viewer lease on the session.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Agent panes and terminal panes</h3>
          <p className="text-zinc-400 mb-4">They sit in the same dock and are not the same thing.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li>An <span className="text-zinc-300">agent pane</span> has no terminal in it. It renders a native transcript of blocks, with a control bar on top and a composer at the bottom.</li>
            <li>A <span className="text-zinc-300">terminal pane</span> is a real shell. Keystrokes go to the process.</li>
          </ul>
          <p className="text-zinc-400 mb-8">Closing either one with the tab's <code className="text-zinc-300">×</code> only stops you watching. An agent pane drops your viewer lease and the session keeps going; a terminal pane detaches and the shell keeps running. Ending a session for real is the separate <code className="text-zinc-300">×</code> on its sidebar row.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Starting an agent</h3>
          <p className="text-zinc-400 mb-4">Click <code className="text-zinc-300">＋ New thread</code> under <code className="text-zinc-300">Agent</code>. A pane opens and the composer is ready. Clicking an existing row opens that session in a pane instead.</p>
          <p className="text-zinc-400 mb-4">Each row carries a coloured marker for the session state, the model underneath the title, and how long ago it was active. While a session is running, a small <code className="text-zinc-300">✕</code> beside the row stops the current turn without ending the session. When it is not running, <code className="text-zinc-300">×</code> closes it. Closed sessions stay in the list marked <code className="text-zinc-300">closed</code> and can be filed away with <code className="text-zinc-300">arc</code>; archived ones hide behind an <code className="text-zinc-300">Archived agent sessions</code> row and come back with <code className="text-zinc-300">res</code>.</p>
          <p className="text-zinc-400 mb-4">The colours are consistent everywhere a session is drawn:</p>
          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-8 font-mono text-[11px] space-y-1">
            <div className="text-zinc-400"><span className="text-green-500">●</span> running <span className="text-zinc-600">the agent is working</span></div>
            <div className="text-zinc-400"><span className="text-blue-500">●</span> waiting <span className="text-zinc-600">idle, your move</span></div>
            <div className="text-zinc-400"><span className="text-amber-400">●</span> needs permission <span className="text-zinc-600">a question is on screen</span></div>
            <div className="text-zinc-400"><span className="text-red-500">●</span> retrying <span className="text-zinc-600">the turn failed and is being retried</span></div>
            <div className="text-zinc-400"><span className="text-zinc-600">●</span> closed / dormant / archived</div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">The transcript</h3>
          <p className="text-zinc-400 mb-4">The transcript is built from typed blocks rather than terminal output, so each kind of thing gets its own shape: messages, thinking, tool calls, diffs, code, file trees, tables, plans, checklists, images, mermaid diagrams, and sub-agent cards showing which model ran and how long it took.</p>
          <p className="text-zinc-400 mb-4">Some blocks are interactive. A question from the agent renders inline, above the composer, so you can read the conversation while you answer. A review gate offers <code className="text-zinc-300">Approve</code> and <code className="text-zinc-300">Request changes</code>. A failed prompt shows an error block with a <code className="text-zinc-300">Retry</code> button that re-sends it.</p>
          <p className="text-zinc-400 mb-8">Your message appears immediately when you send it and stays marked pending until the agent's own echo comes back.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The composer</h3>
          <p className="text-zinc-400 mb-4">The box at the bottom of an agent pane. Its placeholder is <code className="text-zinc-300">Message agent...</code>. The hint line under the box reads <code className="text-zinc-300">Enter sends · Shift+Enter adds a newline</code>.</p>
          <p className="text-zinc-400 mb-4">While the agent is busy the rules change, and the hint changes with them to <code className="text-zinc-300">Enter steers current turn · Ctrl/Cmd+Enter queues follow-up · use the mode button to switch Send</code>. A red stop button appears, titled <code className="text-zinc-300">Abort current turn</code>, next to a button reading <code className="text-zinc-300">Steer current turn ▾</code> or <code className="text-zinc-300">Queue follow-up ▾</code> that switches which one Send does. Anything queued is listed above the composer under <code className="text-zinc-300">Steering current turn</code> or <code className="text-zinc-300">Queued follow-ups</code>, each row with <code className="text-zinc-300">Edit</code> and <code className="text-zinc-300">Cancel</code>. Editing pulls the message back into the box.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li>Type <code className="text-zinc-300">/</code> at the start of a message for slash commands, and <code className="text-zinc-300">@</code> anywhere for a file. A list appears above the box: arrow keys move, Tab accepts, Escape closes it. Enter also accepts a file suggestion.</li>
            <li>Attach images and files with the two buttons on the left, or paste an image straight into the box. Files are uploaded and appended to your message as <code className="text-zinc-300">@path</code>.</li>
            <li>The words <code className="text-zinc-300">ultrathink</code>, <code className="text-zinc-300">orchestrate</code> and <code className="text-zinc-300">workflowz</code> light up as you type them, because each one triggers a mode.</li>
          </ul>
          <p className="text-zinc-400 mb-8">A draft you have not sent is kept per pane, so switching tabs does not lose it, and a send that fails leaves your text where it was.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The pane header</h3>
          <p className="text-zinc-400 mb-4">The strip above the transcript. Left to right: a status dot (green and pulsing while working, blue when idle, amber when the session is blocked on you, red on error), the model name, <code className="text-zinc-300">think</code> for reasoning effort, <code className="text-zinc-300">role</code> which advances through the model cycle when clicked, a <code className="text-zinc-300">ctx</code> bar showing how full the context window is, and running token and dollar totals for the session.</p>
          <p className="text-zinc-400 mb-4">Click the model name for a searchable list. On the right sit <code className="text-zinc-300">⚡ fast</code> where the provider supports it, <code className="text-zinc-300">⟲</code> titled <code className="text-zinc-300">History — rewind / undo the conversation</code>, <code className="text-zinc-300">⋯</code> for <code className="text-zinc-300">Session actions</code>, a <code className="text-zinc-300">goal</code> button when the workspace is bound to a goal, and <code className="text-zinc-300">⚙</code> for <code className="text-zinc-300">Agent controls &amp; settings</code>.</p>
          <p className="text-zinc-400 mb-8">Under <code className="text-zinc-300">⋯</code> are three ways to make room in the context: <code className="text-zinc-300">Elide heavy output</code>, <code className="text-zinc-300">Drop images</code>, and <code className="text-zinc-300">Compact now</code>. The panel warns that this changes the persisted active branch and the agent cannot undo it, then reports what it removed.</p>

          <h3 className="text-xl font-semibold text-white mb-4">History and rewind</h3>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">⟲</code> button opens a navigator over the session with two tabs.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">↩ History</code> lists your messages on the current branch, oldest first, current at the bottom. Activating one re-does that turn: the message leaves the transcript and its text comes back to the composer for you to change and send again. There is a filter box, focused with <code className="text-zinc-300">/</code>.</li>
            <li><code className="text-zinc-300">⑂ Tree</code> draws the current branch flat. At every point where the conversation forked, an amber group lists the other branches and expands them in place. Activating a node jumps the conversation there.</li>
          </ul>
          <p className="text-zinc-400 mb-8">Arrow keys move, Enter activates, Escape closes. The panel opens focused on the current turn.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Agent settings</h3>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">⚙</code> menu holds a role cycle, an <code className="text-zinc-300">approve</code> picker for approval mode, and <code className="text-zinc-300">⚙ Agent settings…</code>, which opens a panel titled <code className="text-zinc-300">Agent settings</code> with tabs: <code className="text-zinc-300">models</code>, <code className="text-zinc-300">agent</code>, <code className="text-zinc-300">agents</code>, <code className="text-zinc-300">settings</code>, <code className="text-zinc-300">usage</code>, <code className="text-zinc-300">context</code>, <code className="text-zinc-300">providers</code>.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><span className="text-zinc-300">models</span> assigns a model and a thinking level to each role, and marks which roles are in the quick cycle.</li>
            <li><span className="text-zinc-300">agent</span> sets the approval mode and per-tool approvals.</li>
            <li><span className="text-zinc-300">agents</span> gives each sub-agent its own model, showing where the definition came from.</li>
            <li><span className="text-zinc-300">usage</span> breaks the session's cost and tokens down by provider, model and role, including sub-sessions.</li>
            <li><span className="text-zinc-300">providers</span> is where you sign in, whether by API key or by a sign-in flow the panel walks you through.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Terminals</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">＋ New terminal</code> starts a shell in the worktree. Existing ones are listed above it, each with a right-hand label of <code className="text-zinc-300">attached</code> or <code className="text-zinc-300">idle</code>, and a glyph that goes green once the session is open in front of you. Sessions live on the machine, not in the tab, so closing the browser does not kill them and you can pick one back up later.</p>
          <p className="text-zinc-400 mb-4">On a phone, floating <code className="text-zinc-300">PgUp</code> and <code className="text-zinc-300">PgDn</code> buttons sit over the pane while the on-screen keyboard is hidden, so you can page through scrollback without a keyboard.</p>
          <p className="text-zinc-400 mb-8">Some panes are watch-only. Attaching to a running service from the <code className="text-zinc-300">Services</code> section with its <code className="text-zinc-300">att</code> button gives you the output with input disabled, so you can read a dev server without typing into it. Services also show their address, with <code className="text-zinc-300">↗</code> to open it and <code className="text-zinc-300">stop</code> to shut it down.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Replays</h3>
          <p className="text-zinc-400 mb-4">Recorded sessions appear under <code className="text-zinc-300">Replays</code> in the sidebar. Open one and you get the terminal as it was, with a transport: <code className="text-zinc-300">Play</code> and <code className="text-zinc-300">Pause</code>, arrows to step an event at a time, and <code className="text-zinc-300">-</code> and <code className="text-zinc-300">+</code> for speed. The header counts the elapsed time, the step, the checkpoint, and the current speed, and says <code className="text-zinc-300">[playing]</code> or <code className="text-zinc-300">[paused]</code>.</p>
          <p className="text-zinc-400 mb-4">The same controls are on the keyboard, and the header prints the ones that apply right now:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Space plays and pauses.</li>
            <li>While paused, left and right step one event; while playing, they change speed. Up and down also change speed while playing.</li>
            <li>Shift with left or right jumps between checkpoints. Home and End go to the ends.</li>
            <li><code className="text-zinc-300">r</code> reloads, <code className="text-zinc-300">d</code> dismisses or restores, <code className="text-zinc-300">q</code> or Escape leaves.</li>
          </ul>
          <p className="text-zinc-400 mb-8">A replay is read only. Nothing you type reaches anything.</p>
        </div>
      );

    case "reviewing-changes":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Reviewing Changes</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">GitSpace reviews a workspace's branch against its base branch, in the browser. You read diffs, leave comments on lines and hunks, approve or reject each hunk, and hand anything unresolved back to the agent that wrote the code.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Two ways in</h3>
          <p className="text-zinc-400 mb-4">Select a workspace. Its sidebar has a <code className="text-zinc-300">Surfaces</code> group with <code className="text-zinc-300">⛓ Change Guide</code> and <code className="text-zinc-300">☰ Review rubric</code>, which open as panes beside your terminals. Lower down, the action <code className="text-zinc-300">Open Review</code> replaces the whole window with the full review page: file list, diff, and a thread panel. The same action is in the command palette.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Use the <b className="text-zinc-300">Change Guide</b> when you want the change explained in the order it was built.</li>
            <li>Use the <b className="text-zinc-300">review page</b> when you want to sweep every file and record a decision per hunk.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Reading a diff</h3>
          <p className="text-zinc-400 mb-4">The review page puts the changed files down the left. Each row carries a one-letter change mark: <code className="text-zinc-300">A</code> added, <code className="text-zinc-300">D</code> deleted, <code className="text-zinc-300">R</code> renamed, <code className="text-zinc-300">C</code> copied, <code className="text-zinc-300">M</code> modified. Two toggles sit above the list: <code className="text-zinc-300">List</code> flips to <code className="text-zinc-300">Tree</code>, and <code className="text-zinc-300">Hide approved</code> drops files you have finished with. Drag the divider to widen the list.</p>
          <p className="text-zinc-400 mb-4">Diffs render unified. Only the changed lines load at first. Click <code className="text-zinc-300">Enable context expansion</code> in the bar above the diff to fetch the rest of the file, after which the separators between hunks expand the unmodified lines around them. The bar reads <code className="text-zinc-300">Context expansion ready</code> once that has happened. In the Change Guide the same thing happens on the first click of an <code className="text-zinc-300">n unmodified lines</code> separator.</p>
          <p className="text-zinc-400 mb-8">In the Change Guide, a diff larger than roughly 60KB is not rendered inline until you ask. It shows its size and offers <code className="text-zinc-300">render anyway</code> or <code className="text-zinc-300">open as tab</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Leaving a comment</h3>
          <p className="text-zinc-400 mb-4">The bar above the diff spells the two moves out: <code className="text-zinc-300">Hover a line and click + to comment</code> and <code className="text-zinc-300">Drag line numbers to comment on a range</code>. Hovering a line puts a round blue <code className="text-zinc-300">+</code> in the gutter; clicking it opens the composer for that one line. Dragging down the line numbers opens the same composer for the range.</p>
          <p className="text-zinc-400 mb-4">On the review page the composer is a bar pinned to the bottom of the window, headed <code className="text-zinc-300">Commenting on line 43</code>, <code className="text-zinc-300">Commenting on line 12-18</code>, or <code className="text-zinc-300">Commenting on hunk</code>. In the Change Guide it opens inline under the line, headed <code className="text-zinc-300">Commenting on L12–L18</code> with <code className="text-zinc-300">· old side</code> or <code className="text-zinc-300">· new side</code> after it. In both, <code className="text-zinc-300">Cmd/Ctrl+Enter</code> submits and <code className="text-zinc-300">Escape</code> cancels. If the write fails your text stays in the box.</p>
          <p className="text-zinc-400 mb-4">Whole hunks get their own strip of buttons at the top right of the hunk, on the review page only: <code className="text-zinc-300">Reject</code>, <code className="text-zinc-300">Approve</code>, and then either <code className="text-zinc-300">Comment</code> or <code className="text-zinc-300">Threads</code> once a thread exists there. Diffs inside the Change Guide take line comments but carry no hunk controls.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-8 font-mono text-[11px] leading-relaxed">
            <div className="text-zinc-600 mb-2">src/core/review.ts</div>
            <div className="flex items-center gap-2 text-zinc-600">
              <span className="w-8 text-right">41</span>
              <span className="flex-1 text-zinc-400">  const threads = getThreads(path);</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-600">
              <span className="w-8 text-right">42</span>
              <span className="flex-1 text-zinc-400">  if (!threads.length) return null;</span>
              <span className="ml-auto flex items-center gap-1">
                <span className="border border-[#1a1a1a] px-1.5 text-[#f85149]">Reject</span>
                <span className="border border-[#1a1a1a] px-1.5 text-[#22c55e]">Approve</span>
                <span className="border border-[#1a1a1a] px-1.5 text-blue-500">Comment</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-zinc-600">
              <span className="w-8 text-right">43</span>
              <span className="inline-flex h-4 w-4 items-center justify-center bg-blue-500 text-black font-bold">+</span>
              <span className="flex-1 text-[#22c55e]">+ return summarize(threads);</span>
            </div>
            <div className="mt-3 border-t border-[#1a1a1a] pt-2">
              <div className="text-zinc-500 mb-1">Commenting on line 43</div>
              <div className="border border-[#1a1a1a] px-2 py-1 text-zinc-600">Add a comment...</div>
            </div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Decisions and what the colours mean</h3>
          <p className="text-zinc-400 mb-4">A hunk carries one of three decisions. The same three colours mark it on the thread badge in the panel and on the thread marker in the diff.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><span className="text-[#22c55e]">Green</span> is <code className="text-zinc-300">✓ Approved</code>.</li>
            <li><span className="text-[#f85149]">Red</span> is <code className="text-zinc-300">✗ Changes requested</code>.</li>
            <li><span className="text-[#d29922]">Amber</span> is <code className="text-zinc-300">⏳ Pending</code>, meaning a thread exists but you have not decided.</li>
          </ul>
          <p className="text-zinc-400 mb-4">If any thread on a hunk is rejected, the hunk is rejected. A hunk counts as approved only when every thread on it is approved. A file shows <code className="text-zinc-300">OK</code> in the file list once all of its hunks are approved, which is also what <code className="text-zinc-300">Hide approved</code> filters on. In Tree mode each folder row has an <code className="text-zinc-300">Approve</code> button that approves every remaining hunk beneath it in one go.</p>
          <p className="text-zinc-400 mb-8">The whole workspace gets a status chip in the review page header, rolled up from those decisions: <code className="text-zinc-300">Not started</code> in grey, <code className="text-zinc-300">In progress</code> in amber, <code className="text-zinc-300">Approved</code> in green, <code className="text-zinc-300">Changes required</code> in red.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The thread panel</h3>
          <p className="text-zinc-400 mb-4">The right side of the review page lists every thread, headed <code className="text-zinc-300">Review Threads</code> with a count of open ones. Three filter pills narrow it: <code className="text-zinc-300">All</code>, <code className="text-zinc-300">Current file</code>, <code className="text-zinc-300">Current hunk</code>. The last two stay disabled until you have a file or a hunk in focus.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">Go to code</code> jumps the diff to the thread's anchor.</li>
            <li><code className="text-zinc-300">Reply</code> adds to the thread, <code className="text-zinc-300">Resolve</code> closes it and turns into <code className="text-zinc-300">Re-open</code>.</li>
            <li>Comments you wrote yourself carry <code className="text-zinc-300">Edit</code> and <code className="text-zinc-300">Del</code>.</li>
            <li>Hunk threads show <code className="text-zinc-300">✓ Approve</code>, <code className="text-zinc-300">✗ Reject</code> and <code className="text-zinc-300">⏳ Pending</code> inline while they are open.</li>
            <li><code className="text-zinc-300">✦ Send to agent → fix</code> routes that one finding to the workspace's agent session.</li>
          </ul>
          <p className="text-zinc-400 mb-4">Comment bodies take a small subset of markdown: paragraphs, <code className="text-zinc-300">- </code> bullet lists, fenced code, inline code, bold, italic, links. Comments that came from GitHub are tagged <code className="text-zinc-300">· GH</code>.</p>
          <p className="text-zinc-400 mb-8">The header also has <code className="text-zinc-300">↺ Refresh</code>, <code className="text-zinc-300">↓ Import GH</code> to pull review comments in from the pull request, <code className="text-zinc-300">↑ Push to GH</code> to send yours out, and <code className="text-zinc-300">≡ Hide</code> to collapse the panel, which then reads <code className="text-zinc-300">≡ Threads</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The Change Guide</h3>
          <p className="text-zinc-400 mb-4">A diff sorted by path tells you nothing about how a change was built. The Change Guide, headed <code className="text-zinc-300">Change Guide · the PR as a story</code>, retells it as an ordered walkthrough instead. A narrator agent writes the guide; press <code className="text-zinc-300">✦ Generate guide</code> in the guide's footer to spawn one. Until a guide exists, the pane falls back to grouping the changed files by top level directory so there is still something to walk.</p>
          <p className="text-zinc-400 mb-4">Each step has a short phase label, a title, and the narrator's explanation. Callouts are tagged <code className="text-zinc-300">risk</code>, <code className="text-zinc-300">decision</code> or <code className="text-zinc-300">mechanical</code>. Direct questions to you appear as their own boxes. A narrated step lists all its files under an <code className="text-zinc-300">n files in this step</code> header, then shows diffs for the handful the narrator chose as exhibits, each with the note saying why it is in front of you. An exhibit worth slowing down on is marked <code className="text-zinc-300">slow</code>. The step header and its notes pin to the top while you scroll the diffs, and <code className="text-zinc-300">▾ notes</code> collapses them if you want the room.</p>
          <p className="text-zinc-400 mb-4">Mark each step <code className="text-zinc-300">Mark complete</code> as you finish it, after which the button reads <code className="text-zinc-300">✓ Complete</code>. The left rail keeps a running <code className="text-zinc-300">n / m phases reviewed</code>.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] mb-4 text-[11px]">
            <div className="flex">
              <div className="w-48 shrink-0 border-r border-[#1a1a1a] p-3 font-mono">
                <div className="text-zinc-500 mb-2">Change Guide</div>
                <div className="flex items-center gap-2 text-zinc-500"><span className="h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" /><span>1 storage seam</span></div>
                <div className="flex items-center gap-2 text-zinc-300"><span className="h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" /><span>2 the executor</span></div>
                <div className="flex items-center gap-2 text-zinc-500"><span className="h-2 w-2 shrink-0 rounded-full border border-zinc-600" /><span>3 the pane</span></div>
                <div className="mt-3 text-zinc-600">2 / 3 phases reviewed</div>
                <div className="mt-3 border border-[#22c55e] px-2 py-0.5 text-center text-[#22c55e]">Approve · 2/3</div>
              </div>
              <div className="min-w-0 flex-1 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-zinc-300">the executor</span>
                  <span className="ml-auto text-zinc-600 uppercase text-[10px]">core</span>
                  <span className="border border-[#1a1a1a] px-1.5 text-zinc-500">Mark complete</span>
                </div>
                <p className="text-zinc-400 mb-2">Every review op lands here first, so read this before the pane that calls it.</p>
                <div className="border-l-2 border-[#f85149] px-2 text-[#f85149] mb-2"><span className="uppercase text-[9px] mr-1">risk</span>approve_path writes one thread per hunk</div>
                <div className="border border-[#1a1a1a] px-2 py-1 font-mono text-zinc-500">
                  <span className="border border-[#ffcc0055] px-1 text-[#ffcc00] mr-2 text-[9px]">SLOW</span>src/core/review-executor.ts
                </div>
              </div>
            </div>
          </div>

          <p className="text-zinc-400 mb-4">If HEAD has moved since the guide was written, a banner says so and the button becomes <code className="text-zinc-300">✦ Regenerate guide</code>. The narrative still describes the older commit while the exhibits show the current diff, so the two can disagree.</p>
          <p className="text-zinc-400 mb-8">The footer carries <code className="text-zinc-300">☰ Review rubric</code>, which opens the rubric pane, and <code className="text-zinc-300">Approve</code>. While anything is open, <code className="text-zinc-300">↺ Request changes</code> appears too: it collects your open threads and any pending human gate into one prompt and sends it to the workspace's agent. <code className="text-zinc-300">Approve</code> stays disabled, reading <code className="text-zinc-300">Approve · n/m</code> with the open thread count after it, until every step is marked complete, no threads are open, and no human gate in the rubric is still pending. Approving records who approved, when, and which commit they approved, and moves the workspace to the ship phase.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The rubric</h3>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">☰ Review rubric</code> pane, subtitled <code className="text-zinc-300">· the contract</code>, is the list of criteria this workspace's goal has to satisfy. It only appears once the goal carries validation requirements; criteria are authored from the goal detail panel, not here. The index and the criterion you have selected sit on the left, the full list on the right.</p>
          <p className="text-zinc-400 mb-4">Every criterion shows a verdict chip: <code className="text-zinc-300">pass</code> green, <code className="text-zinc-300">partial</code> amber, <code className="text-zinc-300">fail</code> red, <code className="text-zinc-300">pending</code> dim. Next to it is the gate, meaning who is allowed to decide it: <code className="text-zinc-300">◆ human gate</code>, <code className="text-zinc-300">✦ llm gate</code>, or <code className="text-zinc-300">❯ command gate</code>. Under that sit the criterion text, the commands that generate and verify its evidence with the expectation each must meet, such as <code className="text-zinc-300">expects exit 0</code>, and a count of the judges and evidence recorded against it.</p>
          <p className="text-zinc-400 mb-4">Criteria that are not human gated and not yet accepted offer <code className="text-zinc-300">run judgment</code>. A human gated criterion is flagged <code className="text-zinc-300">awaiting your verdict</code> and gives you a form: pick <code className="text-zinc-300">pass</code>, <code className="text-zinc-300">partial</code> or <code className="text-zinc-300">fail</code>, set a score from 0 to 100, and write a note. The note is required. Then press <code className="text-zinc-300">Record judgement</code>.</p>
          <p className="text-zinc-400 mb-8">When the rubric is opened filtered to a workflow phase it shows a phase gate strip at the top, saying how many requirements that phase owes and how many are unmet. A human can override it with <code className="text-zinc-300">waive…</code>, which records a reason. <code className="text-zinc-300">✕ show all criteria</code> clears the filter, and <code className="text-zinc-300">§ by slice</code> regroups criteria by the goal document slice they belong to.</p>
        </div>
      );

    case "goals-and-chains":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Goals and Chains</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">A goal is one intended change, written down before the work starts. It carries a doc that says what you want and a contract that says what would prove you got it. A chain is an ordered run of goals where a later goal can never be further along than an earlier one.</p>

          <h3 className="text-xl font-semibold text-white mb-4">What a goal is</h3>
          <p className="text-zinc-400 mb-4">A goal lives in a project and belongs to exactly one chain. It has a title, a position in that chain, a phase (<code className="text-zinc-300">plan</code>, <code className="text-zinc-300">code</code>, <code className="text-zinc-300">review</code>, <code className="text-zinc-300">ship</code>), and a status.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">planned</code>: the goal exists, no workspace has been created for it yet. Its phase always reads as <code className="text-zinc-300">plan</code>.</li>
            <li><code className="text-zinc-300">workspace-backed</code>: a workspace was created from it, and the workspace's phase is the goal's phase.</li>
            <li><code className="text-zinc-300">archived</code>: the workspace is gone and the phase is frozen where it ended.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Creating a goal</h3>
          <p className="text-zinc-400 mb-4">Open the create menu and pick <code className="text-zinc-300">Goal</code> ("Add a goal to a chain (new or existing)"). You then pick a chain from the <code className="text-zinc-300">Select chain</code> list, or <code className="text-zinc-300">＋ New chain</code> to start one with this goal as its first. Name the goal, then choose where it sits under <code className="text-zinc-300">Goal position</code>.</p>
          <p className="text-zinc-400 mb-8">The position list only offers legal slots. A new goal is always in <code className="text-zinc-300">plan</code>, so it cannot be placed at or before a goal that has already moved past <code className="text-zinc-300">plan</code>. If the chain is empty you get one option, <code className="text-zinc-300">First goal</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The goal detail panel</h3>
          <p className="text-zinc-400 mb-4">Clicking a planned goal on the board opens a full-height panel down the right edge. Its left rail states readiness at the top, a summary line and a detail line under it, then four tabs:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">At a glance</code>: every requirement in one table, columns <code className="text-zinc-300">Requirement</code>, <code className="text-zinc-300">Produced by</code>, <code className="text-zinc-300">Judged by</code>, <code className="text-zinc-300">Status</code>, <code className="text-zinc-300">Next</code>. Four counters (total, missing, needs review, accepted) double as filters, and <code className="text-zinc-300">View Blocker</code> jumps you to the first thing standing in the way.</li>
            <li><code className="text-zinc-300">Goal doc</code>: the brief.</li>
            <li><code className="text-zinc-300">Requirements</code>: the contract, where you author and judge.</li>
            <li><code className="text-zinc-300">Timeline</code>: how the goal got to its current state, filterable by event kind.</li>
          </ul>
          <p className="text-zinc-400 mb-8">At the bottom of that rail sit <code className="text-zinc-300">Create workspace</code> (shown only while the goal has no workspace) and <code className="text-zinc-300">Run stack status</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The goal doc</h3>
          <p className="text-zinc-400 mb-4">The doc is markdown, described in the panel as "The implementer's brief. Describe intent; link the specific requirements that prove it." A goal with no doc yet starts from a skeleton of <code className="text-zinc-300">## Objective</code>, <code className="text-zinc-300">## Non-goals</code> and <code className="text-zinc-300">## Validation</code> under the title. You can view it as preview, edit, or a split of both, and save or discard your draft.</p>
          <p className="text-zinc-400 mb-8">Inside a workspace the same doc opens as the <code className="text-zinc-300">◇ Goal</code> pane, reachable from the right rail's <code className="text-zinc-300">Goal</code> group (the <code className="text-zinc-300">goal.md</code> row). That pane adds a strip of the whole chain across the top, with <code className="text-zinc-300">‹ up</code> and <code className="text-zinc-300">down ›</code> to walk to the neighbouring goals and a card at the end that opens the <code className="text-zinc-300">⟜ Workflow</code> pane.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The validation contract</h3>
          <p className="text-zinc-400 mb-4">Requirements are the contract. The panel puts it plainly: "Each row owns its rubric, its generation strategy, and its judgment strategy." <code className="text-zinc-300">Add requirement</code> asks three questions.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><strong className="text-zinc-300">What is it.</strong> A title, a rubric, whether it is required or optional, and a kind: screenshot, video, command output, note, file, or link.</li>
            <li><strong className="text-zinc-300">How is it produced.</strong> Manual (you attach it) or a command that produces it.</li>
            <li><strong className="text-zinc-300">How is it judged.</strong> Human, llm, or command.</li>
          </ul>
          <p className="text-zinc-400 mb-4">The rubric is not optional. The form refuses to submit without one: "Rubric is required — what makes this evidence acceptable?" It is the text the implementer reads to know what to produce and the judge reads when deciding.</p>
          <p className="text-zinc-400 mb-8">A requirement is in one of three states, shown as <code className="text-zinc-300">needs evidence</code>, <code className="text-zinc-300">needs review</code>, or <code className="text-zinc-300">review passed</code>. Until evidence exists, judgment is locked and the panel says so: "Judgment unlocks after evidence is produced."</p>

          <h3 className="text-xl font-semibold text-white mb-4">The three judges</h3>
          <p className="text-zinc-400 mb-4"><strong className="text-zinc-300">Command.</strong> You give a command and what to expect from it: exit zero, empty stderr, stdout contains a string, or stdout matches a regex. Pressing <code className="text-zinc-300">Run check</code> runs it and records a pass or fail with the exit code. If the requirement's generation command is the same command, the check judges that run rather than executing it twice, and a generation run that already satisfies the expectation accepts the requirement on the spot.</p>
          <p className="text-zinc-400 mb-4"><strong className="text-zinc-300">Human.</strong> You read the evidence and decide. Described below.</p>
          <p className="text-zinc-400 mb-8"><strong className="text-zinc-300">LLM.</strong> You can declare a requirement as llm-judged and name a model hint, and the button <code className="text-zinc-300">Run LLM judgment</code> appears. The runner is not implemented yet. Pressing it records an honest amber review saying the LLM judgment runner is not available and that you should apply the rubric manually or wire an LLM backend. It never fabricates a pass. Treat llm as a declaration of intent for now, not a working judge.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Judging as a human</h3>
          <p className="text-zinc-400 mb-4">When a human-judged requirement has evidence, the reviews box grows a note field and three buttons: <code className="text-zinc-300">Fail</code>, <code className="text-zinc-300">Needs changes</code>, <code className="text-zinc-300">Pass</code>. The note is labelled "(required for fail / needs changes)" and the panel blocks you with "A note is required to fail this requirement." or "A note is required to request changes." if you skip it. Pass takes a note but does not demand one.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">Pass</code> accepts the requirement and pins the rubric text you judged against.</li>
            <li><code className="text-zinc-300">Needs changes</code> leaves it in needs review with your note attached.</li>
            <li><code className="text-zinc-300">Fail</code> sends it back to needs evidence and clears the attached evidence. It is a reset, not a comment.</li>
          </ul>
          <p className="text-zinc-400 mb-4">Every decision lands on the timeline and the panel confirms with "Review recorded: passed", "needs changes", or "failed". An accepted requirement keeps a <code className="text-zinc-300">Reopen for review</code> button if you change your mind.</p>
          <p className="text-zinc-400 mb-8">Inside a workspace, the <code className="text-zinc-300">☰ Review rubric</code> pane is the same act with more room: criteria down the left, evidence cards with previews on the right, and a judgement form headed "◆ your judgement — this criterion is human-gated" offering <code className="text-zinc-300">pass</code>, <code className="text-zinc-300">partial</code>, <code className="text-zinc-300">fail</code>, a 0 to 100 score slider, and a note prompted with "Why — cite what the evidence on the right does or doesn't prove…". <code className="text-zinc-300">Record judgement</code> stays disabled until you have picked a decision and written something. Here <code className="text-zinc-300">partial</code> is the same decision as <code className="text-zinc-300">Needs changes</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Readiness</h3>
          <p className="text-zinc-400 mb-4">Readiness is one sentence computed from the required requirements only. Optional ones never hold a goal back.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><strong className="text-zinc-300">Ready</strong>: "Ready: all required artifacts passed judgment."</li>
            <li><strong className="text-zinc-300">Awaiting review</strong>: everything is attached but something has not been judged.</li>
            <li><strong className="text-zinc-300">Not ready</strong>: something is missing, or a required requirement's last review was a fail.</li>
          </ul>
          <p className="text-zinc-400 mb-8">A goal with no required requirements at all is not ready either, and says so: "No required artifacts declared." Readiness is advice, not a lock. When you roll a workspace up, GitSpace checks the goal's gates first. If they are all met you get a short confirm. If they are not, you get a red confirm that names each unmet requirement and states that proceeding overrides those gates on your authority, with the button reading <code className="text-zinc-300">Roll up anyway</code>. You are never blocked, only told.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Chains</h3>
          <p className="text-zinc-400 mb-4">A chain is an ordered plan. Each goal in it shows a <code className="text-zinc-300">⛓</code> badge with its position, like 2/4. The rule that gives the order meaning: a descendant can never be further along than its ancestor. Phases run <code className="text-zinc-300">plan → code → review → ship</code>, and if goal 2 is still in <code className="text-zinc-300">code</code>, goal 3 cannot be in <code className="text-zinc-300">review</code>.</p>
          <p className="text-zinc-400 mb-4">That rule is enforced everywhere the order can change. The position picker hides illegal slots. In the reorder popup the ↑ and ↓ buttons grey out on any move that would break it. Moving a workspace forward past what its ancestors allow is refused with a message naming the maximum phase allowed and why; moving one backward that would strand its descendants tells you how many descendants must come back with it.</p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-4 overflow-x-auto">
            <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-600 mb-3">⛓ Editor rewrite &middot; 4 goals</div>
            <div className="flex items-stretch font-mono text-xs">
              <div className="w-48 flex-none border border-[#1a1a1a] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-zinc-600" />
                  <span className="truncate text-zinc-300">Extract parser</span>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-600">ship &middot; <span className="text-green-500">aligned</span></div>
              </div>
              <span className="flex w-8 flex-none items-center justify-center text-amber-400">→</span>
              <div className="w-48 flex-none border border-[#1a1a1a] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-green-500" />
                  <span className="truncate text-zinc-300">Streaming reads</span>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-600">review &middot; <span className="text-amber-400">needs rebase</span></div>
              </div>
              <span className="flex w-8 flex-none items-center justify-center text-zinc-600">→</span>
              <div className="w-48 flex-none border border-[#1a1a1a] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-blue-500" />
                  <span className="truncate text-zinc-300">Error surfaces</span>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-600">code &middot; <span className="text-green-500">aligned</span></div>
              </div>
              <span className="flex w-8 flex-none items-center justify-center text-zinc-600">→</span>
              <div className="w-48 flex-none border border-[#1a1a1a] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-zinc-600" />
                  <span className="truncate text-zinc-300">Docs pass</span>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-600">planned &middot; <span className="text-zinc-600">not created</span></div>
              </div>
            </div>
            <div className="mt-3 text-[10px] text-zinc-600">Order is left to right. Nothing to the right may sit in a later phase than anything to its left. A connector takes its colour from the node it points to.</div>
          </div>
          <p className="text-zinc-400 mb-8">The board has two lenses, toggled by <code className="text-zinc-300">Workspaces</code> and <code className="text-zinc-300">Chains</code> in its header. <code className="text-zinc-300">Chains</code> lays each chain out as a horizontal lane like the one above, kicker text "Goal chains · alignment across the chain". Clicking a node opens its workspace, or the goal itself if no workspace exists yet, and a planned node offers <code className="text-zinc-300">＋ Create workspace</code> right there. The project home page shows the same chains as compact rows of status dots, one dot per goal, each dot clickable on its own.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Reordering, and what it does not touch</h3>
          <p className="text-zinc-400 mb-4">Hovering a goal card reveals a <code className="text-zinc-300">⇅</code> handle titled "Rearrange chain order". It opens a small <code className="text-zinc-300">Edit chain order</code> panel listing the chain in order with ↑ and ↓ per row, and arrow keys work on a focused row. Nothing is written until you press <code className="text-zinc-300">Save order</code>.</p>
          <p className="text-zinc-400 mb-8">Reordering changes the plan, not the repository. The panel says it twice, in its footer ("Save updates planning order only.") and in the message after saving: "Goal order saved; git stack unchanged. Run stack status when ready." <code className="text-zinc-300">Run stack status</code> is the separate act that compares the chain against real branches and reports each edge as aligned, needs rebase, dirty worktree, missing branch, or not created. Those verdicts come back as chips on the goal cards and as coloured connectors between chain nodes.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Gates and waiving</h3>
          <p className="text-zinc-400 mb-4">When a workspace has a workflow spec, each phase of that workflow owes the requirements tagged to it, and the phase gate is satisfied when all of them are accepted. The <code className="text-zinc-300">☰ Review rubric</code> pane, opened from a workflow gate chip, shows that phase's gate as <code className="text-zinc-300">✓ satisfied</code>, <code className="text-zinc-300">◇ trivial</code> (nothing owed), <code className="text-zinc-300">◆ waived</code>, or a count of owed and unmet.</p>
          <p className="text-zinc-400 mb-8">An unmet gate offers <code className="text-zinc-300">waive…</code>, described in the app as human only. It asks for a reason and refuses an empty one: "A reason is required to waive a gate." The reason is recorded on the goal's timeline. Waiving is how a person overrides the contract on the record, rather than quietly around it.</p>
        </div>
      );

    case "artifacts-ops":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Artifacts and Operations</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">
            Artifacts are the files your work produces: goal docs, evidence, reports, notes, data, dashboards and small
            apps. They live in a separate per-project repo, one branch per workspace, and roll up into main when a
            workspace ships. You read and open all of them from the rails in the app.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Where artifacts show up</h3>
          <p className="text-zinc-400 mb-4">
            A workspace has a right rail with three tabs: <code className="text-zinc-300">repo</code>,{' '}
            <code className="text-zinc-300">artifacts</code> and <code className="text-zinc-300">project</code>. The
            <code className="text-zinc-300"> artifacts</code> tab shows this workspace&apos;s own artifacts. The
            <code className="text-zinc-300"> project</code> tab shows the project&apos;s artifacts, the ones already rolled
            up into main; it is read-only, so rows there have no star and no share control. Drag the rail&apos;s left edge
            to resize it; the width, the tab you were on and whether it was collapsed are all remembered.
          </p>
          <p className="text-zinc-400 mb-4">
            The artifacts tab has two views, <code className="text-zinc-300">Artifacts</code> and{' '}
            <code className="text-zinc-300">★ Favorites</code>, plus a search box (&ldquo;search project artifacts…&rdquo;)
            that filters rows as you type. Star a row to pin it into Favorites. Clicking a row opens the artifact as a tab
            in the middle of the workspace.
          </p>
          <p className="text-zinc-400 mb-4">
            Project home has the same rail on its right, with the same{' '}
            <code className="text-zinc-300">Artifacts</code> and <code className="text-zinc-300">★ Favorites</code> views,
            grouped by goal. One goal is shown at a time. When more than one goal has been rolled up, the goal title at the
            top of the group is itself the picker: click it to search and switch goals. Artifacts that sit at the project
            root are collected under a section headed <code className="text-zinc-300">Project</code>. In this rail, a file
            stored through Git LFS carries a small <code className="text-zinc-300">lfs</code> badge.
          </p>

          <div className="mb-8 border border-[#1a1a1a] bg-[#0c0c0c] p-3 font-mono text-[11px] text-zinc-400">
            <div className="flex border-b border-[#1a1a1a] pb-1 mb-2 text-[10px] uppercase tracking-widest">
              <span className="flex-1 text-center text-zinc-600">repo</span>
              <span className="flex-1 text-center text-zinc-300">artifacts</span>
              <span className="flex-1 text-center text-zinc-600">project</span>
            </div>
            <div className="mb-2 text-zinc-300">Artifacts <span className="text-zinc-600">★ Favorites 3</span></div>
            <div className="mb-2 border border-[#1a1a1a] px-2 py-1 text-zinc-600">search project artifacts…</div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-2">Goal</div>
            <div className="pl-2 text-zinc-300">◇ goal.md <span className="text-zinc-600">doc</span></div>
            <div className="pl-2 text-zinc-300">☰ 7 requirements <span className="text-zinc-600">rubric</span></div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-2">Evidence</div>
            <div className="pl-2 text-zinc-300">▸ login-flow.webm <span className="text-zinc-600">video</span></div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-2">Dashboards</div>
            <div className="pl-2 text-zinc-300">▦ latency.dashboard.json <span className="text-zinc-600">json</span></div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-2">Data</div>
            <div className="pl-2 text-zinc-300">▤ runs.data.json <span className="text-zinc-600">json</span> <span className="text-amber-400">★</span></div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Kinds</h3>
          <p className="text-zinc-400 mb-4">
            An artifact&apos;s kind comes from its path and name, and it decides the icon, the group it sits in and what
            opens when you click it.
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">◇ Goal</code> is <code className="text-zinc-300">goal.md</code>, the goal document.</li>
            <li><code className="text-zinc-300">☰ Rubric</code> is <code className="text-zinc-300">rubric.json</code> or any <code className="text-zinc-300">*.rubric.json</code>.</li>
            <li><code className="text-zinc-300">⟜ Workflow</code> is any <code className="text-zinc-300">*.workflow.json</code>.</li>
            <li><code className="text-zinc-300">▸ Evidence</code> is anything under <code className="text-zinc-300">validation/</code>, <code className="text-zinc-300">evidence/</code>, <code className="text-zinc-300">shots/</code> or <code className="text-zinc-300">demos/</code>.</li>
            <li><code className="text-zinc-300">▦ Dashboards</code> are <code className="text-zinc-300">*.dashboard.json</code>.</li>
            <li><code className="text-zinc-300">◧ Apps</code> are <code className="text-zinc-300">*.gssh.html</code>, small self-contained pages.</li>
            <li><code className="text-zinc-300">▤ Data</code> is <code className="text-zinc-300">*.data.json</code> or anything under <code className="text-zinc-300">data/</code>.</li>
            <li><code className="text-zinc-300">⚑ Reports</code> are files under <code className="text-zinc-300">reports/</code>.</li>
            <li><code className="text-zinc-300">✎ Notes</code> are files under <code className="text-zinc-300">notes/</code>.</li>
            <li><code className="text-zinc-300">· Other</code> is everything else, including session scratch that has not been promoted.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Opening an artifact</h3>
          <p className="text-zinc-400 mb-4">
            An opened artifact becomes a tab named <code className="text-zinc-300">◇ filename</code>. The header shows the
            full path and the file size, and adds <code className="text-zinc-300">· truncated</code> when you are not
            seeing all of it. The viewer picks the right renderer for you:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li>Markdown renders as a document.</li>
            <li>Images show inline; video and audio get real player controls.</li>
            <li>PDFs open in the document viewer.</li>
            <li>JSON is pretty-printed, and code is syntax-highlighted.</li>
            <li>HTML runs as a page in a sandbox, with a <code className="text-zinc-300">▸ view</code> and <code className="text-zinc-300">source</code> switch in the header.</li>
            <li>Anything that is not text and has no known media type says <code className="text-zinc-300">Binary artifact — no inline preview.</code></li>
          </ul>
          <p className="text-zinc-400 mb-8">
            Large files are fetched in pieces. Past 128 MB the viewer refuses rather than trying, and says{' '}
            <code className="text-zinc-300">Too large to preview inline</code> with the size.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Dashboards</h3>
          <p className="text-zinc-400 mb-4">
            A dashboard is a grid of small apps. Each panel runs one <code className="text-zinc-300">*.gssh.html</code>{' '}
            artifact in a sandbox, and a panel can be handed one data artifact. Existing dashboards are listed in the
            sidebar under <code className="text-zinc-300">Dashboards</code>, and{' '}
            <code className="text-zinc-300">＋ New dashboard</code> creates one: type a name and it becomes a slug, saved
            as <code className="text-zinc-300">&lt;slug&gt;.dashboard.json</code>.
          </p>
          <p className="text-zinc-400 mb-8">
            Inside a dashboard you can edit, <code className="text-zinc-300">＋ Add panel</code> lists the{' '}
            <code className="text-zinc-300">*.gssh.html</code> mini-apps it can find and adds the one you pick. Each panel
            header has a resize control that switches it between half and full width, and an{' '}
            <code className="text-zinc-300">✕</code> that removes it. There is no save button. Changes are written back to
            the dashboard artifact for you, shortly after you make them.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Scheduled runs</h3>
          <p className="text-zinc-400 mb-4">
            Open <code className="text-zinc-300">Crons &amp; triggers</code> from a workspace sidebar or from project home
            navigation. Each trigger is a card: its name, its kind, when it runs, what it does, what it reads and writes,
            its recent run history and when it last ran. The header of the pane tells you how many cron triggers are armed
            and that they fire from this machine, or says <code className="text-zinc-300">no cron triggers armed</code>.
          </p>
          <p className="text-zinc-400 mb-4">
            <code className="text-zinc-300">＋ New trigger</code> opens a short form. You give it a name, a kind
            (<code className="text-zinc-300">cron</code>, <code className="text-zinc-300">event</code> or{' '}
            <code className="text-zinc-300">manual</code>), a schedule such as{' '}
            <code className="text-zinc-300">every 6h</code>, a one-line intent, the prompt a run should follow, and a
            capability scope: the comma-separated artifact paths a run is allowed to write, like{' '}
            <code className="text-zinc-300">data/**</code>. <code className="text-zinc-300">Save trigger</code> writes it.
            Runs are prompted with that scope, and the machine daemon enforces it.
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">⟳ Run now</code> starts a run immediately. It appears as an agent session named <code className="text-zinc-300">trigger: &lt;name&gt;</code>.</li>
            <li><code className="text-zinc-300">Edit</code> expands the card so you can change the prompt, the schedule and the write scope, then <code className="text-zinc-300">Save changes</code>.</li>
            <li>A cron whose schedule cannot be parsed is labelled <code className="text-zinc-300">never fires · bad schedule</code> in red, rather than pretending to be armed.</li>
            <li>Event triggers are labelled <code className="text-zinc-300">manual only · no event engine</code>. They exist, but nothing fires them automatically yet.</li>
            <li>A trigger file the app cannot read is listed as <code className="text-zinc-300">Invalid trigger</code> with its path and the reasons, so it does not vanish silently.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Evidence</h3>
          <p className="text-zinc-400 mb-4">
            Evidence is what backs a claim that something works. It opens in its own tab with a chip naming the kind
            (command, screenshot, video, audio, url, file or note) and a second chip that says{' '}
            <code className="text-zinc-300">captured</code> when the evidence came from a command that actually ran, or{' '}
            <code className="text-zinc-300">asserted</code> when someone simply stated it.
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Screenshots, video and audio play inline, with the media type and size under them.</li>
            <li>Command evidence shows the command with its exit code, then its stdout and stderr in separate blocks.</li>
            <li>A <code className="text-zinc-300">refs</code> block lists the url, the original file path and the artifact path behind the record.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Sharing an artifact by link</h3>
          <p className="text-zinc-400 mb-4">
            An open artifact has an <code className="text-zinc-300">↗ Share</code> button in its header, and rows in the
            workspace artifacts tab and in the project home rail have an <code className="text-zinc-300">↗</code>. It mints
            a signed public link and copies it to your clipboard, and the toast tells you the date it stops working.
            Sharing needs a live connection to a machine that is serving; without one the app says{' '}
            <code className="text-zinc-300">Sharing needs an active machine connection with serve running.</code> instead
            of handing you a dead link.
          </p>
          <p className="text-zinc-400 mb-4">
            The person you send it to needs no account and no key. The link itself is the permission, and it only reaches
            that one artifact. They see a plain page headed <code className="text-zinc-300">GitSpace</code> with the file
            path, and the artifact rendered by the same renderers you use: markdown as a document, media playing, a
            dashboard as a dashboard, a mini-app running in its sandbox, a review guide as a readable guide. If the link
            was pinned to a point in time, the page shows a <code className="text-zinc-300">pinned @</code> chip with the
            short commit, so they know they are seeing the file as it was when you shared it. It also shows{' '}
            <code className="text-zinc-300">expires</code> and the date.
          </p>
          <p className="text-zinc-400 mb-8">
            After that date, or after you revoke it, the page says{' '}
            <code className="text-zinc-300">This share link has expired.</code> or{' '}
            <code className="text-zinc-300">This share link is gone.</code> and tells the reader to ask you for a fresh
            link.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Turning on sharing for a team</h3>
          <p className="text-zinc-400 mb-4">
            Artifacts work with no setup at all. They are versioned in a project-local repo on your machine from the
            start. Sharing them with teammates and your other machines is a separate, optional step you do once, in project
            home under <code className="text-zinc-300">Config</code> then{' '}
            <code className="text-zinc-300">◈ Artifacts repo</code>.
          </p>
          <p className="text-zinc-400 mb-4">
            That page offers two paths. <code className="text-zinc-300">GitHub private repo</code> creates a private
            <code className="text-zinc-300"> &lt;owner&gt;/&lt;repo&gt;-artifacts</code>, mirrors the code repo&apos;s
            collaborators onto it, and puts large files on GitHub LFS.{' '}
            <code className="text-zinc-300">Bring your own remote</code> takes any git URL you control; access is whatever
            that host enforces, and large files stay local to each machine. The page lists exactly what each will do before
            you press <code className="text-zinc-300">⚡ Enable sharing</code>.
          </p>
          <p className="text-zinc-400 mb-4">
            One thing is left for you afterwards. Enabling sharing stages{' '}
            <code className="text-zinc-300">.gitspace/artifacts.json</code> in your code repo, and the page keeps warning
            you until it is committed. Commit and push it, and teammates pick up sharing automatically when they add the
            project. After that, every machine with the project syncs on its own every five minutes, and{' '}
            <code className="text-zinc-300">⟳ Sync now</code> is there when you do not want to wait.
          </p>
          <p className="text-zinc-400 mb-4">
            On the GitHub path, each person needs their own GitHub CLI login on their machine:
          </p>
          <CodeBlock code={`gh auth login`} multiLine />
        </div>
      );

    case "machines-access":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Machines and Access</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">
            GitSpace runs on the machines that hold your code. The app you open in a browser is a client. This page is about wiring those two together: getting to your machine from somewhere else, adding a second machine, and running your own relay. It is the one part of GitSpace where you type commands.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">The shape of it</h3>
          <p className="text-zinc-400 mb-4">
            Three pieces. Your machine runs a daemon that owns the workspaces and the agent sessions. A relay is a WebSocket server that routes traffic between your machine and your browser, so neither has to be reachable from the internet. Your browser runs the app.
          </p>
          <p className="text-zinc-400 mb-8">
            Every machine and every browser has its own keypair. Ed25519 for signing, X25519 for key exchange. The two ends run a handshake through the relay and derive a session key the relay never holds. Traffic through the relay is opaque to it.
          </p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 font-mono text-xs text-zinc-400 mb-8 overflow-x-auto">
            <div className="flex items-center gap-3 whitespace-nowrap">
              <div className="border border-[#1a1a1a] px-3 py-2">
                <div className="text-zinc-300">browser</div>
                <div className="text-zinc-600">keypair + PIN</div>
              </div>
              <div className="text-zinc-600">== encrypted ==&gt;</div>
              <div className="border border-[#1a1a1a] px-3 py-2">
                <div className="text-zinc-300">relay</div>
                <div className="text-zinc-600">routes only</div>
              </div>
              <div className="text-zinc-600">== encrypted ==&gt;</div>
              <div className="border border-[#1a1a1a] px-3 py-2">
                <div className="text-zinc-300">machine</div>
                <div className="text-zinc-600">keypair + daemon</div>
              </div>
            </div>
            <div className="mt-3 text-zinc-600">relay sees: machine id, label, online or not, message sizes</div>
            <div className="text-zinc-600">relay does not see: terminal output, prompts, diffs, file contents</div>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Your identity</h3>
          <p className="text-zinc-400 mb-4">
            You have one user identity. It is created from a 24 word recovery phrase and stored in your keychain. Everything else hangs off it: a machine that can prove it belongs to your user identity is authorised automatically, with no invite step.
          </p>
          <CodeBlock code={`gssh user identity init`} multiLine />
          <p className="text-zinc-400 mb-4">
            Write the 24 words down. On any other machine, that phrase is how you become you again.
          </p>
          <CodeBlock code={`gssh user identity recover`} multiLine />
          <p className="text-zinc-400 mb-8">
            <code className="text-zinc-300">gssh user identity show</code> prints the id, fingerprint and public key. If you would rather not carry the phrase around, <code className="text-zinc-300">gssh user identity backup enable</code> stores an encrypted copy in the cloud, protected by a backup password you choose, and the app can pull it back down for you.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Starting the stack</h3>
          <p className="text-zinc-400 mb-4">
            One command starts a local relay, starts the machine daemon, and opens the app.
          </p>
          <CodeBlock code={`gssh web`} multiLine />
          <p className="text-zinc-400 mb-4">
            It asks for the password that unlocks this machine's device identity, then prints the URL it opened, something like <code className="text-zinc-300">http://127.0.0.1:4480/</code>, and holds the terminal until you press Ctrl+C. The link it opens carries a single use enrolment token, so the browser on that machine is signed in already and never shows the identity screen.
          </p>
          <p className="text-zinc-400 mb-4">
            It needs both identities to exist first. Without a user identity it tells you to run <code className="text-zinc-300">gssh user identity init</code> or <code className="text-zinc-300">gssh user identity recover</code>. Without a device identity for this machine it tells you to run <code className="text-zinc-300">gssh user auth login</code>. Commands that create the device identity ask you to pick a password for it, and that is the password <code className="text-zinc-300">gssh web</code> asks for later.
          </p>
          <p className="text-zinc-400 mb-8">
            <code className="text-zinc-300">--port</code> moves it off 4480. <code className="text-zinc-300">gssh status</code> reports whether the daemon and the relay connection are up.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Reaching your machine from elsewhere</h3>
          <p className="text-zinc-400 mb-4">
            Local mode only listens on 127.0.0.1. To open the app from a laptop on another network, or a phone, run the hosted mode: it starts the relay behind a cloudflared tunnel attached to a subdomain you reserve on gitspace.sh.
          </p>
          <CodeBlock code={`gssh user auth login
        gssh user host reserve brad
        gssh web --relay`} multiLine />
          <p className="text-zinc-400 mb-4">
            Now the app is at <code className="text-zinc-300">https://brad.gitspace.sh</code>. Two prerequisites, both enforced with a clear error: cloudflared must be installed (<code className="text-zinc-300">brew install cloudflared</code>), and no other relay may be running, so stop one with <code className="text-zinc-300">gssh relay stop</code> first.
          </p>
          <p className="text-zinc-400 mb-4">The rest of the hosting commands:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li><code className="text-zinc-300">gssh user host list</code> shows the subdomains you hold.</li>
            <li><code className="text-zinc-300">gssh user host set-primary &lt;name&gt;</code> picks the one used by default when you hold several.</li>
            <li><code className="text-zinc-300">gssh user host status</code> shows the current hosting state.</li>
            <li><code className="text-zinc-300">gssh user host doctor</code> checks hosted relay readiness and remediation steps.</li>
            <li><code className="text-zinc-300">gssh user host release [name]</code> gives a subdomain back.</li>
          </ul>
          <p className="text-zinc-400 mb-8">
            On a browser that has never connected, the app asks for your identity before it shows anything. It offers <code className="text-zinc-300">Sign in with GitHub</code> to recover from cloud backup, which then asks for your backup password, or <code className="text-zinc-300">Enter recovery phrase</code> to paste the 24 words. Either way it then asks you to create a PIN, which protects the device keys stored in that browser. On later visits you get a single <code className="text-zinc-300">Unlock</code> prompt for the PIN, with <code className="text-zinc-300">Reset browser identity</code> beside it if you want to start that browser over.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">A second machine</h3>
          <p className="text-zinc-400 mb-4">
            If the second machine is yours, there is no invite dance. Recover your identity on it, then point its daemon at the relay you are already using.
          </p>
          <CodeBlock code={`gssh user identity recover
        gssh machine serve start --relay wss://brad.gitspace.sh/ws`} multiLine />
          <p className="text-zinc-400 mb-4">
            The daemon signs a device certificate proving it belongs to your user identity, and the relay authorises it on that basis. Nothing to accept in the UI. The app discovers every machine that is online and authorised, connects to each one, and folds their projects and workspaces in beside the local ones. Each workspace card carries the machine it lives on in its footer, and the local machine reads as <code className="text-zinc-300">local</code>.
          </p>

          <div className="border border-[#1a1a1a] bg-[#0c0c0c] p-4 mb-8">
            <div className="border border-[#1a1a1a] p-3 mb-3">
              <div className="text-sm text-zinc-300">pi-agent-blame</div>
              <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-zinc-600">
                <span>local</span>
                <span className="ml-auto text-green-500">4/4 gates</span>
              </div>
            </div>
            <div className="border border-[#1a1a1a] p-3">
              <div className="text-sm text-zinc-300">relay-vault-fix</div>
              <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-zinc-600">
                <span>studio-mini</span>
                <span className="ml-auto text-amber-400">2/4 gates</span>
              </div>
            </div>
          </div>

          <p className="text-zinc-400 mb-4">
            A machine that is not yours, or one you do not want to give your identity to, joins with an invite instead. Start the daemon once on that machine so it creates its own device identity, read its two public keys out of the identity directory (<code className="text-zinc-300">~/gitspace/.identity/keypair.json</code> by default, fields <code className="text-zinc-300">signingPublicKey</code> and <code className="text-zinc-300">keyExchangePublicKey</code>), then mint an invite from the machine that owns the relay.
          </p>
          <CodeBlock code={`gssh invite relay-machine create \\
          --relay wss://brad.gitspace.sh/ws \\
          --machine-signing-key <base64> \\
          --machine-key-exchange-key <base64> \\
          --expires 24h \\
          --label "studio mini"`} multiLine />
          <p className="text-zinc-400 mb-4">
            Hand the token to the other machine. The invite is pinned to those exact keys, so it is useless anywhere else.
          </p>
          <CodeBlock code={`gssh machine enroll --invite <token>`} multiLine />
          <p className="text-zinc-400 mb-8">
            Enrolment asks for that machine's identity password, checks the relay fingerprint with you the first time, and registers. <code className="text-zinc-300">gssh invite list</code> shows the invites you own and <code className="text-zinc-300">gssh invite revoke &lt;invite-id&gt;</code> kills one. Invites default to a single use and 24 hours.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Running your own relay</h3>
          <p className="text-zinc-400 mb-4">
            You do not need gitspace.sh. Run the relay yourself on any host both ends can reach.
          </p>
          <CodeBlock code={`gssh relay start --port 4480 --label "office relay"`} multiLine />
          <p className="text-zinc-400 mb-4">
            It runs in the background by default; <code className="text-zinc-300">--foreground</code> keeps it in the terminal, and <code className="text-zinc-300">--mode local</code> keeps it purely local instead of also attaching a gitspace.sh tunnel when one is available. Then point each machine at it.
          </p>
          <CodeBlock code={`gssh machine serve start --relay ws://relay.example:4480/ws`} multiLine />
          <p className="text-zinc-400 mb-4">
            The first connection to an unknown relay prints its fingerprint and asks you to trust it. That pin is remembered, and a later mismatch is refused rather than silently accepted.
          </p>
          <p className="text-zinc-400 mb-8">
            From the relay side, <code className="text-zinc-300">gssh relay machines list</code> shows what is registered and <code className="text-zinc-300">gssh relay machines revoke &lt;machine-id&gt;</code> removes one. <code className="text-zinc-300">gssh relay status</code> and <code className="text-zinc-300">gssh relay stop</code> do what they say.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">What the relay can and cannot see</h3>
          <p className="text-zinc-400 mb-4">
            The relay is routing plumbing. It authenticates both ends with an Ed25519 challenge, keeps a directory of registered machines, and forwards data frames between them. Those frames are encrypted end to end and the relay cannot open them.
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li>It knows machine ids, machine labels, whether each is online, and when each was last connected. That is the directory the app reads.</li>
            <li>It knows how much traffic moves and when.</li>
            <li>It does not know what is in it. Terminal output, agent transcripts, diffs and file contents are decrypted only on your machine and in your browser.</li>
          </ul>
          <p className="text-zinc-400 mb-8">
            A relay is also bound to an owner identity. If you point <code className="text-zinc-300">gssh web</code> at a running relay bound to somebody else, it refuses and tells you to stop it or recover the original identity, rather than quietly rebinding.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Checking from the terminal</h3>
          <p className="text-zinc-400 mb-4">
            Two commands are useful when the app is not showing what you expect.
          </p>
          <CodeBlock code={`gssh status
        gssh client machines list --relay wss://brad.gitspace.sh/ws`} multiLine />
          <p className="text-zinc-400 mb-8">
            The first prints the tmux-lite and serve daemon state for this machine, including the relay connection. The second lists the machines your identity can reach on that relay, which is the same set the app draws from, so if a machine is missing there it will be missing in the app too. <code className="text-zinc-300">gssh client connect &lt;machine-id&gt;</code> attaches to one from the terminal if you need a way in without a browser.
          </p>
        </div>
      );

    case "cli-commands":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">CLI Commands</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">Reference, not a required path. Day to day you work in the app; this page is here for scripting, for automation, and for the times you want to see what a screen is actually doing.</p>
          <p className="text-zinc-400 mb-8">The binary is <code className="text-zinc-300">gssh</code>. Most commands are grouped under a top-level noun: project, workspace, machine, invite, client, user, cloud, relay, artifacts. There is also <code className="text-zinc-300">gssh space</code>, which is workspace-scoped and resolves the workspace from where you are; it does not appear in the root <code className="text-zinc-300">--help</code> listing. Run <code className="text-zinc-300">gssh &lt;command&gt; --help</code> at any depth to see the real flags.</p>

          <CodeBlock code={`gssh --help
        gssh workspace --help
        gssh workspace session new --help`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Top level</h3>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project</td><td className="px-4 py-3">Manage projects</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace</td><td className="px-4 py-3">Manage workspaces within a project</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine</td><td className="px-4 py-3">Manage this machine as a remote-accessible host</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite</td><td className="px-4 py-3">Create and manage machine enrollment invites</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client</td><td className="px-4 py-3">Connect to remote machines as a client</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user</td><td className="px-4 py-3">User identity, authentication, and settings</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh cloud</td><td className="px-4 py-3">Cloud workspace management</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay</td><td className="px-4 py-3">Manage relay server and registered machines</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh artifacts</td><td className="px-4 py-3">Project artifacts repo (branch per workspace, roll-up to main)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh status</td><td className="px-4 py-3">Show status of all gitspace daemons</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh web</td><td className="px-4 py-3">Start the local relay + serve web stack on this machine</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh gallery</td><td className="px-4 py-3">Open the block render gallery (design surface for transcript blocks and tool calls)</td></tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">project</h3>
          <p className="text-zinc-400 mb-4">A project is a container for one repository and its workspaces. <code className="text-zinc-300">add</code> pulls a repo from GitHub. <code className="text-zinc-300">create</code> makes one from scratch with a local <code className="text-zinc-300">git init</code> and no GitHub repo.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project list</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code>, <code className="text-zinc-300">--verbose</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project add</td><td className="px-4 py-3"><code className="text-zinc-300">--org &lt;org&gt;</code>, <code className="text-zinc-300">--no-clone</code>, <code className="text-zinc-300">--bundle-url &lt;url&gt;</code>, <code className="text-zinc-300">--bundle-path &lt;path&gt;</code>, <code className="text-zinc-300">--skip-bundle</code>, <code className="text-zinc-300">--linear-key &lt;key&gt;</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project create &lt;name&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--base-branch &lt;branch&gt;</code> (default <code className="text-zinc-300">main</code>), <code className="text-zinc-300">--workspace &lt;name&gt;</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project remove [project-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--force</code></td></tr>
            </tbody>
          </table>
          <CodeBlock code={`gssh project add --org acme
        gssh project create scratchpad --base-branch main --workspace first-cut
        gssh project list --json`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">workspace</h3>
          <p className="text-zinc-400 mb-4">A workspace is a git worktree on its own branch. Almost every workspace command takes <code className="text-zinc-300">--project &lt;name&gt;</code>, and the ones that act on a single workspace also take <code className="text-zinc-300">--workspace &lt;name&gt;</code>.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace list</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--json</code>, <code className="text-zinc-300">--verbose</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace add [workspace-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--branch &lt;name&gt;</code>, <code className="text-zinc-300">--from &lt;branch&gt;</code>, <code className="text-zinc-300">--status &lt;phase&gt;</code> (default <code className="text-zinc-300">code</code>), <code className="text-zinc-300">--issue &lt;number&gt;</code>, <code className="text-zinc-300">--no-setup</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace set-phase &lt;workspace-name&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--phase &lt;phase&gt;</code>, <code className="text-zinc-300">--project</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace remove [workspace-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--force</code>, <code className="text-zinc-300">--keep-branch</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace context</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code>, <code className="text-zinc-300">--json</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4">The kanban phases are <code className="text-zinc-300">plan</code>, <code className="text-zinc-300">code</code>, <code className="text-zinc-300">review</code>, and <code className="text-zinc-300">ship</code>. <code className="text-zinc-300">--issue</code> on <code className="text-zinc-300">workspace add</code> imports a GitHub issue: the workspace is named after it and its goal is seeded from the issue.</p>
          <CodeBlock code={`gssh workspace add auth-refresh --project gitspace --from develop
        gssh workspace add --project gitspace --issue 412
        gssh workspace set-phase auth-refresh --project gitspace --phase review
        gssh workspace context --project gitspace --workspace auth-refresh --json`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">workspace session</h4>
          <p className="text-zinc-400 mb-4">Terminal sessions scoped to one workspace. The parent command takes <code className="text-zinc-300">--sandbox &lt;name&gt;</code> to use an isolated tmux-lite runtime sandbox.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session list</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session new [name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session attach</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code>, <code className="text-zinc-300">--session &lt;id&gt;</code>, <code className="text-zinc-300">--force</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">--session</code> accepts a session ID or a name. <code className="text-zinc-300">--force</code> takes the session over if it is attached elsewhere.</p>
          <CodeBlock code={`gssh workspace session new build --project gitspace --workspace auth-refresh
        gssh workspace session list --project gitspace --workspace auth-refresh
        gssh workspace session attach --project gitspace --workspace auth-refresh --session build --force`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">workspace bundle</h4>
          <p className="text-zinc-400 mb-4">Bundle onboarding values for a workspace: <code className="text-zinc-300">status</code>, <code className="text-zinc-300">show</code>, <code className="text-zinc-300">edit</code>, and <code className="text-zinc-300">refresh</code>. <code className="text-zinc-300">show</code> prints current values, secret set-status, and confirm status; <code className="text-zinc-300">edit</code> updates inputs, secrets, and confirm states.</p>
          <CodeBlock code={`gssh workspace bundle status --project gitspace --workspace auth-refresh
        gssh workspace bundle refresh --project gitspace --workspace auth-refresh`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">Other workspace subtrees</h4>
          <p className="text-zinc-400 mb-4">Four subtrees are large enough to have their own pages. They are listed here so you know they exist:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">gssh workspace review</code> is the diff review system: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">import</code>, <code className="text-zinc-300">push</code>, <code className="text-zinc-300">hunks</code>, <code className="text-zinc-300">add-hunk</code>, <code className="text-zinc-300">add-file</code>, <code className="text-zinc-300">add-line</code>.</li>
            <li><code className="text-zinc-300">gssh workspace notes</code> manages local notes and todos: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">add</code>, <code className="text-zinc-300">update</code>, <code className="text-zinc-300">remove</code>, <code className="text-zinc-300">done</code>, <code className="text-zinc-300">undone</code>.</li>
            <li><code className="text-zinc-300">gssh workspace service</code> manages workspace services: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">start</code>, <code className="text-zinc-300">stop</code>, <code className="text-zinc-300">attach</code>, <code className="text-zinc-300">open</code>.</li>
            <li><code className="text-zinc-300">gssh workspace events</code> queries workspace event logs: <code className="text-zinc-300">list</code> (NDJSON), <code className="text-zinc-300">show</code>, <code className="text-zinc-300">tail</code>.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">machine</h3>
          <p className="text-zinc-400 mb-4">This is the host side. <code className="text-zinc-300">serve</code> runs the remote access daemon, <code className="text-zinc-300">tmux</code> runs the terminal session daemon, and <code className="text-zinc-300">enroll</code> registers this machine against a relay using an invite token.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve start</td><td className="px-4 py-3">Start the serve daemon (auto-selects a relay when <code className="text-zinc-300">--relay</code> is omitted)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve stop</td><td className="px-4 py-3">Stop the serve daemon</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve status</td><td className="px-4 py-3">Show serve daemon status</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine enroll</td><td className="px-4 py-3">Enroll with a relay-machine invite token</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux start / stop / status</td><td className="px-4 py-3">Run the tmux-lite server daemon</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux list</td><td className="px-4 py-3">List active tmux-lite sessions</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux new [name]</td><td className="px-4 py-3">Create and attach to a new session</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux attach &lt;id&gt;</td><td className="px-4 py-3">Attach to a session by id or name</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux kill &lt;id&gt;</td><td className="px-4 py-3">Kill a session by id or name</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux replay</td><td className="px-4 py-3">Inspect saved tmux-lite replays</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux hosting</td><td className="px-4 py-3">Configure tmux-lite service hosting</td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">serve start</code> takes <code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--foreground</code>, <code className="text-zinc-300">--password-stdin</code>, <code className="text-zinc-300">-y, --yes</code>, and the one-time token flags <code className="text-zinc-300">--bootstrap-token</code>, <code className="text-zinc-300">--enrollment-token</code>, and <code className="text-zinc-300">--unlock-token</code> (with <code className="text-zinc-300">--workspace-id</code>). <code className="text-zinc-300">--takeover</code> reclaims the machine for the current identity by clearing persisted relay control state and forgetting a stale trust pin. <code className="text-zinc-300">gssh machine tmux</code> also accepts <code className="text-zinc-300">--sandbox &lt;name&gt;</code>.</p>
          <CodeBlock code={`gssh machine serve status
        gssh machine serve start --relay ws://localhost:4480/ws
        gssh machine enroll --invite <token> --label laptop
        gssh machine tmux list`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">invite</h3>
          <p className="text-zinc-400 mb-4">Root-signed tokens that let another machine register on a relay you own.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite relay-machine create</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--machine-signing-key &lt;base64&gt;</code>, <code className="text-zinc-300">--machine-key-exchange-key &lt;base64&gt;</code>, <code className="text-zinc-300">--expires &lt;duration&gt;</code> (default <code className="text-zinc-300">24h</code>), <code className="text-zinc-300">--max-uses &lt;n&gt;</code> (default <code className="text-zinc-300">1</code>), <code className="text-zinc-300">--label</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite list</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite revoke &lt;invite-id&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-8"><code className="text-zinc-300">--max-uses</code> also accepts the literal value <code className="text-zinc-300">unlimited</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">client</h3>
          <p className="text-zinc-400 mb-4">The connecting side.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client machines list</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--json</code>, <code className="text-zinc-300">-y, --yes</code>, <code className="text-zinc-300">--password-stdin</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client connect [target]</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--machine &lt;id&gt;</code>, <code className="text-zinc-300">-y, --yes</code>, <code className="text-zinc-300">--password-stdin</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">target</code> argument is a machine ID. <code className="text-zinc-300">--machine</code> supplies the machine ID for direct mode.</p>
          <CodeBlock code={`gssh client machines list --relay ws://localhost:4480/ws
        gssh client connect <machine-id>`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">user</h3>
          <p className="text-zinc-400 mb-4">Identity, gitspace.sh login and hosting, settings, and notification hooks.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity init</td><td className="px-4 py-3">Initialize a new identity (generates a 24-word mnemonic)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity show</td><td className="px-4 py-3">Show identity information</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity recover</td><td className="px-4 py-3">Recover identity from the 24-word mnemonic</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity export</td><td className="px-4 py-3">Export public key in <code className="text-zinc-300">gssh-user:</code> format</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity import &lt;key&gt;</td><td className="px-4 py-3">Import a peer public key (validates format)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity remove</td><td className="px-4 py-3">Remove identity from the keychain (mnemonic required to recover)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity backup</td><td className="px-4 py-3">Manage optional encrypted cloud backup of your identity</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user auth login / logout / status</td><td className="px-4 py-3">GitHub login for gitspace.sh</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host reserve &lt;subdomain&gt;</td><td className="px-4 py-3">Reserve a subdomain</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host release [subdomain]</td><td className="px-4 py-3">Release a subdomain</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host list</td><td className="px-4 py-3">List your subdomains</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host set-primary &lt;subdomain&gt;</td><td className="px-4 py-3">Set the primary subdomain for hosted relay and tmux hosting</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host status</td><td className="px-4 py-3">Show hosting status</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host doctor</td><td className="px-4 py-3">Check hosted relay readiness and remediation steps</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user config notifications</td><td className="px-4 py-3">Configure notification settings (<code className="text-zinc-300">--show</code>, <code className="text-zinc-300">--reset</code>)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user config linear setup / show / clear</td><td className="px-4 py-3">Configure the Linear integration</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user notifications install / uninstall / hook / status</td><td className="px-4 py-3">Manage the notification shell hooks</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user migrate cleanup-legacy</td><td className="px-4 py-3">Delete stale keychain entries after migrating to unified secrets</td></tr>
            </tbody>
          </table>
          <CodeBlock code={`gssh user identity init
        gssh user auth login
        gssh user host reserve brad
        gssh user host doctor`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">relay</h3>
          <p className="text-zinc-400 mb-4">The relay routes encrypted traffic between machines and clients. It never sees plaintext.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay start</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">4480</code>), <code className="text-zinc-300">--bind &lt;address&gt;</code> (default <code className="text-zinc-300">0.0.0.0</code>), <code className="text-zinc-300">--mode &lt;mode&gt;</code> (default <code className="text-zinc-300">auto</code>), <code className="text-zinc-300">--hostname</code>, <code className="text-zinc-300">--label</code>, <code className="text-zinc-300">--foreground</code>, <code className="text-zinc-300">--takeover</code>, <code className="text-zinc-300">-y, --yes</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay stop</td><td className="px-4 py-3">Stop the relay server</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay status</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay machines list</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay machines revoke &lt;machine-id&gt;</td><td className="px-4 py-3">Remove a machine from the relay registry</td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">--mode</code> takes <code className="text-zinc-300">auto</code> (local plus hosted if available), <code className="text-zinc-300">hosted</code> (require a tunnel, keep local), or <code className="text-zinc-300">local</code>. <code className="text-zinc-300">relay start</code> runs in the background unless you pass <code className="text-zinc-300">--foreground</code>.</p>
          <CodeBlock code={`gssh relay start --mode local --port 4480
        gssh relay status --json
        gssh relay machines list`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Whole-machine commands</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh status</code> prints the state of every gitspace daemon. <code className="text-zinc-300">gssh web</code> brings up the local relay and serve stack together, which is the fastest way to get the web app running on this machine.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh status</td><td className="px-4 py-3">No flags</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh web</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">4480</code>), <code className="text-zinc-300">--relay</code>, <code className="text-zinc-300">--takeover</code>, <code className="text-zinc-300">--password-stdin</code>, <code className="text-zinc-300">-y, --yes</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh gallery [page]</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">5173</code>), <code className="text-zinc-300">--no-open</code>; page is <code className="text-zinc-300">blocks</code> (default) or <code className="text-zinc-300">transcript</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-8"><code className="text-zinc-300">gssh web --relay</code> starts a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain.</p>

          <h3 className="text-xl font-semibold text-white mb-4">artifacts and cloud</h3>
          <p className="text-zinc-400 mb-4">Two trees are documented on their own pages. In outline:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">gssh artifacts</code> manages the per-project artifacts repo, one branch per workspace rolled up to main: <code className="text-zinc-300">provision</code>, <code className="text-zinc-300">status</code>, <code className="text-zinc-300">repair</code>, <code className="text-zinc-300">remote</code>, <code className="text-zinc-300">sync</code>, <code className="text-zinc-300">rollup &lt;workspace&gt;</code>.</li>
            <li><code className="text-zinc-300">gssh cloud</code> manages cloud workspaces: <code className="text-zinc-300">setup</code>, <code className="text-zinc-300">status</code>, <code className="text-zinc-300">list</code>, <code className="text-zinc-300">launch</code>, <code className="text-zinc-300">stop</code>, <code className="text-zinc-300">resume</code>, <code className="text-zinc-300">destroy</code>, <code className="text-zinc-300">connect</code>.</li>
          </ul>
        </div>
      );

    case "custom-scripts":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Custom Scripts</h1>

          <p className="text-zinc-400 mb-4">
            GitSpace uses convention-based scripts stored per workspace in <code className="text-zinc-300">~/gitspace/&lt;project&gt;/workspaces/&lt;workspace&gt;/.gitspace/scripts/</code>:
          </p>

          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 font-mono text-sm mb-8">
            <pre className="text-zinc-300">{`~/gitspace/<project>/workspaces/<workspace>/.gitspace/
└── scripts/
    ├── pre/      # Run before setup (once)
    ├── setup/    # Run on workspace creation (once)
    ├── select/   # Run every time workspace is opened
    └── remove/   # Run before workspace deletion`}</pre>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Rules</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Scripts must be executable (<code className="text-zinc-300">chmod +x</code>)</li>
            <li>Run alphabetically (use <code className="text-zinc-300">01-</code>, <code className="text-zinc-300">02-</code> prefixes)</li>
            <li>Working directory: the workspace</li>
            <li>Arguments: <code className="text-zinc-300">$1</code> = workspace name, <code className="text-zinc-300">$2</code> = repository</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Example Script</h3>
          <p className="text-zinc-500 text-sm mb-2">.gitspace/scripts/select/01-status.sh</p>
          <JsonBlock code={`#!/bin/bash
echo "Switching to: $1"
git fetch origin
git status`} />
        </div>
      );

    case "repo-bundles":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Repo Config Bundles</h1>

          <p className="text-zinc-400 mb-4">
            Bundles allow teams to share onboarding configurations. Place in <code className="text-zinc-300">.gitspace/</code>:
          </p>

          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 font-mono text-sm mb-8">
            <pre className="text-zinc-300">{`.gitspace/
├── bundle.json           # Manifest
└── scripts/
    ├── pre/              # Pre-setup scripts
    ├── setup/            # Setup scripts
    ├── select/           # Select scripts
    └── remove/           # Remove scripts`}</pre>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Manifest Example</h3>
          <JsonBlock code={`{
  "version": "1.0",
  "name": "my-app-bundle",
  "onboarding": [
    { "id": "node", "type": "confirm", "title": "Node.js", "checkCommand": "node" },
    { "id": "api-key", "type": "secret", "title": "API Key", "configKey": "apiKey" }
  ]
}`} />

          <h3 className="text-xl font-semibold text-white mb-4">Step Types</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Purpose</th>
                  <th className="px-4 py-3">Storage</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">info</td>
                  <td className="px-4 py-3">Display information</td>
                  <td className="px-4 py-3">N/A</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">confirm</td>
                  <td className="px-4 py-3">Verify installation</td>
                  <td className="px-4 py-3">N/A</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">secret</td>
                  <td className="px-4 py-3">Sensitive values</td>
                  <td className="px-4 py-3">OS Keychain</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">input</td>
                  <td className="px-4 py-3">Plain text</td>
                  <td className="px-4 py-3">Config file</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Using Values in Scripts</h3>
          <JsonBlock code={`echo "Team: $TEAM_NAME"
echo "Has API key: $API_KEY"`} />
        </div>
      );

    case "configuration":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Configuration</h1>

          <h3 className="text-xl font-semibold text-white mb-4">Global Config</h3>
          <p className="text-zinc-500 text-sm mb-2">~/gitspace/.config.json</p>
          <JsonBlock code={`{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/gitspace",
  "defaultBaseBranch": "main"
}`} />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Project Config</h3>
          <p className="text-zinc-500 text-sm mb-2">~/gitspace/&lt;project&gt;/.config.json</p>
          <JsonBlock code={`{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main"
}`} />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Environment Variables</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Variable</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Default</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">RELAY_PORT</td>
                  <td className="px-4 py-3">Relay port</td>
                  <td className="px-4 py-3">4480</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );

    case "troubleshooting":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Troubleshooting</h1>

          <div className="space-y-8">
            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"command not found: gssh"</h4>
              <p className="text-zinc-400 text-sm mb-2">Ensure Bun's global bin is in your PATH:</p>
              <CodeBlock code={`export PATH="$HOME/.bun/bin:$PATH"`} />
              <p className="text-zinc-500 text-sm">Add to your shell profile (<code className="text-zinc-300">~/.zshrc</code>, <code className="text-zinc-300">~/.bashrc</code>)</p>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"No identity found"</h4>
              <CodeBlock code="gssh user identity init" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Failed to unlock identity"</h4>
              <p className="text-zinc-400 text-sm mb-2">You're entering the wrong password. If forgotten, recreate:</p>
              <CodeBlock code="gssh user identity init --force" />
              <p className="text-zinc-500 text-sm">Warning: This invalidates existing owner identity bindings and requires re-enrollment/recovery across devices</p>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Machine offline"</h4>
              <ul className="list-disc list-inside text-zinc-400 text-sm space-y-1 ml-2">
                <li>Ensure <code className="text-zinc-300">gssh web</code> is still running on the target machine, or <code className="text-zinc-300">gssh machine serve status</code> if you started the daemon directly</li>
                <li>Check the machine can reach the relay URL</li>
                <li>Verify the machine is authorized on the relay</li>
              </ul>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Client not authorized"</h4>
              <p className="text-zinc-400 text-sm mb-2">The client identity does not match the relay/machine owner identity:</p>
              <CodeBlock code={`gssh user identity show
gssh user identity recover`} multiLine language="bash" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Enrollment invite expired"</h4>
              <p className="text-zinc-400 text-sm mb-2">Create a new machine enrollment invite with longer expiration:</p>
              <CodeBlock code="gssh invite relay-machine create --relay ws://relay.example.com/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --expires 7d" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"GitHub CLI not authenticated"</h4>
              <CodeBlock code="gh auth login" />
            </div>
          </div>
        </div>
      );

    case "security":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Security</h1>

          <div className="space-y-8">
            <div className="p-6 rounded-xl bg-green-500/5 border border-green-500/20">
              <h3 className="font-bold text-green-400 mb-2">End-to-End Encrypted</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Terminal traffic encrypted with AES-256-GCM. Relay cannot decrypt.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-blue-500/5 border border-blue-500/20">
              <h3 className="font-bold text-blue-400 mb-2">Cryptographic Identity</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Ed25519 signing + X25519 key exchange. No passwords for authentication.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-purple-500/5 border border-purple-500/20">
              <h3 className="font-bold text-purple-400 mb-2">X3DH Handshake</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Session keys derived per-connection for forward secrecy.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-yellow-500/5 border border-yellow-500/20">
              <h3 className="font-bold text-yellow-500 mb-3">Current Limitations</h3>
              <ul className="list-disc list-inside space-y-3 text-zinc-400 text-sm leading-relaxed">
                <li>
                  <strong className="text-white">Client proof-of-possession</strong>: The handshake doesn't fully enforce that the client possesses the private key corresponding to their claimed public key. If an attacker learns an allowed public key, identity spoofing is theoretically possible.
                </li>
                <li>
                  <strong className="text-white">Permission enforcement</strong>: Permission flags (<code className="text-zinc-300">read</code>/<code className="text-zinc-300">write</code>/<code className="text-zinc-300">manage</code>) are not fully enforced server-side after the handshake completes. "View-only" access should be treated as intended behavior rather than a strict security guarantee.
                </li>
              </ul>
              <p className="text-zinc-500 text-sm mt-4">These limitations are being addressed in future releases.</p>
            </div>
          </div>
        </div>
      );

    case "glossary":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Glossary</h1>

          <dl className="grid gap-6">
            <div>
              <dt className="text-white font-bold mb-1">Machine</dt>
              <dd className="text-zinc-400 text-sm">A computer serving its workspaces, started with <code className="text-zinc-300">gssh web</code></dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Client</dt>
              <dd className="text-zinc-400 text-sm">Device connecting via browser or CLI</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Relay</dt>
              <dd className="text-zinc-400 text-sm">WebSocket router that forwards encrypted traffic between machines and clients</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Relay Identity</dt>
              <dd className="text-zinc-400 text-sm">Ed25519 keypair used by the relay to sign messages and challenges</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Authorized Machine</dt>
              <dd className="text-zinc-400 text-sm">Machine public key approved to register with a relay</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Identity</dt>
              <dd className="text-zinc-400 text-sm">Ed25519 signing + X25519 key exchange keypairs, encrypted at rest</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Invite</dt>
              <dd className="text-zinc-400 text-sm">Signed token that bootstraps trust and enables first connection</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Owner Identity Binding</dt>
              <dd className="text-zinc-400 text-sm">Runtime rule requiring client and machine device certificates to derive from the same owner user root identity</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">X3DH</dt>
              <dd className="text-zinc-400 text-sm">Extended Triple Diffie-Hellman handshake for session key establishment</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">PTY</dt>
              <dd className="text-zinc-400 text-sm">Pseudo-terminal, the interface between your shell and the terminal</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Worktree</dt>
              <dd className="text-zinc-400 text-sm">Git feature allowing multiple working directories for one repository</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Bundle</dt>
              <dd className="text-zinc-400 text-sm">Repository configuration package for team onboarding</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Session</dt>
              <dd className="text-zinc-400 text-sm">A terminal session managed by tmux-lite on the server</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Web app</dt>
              <dd className="text-zinc-400 text-sm">The interactive surface, started with <code className="text-zinc-300">gssh web</code> or <code className="text-zinc-300">gssh machine serve start</code></dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">tmux-lite</dt>
              <dd className="text-zinc-400 text-sm">Built-in terminal multiplexer for managing sessions</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Subdomain</dt>
              <dd className="text-zinc-400 text-sm">Your custom URL on gitspace.sh (e.g., <code className="text-zinc-300">yourname.gitspace.sh</code>)</dd>
            </div>
          </dl>
        </div>
      );

    case "linear-integration":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Linear Integration</h1>

          <p className="text-zinc-400 mb-8">
            GitSpace integrates with Linear to create workspaces directly from issues. Configure Linear at the user level,
            then optionally customize per-project.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Setup</h3>
          <p className="text-zinc-400 mb-4">
            Run the setup wizard to configure your Linear API key and select teams:
          </p>
          <CodeBlock code="gssh user config linear setup" />

          <p className="text-zinc-400 mb-4">
            The wizard will:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Prompt for your Linear API key (stored securely in OS keychain)</li>
            <li>Fetch available teams from Linear</li>
            <li>Let you select which teams to work with</li>
            <li>Set a default team for new projects</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Project-Level Configuration</h3>
          <p className="text-zinc-400 mb-4">
            Configure Linear for a specific project:
          </p>
          <CodeBlock code="gssh user config linear setup --project myapp" />

          <p className="text-zinc-400 mb-4">
            You can choose to:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><strong className="text-zinc-300">Use user-level API key</strong> - Inherit from your global config and select which teams to use</li>
            <li><strong className="text-zinc-300">Use project-specific API key</strong> - Enter a different API key for this project (useful for different Linear workspaces)</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Commands</h3>
          <CodeBlock code={`gssh user config linear setup                 # User-level setup wizard
gssh user config linear setup --project app   # Project-specific config (key + teams)
gssh user config linear show                  # Show user-level config
gssh user config linear show --project app    # Show project config
gssh user config linear clear                 # Clear user-level config
gssh user config linear clear --project app   # Clear project config (including API key)`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Creating Workspaces from Issues</h3>
          <p className="text-zinc-400 mb-4">
            Once configured, you can create workspaces from Linear issues:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Run <code className="text-zinc-300">gssh workspace add --project my-project</code> and select "Create from Linear issue" at the source prompt</li>
          </ul>

          <p className="text-zinc-400 mb-4">
            The workspace will be named using the issue identifier and title, and issue details will be saved
            to <code className="text-zinc-300">.prompt/issue.md</code> in the workspace.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Getting Your API Key</h3>
          <p className="text-zinc-400 mb-4">
            To get your Linear API key:
          </p>
          <ol className="list-decimal list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Go to Linear → Settings → API</li>
            <li>Under "Personal API keys", click "Create key"</li>
            <li>Give it a name (e.g., "GitSpace")</li>
            <li>Copy the key and paste it when prompted by <code className="text-zinc-300">gssh user config linear setup</code></li>
          </ol>
        </div>
      );

    default:
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h1 className="text-4xl font-bold mb-6">Documentation</h1>
            <p className="text-zinc-400">Select a section from the sidebar to get started.</p>
        </div>
      );
  }
}
