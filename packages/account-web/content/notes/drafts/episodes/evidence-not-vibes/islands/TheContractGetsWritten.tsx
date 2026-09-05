import { useEffect, useRef, useState } from "react";
import { Ban, Bot, Play, RotateCcw, ShieldCheck, Terminal, User } from "lucide-react";
import { cn } from "../../../lib/utils";

/* THE CONTRACT GETS WRITTEN.
   The human sets the bar in plain language. The AGENT proposes the requirements,
   names the proxy trap each one closes, and writes the `space goal requirement add`
   commands — a background detail streaming in the right panel. The human never
   types a CLI here; every blue mark on this screen is an agent action.

   Grounded in:
   - space-goal SKILL.md — real `space goal requirement add` syntax (--kind,
     --rubric, --gen command --gen-command, --judge human|command, --expect exit-zero).
   - review-gated-implementation SKILL.md — "forbidden shortcuts and proxy traps",
     "a reviewer gate that cannot be satisfied by the implementer's summary alone". */

type Step =
  | { col: "chat"; kind: "human"; text: string; delay: number }
  | { col: "chat"; kind: "say"; text: string; delay: number }
  | { col: "chat"; kind: "req"; n: number; prose: string; kindTag: string; judgeTag: string; trap: string; delay: number }
  | { col: "cli"; kind: "cmd"; n: number; lines: string[]; delay: number }
  | { col: "card"; kind: "card"; delay: number };

/* The three requirements — real syntax, one per proxy trap. */
const R1_CMD = [
  '--title "Checkout suite passes end to end"',
  "--kind test-output",
  '--rubric "Runs the checkout suite specifically; 0 failures, 0 skipped; exit 0."',
  '--gen command --gen-command "bun test src/checkout"',
  "--expect exit-zero",
];
const R2_CMD = [
  '--title "Order summary shows subtotal, tax, total"',
  "--kind screenshot",
  '--rubric "A human can read subtotal, regional tax, and total in the rendered summary; Pay enabled."',
  "--gen manual",
  "--judge human",
];
const R3_CMD = [
  '--title "Legacy checkout_v2 path is gone, not hidden"',
  "--kind test-output",
  '--rubric "No source reference to checkout_v2 remains AND the new path is exercised. Absence alone does not pass."',
  '--gen command --gen-command "! grep -rn checkout_v2 src/"',
  '--judge command --judge-command "bun test src/checkout/live-path.test.ts"',
  "--expect exit-zero",
];

const SCRIPT: Step[] = [
  {
    col: "chat",
    kind: "human",
    delay: 300,
    text: "Refactor checkout. I don't want you to tell me it's done. I want you to prove it. And write the checks so you can't game them.",
  },
  {
    col: "chat",
    kind: "say",
    delay: 800,
    text: "Understood. I won't report done. I'll declare the contract that decides done, and I'll make the judges things I can't talk my way past. Three required artifacts.",
  },
  {
    col: "chat",
    kind: "req",
    n: 1,
    delay: 750,
    prose: "First, the checkout suite has to pass on its own, so a broad green run cannot stand in for it.",
    kindTag: "test-output",
    judgeTag: "command · expect exit-zero",
    trap: "a green test run that skips checkout. The judge runs bun test src/checkout, nothing broader. A suite that never touches checkout can't earn this.",
  },
  { col: "cli", kind: "cmd", n: 1, lines: R1_CMD, delay: 550 },
  {
    col: "chat",
    kind: "req",
    n: 2,
    delay: 750,
    prose: "Second, the rendered order summary has to be legible to a human: subtotal, regional tax, total, and Pay enabled.",
    kindTag: "screenshot",
    judgeTag: "human",
    trap: "a passing render test. A test that mounts the component proves it renders, not that the numbers are readable. This one answers to your eyes, not to green.",
  },
  { col: "cli", kind: "cmd", n: 2, lines: R2_CMD, delay: 550 },
  {
    col: "chat",
    kind: "req",
    n: 3,
    delay: 750,
    prose: "Third, checkout_v2 has to be actually gone. Not renamed, not wrapped behind a new alias.",
    kindTag: "test-output",
    judgeTag: "command · paired",
    trap: "grep-for-absence as proof. Absence is a proxy; dead code deletes clean. So I pair it: a second, different command proves the new path is the one that runs. Absence alone can't pass.",
  },
  { col: "cli", kind: "cmd", n: 3, lines: R3_CMD, delay: 550 },
  {
    col: "chat",
    kind: "say",
    delay: 750,
    text: "That's the contract. Every line names its own judge, a command or you, so none of them accept my summary as evidence. When all three read accepted, the goal is ready. Not before.",
  },
  { col: "card", kind: "card", delay: 600 },
];

