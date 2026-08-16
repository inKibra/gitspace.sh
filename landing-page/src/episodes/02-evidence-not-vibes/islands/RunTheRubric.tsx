import { useEffect, useState } from "react";
import { Check, Paperclip, Play, RotateCcw, Wrench } from "lucide-react";
import { cn } from "../../../lib/utils";

/* Run the rubric: three requirements guard a goal. Command judges stream real
   output and auto-accept on pass; the screenshot requirement takes a manual
   attach + human review. One command judge fails on the first run on purpose. */

type RunScript = { lines: string[]; exit: number };
type ReqDef = {
  id: string;
  title: string;
  kind: "test-output" | "screenshot";
  rubric: string;
  judge: "command" | "human";
  runs?: RunScript[]; // scripted attempts, in order
};

const REQS: ReqDef[] = [
  {
    id: "tests",
    title: "Checkout tests pass",
    kind: "test-output",
    rubric: "Exercises the real checkout path, not a stub. 0 failures, exit 0.",
    judge: "command",
    runs: [
      {
        lines: [
          "$ bun test src/checkout",
          "bun test v1.3.2",
          "src/checkout/totals.test.ts:",
          "✓ computes subtotal from line items [4ms]",
          "✓ applies regional tax to subtotal [2ms]",
          "✓ free shipping over threshold [3ms]",
          "✓ rejects negative quantities [1ms]",
          "142 pass · 0 fail · 311 expect() calls",
          "exit 0",
        ],
        exit: 0,
      },
    ],
  },
  {
    id: "types",
    title: "No type errors in checkout",
    kind: "test-output",
    rubric: "bunx tsc --noEmit exits 0 across src/checkout.",
    judge: "command",
    runs: [
      {
        lines: [
          "$ bunx tsc --noEmit",
          "src/checkout/Totals.tsx:41:7 - error TS2345:",
          "  Argument of type 'string | undefined' is not",
          "  assignable to parameter of type 'string'.",
          "Found 1 error in src/checkout/Totals.tsx:41",
          "exit 1",
        ],
        exit: 1,
      },
      {
        lines: ["$ bunx tsc --noEmit", "exit 0"],
        exit: 0,
      },
    ],
  },
  {
    id: "shot",
    title: "Checkout screenshot",
    kind: "screenshot",
    rubric: "Order summary shows subtotal, tax, and total. Pay button enabled.",
    judge: "human",
  },
];

type ReqState = {
  status: "missing" | "review" | "accepted";
  failed: boolean; // last judgment failed
  attempts: number;
  output: string[];
  evidence: string[];
};

const initial = (): Record<string, ReqState> =>
  Object.fromEntries(
    REQS.map((r) => [r.id, { status: "missing", failed: false, attempts: 0, output: [], evidence: [] } as ReqState])
  );

const PIP: Record<string, string> = {
  missing: "bg-zinc-700",
  review: "bg-[#ffcc00]",
  failed: "bg-[#ff4444]",
  accepted: "bg-[#00ff66]",
};

function lineColor(l: string) {
  if (l.includes("error") || l === "exit 1" || l.startsWith("Found 1")) return "text-red-400";
  if (l === "exit 0" || l.startsWith("142 pass")) return "text-[#00ff66]";
  if (l.startsWith("✓")) return "text-zinc-400";
  if (l.startsWith("$")) return "text-zinc-200";
  return "text-zinc-500";
}

/* small mock of checkout-flow.png */
function ShotThumb() {
  return (
    <div className="w-[112px] h-[72px] bg-[#0c0c0c] border border-[#2a2a2a] p-1.5 flex flex-col gap-1 shrink-0" aria-hidden>
      <div className="h-1.5 w-10 bg-zinc-700" />
      <div className="flex-1 flex flex-col gap-[3px] justify-center">
        <div className="flex justify-between"><div className="h-1 w-9 bg-zinc-700" /><div className="h-1 w-5 bg-zinc-600" /></div>
        <div className="flex justify-between"><div className="h-1 w-6 bg-zinc-700" /><div className="h-1 w-4 bg-zinc-600" /></div>
        <div className="flex justify-between"><div className="h-1 w-8 bg-zinc-400" /><div className="h-1 w-6 bg-zinc-300" /></div>
      </div>
      <div className="h-3.5 bg-[#00ff66] flex items-center justify-center">
        <span className="text-[6px] leading-none text-black font-bold font-mono">PAY $148.00</span>
      </div>
    </div>
  );
}

