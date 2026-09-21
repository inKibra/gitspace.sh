import { useEffect, useRef, useState } from "react";
import { RotateCcw, CornerDownLeft } from "lucide-react";
import { cn } from "../../../lib/utils";

/* ------------------------------------------------------------------ types */

type Kind = "note" | "test-output" | "screenshot";
type ReqStatus = "missing" | "review" | "accepted";

type Req = {
  title: string;
  kind: Kind;
  rubric: string;
  gen: string; // "manual" or a command string
  judge: string; // rendered judge label
  phase: string;
};

type PhaseNode = { id: string; col: number; row: 0 | 1 };

type Derivation = {
  goal: string;
  phases: PhaseNode[];
  edges: Array<[string, string]>;
  reqs: Req[];
  journalPhase: string;
  workflowRef: string;
  intent: string;
  outcomeHead: string;
  decision: string;
  verdictNote: string;
};

/* ---------------------------------------------------------------- presets */

const PRESETS: Derivation[] = [
  {
    goal: "Remove the checkout_v2 flag",
    phases: [
      { id: "plan", col: 0, row: 0 },
      { id: "map-reads", col: 1, row: 0 },
      { id: "remove-code", col: 2, row: 0 },
      { id: "purge-config", col: 2, row: 1 },
      { id: "verify", col: 3, row: 0 },
    ],
    edges: [
      ["plan", "map-reads"],
      ["map-reads", "remove-code"],
      ["map-reads", "purge-config"],
      ["remove-code", "verify"],
      ["purge-config", "verify"],
    ],
    reqs: [
      {
        title: "Flag read inventory",
        kind: "note",
        rubric: "Every checkout_v2 read site listed as file:line. Zero left unclassified.",
        gen: "manual",
        judge: "human",
        phase: "map-reads",
      },
      {
        title: "No references remain",
        kind: "test-output",
        rubric: "Zero checkout_v2 hits outside CHANGELOG. Exit code 0.",
        gen: `command "scripts/assert-no-flag.sh"`,
        judge: "same-run · expect exit-zero",
        phase: "remove-code",
      },
      {
        title: "Config keys purged",
        kind: "test-output",
        rubric: "checkout_v2 absent from every env file and config map. Exit code 0.",
        gen: `command "bun run scripts/check-config.ts"`,
        judge: "same-run · expect exit-zero",
        phase: "purge-config",
      },
      {
        title: "Checkout suite passes",
        kind: "test-output",
        rubric: "Suite completes with 0 failures. No skipped tests. Exit code 0.",
        gen: `command "bun test src/checkout"`,
        judge: "same-run · expect exit-zero",
        phase: "verify",
      },
    ],
    journalPhase: "map-reads",
    workflowRef: "checkout-v2.workflow.json#phases[1]",
    intent:
      "Sweep src for checkout_v2 reads and classify each site: delete, replace with the v2 default, or keep behind config. Expect a note, zero edits.",
    outcomeHead: "Inventoried 14 checkout_v2 read sites",
    decision: "Counted the analytics event as a read; it dies with the flag.",
    verdictNote: "14 sites listed as file:line, every one classified. Rubric line 1 satisfied.",
  },
  {
    goal: "Add rate limits to the api",
    phases: [
      { id: "plan", col: 0, row: 0 },
      { id: "design-limits", col: 1, row: 0 },
      { id: "middleware", col: 2, row: 0 },
      { id: "buckets", col: 2, row: 1 },
      { id: "verify", col: 3, row: 0 },
    ],
    edges: [
      ["plan", "design-limits"],
      ["design-limits", "middleware"],
      ["design-limits", "buckets"],
      ["middleware", "verify"],
      ["buckets", "verify"],
    ],
    reqs: [
      {
        title: "Limit policy note",
        kind: "note",
        rubric: "Per-key ceiling and burst policy stated with numbers, plus why per-key beats per-IP here.",
        gen: "manual",
        judge: "human",
        phase: "design-limits",
      },
      {
        title: "429 contract test",
        kind: "test-output",
        rubric: "Requests over the ceiling get 429 with Retry-After set. Exit code 0.",
        gen: `command "bun test src/api/rate-limit"`,
        judge: "same-run · expect exit-zero",
        phase: "middleware",
      },
      {
        title: "Buckets expire",
        kind: "test-output",
        rubric: "No key survives past its window; keyspace flat after the run. Exit code 0.",
        gen: `command "bun test src/api/buckets"`,
        judge: "same-run · expect exit-zero",
        phase: "buckets",
      },
      {
        title: "Throttle screenshot",
        kind: "screenshot",
        rubric: "Dashboard shows requests flatten at the configured ceiling, not before it.",
        gen: "manual",
        judge: "human",
        phase: "verify",
      },
    ],
    journalPhase: "design-limits",
    workflowRef: "rate-limits.workflow.json#phases[1]",
    intent: "Pick ceilings per key tier and write the burst policy. Expect a note, zero code.",
    outcomeHead: "Set per-key ceilings: 100 rps standard, 1000 rps internal",
    decision: "Per key, not per IP: our worst offenders share a NAT.",
    verdictNote: "Ceilings stated with numbers; the per-key argument covers the NAT case.",
  },
];

