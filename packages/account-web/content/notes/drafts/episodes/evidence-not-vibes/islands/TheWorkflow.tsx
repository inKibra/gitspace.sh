import { useEffect, useState } from "react";

/* The review-gated workflow, rendered in the app's own workflow grammar.
   Faithful to src/blocks/render/workflow.web.tsx: phase sections with
   source/artifact-typed dataflow (◇ artifact · ▤ source), node cards joined by
   ▶ connectors, a dashed review-GATE node, a gated-loop ↺ strip, and a phase
   gate chip that is COMPUTED, not asserted. Phase 1's gate cycles unmet →
   satisfied so you can watch it hold the phase shut until the reviewer accepts. */

const C = {
  green: "#00ff66",
  amber: "#ffcc00",
  blue: "#4488ff",
  purple: "#bc8cff",
  red: "#ff4444",
  border: "#1a1a1a",
  borderMuted: "#111111",
  borderActive: "#3a3a3a",
  bg: "#050505",
  elevated: "#080808",
  panel: "#070707",
  text: "#e6e6e6",
  muted: "#9c9c9c",
  dim: "#6a6a6a",
  ghost: "#2a2a2a",
};

type Ref = { name: string; io: "source" | "artifact" };

function RefChip({ r }: { r: Ref }) {
  const art = r.io === "artifact";
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10.5px] px-1.5 py-px border"
      style={{
        color: art ? C.purple : C.blue,
        borderColor: art ? "rgba(188,140,255,0.35)" : "rgba(68,136,255,0.3)",
        background: art ? "rgba(188,140,255,0.06)" : "rgba(68,136,255,0.05)",
      }}
    >
      <span className="text-[10px]">{art ? "◇" : "▤"}</span>
      {r.name}
    </span>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={`w-[7px] h-[7px] rounded-full flex-none ${pulse ? "animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

function NodeCard({
  title,
  dotColor,
  pulse,
  roleLabel,
  reads,
  writes,
  gate,
  running,
}: {
  title: string;
  dotColor: string;
  pulse?: boolean;
  roleLabel?: string;
  reads?: Ref[];
  writes?: Ref[];
  gate?: boolean;
  running?: boolean;
}) {
  return (
    <div
      className="border"
      style={{
        minWidth: gate ? 122 : 158,
        maxWidth: gate ? 150 : 214,
        alignSelf: gate ? "center" : undefined,
        borderStyle: gate ? "dashed" : "solid",
        borderColor: gate ? C.borderActive : running ? "rgba(0,255,102,0.4)" : C.border,
        background: gate ? "#0a0a0a" : C.elevated,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 text-[11px]"
        style={{ borderBottom: gate ? "none" : `1px solid ${C.border}` }}
      >
        <Dot color={dotColor} pulse={pulse} />
        <span className="font-medium" style={{ color: C.text }}>{title}</span>
        {roleLabel && (
          <span className="ml-auto text-[10px] font-mono" style={{ color: C.dim }}>{roleLabel}</span>
        )}
      </div>
      {reads && (
        <div className="flex items-baseline gap-1 flex-wrap px-2 py-1">
          <span className="flex-none w-[34px] text-[10.5px] uppercase tracking-[0.04em]" style={{ color: C.blue }}>reads</span>
          {reads.map((r, i) => <RefChip key={i} r={r} />)}
        </div>
      )}
      {writes && (
        <div className="flex items-baseline gap-1 flex-wrap px-2 py-1 pt-0">
          <span className="flex-none w-[34px] text-[10.5px] uppercase tracking-[0.04em]" style={{ color: C.green }}>writes</span>
          {writes.map((r, i) => <RefChip key={i} r={r} />)}
        </div>
      )}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-1.5 min-w-[62px]">
      {label && <span className="font-mono text-[10px] text-center mb-0.5" style={{ color: C.dim }}>{label}</span>}
      <span className="text-[10px]" style={{ color: C.muted }}>▶</span>
    </div>
  );
}

/** The COMPUTED phase gate chip (workflow.web.tsx PhaseGateChip). */
function GateChip({ state }: { state: "unmet" | "satisfied" | "trivial" }) {
  const base = "whitespace-nowrap text-[10.5px] px-1.5 py-px border font-mono";
  if (state === "trivial")
    return <span className={base} style={{ color: C.dim, borderColor: C.border }}>◇ gate · pending</span>;
  if (state === "satisfied")
    return <span className={base} style={{ color: C.green, borderColor: "rgba(0,255,102,0.35)" }}>✓ gate · satisfied · 2 owed</span>;
  return <span className={base} style={{ color: C.red, borderColor: C.red, background: "rgba(255,68,68,0.06)" }}>✕ gate · 2 owed, 1 unmet</span>;
}

function OutChip({ name, kind, done }: { name: string; kind: string; done: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10.5px] px-1.5 py-px border"
      style={{
        color: done ? C.text : C.muted,
        borderColor: done ? C.borderActive : C.border,
        borderLeft: `2px solid ${C.blue}`,
        background: "#0a0a0a",
        opacity: done ? 1 : 0.55,
      }}
    >
      <span className="text-[10px]" style={{ color: C.blue }}>▤</span>
      {name}
      <span className="text-[10.5px] uppercase" style={{ color: C.dim }}>{kind}</span>
    </span>
  );
}

export function TheWorkflow() {
  // Phase-1 gate cycles unmet → (loop runs) → satisfied, then resets.
  const [pass, setPass] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setPass((p) => !p), 3400);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest mb-2" style={{ color: "rgba(0,255,102,0.7)" }}>
        demo · the review-gated workflow
      </div>
      <div className="border p-3" style={{ borderColor: C.border, background: C.bg }}>
        {/* head: recipe · traversal · io key */}
        <div
          className="flex items-center gap-2 flex-wrap px-3 py-2 mb-3 border text-[11px]"
          style={{ borderColor: C.border, background: C.elevated, color: C.muted }}
        >
          <Dot color={C.green} pulse />
          <span className="font-medium" style={{ color: C.text }}>review-gated-implementation</span>
          <span className="text-[10.5px]" style={{ color: C.dim }}>
            traversal of <span className="font-mono" style={{ color: C.green }}>recipes/review-gated.recipe.md</span>
          </span>
          <span className="grow" />
          <span className="inline-flex gap-1.5">
            <RefChip r={{ name: "artifact", io: "artifact" }} />
            <RefChip r={{ name: "source", io: "source" }} />
          </span>
        </div>

        {/* PHASE 1 — the animated review gate */}
        <div className="border" style={{ borderColor: C.border }}>
          <div className="flex items-center gap-2 flex-wrap px-3 py-2" style={{ background: C.elevated, borderBottom: `1px solid ${C.border}` }}>
            <span className="text-[10.5px] uppercase tracking-[0.1em]" style={{ color: C.dim }}>phase 1</span>
            <span className="text-[12.5px] font-medium" style={{ color: C.text }}>remove-api</span>
            <span className="ml-auto"><GateChip state={pass ? "satisfied" : "unmet"} /></span>
          </div>
          {/* inputs */}
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
            <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em]" style={{ color: C.dim }}>in</span>
            <RefChip r={{ name: "flags.ts", io: "source" }} />
            <RefChip r={{ name: "checkout-rubric", io: "artifact" }} />
          </div>
          {/* node flow: implementer ▶ evidence ▶ review gate */}
          <div className="flex items-center flex-wrap px-3 py-3">
            <NodeCard
              title="implementer"
              roleLabel="build role"
              dotColor={pass ? C.green : C.green}
              pulse={!pass}
              running={!pass}
              writes={[{ name: "flags.ts", io: "source" }, { name: "totals.test.ts", io: "source" }]}
            />
            <Arrow label="evidence packet" />
            <NodeCard
              title="review-gate"
              gate
              roleLabel="orchestration"
              dotColor={pass ? C.green : C.red}
            />
          </div>
          {/* gated loop */}
          <div
            className="flex items-center gap-2 mx-3 mb-3 px-2.5 py-1.5 border text-[11px]"
            style={{
              background: pass ? "rgba(255,204,0,0.02)" : "rgba(255,204,0,0.06)",
              borderColor: C.border,
              borderLeft: `2px solid ${C.amber}`,
              color: C.muted,
              opacity: pass ? 0.5 : 1,
            }}
          >
            <span className={`text-[14px] ${pass ? "" : "animate-spin"}`} style={{ color: C.amber, display: "inline-block" }}>↺</span>
            <span>gated loop — reviewer refutes, implementer fixes, re-review</span>
            <span className="ml-auto text-[10px]">exit owned by <b className="font-medium" style={{ color: C.amber }}>review-gate</b></span>
          </div>
          {/* created artifacts */}
          <div className="flex items-center gap-[7px] flex-wrap px-[11px] py-2" style={{ borderTop: `1px solid ${C.borderMuted}`, background: "rgba(188,140,255,0.03)" }}>
            <span className="flex-none text-[10px] uppercase tracking-[0.08em]" style={{ color: C.purple }}>artifacts</span>
            <span className="inline-flex items-center gap-[7px] border px-2 py-[3px] text-[11px]" style={{ borderColor: C.border, borderLeft: `2px solid ${C.purple}`, background: "#0a0a0a" }}>
              <span className="text-[10.5px] uppercase tracking-[0.04em]" style={{ color: C.purple }}>rubric</span>
              <span style={{ color: C.text }}>checkout-rubric</span>
              <span className="text-[10px]" style={{ color: C.blue }}>→ review-gate</span>
            </span>
          </div>
          {/* outputs */}
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5" style={{ borderTop: `1px solid ${C.borderMuted}` }}>
            <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em]" style={{ color: C.dim }}>out</span>
            <OutChip name="R1 checkout suite passes" kind="test-output" done={pass} />
            <OutChip name="R3 checkout_v2 gone" kind="test-output" done={pass} />
          </div>
        </div>

        {/* dataflow connector */}
        <div className="flex items-center gap-2 px-3 py-2 text-[10.5px] font-mono" style={{ color: C.dim }}>
          <span style={{ color: C.green }}>▼</span>
          dataflow · R1 checkout suite passes, R3 checkout_v2 gone
        </div>

        {/* PHASE 2 — waiting on phase 1's gate */}
        <div className="border" style={{ borderColor: C.border, opacity: 0.9 }}>
          <div className="flex items-center gap-2 flex-wrap px-3 py-2" style={{ background: C.elevated, borderBottom: `1px solid ${C.border}` }}>
            <span className="text-[10.5px] uppercase tracking-[0.1em]" style={{ color: C.dim }}>phase 2</span>
            <span className="text-[12.5px] font-medium" style={{ color: C.text }}>swap-callers</span>
            <span className="ml-auto"><GateChip state="trivial" /></span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
            <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em]" style={{ color: C.dim }}>in</span>
            <RefChip r={{ name: "R1 checkout suite passes", io: "source" }} />
          </div>
          <div className="flex items-center flex-wrap px-3 py-3">
            <NodeCard title="implementer" roleLabel="build role" dotColor={C.dim} />
            <Arrow label="evidence packet" />
            <NodeCard title="review-gate" gate roleLabel="human" dotColor={C.dim} />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5" style={{ borderTop: `1px solid ${C.borderMuted}` }}>
            <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em]" style={{ color: C.dim }}>out</span>
            <OutChip name="R2 checkout renders" kind="screenshot" done={false} />
          </div>
        </div>
      </div>
    </div>
  );
}