export function RunTheRubric() {
  const [states, setStates] = useState<Record<string, ReqState>>(initial);
  const [active, setActive] = useState<{ id: string; runIdx: number } | null>(null);

  /* stream the active run's output one line at a time, then finalize */
  useEffect(() => {
    if (!active) return;
    const def = REQS.find((r) => r.id === active.id);
    const script = def?.runs?.[active.runIdx];
    if (!script) return;
    const shown = states[active.id].output.length;

    if (shown >= script.lines.length) {
      const t = setTimeout(() => {
        setStates((s) => {
          const st = s[active.id];
          const pass = script.exit === 0;
          return {
            ...s,
            [active.id]: {
              ...st,
              status: pass ? "accepted" : "review",
              failed: !pass,
              attempts: st.attempts + 1,
              evidence: [...st.evidence, `test-run.json · exit ${script.exit}`],
            },
          };
        });
        setActive(null);
      }, 400);
      return () => clearTimeout(t);
    }

    const t = setTimeout(
      () => {
        setStates((s) => {
          const st = s[active.id];
          if (st.output.length !== shown) return s;
          return { ...s, [active.id]: { ...st, output: [...st.output, script.lines[shown]] } };
        });
      },
      shown === 0 ? 250 : 150
    );
    return () => clearTimeout(t);
  }, [active, states]);

  function runJudgment(id: string) {
    if (active) return;
    const def = REQS.find((r) => r.id === id);
    if (!def?.runs) return;
    const runIdx = Math.min(states[id].attempts, def.runs.length - 1);
    setStates((s) => ({ ...s, [id]: { ...s[id], output: [], failed: false } }));
    setActive({ id, runIdx });
  }

  function attachShot() {
    setStates((s) => ({
      ...s,
      shot: { ...s.shot, status: "review", evidence: ["checkout-flow.png"] },
    }));
  }

  function passShot() {
    setStates((s) => ({ ...s, shot: { ...s.shot, status: "accepted" } }));
  }

  function reset() {
    setActive(null);
    setStates(initial());
  }

  /* readiness, computed the way `space goal status` computes it */
  const all = REQS.map((r) => states[r.id]);
  const accepted = all.filter((s) => s.status === "accepted").length;
  const failedN = all.filter((s) => s.failed).length;
  const missing = all.filter((s) => s.status === "missing").length;
  const inReview = all.filter((s) => s.status === "review").length;
  const unjudged = inReview - failedN;
  const ready = accepted === REQS.length;

  const word = ready ? "ready" : failedN > 0 || missing > 0 ? "not-ready" : "awaiting-review";
  const summary = ready
    ? "Ready: all required artifacts passed judgment."
    : failedN > 0
      ? `${failedN} requirement${failedN === 1 ? "" : "s"} failed review.`
      : missing > 0
        ? `${missing} required artifact${missing === 1 ? "" : "s"} missing.`
        : `${unjudged} artifact${unjudged === 1 ? "" : "s"} attached but not judged.`;

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 2 · run the rubric</div>
      <div className="border border-[#1a1a1a] bg-[#050505]">
        {/* header */}
        <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center gap-3">
          <span className="text-[12px] text-zinc-400">
            Goal <span className="font-mono text-zinc-300">checkout-refactor</span> · 3 required artifacts. Run every judgment.
          </span>
          <button onClick={reset} className="ml-auto text-[12px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> reset
          </button>
        </div>

        {/* requirements */}
        {REQS.map((r) => {
          const st = states[r.id];
          const running = active?.id === r.id;
          const pip = st.status === "accepted" ? "accepted" : st.failed ? "failed" : st.status;
          return (
            <div key={r.id} className="border-b border-[#1a1a1a] px-4 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={cn("h-2 w-2 shrink-0", PIP[pip], st.status === "accepted" && "shadow-[0_0_6px] shadow-[#00ff66]/60")} />
                <span className="text-sm text-zinc-200">{r.title}</span>
                <span className="text-[10px] font-mono text-zinc-600 border border-[#1a1a1a] px-1.5 py-0.5">{r.kind}</span>
                <span className="text-[10px] font-mono text-zinc-600 border border-[#1a1a1a] px-1.5 py-0.5">judge: {r.judge}</span>
                <span
                  className={cn(
                    "text-[11px] font-mono ml-auto",
                    st.status === "accepted" ? "text-[#00ff66]" : st.failed ? "text-[#ff4444]" : st.status === "review" ? "text-[#ffcc00]" : "text-zinc-600"
                  )}
                >
                  {st.status === "review" && st.failed ? "review · failed" : st.status}
                </span>
              </div>
              <div className="text-[12px] text-zinc-500 mt-1.5 pl-5">rubric: {r.rubric}</div>

              {/* actions */}
              <div className="pl-5 mt-3 flex flex-wrap items-center gap-2">
                {r.judge === "command" && st.status !== "accepted" && (
                  <button
                    onClick={() => runJudgment(r.id)}
                    disabled={active != null}
                    className={cn(
                      "text-[12px] font-mono px-3 py-1.5 border flex items-center gap-1.5 transition-colors",
                      running
                        ? "border-[#1a1a1a] text-zinc-500 cursor-default"
                        : st.failed
                          ? "border-[#00ff66]/40 text-[#00ff66] hover:bg-[#00ff66]/10"
                          : "border-green-500/40 text-green-300 hover:bg-green-500/10",
                      active != null && !running && "opacity-40 cursor-default"
                    )}
                  >
                    {running ? (
                      <>running…</>
                    ) : st.failed ? (
                      <>
                        <Wrench className="w-3 h-3" /> fix applied · re-run judgment
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3" /> run judgment
                      </>
                    )}
                  </button>
                )}
                {r.judge === "command" && st.failed && !running && (
                  <span className="text-[11px] font-mono text-zinc-500">fix: guard optional sku before formatTotal()</span>
                )}
                {r.id === "shot" && st.status === "missing" && (
                  <button
                    onClick={attachShot}
                    className="text-[12px] font-mono px-3 py-1.5 border border-green-500/40 text-green-300 hover:bg-green-500/10 flex items-center gap-1.5 transition-colors"
                  >
                    <Paperclip className="w-3 h-3" /> attach checkout-flow.png
                  </button>
                )}
                {r.id === "shot" && st.status === "review" && (
                  <button
                    onClick={passShot}
                    className="text-[12px] font-mono px-3 py-1.5 border border-[#ffcc00]/40 text-[#ffcc00] hover:bg-[#ffcc00]/10 flex items-center gap-1.5 transition-colors"
                  >
                    <Check className="w-3 h-3" /> record review · pass
                  </button>
                )}
                {st.status === "accepted" && (
                  <span className="text-[12px] font-mono text-[#00ff66] flex items-center gap-1.5">
                    <Check className="w-3 h-3" /> {r.judge === "command" ? "auto-accepted: run satisfied expect exit-zero" : "Accepted."}
                  </span>
                )}
              </div>

              {/* streamed output */}
              {st.output.length > 0 && (
                <pre className="ml-5 mt-3 bg-black border border-[#1a1a1a] px-3 py-2.5 text-[12px] leading-relaxed font-mono overflow-x-auto">
                  {st.output.map((l, i) => (
                    <div key={i} className={lineColor(l)}>
                      {l}
                    </div>
                  ))}
                  {running && <div className="text-zinc-600">▌</div>}
                </pre>
              )}

              {/* evidence chips */}
              {st.evidence.length > 0 && (
                <div className="pl-5 mt-3 flex flex-wrap items-center gap-2">
                  {st.evidence.map((e, i) => (
                    <span
                      key={i}
                      className={cn(
                        "text-[11px] font-mono border px-2 py-1 flex items-center gap-1.5",
                        e.endsWith("exit 1") ? "border-[#ff4444]/40 text-red-300" : "border-[#1a1a1a] text-zinc-400"
                      )}
                    >
                      <Paperclip className="w-3 h-3 text-zinc-500" /> {e}
                    </span>
                  ))}
                  {r.id === "shot" && <ShotThumb />}
                </div>
              )}
            </div>
          );
        })}

        {/* readiness: the four lines `space goal status` prints */}
        <div className="px-4 py-4 font-mono text-[12px] leading-relaxed">
          <div className="text-zinc-500">$ space goal status</div>
          <div className="text-zinc-400">
            Validation readiness for checkout-refactor:{" "}
            <span className={ready ? "text-[#00ff66]" : word === "awaiting-review" ? "text-[#ffcc00]" : "text-zinc-300"}>{word}</span>
          </div>
          <div className={ready ? "text-[#00ff66] [text-shadow:0_0_10px_rgba(0,255,102,0.45)]" : failedN > 0 ? "text-[#ff4444]" : "text-zinc-300"}>
            {summary}
          </div>
          <div className="text-zinc-500">
            Required: {REQS.length} · missing: {missing} · review: {inReview} · accepted: {accepted}
          </div>
        </div>
      </div>
    </div>
  );
}
