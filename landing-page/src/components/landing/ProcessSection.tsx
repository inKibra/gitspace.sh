import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ProcessSection — the Fleet Green process, acted out.
 *
 * One deterministic 54s loop: a goal types itself and derives a workflow
 * graph, gitspace sets up a workspace by itself, an agent works in a real
 * transcript (text + tool-use rows) and asks its one question, review runs as
 * two explicit gates (change guide, then the validation contract judging
 * evidence — including a screenshot), and operations close the loop with a
 * cron-refreshed dashboard, promote, and rollup. The only human act in the
 * whole sim is answering the ask form. The five stage cards below are the
 * player's timeline — the active card is lit and fills; clicking a card seeks
 * the simulation to that stage.
 *
 * Engineering: a single rAF clock; every scene renders as a pure function of
 * elapsed ms (seeking = moving the clock). Paused off-viewport via
 * IntersectionObserver. prefers-reduced-motion freezes the sim at a
 * representative frame (rail clicks still seek statically).
 *
 * Story beats, names, and hexes rhyme with marketing/video episode 01
 * (checkout-flags, feat/remove-checkout-v2, the canary option) and
 * ProductShots.tsx.
 */

const C = {
  bg: "#000000",
  surface: "#080808",
  bar: "#050505",
  border: "#1a1a1a",
  borderMuted: "#111111",
  text: "#e6e6e6",
  muted: "#9c9c9c",
  dim: "#6a6a6a",
  ghost: "#3a3a3a",
  green: "#00ff66",
  amber: "#ffcc00",
  blue: "#4488ff",
};

/* ── the timeline: absolute ms within one 54s loop ──────────────────────── */

const LOOP = 54000;
const STAGE_STARTS = [0, 11000, 18000, 31000, 42000] as const;
const STAGE_ENDS = [11000, 18000, 31000, 42000, LOOP] as const;

const EV = {
  // 01 · plan — goal doc, validation contract, then the workflow spec graph
  typeTitle: 400,
  typeBody: 2100,
  goalChip: 4300,
  rubric: 5200,
  wfLine: 6200,
  wfNode: [6900, 7500, 7800, 8500, 9400] as const, // api · web · worker · canary · ship
  wfEdge: [7200, 8200, 9100] as const,
  handoff: 10200,
  // 02 · context — gitspace runs setup itself; no human at a prompt
  treeMain: 11200,
  treeBranch: 11900,
  wsBadge: 12400,
  setup: [12900, 13600, 14300, 15000] as const,
  autoCaption: 15900,
  cleanRoom: 16800,
  // 03 · implement — the agent transcript: text + tool-use rows, then the ask
  strip: 18200,
  kicker: 18500,
  asst1: 18800,
  tool: [19500, 20300, 21100] as const,
  asst2: 21900,
  ask: 22600,
  formIn: 23400,
  pick: 25400,
  submit: 26700,
  formExit: 27150,
  answered: 27900,
  canaryTool: 28700,
  asst3: 29500,
  // 04 · review — gate 1: CODE REVIEW (the change guide's build-order story),
  // gate 2: IMPLEMENTATION PROOF (the validation contract judging evidence)
  guideLabel: 31300,
  guideStep: [31900, 32800, 33700] as const,
  guideChip: 34100,
  proofLabel: 34400,
  statusCmd: 40000,
  ready: 40500,
  // 05 · operate — promote, rollup, cron-refreshed ops dashboard, shipped
  promote: 42400,
  promoteDone: 43200,
  rollup: 43800,
  rollupFill: 44000,
  rollupDone: 45000,
  dash: 45700,
  cronTick: 47600,
  dashCommit: 48900,
  fill: 49400,
  shipped: 51100,
  board: 51800,
  caption: 52600,
  next: 53400,
} as const;

/**
 * Stage 04: each requirement row carries its own beat times — appear (row
 * lands, status `missing`), attach (evidence artifact chip pops, → `review`),
 * judge (judgment runs, "judging…"), accept (→ `accepted`, green square).
 */
const REQS = [
  {
    title: "Focused tests pass",
    rubric: "Suite completes with 0 failures.",
    artifact: "test-run.json",
    shot: false,
    appear: 34600,
    attach: 35400,
    judge: 36000,
    accept: 36700,
  },
  {
    title: "Canary clean",
    rubric: "api error rate 0.00% over 10m.",
    artifact: "canary-metrics.json",
    shot: false,
    appear: 34750,
    attach: 36500,
    judge: 37200,
    accept: 37900,
  },
  {
    title: "Checkout flow verified",
    rubric: "One code path; totals render.",
    artifact: "checkout-flow.png",
    shot: true,
    appear: 34900,
    attach: 37700,
    judge: 38500,
    accept: 39300,
  },
] as const;