const CONTRACT_ROWS = [
  { title: "Checkout suite passes end to end", judge: "command" },
  { title: "Order summary shows subtotal, tax, total", judge: "human" },
  { title: "Legacy checkout_v2 path is gone, not hidden", judge: "command" },
];

/* highlight --flags blue; leave the rest dim so the command reads as config, not prose */
function CmdLine({ line }: { line: string }) {
  const parts = line.split(/(--[\w-]+)/g);
  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        p.startsWith("--") ? (
          <span key={i} className="text-[#4488ff]">
            {p}
          </span>
        ) : (
          <span key={i} className="text-zinc-400">
            {p}
          </span>
        )
      )}
    </div>
  );
}

function AgentAvatar() {
  return (
    <div className="h-7 w-7 shrink-0 bg-[#4488ff]/15 border border-[#4488ff]/40 flex items-center justify-center">
      <Bot className="w-3.5 h-3.5 text-[#4488ff]" />
    </div>
  );
}

export function TheContractGetsWritten() {
  const [reduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
  const [revealed, setRevealed] = useState(reduced ? SCRIPT.length : 0);
  const [playing, setPlaying] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reduced || !playing) return;
    if (revealed >= SCRIPT.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setRevealed((r) => r + 1), SCRIPT[revealed].delay);
    return () => clearTimeout(t);
  }, [playing, revealed, reduced]);

  function play() {
    setRevealed(0);
    setPlaying(true);
  }

  const shown = SCRIPT.slice(0, revealed);
  const chat = shown.filter((s) => s.col === "chat");
  const cmds = shown.filter((s) => s.col === "cli") as Extract<Step, { col: "cli" }>[];
  const cardShown = shown.some((s) => s.col === "card");
  const started = revealed > 0;
  const done = revealed >= SCRIPT.length;

  const btnLabel = playing ? "authoring…" : started ? "replay" : "play";

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">
        demo 3 · the contract gets written
      </div>
      <div className="border border-[#1a1a1a] bg-black">
        {/* header */}
        <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center gap-3">
          <span className="text-[12px] text-zinc-400">
            Goal <span className="font-mono text-zinc-300">checkout-refactor</span> · the human sets the bar; the agent
            authors the contract.
          </span>
          <button
            onClick={play}
            disabled={playing}
            className={cn(
              "ml-auto text-[12px] font-mono px-3 py-1.5 border flex items-center gap-1.5 transition-colors shrink-0",
              playing
                ? "border-[#1a1a1a] text-zinc-500 cursor-default"
                : "border-green-500/40 text-green-300 hover:bg-green-500/10"
            )}
          >
            {playing ? (
              <span className="text-[#4488ff]">{btnLabel}</span>
            ) : started ? (
              <>
                <RotateCcw className="w-3 h-3" /> {btnLabel}
              </>
            ) : (
              <>
                <Play className="w-3 h-3" /> {btnLabel}
              </>
            )}
          </button>
        </div>

        <div className="grid md:grid-cols-[1.35fr_1fr]">
          {/* LEFT — the conversation */}
          <div className="p-4 md:border-r border-[#1a1a1a] min-h-[300px]">
            {!started && !reduced ? (
              <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center gap-2">
                <Bot className="w-5 h-5 text-[#4488ff]/60" />
                <div className="text-[12px] text-zinc-500 max-w-[280px]">
                  Press play. Watch the agent turn a plain-language bar into a contract it can't game, and write every
                  check itself.
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {chat.map((s, i) => {
                  if (s.kind === "human") {
                    return (
                      <div key={i} className="flex gap-3">
                        <div className="h-7 w-7 shrink-0 bg-[#00ff66]/15 border border-[#00ff66]/40 flex items-center justify-center">
                          <User className="w-3.5 h-3.5 text-[#00ff66]" />
                        </div>
                        <div className="flex-1">
                          <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1">
                            you · setting the bar
                          </div>
                          <div className="border border-[#00ff66]/25 bg-[#00ff66]/[0.04] px-3 py-2.5 text-[13px] text-zinc-100 leading-relaxed">
                            {s.text}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  if (s.kind === "say") {
                    return (
                      <div key={i} className="flex gap-3">
                        <AgentAvatar />
                        <div className="flex-1">
                          <div className="text-[10px] font-mono uppercase tracking-widest text-[#4488ff]/60 mb-1">
                            agent
                          </div>
                          <div className="border border-[#1a1a1a] bg-[#080808] px-3 py-2.5 text-[13px] text-zinc-300 leading-relaxed">
                            {s.text}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  // requirement
                  return (
                    <div key={i} className="flex gap-3">
                      <AgentAvatar />
                      <div className="flex-1">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-[#4488ff]/60 mb-1">
                          agent · requirement {s.n}
                        </div>
                        <div className="border border-[#1a1a1a] bg-[#080808]">
                          <div className="px-3 py-2.5 text-[13px] text-zinc-200 leading-relaxed">{s.prose}</div>
                          <div className="px-3 pb-2.5 flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-mono text-zinc-500 border border-[#1a1a1a] px-1.5 py-0.5">
                              kind: {s.kindTag}
                            </span>
                            <span className="text-[10px] font-mono text-[#4488ff]/80 border border-[#4488ff]/25 px-1.5 py-0.5">
                              judge: {s.judgeTag}
                            </span>
                          </div>
                          <div className="border-t border-[#1a1a1a] px-3 py-2 flex gap-2 items-start bg-[#ffcc00]/[0.03]">
                            <Ban className="w-3 h-3 text-[#ffcc00] mt-[3px] shrink-0" />
                            <span className="text-[11.5px] text-zinc-400 leading-relaxed">
                              <span className="text-[#ffcc00] font-mono">closes proxy trap:</span> {s.trap}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* RIGHT — the agent's terminal. Dim, background, unmistakably the AGENT's action. */}
          <div className="bg-[#050505] flex flex-col">
            <div className="px-3 py-2.5 border-b border-[#1a1a1a] flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-[#4488ff]/70" />
              <span className="text-[10px] font-mono uppercase tracking-widest text-[#4488ff]/70">agent · terminal</span>
              <span className="ml-auto text-[10px] font-mono text-zinc-600">not typed by you</span>
            </div>
            <div className="px-3 py-3 text-[10px] font-mono text-zinc-600 border-b border-[#1a1a1a] leading-relaxed">
              commands the agent runs as it talks. every line below is an agent action.
            </div>
            <div className="p-3 flex flex-col gap-3 flex-1">
              {cmds.length === 0 && (
                <div className="text-[11px] font-mono text-zinc-700 py-4">// awaiting the first requirement…</div>
              )}
              {cmds.map((c) => (
                <div key={c.n} className="border border-[#1a1a1a] bg-black">
                  <div className="px-2.5 py-1.5 border-b border-[#1a1a1a] flex items-center gap-2">
                    <Bot className="w-3 h-3 text-[#4488ff]" />
                    <span className="text-[10px] font-mono text-[#4488ff]">agent ran</span>
                    <span className="text-[11px] font-mono text-zinc-300">space goal requirement add</span>
                    <span className="ml-auto text-[10px] font-mono text-zinc-600">req {c.n}</span>
                  </div>
                  <pre className="px-2.5 py-2 text-[11px] leading-relaxed font-mono overflow-x-auto">
                    {c.lines.map((l, i) => (
                      <CmdLine key={i} line={l} />
                    ))}
                  </pre>
                </div>
              ))}
              {playing && cmds.length > 0 && cmds.length < 3 && (
                <div className="text-[11px] font-mono text-zinc-700">
                  agent<span className="animate-pulse">▌</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FINAL — the assembled contract */}
        {(cardShown || (reduced && done)) && (
          <div className="border-t border-[#1a1a1a] p-4">
            <div className="border border-[#4488ff]/30 bg-[#4488ff]/[0.04]">
              <div className="px-4 py-3 border-b border-[#4488ff]/20 flex flex-wrap items-center gap-x-3 gap-y-1">
                <ShieldCheck className="w-4 h-4 text-[#4488ff]" />
                <span className="text-[12px] font-mono uppercase tracking-widest text-[#4488ff]">validation contract</span>
                <span className="text-[12px] font-mono text-zinc-500">
                  3 requirements · gate: every required artifact accepted
                </span>
              </div>
              {CONTRACT_ROWS.map((r) => (
                <div key={r.title} className="px-4 py-2.5 border-b border-[#1a1a1a] flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="h-2 w-2 bg-[#4488ff] shrink-0" />
                  <span className="text-[13px] text-zinc-200">{r.title}</span>
                  <span className="ml-auto text-[10px] font-mono text-[#4488ff]/80 border border-[#4488ff]/25 px-1.5 py-0.5">
                    judge: {r.judge}
                  </span>
                </div>
              ))}
              <div className="px-4 py-3 text-[12px] text-zinc-400 leading-relaxed">
                The gate can't be satisfied by the agent's own say-so. Every line answers to a command or a human, never
                to a summary.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
