import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

/**
 * Demo 2 · promote → rollup, the two moves that build the record.
 *
 * Promote: a typeless local:// draft gains a typed path (that is the moment
 * the product can see it). Rollup: the workspace's artifacts branch merges
 * into main; the goal folder arrives intact, nothing moves, nothing renamed.
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

type Step = "draft" | "promoted" | "rolling" | "rolled";

const TREE: Array<{ path: string; tag: string }> = [
  { path: "goal.md · rubric.json", tag: "goal canon" },
  { path: "ops.dashboard.json", tag: "▦ dashboard" },
  { path: "data/rollout.data.json", tag: "feeds the board" },
  { path: "triggers/nightly.trigger.json", tag: "◷ every 1 d" },
];

export function PromoteRollup() {
  const [step, setStep] = useState<Step>("draft");
  const [merge, setMerge] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  function promote() {
    if (step !== "draft") return;
    setStep("promoted");
  }
  function rollup() {
    if (step !== "promoted") return;
    setStep("rolling");
    // let the bar transition from 0 → 100 on the next frame
    timers.current.push(window.setTimeout(() => setMerge(1), 30));
    later(1100, () => setStep("rolled"));
  }
  function reset() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setMerge(0);
    setStep("draft");
  }

  const promoted = step !== "draft";

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 2 · promote, then roll up</div>
      <div className="font-mono border" style={{ borderColor: C.border, background: C.bg }}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ background: C.bar, borderBottom: `1px solid ${C.border}` }}>
          <span className="text-[12px] font-sans" style={{ color: C.muted }}>
            {step === "draft" && "The board is still a scratch draft. Promote it."}
            {step === "promoted" && "Typed and visible. Now carry the folder to main."}
            {step === "rolling" && "Merging the artifacts branch…"}
            {step === "rolled" && "On main. The workspace can die now; the record stays."}
          </span>
          <button
            onClick={reset}
            className="ml-auto flex items-center gap-1 text-[12px] py-2 pl-2 -my-1 transition-colors hover:text-zinc-200"
            style={{ color: C.dim }}
          >
            <RotateCcw className="w-3 h-3" /> reset
          </button>
        </div>

        <div className="p-4 sm:p-5">
          {/* the goal folder */}
          <div className="text-[10px] mb-2" style={{ color: C.dim }}>
            goals/remove-checkout-v2/{" "}
            <span style={{ color: C.ghost }}>· branch: artifacts/remove-checkout-v2</span>
          </div>
          <div className="space-y-1 text-[11px]">
            {TREE.map((f) => (
              <div key={f.path} className="flex items-center gap-2 pl-3">
                <span style={{ color: C.ghost }}>·</span>
                <span style={{ color: C.muted }}>{f.path}</span>
                <span className="text-[9px]" style={{ color: C.ghost }}>
                  {f.tag}
                </span>
              </div>
            ))}
            {/* the draft ↔ typed row */}
            <div className="flex flex-wrap items-center gap-2 pl-3 min-h-[28px]">
              <span style={{ color: C.ghost }}>·</span>
              {promoted ? (
                <>
                  <span style={{ color: C.green }}>apps/ops-board.gssh.html</span>
                  <span className="text-[9px]" style={{ color: C.ghost }}>
                    mini-app · sandboxed
                  </span>
                </>
              ) : (
                <>
                  <span style={{ color: C.dim, fontStyle: "italic" }}>local://board-draft.html</span>
                  <span className="text-[9px]" style={{ color: C.ghost }}>
                    scratch · typeless · invisible to the product
                  </span>
                  <button
                    onClick={promote}
                    className="text-[10px] px-2.5 py-1.5 transition-colors hover:bg-[#101010] active:scale-[0.96]"
                    style={{ color: C.text, border: `1px solid ${C.border}`, transitionProperty: "background-color, transform" }}
                  >
                    promote ▸
                  </button>
                </>
              )}
            </div>
          </div>

          {/* command echo */}
          <div className="mt-3 space-y-1 text-[11px] min-h-[2.5rem]">
            {promoted && (
              <div className="flex gap-2">
                <span style={{ color: C.ghost }}>sys ▸</span>
                <span className="truncate" style={{ color: C.muted }}>
                  space artifacts promote local://board-draft.html{" "}
                  <span style={{ color: C.green }}>→</span> apps/ops-board.gssh.html
                </span>
              </div>
            )}
            {(step === "rolling" || step === "rolled") && (
              <div className="flex gap-2">
                <span style={{ color: C.ghost }}>sys ▸</span>
                <span style={{ color: C.muted }}>gssh artifacts rollup remove-checkout-v2</span>
              </div>
            )}
          </div>

          {/* rollup bar */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            {step === "promoted" ? (
              <button
                onClick={rollup}
                className="text-[11px] px-3 py-2 transition-colors hover:bg-[#101010] active:scale-[0.96]"
                style={{ color: C.text, border: `1px solid ${C.border}`, transitionProperty: "background-color, transform" }}
              >
                roll up to main ▸
              </button>
            ) : (
              <>
                <span style={{ color: C.dim }}>rollup:</span>
                <span style={{ color: C.muted }}>artifacts/remove-checkout-v2</span>
                <span className="relative h-0.5 w-16 sm:w-24" style={{ background: "#1f1f1f", flex: "none" }}>
                  <span
                    className="absolute left-0 top-0 h-full transition-[width] duration-1000 ease-out"
                    style={{ width: `${merge * 100}%`, background: C.green }}
                  />
                </span>
                <span style={{ color: step === "rolled" ? C.green : C.dim }}>main</span>
                {step === "rolled" && <span style={{ color: C.green }}>✓</span>}
              </>
            )}
            {step === "rolled" && (
              <span className="basis-full text-[10px] mt-1 font-sans" style={{ color: C.muted }}>
                The folder arrives intact at goals/remove-checkout-v2/ on main. Nothing moves, nothing renamed, every
                reference keeps resolving.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