/** Good static frame per stage (used by reduced-motion seeking). */
const STAGE_FREEZE = [9000, 16000, 25800, 38700, 48400] as const;

const GOAL_TITLE = "# Remove checkout_v2 flag from all services";
const GOAL_BODY = "Done means: zero references, tests green, canary clean.";

const FLEET: Array<{ name: string; base: "green" | "blue" }> = [
  { name: "api-hardening", base: "green" },
  { name: "checkout-flags", base: "green" },
  { name: "retry-backoff", base: "green" },
  { name: "docs-refresh", base: "blue" },
  { name: "relay-metrics", base: "green" },
];

const STAGES = [
  {
    num: "01",
    name: "Plan",
    line: "State the goal before any agent starts.",
    proof: ["goals & chains", "plans as artifacts", "rubric from the goal"],
  },
  {
    num: "02",
    name: "Context",
    line: "Give every agent a clean room.",
    proof: ["worktree workspaces", "setup scripts & bundles", "Linear in"],
  },
  {
    num: "03",
    name: "Implement",
    line: "Run the fleet. Watch the strip.",
    proof: ["agents per workspace", "native ask forms", "E2E remote access"],
  },
  {
    num: "04",
    name: "Review",
    line: "Evidence, not vibes.",
    proof: ["review rubrics", "command judges", "change guides & blame"],
  },
  {
    num: "05",
    name: "Operate",
    line: "Shipped isn’t done.",
    proof: ["project view", "shipped-goal ops", "phase journal"],
  },
];

/* ── pure helpers ───────────────────────────────────────────────────────── */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const typed = (text: string, t: number, start: number, msPerChar = 30) =>
  t < start ? "" : text.slice(0, Math.floor((t - start) / msPerChar));