function customDerivation(goal: string): Derivation {
  return {
    goal,
    phases: [
      { id: "plan", col: 0, row: 0 },
      { id: "spec", col: 1, row: 0 },
      { id: "implement", col: 2, row: 0 },
      { id: "tests", col: 2, row: 1 },
      { id: "verify", col: 3, row: 0 },
    ],
    edges: [
      ["plan", "spec"],
      ["spec", "implement"],
      ["spec", "tests"],
      ["implement", "verify"],
      ["tests", "verify"],
    ],
    reqs: [
      {
        title: "Definition of done note",
        kind: "note",
        rubric: `What "${goal}" changes for the user, one paragraph, failure case included.`,
        gen: "manual",
        judge: "human",
        phase: "spec",
      },
      {
        title: "No type errors",
        kind: "test-output",
        rubric: "tsc --noEmit exits 0.",
        gen: `command "bun run typecheck"`,
        judge: "same-run · expect exit-zero",
        phase: "implement",
      },
      {
        title: "Focused tests pass",
        kind: "test-output",
        rubric: "Suite completes with 0 failures. No skipped tests. Exit code 0.",
        gen: `command "bun test"`,
        judge: "same-run · expect exit-zero",
        phase: "tests",
      },
      {
        title: "Behavior screenshot",
        kind: "screenshot",
        rubric: "The new behavior visible on screen; the old behavior gone.",
        gen: "manual",
        judge: "human",
        phase: "verify",
      },
    ],
    journalPhase: "spec",
    workflowRef: "goal.workflow.json#phases[1]",
    intent: `Write the definition of done for "${goal}" before touching code. Expect one note, zero edits.`,
    outcomeHead: `Defined done for: ${goal}`,
    decision: "Named the failure case first; the requirements fell out of it.",
    verdictNote: "States the user-visible change and the failure case. Rubric satisfied.",
  };
}

/* --------------------------------------------------------------- visuals */

const KIND_LABEL: Record<Kind, string> = {
  note: "note",
  "test-output": "test-output",
  screenshot: "screenshot",
};

const PIP: Record<ReqStatus, string> = {
  missing: "border border-zinc-600 bg-transparent",
  review: "bg-amber-400",
  accepted: "bg-green-500 shadow-[0_0_6px] shadow-green-500/60",
};

function Pip({ s }: { s: ReqStatus }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 transition-colors duration-300", PIP[s])} />;
}

/* graph geometry */
const COL_W = 148;
const NODE_W = 116;
const NODE_H = 28;
const PAD_X = 8;
function nodeXY(n: PhaseNode, hasParallel: boolean) {
  const x = PAD_X + n.col * COL_W;
  const y = n.row === 1 ? 76 : hasParallel && sameColHasPair(n) ? 12 : 44;
  return { x, y };
}
// a col-2 row-0 node sits high only when a row-1 partner exists in its column
let PAIR_COLS: Set<number> = new Set();
function sameColHasPair(n: PhaseNode) {
  return PAIR_COLS.has(n.col);
}