const stageAt = (t: number) => {
  for (let i = STAGE_STARTS.length - 1; i >= 0; i--) {
    if (t >= STAGE_STARTS[i]) return i;
  }
  return 0;
};

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `0${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ── tiny primitives ────────────────────────────────────────────────────── */

function Caret() {
  return (
    <span className="pf-caret inline-block align-middle ml-0.5" style={{ width: 6, height: 12, background: C.green }} />
  );
}

/** A log line that exists once t passes `at`; rises in on mount. */
function L({ t, at, color = C.dim, children }: { t: number; at: number; color?: string; children: React.ReactNode }) {
  if (t < at) return null;
  return (
    <div className="pf-rise flex items-baseline gap-2 text-[11px] leading-relaxed" style={{ color }}>
      {children}
    </div>
  );
}

function Pip({ color, pulse = false, bloom = false }: { color: string; pulse?: boolean; bloom?: boolean }) {
  return (
    <span
      className={pulse ? "animate-pulse" : bloom ? "pf-bloom" : ""}
      style={{ width: 9, height: 9, background: color, boxShadow: `0 0 6px ${color}66`, flex: "none", display: "inline-block" }}
    />
  );
}

/** Marks a command the SYSTEM runs — never a human at a prompt. */
function Sys() {
  return (
    <span className="select-none flex-none" style={{ color: C.ghost }}>
      gitspace ·
    </span>
  );
}

/** A workflow-spec node; pops in lit as it derives from the goal. */
function WfNode({ t, at, label }: { t: number; at: number; label: string }) {
  if (t < at) return null;
  return (
    <span
      className="pf-pop px-1.5 py-0.5 text-[8px] whitespace-nowrap"
      style={{ border: `1px solid ${C.green}55`, color: C.text, background: C.surface }}
    >
      {label}
    </span>
  );
}

/** A hairline edge between workflow nodes; draws left→right. */
function WfEdge({ t, at }: { t: number; at: number }) {
  const p = clamp01((t - at) / 250);
  return (
    <span className="relative flex-none" style={{ width: 12, height: 1, background: p > 0 ? C.border : "transparent" }}>
      <span className="absolute left-0 top-0 h-full" style={{ width: `${p * 100}%`, background: `${C.green}88` }} />
    </span>
  );
}

/** A tool-use row in the agent transcript (▸ tag · result). */
function ToolRow({ t, at, tag, body }: { t: number; at: number; tag: string; body: string }) {
  if (t < at) return null;
  return (
    <div
      className="pf-rise flex w-fit max-w-full items-center gap-2 px-2 py-1 text-[10px]"
      style={{ border: `1px solid ${C.border}`, background: C.surface }}
    >
      <span className="flex-none" style={{ color: C.ghost }}>▸</span>
      <span className="flex-none text-[8px] px-1" style={{ border: `1px solid ${C.borderMuted}`, color: C.dim }}>
        {tag}
      </span>
      <span className="truncate" style={{ color: C.muted }}>{body}</span>
    </div>
  );
}

/* ── scenes (each a pure function of t) ─────────────────────────────────── */

function PlanScene({ t }: { t: number }) {
  const title = typed(GOAL_TITLE, t, EV.typeTitle);
  const body = typed(GOAL_BODY, t, EV.typeBody);
  const titleDone = title.length === GOAL_TITLE.length;
  const bodyDone = body.length === GOAL_BODY.length;
  return (
    <div>
      <div className="text-[9px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
        GOAL.MD — NEW GOAL
      </div>
      <div className="text-[13px] mb-2 min-h-[20px]" style={{ color: C.text }}>
        {title}
        {t >= EV.typeTitle && (!titleDone || (bodyDone === false && body.length === 0)) && <Caret />}
      </div>
      <div className="text-[11px] leading-relaxed mb-4 min-h-[18px]" style={{ color: C.muted }}>
        {body}
        {body.length > 0 && !bodyDone && <Caret />}
      </div>
      {t >= EV.goalChip && (
        <span
          className="pf-pop inline-flex items-center gap-1.5 px-2 py-1 text-[10px] mb-3"
          style={{ color: C.green, border: `1px solid ${C.green}55` }}
        >
          ✓ goal.json
        </span>
      )}
      <div className="space-y-1">
        <L t={t} at={EV.rubric}>
          <span style={{ color: C.green }}>←</span> validation contract derived · 3 requirements, each with a rubric
        </L>
        <L t={t} at={EV.wfLine}>
          <span style={{ color: C.green }}>←</span> workflow spec derived · remove-checkout-v2.workflow.json
        </L>
      </div>
      {/* the plan AS a workflow: phases materialize as a node graph */}
      {t >= EV.wfNode[0] && (
        <div className="pf-rise mt-3 flex items-center overflow-hidden">
          <WfNode t={t} at={EV.wfNode[0]} label="remove-api" />
          <WfEdge t={t} at={EV.wfEdge[0]} />
          <span className="flex flex-col gap-1">
            <WfNode t={t} at={EV.wfNode[1]} label="remove-web" />
            <WfNode t={t} at={EV.wfNode[2]} label="remove-worker" />
          </span>
          <WfEdge t={t} at={EV.wfEdge[1]} />
          <WfNode t={t} at={EV.wfNode[3]} label="verify-canary" />
          <WfEdge t={t} at={EV.wfEdge[2]} />
          <WfNode t={t} at={EV.wfNode[4]} label="ship" />
        </div>
      )}
      <div className="mt-3 space-y-1">
        <L t={t} at={EV.handoff}>
          → handing to a workspace…
        </L>
      </div>
    </div>
  );
}

function ContextScene({ t }: { t: number }) {
  const setupLines = [
    "git worktree add ../checkout-flags",
    "setup/install.sh · deps ✓",
    "bundle: env + secrets ✓",
    "agent boot · goal.json loaded ✓",
  ];
  return (
    <div>
      <div className="text-[9px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
        WORKSPACE — CLEAN ROOM
      </div>
      {t >= EV.treeMain && (
        <div className="pf-rise flex items-center gap-2 text-[11px]" style={{ color: C.muted }}>
          main <span className="flex-1 h-px" style={{ background: C.border }} />
        </div>
      )}
      {t >= EV.treeBranch && (
        <div className="pf-rise mt-1.5 ml-2 flex items-center gap-2 text-[11px]">
          <span style={{ color: C.ghost }}>└─</span>
          <span style={{ color: C.green }}>feat/remove-checkout-v2</span>
          {t >= EV.wsBadge && (
            <span className="pf-pop text-[8px] px-1" style={{ border: `1px solid ${C.border}`, color: C.dim }}>
              workspace
            </span>
          )}
        </div>
      )}
      <div className="mt-4 space-y-1">
        {setupLines.map((line, i) => (
          <L key={line} t={t} at={EV.setup[i]}>
            <Sys />
            <span>{line}</span>
          </L>
        ))}
        <L t={t} at={EV.autoCaption} color={C.green}>
          workspace setup runs itself — you never typed a command.
        </L>
        <L t={t} at={EV.cleanRoom} color={C.muted}>
          agent: starting from a clean room
        </L>
      </div>
    </div>
  );
}

function AskPanel({ t }: { t: number }) {
  const enter = clamp01((t - EV.formIn) / 280);
  const exit = clamp01((t - EV.formExit) / 350);
  const alpha = enter * (1 - exit);
  if (alpha <= 0) return null;
  const picked = t >= EV.pick;
  const flashing = t >= EV.submit && t < EV.formExit;
  const options = [
    { label: "Canary: api first, watch errors 10m", tag: "Recommended", desc: "Safest. Adds about 20 minutes." },
    { label: "All three at once", desc: "Fastest. One revert point." },
    { label: "web only, hold the rest", desc: "Partial cleanup with a follow-up PR." },
  ];
  return (
    <div
      className="absolute inset-y-0 right-0 w-full sm:w-[360px] overflow-hidden"
      style={{
        background: C.bar,
        borderLeft: `1px solid ${C.border}`,
        opacity: alpha,
        transform: `translateX(${(1 - enter) * 24 + exit * 24}px)`,
      }}
    >
      <div className="px-4 pt-3 pb-2" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
        <div className="text-[8px] tracking-[0.18em] mb-1" style={{ color: C.amber }}>
          AGENT QUESTIONS · checkout-flags
        </div>
        <div className="text-[12px]" style={{ color: C.text }}>
          Flag cleanup: rollout order
        </div>
      </div>
      <div className="p-4">
        <p className="text-[10.5px] leading-relaxed mb-3" style={{ color: C.muted }}>
          checkout_v2 is still referenced by api, web, and worker. How should I roll out the removal?
        </p>
        <div className="space-y-0.5 mb-3">
          {options.map((o, i) => {
            const on = i === 0;
            const lit = on && picked;
            return (
              <div
                key={o.label}
                className="flex items-start gap-2 px-2 py-1.5"
                style={{
                  background: on ? "#0c0c0c" : "transparent",
                  outline: lit ? `1px solid ${C.green}88` : "none",
                  boxShadow: lit ? `0 0 14px ${C.green}22` : "none",
                }}
              >
                <span
                  className="mt-0.5 h-3 w-3 rounded-full flex items-center justify-center"
                  style={{ border: `2px solid ${on ? C.green : C.dim}`, flex: "none" }}
                >
                  {on && <span className="h-1 w-1 rounded-full" style={{ background: C.green }} />}
                </span>
                <span>
                  <span className="block text-[10.5px]" style={{ color: C.text }}>
                    {o.label}
                    {o.tag && (
                      <span className="ml-1.5 text-[8px] px-1" style={{ color: C.green, border: `1px solid ${C.green}44` }}>
                        {o.tag}
                      </span>
                    )}
                  </span>
                  <span className="block text-[9px] mt-0.5" style={{ color: C.dim }}>
                    {o.desc}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 text-[10px]">
          <span className="px-3 py-1.5" style={{ border: `1px solid ${C.border}`, color: C.dim }}>
            Cancel
          </span>
          <span
            className="px-3 py-1.5 font-semibold"
            style={{
              background: flashing ? "#b8ffd6" : C.green,
              color: "#000",
              boxShadow: flashing ? `0 0 22px ${C.green}aa` : "none",
            }}
          >
            Submit
          </span>
        </div>
      </div>
    </div>
  );
}

function ImplementScene({ t }: { t: number }) {
  const flagsColor = t >= EV.ask && t < EV.answered ? C.amber : C.green;
  const tools = [
    { tag: "edit", body: "services/api/flags.ts · −42 lines" },
    { tag: "bash", body: "bun test · 142 passed" },
    { tag: "grep", body: "checkout_v2 · 3 refs left" },
  ];
  return (
    <div className="relative h-full">
      {t >= EV.strip && (
        <div className="pf-rise flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
          {FLEET.map((w) => {
            const isFlags = w.name === "checkout-flags";
            const color = isFlags ? flagsColor : w.base === "blue" ? C.blue : C.green;
            return (
              <span key={w.name} className="flex items-center gap-1.5 text-[9px]" style={{ color: C.dim }}>
                <Pip
                  color={color}
                  pulse={isFlags && color === C.amber}
                  bloom={isFlags && t >= EV.answered && t < EV.answered + 900}
                />
                {w.name}
              </span>
            );
          })}
        </div>
      )}
      {/* the agent transcript: assistant text + tool-use rows */}
      {t >= EV.kicker && (
        <div className="pf-rise text-[8px] tracking-[0.18em] mb-1.5" style={{ color: C.ghost }}>
          PI · CLAUDE-FABLE-5 · CHECKOUT-FLAGS
        </div>
      )}
      <div className="space-y-1">
        <L t={t} at={EV.asst1} color={C.text}>
          Removing the flag from api first — it gates the other two services.
        </L>
        <div className="space-y-1">
          {tools.map((tool, i) => (
            <ToolRow key={tool.tag} t={t} at={EV.tool[i]} tag={tool.tag} body={tool.body} />
          ))}
        </div>
        <L t={t} at={EV.asst2} color={C.text}>
          web and worker still reference it. Rollout order is a judgment call — asking.
        </L>
        {t >= EV.ask && t < EV.answered && (
          <div className="pf-rise pt-1">
            <span className="text-[10px] px-1.5 py-0.5" style={{ color: C.amber, border: `1px solid ${C.amber}44` }}>
              ⚑ asked you a question
            </span>
          </div>
        )}
        <L t={t} at={EV.answered} color={C.green}>
          ✓ you · Canary: api first, watch errors 10m
        </L>
        <ToolRow t={t} at={EV.canaryTool} tag="bash" body="canary api · errors 0.00%" />
        <L t={t} at={EV.asst3} color={C.text}>
          Canary is clean — proceeding with web and worker.
        </L>
      </div>
      <AskPanel t={t} />
    </div>
  );
}

type ReqStatus = "missing" | "review" | "judging" | "accepted";

function ReqRow({ t, r }: { t: number; r: (typeof REQS)[number] }) {
  if (t < r.appear) return null;
  const status: ReqStatus = t < r.attach ? "missing" : t < r.judge ? "review" : t < r.accept ? "judging" : "accepted";
  const statusColor =
    status === "missing" ? C.dim : status === "accepted" ? C.green : C.amber;
  const label = status === "judging" ? "judging…" : status;
  return (
    <div
      className="pf-rise px-3 py-2"
      style={{
        background: C.surface,
        border: `1px solid ${status === "accepted" ? `${C.green}33` : C.border}`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className={status === "judging" ? "animate-pulse" : status === "accepted" && t < r.accept + 900 ? "pf-bloom" : ""}
          style={{
            width: 8,
            height: 8,
            flex: "none",
            background: status === "missing" ? "transparent" : statusColor,
            border: status === "missing" ? `1px solid ${C.ghost}` : "none",
            boxShadow: status === "missing" ? "none" : `0 0 6px ${statusColor}66`,
          }}
        />
        <span className="text-[11px]" style={{ color: C.text }}>
          {r.title}
        </span>
        <span
          className={`ml-auto text-[9px] ${status === "judging" ? "animate-pulse" : ""}`}
          style={{ color: statusColor }}
        >
          {label}
        </span>
      </div>
      <div className="pl-[16px] text-[9.5px] truncate" style={{ color: C.dim }}>
        rubric: {r.rubric}
      </div>
      {status !== "missing" && (
        <div className="pl-[16px] mt-1 flex items-center gap-1.5">
          {r.shot && (
            <span
              className="pf-pop flex flex-none flex-col justify-between p-[3px]"
              style={{ width: 26, height: 18, border: `1px solid ${C.border}`, background: C.bg }}
            >
              <span style={{ height: 2, width: "100%", background: "#2a2a2a" }} />
              <span style={{ height: 2, width: "70%", background: "#222222" }} />
              <span style={{ height: 3, width: 10, background: C.green }} />
            </span>
          )}
          <span
            className="pf-pop text-[8.5px] px-1 py-px"
            style={{ color: C.muted, border: `1px solid ${C.border}`, background: C.bg }}
          >
            ⎘ {r.artifact}
          </span>
        </div>
      )}
    </div>
  );
}

/** A review sub-phase label: green while its gate is running, then dims. */
function GateLabel({ t, at, until, text }: { t: number; at: number; until: number; text: string }) {
  if (t < at) return null;
  const active = t < until;
  return (
    <div className="pf-rise text-[8.5px] tracking-[0.18em] mb-2" style={{ color: active ? C.green : C.dim }}>
      {text}
    </div>
  );
}

function ReviewScene({ t }: { t: number }) {
  const guide = [
    ["Step 1 — Foundations", "flag registry drops checkout_v2"],
    ["Step 2 — Wiring", "api · web · worker guards removed"],
    ["Step 3 — Surfaces", "one checkout path remains"],
  ] as const;
  return (
    <div>
      <div className="text-[9px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
        REVIEW — TWO GATES
      </div>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {/* gate 1: the change guide narrates the diff in build order */}
        <div>
          <GateLabel t={t} at={EV.guideLabel} until={EV.proofLabel} text="CODE REVIEW · CHANGE GUIDE" />
          <div className="space-y-1.5">
            {guide.map(([step, desc], i) => (
              <L key={step} t={t} at={EV.guideStep[i]} color={C.dim}>
                <span className="flex-none" style={{ color: C.muted }}>{step}:</span>
                <span>{desc}</span>
              </L>
            ))}
          </div>
          {t >= EV.guideChip && (
            <span
              className="pf-pop mt-2 text-[8.5px] px-1 py-px"
              style={{ color: C.muted, border: `1px solid ${C.border}`, background: C.bg }}
            >
              ⎘ review/guide.json
            </span>
          )}
        </div>
        {/* gate 2: the validation contract judges the evidence */}
        <div>
          <GateLabel t={t} at={EV.proofLabel} until={LOOP} text="IMPLEMENTATION PROOF · RUBRIC" />
          <div className="space-y-1">
            {REQS.map((r) => (
              <ReqRow key={r.title} t={t} r={r} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 space-y-1">
        <L t={t} at={EV.statusCmd}>
          <Sys />
          <span>space goal status</span>
        </L>
        <L t={t} at={EV.ready} color={C.green}>
          Ready: all required artifacts passed judgment.
        </L>
      </div>
    </div>
  );
}

function OperateScene({ t }: { t: number }) {
  const fill = 0.62 + 0.38 * clamp01((t - EV.fill) / 1500);
  const merge = clamp01((t - EV.rollupFill) / (EV.rollupDone - EV.rollupFill));
  return (
    <div>
      <div className="text-[9px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
        OPERATE — THE ARTIFACTS AFTERLIFE
      </div>
      {/* promote: scratch draft becomes a typed artifact in the versioned tree */}
      <div className="space-y-1.5 mb-3">
        <L t={t} at={EV.promote} color={C.muted}>
          <span
            className={`w-3 flex-none text-center ${t >= EV.promoteDone ? "pf-pop" : ""}`}
            style={{ color: t >= EV.promoteDone ? C.green : C.ghost }}
          >
            {t >= EV.promoteDone ? "✓" : "…"}
          </span>
          <Sys />
          <span className="truncate">
            space artifacts promote scratch/rollout-notes.md <span style={{ color: C.green }}>→</span> docs/rollout.md
          </span>
        </L>
        {/* rollup: the workspace's artifacts branch merges into main */}
        {t >= EV.rollup && (
          <div className="pf-rise flex items-center gap-2 text-[11px] leading-relaxed flex-wrap">
            <span style={{ color: C.dim }}>rollup:</span>
            <span style={{ color: C.muted }}>artifacts/checkout-flags</span>
            <span className="relative h-0.5 w-14 sm:w-20" style={{ background: "#1f1f1f", flex: "none" }}>
              <span
                className="absolute left-0 top-0 h-full"
                style={{ width: `${merge * 100}%`, background: C.green }}
              />
            </span>
            <span style={{ color: merge >= 1 ? C.green : C.dim }}>main</span>
            {merge >= 1 && (
              <span className="pf-pop" style={{ color: C.green }}>
                ✓
              </span>
            )}
          </div>
        )}
      </div>
      {/* the ops dashboard: a cron tick refreshes the tiles from fresh data */}
      {t >= EV.dash &&
        (() => {
          const fresh = t >= EV.cronTick;
          const ticking = t >= EV.cronTick - 400 && t < EV.cronTick + 900;
          const sec = Math.max(0, Math.floor((t - EV.cronTick) / 1000));
          const tiles: Array<[string, string]> = fresh
            ? [
                ["error rate", "0.00%"],
                ["canary", "clean ✓"],
                ["rollout", "100%"],
              ]
            : [
                ["error rate", "0.02%"],
                ["canary", "clean"],
                ["rollout", "62%"],
              ];
          return (
            <div className="pf-rise max-w-sm mb-3" style={{ border: `1px solid ${C.border}`, background: C.surface }}>
              <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
                <span className="text-[8px] tracking-[0.16em]" style={{ color: C.dim }}>
                  ▦ OPS DASHBOARD
                </span>
                <span
                  className={`text-[8px] px-1 py-px ${ticking ? "animate-pulse" : "pf-breathe"}`}
                  style={{
                    color: C.blue,
                    border: `1px solid ${C.blue}44`,
                    boxShadow: ticking ? `0 0 10px ${C.blue}66` : "none",
                  }}
                >
                  ◷ cron · nightly
                </span>
                <span
                  key={fresh ? "fresh" : "stale"}
                  className="pf-pop ml-auto text-[8px] tabular-nums"
                  style={{ color: fresh ? C.green : C.ghost }}
                >
                  {fresh ? `updated ${sec}s ago` : "updated 8h ago"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-px" style={{ background: C.borderMuted }}>
                {tiles.map(([label, value]) => (
                  <div key={label} className="px-2 py-1.5" style={{ background: C.bg }}>
                    <div className="text-[7.5px] uppercase tracking-wider" style={{ color: C.ghost }}>
                      {label}
                    </div>
                    <div
                      key={value}
                      className="pf-pop text-[12px] tabular-nums"
                      style={{ color: fresh ? C.green : C.muted }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      <div className="space-y-1 mb-3">
        <L t={t} at={EV.dashCommit}>
          <Sys />
          <span>data/rollout.data.json refreshed → rolled up to main</span>
        </L>
      </div>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[10px] w-40 truncate" style={{ color: C.muted }}>
          remove-checkout-v2
        </span>
        <div className="flex-1 h-1.5 overflow-hidden" style={{ background: "#141414" }}>
          <div className="h-full" style={{ width: `${fill * 100}%`, background: C.green }} />
        </div>
        {t >= EV.shipped && (
          <span className="pf-pop text-[10px] px-1.5 py-0.5" style={{ color: C.green, border: `1px solid ${C.green}55` }}>
            ✓ shipped
          </span>
        )}
      </div>
      {t >= EV.board && (
        <div className="pf-rise flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
          {FLEET.map((w, i) => (
            <span key={w.name} className="flex items-center gap-1.5 text-[9px]" style={{ color: C.dim }}>
              <span
                className="pf-breathe"
                style={{
                  width: 9,
                  height: 9,
                  background: C.green,
                  boxShadow: `0 0 6px ${C.green}66`,
                  display: "inline-block",
                  animationDelay: `${i * 180}ms`,
                }}
              />
              {w.name}
            </span>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <L t={t} at={EV.caption} color={C.green}>
          fleet green.
        </L>
        <L t={t} at={EV.next}>next goal queued · rate-limit hardening ↺</L>
      </div>
    </div>
  );
}

const SCENES = [PlanScene, ContextScene, ImplementScene, ReviewScene, OperateScene];

/* ── the player ─────────────────────────────────────────────────────────── */

export function ProcessSection() {
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [t, setT] = useState<number>(() => (reduced ? STAGE_FREEZE[2] : 0));
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const tRef = useRef(t);
  const epochRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Pause the clock when the section is off-viewport.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The single clock. State is elapsed ms; everything else derives from it.
  useEffect(() => {
    if (reduced || paused || !inView) return;
    let raf = 0;
    const loop = (now: number) => {
      // Re-anchor after long gaps (tab hidden, rAF throttled) so we resume
      // where we left off instead of jumping.
      if (epochRef.current === null || now - lastFrameRef.current > 500) {
        epochRef.current = now - tRef.current;
      }
      lastFrameRef.current = now;
      const next = Math.floor(((now - epochRef.current) % LOOP) / 33) * 33;
      if (next !== tRef.current) {
        tRef.current = next;
        setT(next);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      epochRef.current = null;
    };
  }, [reduced, paused, inView]);

  const seek = useCallback(
    (i: number) => {
      const target = reduced ? STAGE_FREEZE[i] : STAGE_STARTS[i];
      tRef.current = target;
      epochRef.current = null;
      setT(target);
    },
    [reduced],
  );

  const stage = stageAt(t);
  const Scene = SCENES[stage];

  return (
    <section ref={sectionRef} id="flow" className="py-24 bg-black border-y" style={{ borderColor: C.border }}>
      <style>{`
        @keyframes pf-rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
        .pf-rise { animation: pf-rise 0.35s ease-out both; }
        @keyframes pf-pop { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: scale(1); } }
        .pf-pop { animation: pf-pop 0.3s cubic-bezier(0.2, 1.4, 0.4, 1) both; display: inline-flex; }
        @keyframes pf-caret { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
        .pf-caret { animation: pf-caret 0.9s step-end infinite; }
        @keyframes pf-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        .pf-breathe { animation: pf-breathe 2.4s ease-in-out infinite; }
        @keyframes pf-bloom { from { box-shadow: 0 0 18px ${C.green}cc; } to { box-shadow: 0 0 6px ${C.green}66; } }
        .pf-bloom { animation: pf-bloom 0.9s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .pf-rise, .pf-pop, .pf-caret, .pf-breathe, .pf-bloom { animation: none; }
        }
      `}</style>
      <div className="container mx-auto px-4 max-w-6xl">
        <div className="mb-14 max-w-3xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">
            Fleet Green · the prescribed flow
          </div>
          <h2 className="text-3xl md:text-5xl font-bold mb-5">From goal to green, on rails.</h2>
          <p className="text-lg text-zinc-400 leading-relaxed">
            Agents don’t fail for lack of intelligence; they fail for lack of harness. Fleet Green is the flow we
            prescribe and GitSpace enforces: every stage has an artifact, every claim has evidence, and the strip
            tells you who needs you.
          </p>
        </div>

        {/* the viewport: one goal running the whole flow, on loop */}
        <div className="font-mono border" style={{ borderColor: C.border, background: C.bg }}>
          <div
            className="flex items-center text-[10px] px-4 gap-3"
            style={{ background: C.bar, borderBottom: `1px solid ${C.border}`, height: 38 }}
          >
            <span style={{ width: 7, height: 12, background: C.green, display: "inline-block" }} />
            <span className="font-semibold" style={{ color: C.text }}>
              GitSpace
            </span>
            <span style={{ color: C.dim }}>acme · one goal, start to shipped</span>
            <span className="ml-auto hidden sm:inline tabular-nums" style={{ color: C.dim }}>
              {STAGES[stage].num} · {STAGES[stage].name.toUpperCase()}
            </span>
            <span className="tabular-nums" style={{ color: C.ghost }}>
              {fmt(t)} / {fmt(LOOP)}
            </span>
            {!reduced && (
              <button
                onClick={() => setPaused((p) => !p)}
                aria-label={paused ? "Play the simulation" : "Pause the simulation"}
                className="px-1.5 py-0.5 hover:text-white transition-colors"
                style={{ border: `1px solid ${C.border}`, color: C.muted }}
              >
                {paused ? "▶ play" : "❚❚ pause"}
              </button>
            )}
          </div>
          <div className="relative h-[400px] md:h-[380px] overflow-hidden" style={{ background: C.bg }}>
            <div key={stage} className="pf-rise absolute inset-0 p-5 md:p-6">
              <Scene t={t} />
            </div>
          </div>
        </div>

        {/* the rail IS the scrubber: active stage lit, underline filling; click to seek */}
        <div className="mt-4 flex gap-3 overflow-x-auto pb-2 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0">
          {STAGES.map((s, i) => {
            const active = i === stage;
            const done = i < stage;
            const progress = active
              ? clamp01((t - STAGE_STARTS[i]) / (STAGE_ENDS[i] - STAGE_STARTS[i]))
              : done
                ? 1
                : 0;
            return (
              <button
                key={s.num}
                onClick={() => seek(i)}
                aria-label={`Jump to stage ${s.num}: ${s.name}`}
                aria-current={active ? "step" : undefined}
                className="group relative text-left min-w-[210px] lg:min-w-0 p-4 transition-colors duration-300"
                style={{
                  background: active ? C.surface : C.bg,
                  border: `1px solid ${active ? `${C.green}66` : C.border}`,
                  boxShadow: active ? `0 0 24px ${C.green}14` : "none",
                }}
              >
                <span
                  className="absolute top-1 right-3 text-5xl font-black select-none pointer-events-none transition-colors"
                  style={{ color: active ? "#101c14" : "#101010" }}
                >
                  {s.num}
                </span>
                <h3 className="relative text-[15px] font-bold mb-1 flex items-baseline gap-2" style={{ color: C.text }}>
                  <span className="font-mono text-[10px]" style={{ color: active || done ? C.green : C.dim }}>
                    {done ? "✓" : s.num}
                  </span>
                  {s.name}
                </h3>
                <p className="relative text-[12px] mb-3 leading-snug" style={{ color: active ? "#b9b9b9" : "#8a8a8a" }}>
                  {s.line}
                </p>
                <ul className="relative space-y-0.5 mb-3">
                  {s.proof.map((p) => (
                    <li key={p} className="text-[10px] font-mono" style={{ color: active ? C.muted : "#555555" }}>
                      · {p}
                    </li>
                  ))}
                </ul>
                <div className="relative h-0.5" style={{ background: "#141414" }}>
                  <div
                    className="h-full"
                    style={{ width: `${progress * 100}%`, background: done ? `${C.green}55` : C.green }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-8 text-center text-sm text-zinc-500">
          Every stage above is in the product today.{" "}
          <a href="/notes/babysitting-agents-sucks" className="text-green-400 hover:text-green-300">
            See stage 03 in the blog’s interactive demos →
          </a>
        </div>
      </div>
    </section>
  );
}

/**
 * The standalone ask-form section was absorbed into stage 03 of the
 * ProcessSection simulation above — the question now appears (and gets
 * answered) inside the process, where it belongs. Kept as a null export so
 * the page's import keeps working.
 */
export function AskSection() {
  return null;
}