function WorkflowGraph({
  d,
  show,
  journalState,
}: {
  d: Derivation;
  show: boolean;
  journalState: "open" | "closed" | "none";
}) {
  PAIR_COLS = new Set(d.phases.filter((p) => p.row === 1).map((p) => p.col));
  const maxCol = Math.max(...d.phases.map((p) => p.col));
  const width = PAD_X * 2 + maxCol * COL_W + NODE_W;
  const byId = Object.fromEntries(d.phases.map((p) => [p.id, p]));
  return (
    <svg viewBox={`0 0 ${width} 116`} className="w-full max-w-[640px]" role="img" aria-label="Derived workflow graph">
      {d.edges.map(([a, b]) => {
        const pa = byId[a];
        const pb = byId[b];
        const A = nodeXY(pa, true);
        const B = nodeXY(pb, true);
        return (
          <line
            key={`${a}-${b}`}
            x1={A.x + NODE_W}
            y1={A.y + NODE_H / 2}
            x2={B.x}
            y2={B.y + NODE_H / 2}
            stroke="#1f1f1f"
            strokeWidth={1}
            style={{
              opacity: show ? 1 : 0,
              transitionProperty: "opacity",
              transitionDuration: "400ms",
              transitionDelay: `${(maxCol + 1) * 90}ms`,
            }}
          />
        );
      })}
      {d.phases.map((p) => {
        const { x, y } = nodeXY(p, true);
        const isJournal = p.id === d.journalPhase && journalState !== "none";
        const closed = isJournal && journalState === "closed";
        return (
          <g
            key={p.id}
            style={{
              opacity: show ? 1 : 0,
              transitionProperty: "opacity",
              transitionDuration: "300ms",
              transitionDelay: `${p.col * 90}ms`,
            }}
          >
            <rect
              x={x}
              y={y}
              width={NODE_W}
              height={NODE_H}
              fill="#0c0c0c"
              stroke={closed ? "#00ff66" : isJournal ? "#ffcc00" : "#2a2a2a"}
              strokeWidth={1}
              style={{ transitionProperty: "stroke", transitionDuration: "300ms" }}
            />
            <text
              x={x + NODE_W / 2}
              y={y + NODE_H / 2 + 3.5}
              textAnchor="middle"
              fontSize={10.5}
              fontFamily="ui-monospace, monospace"
              fill={closed ? "#00ff66" : isJournal ? "#ffcc00" : "#a1a1aa"}
            >
              {p.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------ the island */

export function DeriveTheContract() {
  const [sel, setSel] = useState<Derivation | null>(null);
  const [selKey, setSelKey] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [step, setStep] = useState(0);
  const [owedStatus, setOwedStatus] = useState<ReqStatus>("missing");
  const [endTried, setEndTried] = useState(false);
  const [ended, setEnded] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  function derive(d: Derivation, key: string) {
    clearTimers();
    setSel(d);
    setSelKey(key);
    setStep(0);
    setOwedStatus("missing");
    setEndTried(false);
    setEnded(false);
    const n = d.reqs.length;
    const total = n + 3; // 1 goal · n reqs · graph · journal
    let delay = 120;
    for (let s = 1; s <= total; s++) {
      const t = window.setTimeout(() => setStep(s), delay);
      timers.current.push(t);
      delay += s === 1 ? 280 : s <= 1 + n ? 170 : 480;
    }
  }

  function reset() {
    clearTimers();
    setSel(null);
    setSelKey("");
    setStep(0);
    setOwedStatus("missing");
    setEndTried(false);
    setEnded(false);
  }

  function attachAndJudge() {
    if (!sel || owedStatus === "accepted") return;
    setOwedStatus("review");
    const t = window.setTimeout(() => setOwedStatus("accepted"), 550);
    timers.current.push(t);
  }

  function phaseEnd() {
    if (!sel || ended) return;
    if (owedStatus !== "accepted") {
      setEndTried(true);
      return;
    }
    setEnded(true);
  }

  const n = sel?.reqs.length ?? 0;
  const graphStep = n + 2;
  const journalStep = n + 3;
  const showGraph = step >= graphStep;
  const showJournal = step >= journalStep;
  const owedReq = sel?.reqs.find((r) => r.phase === sel.journalPhase);
  const acceptedCount = ended || owedStatus === "accepted" ? 1 : 0;
  const missingCount = n - acceptedCount;

  const statusFor = (r: Req): ReqStatus => (sel && r.phase === sel.journalPhase ? owedStatus : "missing");

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">
        demo · state the goal, watch the contract derive
      </div>
      <div className="border border-[#1a1a1a] bg-[#050505]">
        {/* chooser */}
        <div className="px-4 py-3 border-b border-[#1a1a1a] flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-zinc-500 mr-1">Goal:</span>
          {PRESETS.map((p, i) => (
            <button
              key={p.goal}
              onClick={() => derive(p, `preset-${i}`)}
              className={cn(
                "text-[12px] font-mono px-3 py-1.5 border transition-colors active:scale-[0.96]",
                selKey === `preset-${i}`
                  ? "border-green-500/60 text-green-400 bg-green-500/5"
                  : "border-[#2a2a2a] text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              )}
            >
              {p.goal}
            </button>
          ))}
          <form
            className="flex items-center gap-0"
            onSubmit={(e) => {
              e.preventDefault();
              const g = custom.trim().slice(0, 60);
              if (g) derive(customDerivation(g), "custom");
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="or type your own…"
              aria-label="Type your own goal"
              className="w-40 sm:w-48 bg-[#0c0c0c] border border-[#2a2a2a] px-2.5 py-1.5 text-[12px] font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-green-500/50"
            />
            <button
              type="submit"
              aria-label="Derive from typed goal"
              className="border border-l-0 border-[#2a2a2a] px-2.5 py-1.5 text-zinc-400 hover:text-green-400 hover:bg-white/5 transition-colors active:scale-[0.96]"
            >
              <CornerDownLeft className="w-3.5 h-3.5" />
            </button>
          </form>
          {sel && (
            <button
              onClick={reset}
              className="ml-auto text-[12px] text-zinc-500 hover:text-zinc-200 flex items-center gap-1 transition-colors"
            >
              <RotateCcw className="w-3 h-3" /> reset
            </button>
          )}
        </div>

        {!sel && (
          <div className="px-4 py-10 text-center text-[13px] text-zinc-500 font-mono">
            Pick a goal. Everything below derives from it: requirements, workflow, journal.
          </div>
        )}

        {sel && (
          <div className="px-4 py-4 space-y-5">
            {/* 1 · the goal, stated once */}
            <div
              className="font-mono text-[12px] transition-opacity duration-300"
              style={{ opacity: step >= 1 ? 1 : 0 }}
            >
              <span className="text-zinc-600">$ </span>
              <span className="text-zinc-300">space goal set --body </span>
              <span className="text-green-400">"# {sel.goal}"</span>
            </div>

            {/* 2 · requirements with rubrics */}
            <div>
              <div
                className="text-[11px] font-mono uppercase tracking-widest text-zinc-500 mb-2 transition-opacity duration-300"
                style={{ opacity: step >= 2 ? 1 : 0 }}
              >
                requirements · derived · what done means
              </div>
              <div className="space-y-px">
                {sel.reqs.map((r, i) => {
                  const visible = step >= 2 + i;
                  const s = statusFor(r);
                  const owed = r.phase === sel.journalPhase;
                  return (
                    <div
                      key={r.title}
                      className="bg-[#0a0a0a] border border-[#161616] px-3 py-2 transition-[opacity,translate] duration-300"
                      style={{ opacity: visible ? 1 : 0, translate: visible ? "0 0" : "0 6px" }}
                    >
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <Pip s={s} />
                        <span className="text-[13px] text-zinc-200">{r.title}</span>
                        <span className="text-[10px] font-mono text-zinc-500 border border-[#2a2a2a] px-1.5 py-0.5">
                          {KIND_LABEL[r.kind]}
                        </span>
                        <span
                          className={cn(
                            "text-[10px] font-mono px-1.5 py-0.5 border",
                            owed && showJournal && !ended
                              ? "border-amber-400/50 text-amber-300"
                              : "border-[#2a2a2a] text-zinc-500"
                          )}
                        >
                          phase: {r.phase}
                        </span>
                        <span className="ml-auto text-[10px] font-mono text-zinc-600">{s}</span>
                      </div>
                      <div className="mt-1 text-[12px] text-zinc-500 pl-[18px]">rubric: {r.rubric}</div>
                      <div className="mt-0.5 text-[11px] font-mono text-zinc-600 pl-[18px]">
                        gen: {r.gen} · judge: {r.judge}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3 · workflow node graph */}
            <div>
              <div
                className="text-[11px] font-mono uppercase tracking-widest text-zinc-500 mb-2 transition-opacity duration-300"
                style={{ opacity: showGraph ? 1 : 0 }}
              >
                workflow · derived · what order work happens
              </div>
              <div className="overflow-x-auto">
                <WorkflowGraph d={sel} show={showGraph} journalState={ended ? "closed" : showJournal ? "open" : "none"} />
              </div>
            </div>

            {/* 4 · phase journal */}
            <div
              className="transition-[opacity,translate] duration-300"
              style={{ opacity: showJournal ? 1 : 0, translate: showJournal ? "0 0" : "0 6px" }}
            >
              <div className="text-[11px] font-mono uppercase tracking-widest text-zinc-500 mb-2">
                phase journal · intent before, outcome after
              </div>
              <div className="border border-[#161616] bg-[#0a0a0a] px-3 py-3 font-mono text-[12px] leading-relaxed">
                <div>
                  <span className="text-zinc-600">$ </span>
                  <span className="text-zinc-300">gssh space journal phase-start --phase </span>
                  <span className="text-green-400">"{sel.journalPhase}"</span>
                </div>
                <div className="text-zinc-500 pl-4">
                  --intent <span className="text-zinc-400">"{sel.intent}"</span>
                </div>
                <div className="text-zinc-500 pl-4">
                  --workflow-ref <span className="text-zinc-400">"{sel.workflowRef}"</span>
                </div>
                {owedReq && (
                  <div className="mt-2 border-t border-[#161616] pt-2">
                    <div className="text-amber-300/90">
                      phase {sel.journalPhase} · open · owed contract (1 requirement):
                    </div>
                    <div className="pl-2 mt-1 flex items-center gap-2">
                      <Pip s={owedStatus} />
                      <span className={cn(owedStatus === "accepted" ? "text-green-400" : "text-zinc-300")}>
                        {owedReq.title}
                      </span>
                      <span className="text-zinc-600">[{owedStatus}]</span>
                    </div>
                    <div className="pl-6 text-zinc-500">rubric: {owedReq.rubric}</div>
                    <div className="pl-6 text-zinc-600">
                      gen: {owedReq.gen} · judge: {owedReq.judge}
                    </div>
                    <div className="pl-2 mt-1 text-zinc-600">
                      that printout is the phase's definition of done.
                    </div>
                  </div>
                )}

                {/* the beat: try to end, get blocked, produce evidence, end */}
                {!ended && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={phaseEnd}
                      className={cn(
                        "text-[12px] px-3 py-1.5 border transition-colors active:scale-[0.96]",
                        owedStatus === "accepted"
                          ? "border-green-500/60 text-green-400 hover:bg-green-500/10"
                          : "border-[#2a2a2a] text-zinc-300 hover:bg-white/5"
                      )}
                    >
                      gssh space journal phase-end
                    </button>
                    <button
                      onClick={attachAndJudge}
                      disabled={owedStatus !== "missing"}
                      className={cn(
                        "text-[12px] px-3 py-1.5 border transition-colors active:scale-[0.96]",
                        owedStatus === "missing"
                          ? "border-amber-400/40 text-amber-200 hover:bg-amber-400/10"
                          : "border-[#2a2a2a] text-zinc-600 cursor-default"
                      )}
                    >
                      {owedStatus === "missing"
                        ? "attach evidence · apply the rubric"
                        : owedStatus === "review"
                          ? "judging…"
                          : "evidence accepted"}
                    </button>
                  </div>
                )}

                {endTried && owedStatus !== "accepted" && !ended && (
                  <div className="mt-3 border border-amber-400/30 bg-amber-400/5 px-3 py-2">
                    <div className="text-amber-300">
                      phase-end BLOCKED · 1 owed required requirement not accepted
                    </div>
                    <div className="pl-2 text-zinc-400 mt-0.5">→ {owedReq?.title} [missing]</div>
                    <div className="text-zinc-500 mt-0.5">
                      exit: produce the evidence and get it judged, then retry. nothing to edit; the gate is computed.
                    </div>
                  </div>
                )}

                {owedStatus === "accepted" && !ended && (
                  <div className="mt-2 text-zinc-500">
                    verdict: <span className="text-green-400">accept</span> · "{sel.verdictNote}"
                  </div>
                )}

                {ended && (
                  <div className="mt-3 border-t border-[#161616] pt-2">
                    <div>
                      <span className="text-zinc-600">$ </span>
                      <span className="text-zinc-300">gssh space journal phase-end --outcome </span>
                      <span className="text-green-400">"{sel.outcomeHead}"</span>
                    </div>
                    <div className="text-zinc-500 pl-4">
                      --decision <span className="text-zinc-400">"{sel.decision}"</span>
                    </div>
                    <div className="mt-1.5 text-green-400">
                      phase {sel.journalPhase} · closed · gate passed
                    </div>
                    <div className="text-zinc-400">
                      auto-commit: <span className="text-zinc-200">"{sel.outcomeHead}"</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* readiness footer */}
            {showJournal && (
              <div className="border-t border-[#1a1a1a] pt-3 font-mono text-[12px]">
                <span className="text-zinc-600">space goal status → </span>
                <span className={cn(missingCount === 0 ? "text-green-400" : "text-zinc-300")}>
                  Validation readiness: not-ready
                </span>
                <span className="text-zinc-500">
                  {" "}
                  · {missingCount} required artifact{missingCount === 1 ? "" : "s"} missing.
                </span>
                <div className="text-zinc-600 mt-1">
                  {ended
                    ? "The other phases owe the rest. Each gate closes the same way."
                    : "Readiness counts required requirements only. The sentence is the deliverable."}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
