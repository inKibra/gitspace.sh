import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

/**
 * Demo 1 · "the morning after" — the ops dashboard a shipped goal left behind.
 *
 * Beat 1: the reader fires the nightly cron. Stale tiles (updated 8h ago)
 *         refresh; a mono line shows the data commit rolling up to main.
 * Beat 2: the reader advances a day. The cron fires again, error rate crosses
 *         the rubric threshold, the tile flips amber, and the shipped goal
 *         card beneath REOPENS with the original rubric line quoted as the
 *         reason. The rubric that shipped it is the tripwire that reopens it.
 *
 * Visual language: product hexes + square corners + 1px hairlines, matching
 * the homepage OperateScene (SITE-THESIS design-language migration rule).
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

const RUBRIC_LINE = "R2 · error rate stays ≤ 0.10% in production";

type Tile = { label: string; stale: string; fresh: string; day2: string; day2Bad?: boolean };
const TILES: Tile[] = [
  { label: "error rate", stale: "0.02%", fresh: "0.00%", day2: "0.41%", day2Bad: true },
  { label: "canary", stale: "clean", fresh: "clean ✓", day2: "clean ✓" },
  { label: "rollout", stale: "62%", fresh: "100%", day2: "100%" },
  { label: "p95", stale: "214ms", fresh: "186ms", day2: "189ms" },
];

// stale → tick1 → fresh → tick2 → degraded → reopened
type Phase = "stale" | "tick1" | "fresh" | "tick2" | "degraded" | "reopened";

export function MorningAfter() {
  const [phase, setPhase] = useState<Phase>("stale");
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const day2 = phase === "tick2" || phase === "degraded" || phase === "reopened";
  const ticking = phase === "tick1" || phase === "tick2";
  const refreshed = phase !== "stale" && phase !== "tick1";
  const reopened = phase === "reopened";

  function runCron() {
    if (phase !== "stale") return;
    setPhase("tick1");
    later(900, () => setPhase("fresh"));
  }
  function advanceDay() {
    if (phase !== "fresh") return;
    setPhase("tick2");
    later(900, () => setPhase("degraded"));
    later(2100, () => setPhase("reopened"));
  }
  function reset() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase("stale");
  }

  const tileValue = (t: Tile) => (phase === "stale" || phase === "tick1" ? t.stale : day2 && phase !== "tick2" ? t.day2 : t.fresh);
  const tileColor = (t: Tile) => {
    if (phase === "stale" || phase === "tick1") return C.muted;
    if (t.day2Bad && (phase === "degraded" || phase === "reopened")) return C.amber;
    return C.green;
  };

  return (
    <div>
      <style>{`
        @keyframes ma-pop { from { opacity: 0; transform: scale(0.86); } to { opacity: 1; transform: scale(1); } }
        @keyframes ma-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .ma-pop { animation: ma-pop 0.35s cubic-bezier(0.2, 0, 0, 1) both; }
        .ma-rise { animation: ma-rise 0.4s cubic-bezier(0.2, 0, 0, 1) both; }
        @media (prefers-reduced-motion: reduce) { .ma-pop, .ma-rise { animation: none; } }
      `}</style>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 1 · the morning after</div>
      <div className="font-mono border" style={{ borderColor: C.border, background: C.bg }}>
        {/* instruction bar */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ background: C.bar, borderBottom: `1px solid ${C.border}` }}>
          <span className="text-[12px] font-sans" style={{ color: C.muted }}>
            {phase === "stale" && "The goal shipped yesterday. Fire the nightly cron."}
            {(phase === "tick1" || phase === "fresh") && "Fresh numbers, committed and rolled up. Now advance a day."}
            {day2 && !reopened && "The cron ran again. Read the error tile."}
            {reopened && "Production disagreed with the rubric. The goal is back."}
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
          {/* dashboard card */}
          <div style={{ border: `1px solid ${C.border}`, background: C.surface }}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
              <span className="text-[9px] tracking-[0.16em]" style={{ color: C.dim }}>
                ▦ OPS DASHBOARD
              </span>
              <span className="text-[9px] hidden sm:inline" style={{ color: C.ghost }}>
                goals/remove-checkout-v2/ops.dashboard.json
              </span>
              <button
                onClick={runCron}
                disabled={phase !== "stale"}
                className={`text-[10px] px-2 py-1.5 transition-colors ${ticking ? "animate-pulse" : ""} ${
                  phase === "stale" ? "cursor-pointer hover:bg-[#0c1420] active:scale-[0.96]" : "cursor-default"
                }`}
                style={{
                  color: C.blue,
                  border: `1px solid ${C.blue}${phase === "stale" ? "88" : "44"}`,
                  boxShadow: ticking ? `0 0 10px ${C.blue}66` : phase === "stale" ? `0 0 8px ${C.blue}33` : "none",
                  transitionProperty: "background-color, transform",
                }}
              >
                ◷ cron · nightly{phase === "stale" && <span style={{ color: C.text }}> · run ▸</span>}
              </button>
              <span
                key={String(refreshed) + String(day2)}
                className="ma-pop ml-auto text-[9px] tabular-nums"
                style={{ color: refreshed ? C.green : C.ghost }}
              >
                {refreshed ? "updated just now" : "updated 8h ago"}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px" style={{ background: C.borderMuted }}>
              {TILES.map((t, i) => {
                const bad = t.day2Bad && (phase === "degraded" || phase === "reopened");
                return (
                  <div key={t.label} className="px-3 py-2.5" style={{ background: bad ? "#100c00" : C.bg }}>
                    <div className="text-[8.5px] uppercase tracking-wider" style={{ color: bad ? `${C.amber}99` : C.ghost }}>
                      {t.label}
                    </div>
                    <div
                      key={tileValue(t)}
                      className="ma-pop text-[15px] tabular-nums"
                      style={{ color: tileColor(t), animationDelay: `${i * 90}ms` }}
                    >
                      {tileValue(t)}
                    </div>
                    {bad && (
                      <div className="ma-rise text-[8px] mt-0.5" style={{ color: `${C.amber}bb` }}>
                        rubric: ≤ 0.10%
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* cron log */}
          <div className="mt-3 space-y-1 text-[11px] min-h-[3.25rem]">
            {refreshed && (
              <div className="ma-rise flex gap-2">
                <span style={{ color: C.ghost }}>sys ▸</span>
                <span style={{ color: C.muted }}>
                  data/rollout.data.json refreshed <span style={{ color: C.green }}>→</span> rolled up to main
                </span>
              </div>
            )}
            {(phase === "degraded" || phase === "reopened") && (
              <div className="ma-rise flex gap-2" style={{ animationDelay: "250ms" }}>
                <span style={{ color: `${C.amber}99` }}>⚠</span>
                <span style={{ color: C.amber }}>R2 breached: error rate 0.41% &gt; 0.10% · reopening goal</span>
              </div>
            )}
          </div>

          {/* the shipped goal card */}
          <div
            className="mt-3 p-4 transition-colors duration-500"
            style={{
              background: C.surface,
              border: `1px solid ${reopened ? `${C.amber}66` : C.border}`,
              boxShadow: reopened ? `0 0 20px ${C.amber}18` : "none",
              transitionProperty: "border-color, box-shadow",
            }}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span
                className="inline-block transition-colors duration-500"
                style={{
                  width: 9,
                  height: 9,
                  background: reopened ? C.amber : C.green,
                  boxShadow: `0 0 6px ${(reopened ? C.amber : C.green) + "66"}`,
                  transitionProperty: "background-color, box-shadow",
                }}
              />
              <span className="text-[13px]" style={{ color: C.text }}>
                remove-checkout-v2
              </span>
              <span className="text-[10px] hidden sm:inline" style={{ color: C.dim }}>
                goals/remove-checkout-v2/ · on main
              </span>
              <span
                key={String(reopened)}
                className="ma-pop ml-auto text-[10px] px-1.5 py-0.5"
                style={
                  reopened
                    ? { color: C.amber, border: `1px solid ${C.amber}55` }
                    : { color: C.green, border: `1px solid ${C.green}55` }
                }
              >
                {reopened ? "⟲ reopened · regression" : "✓ shipped"}
              </span>
            </div>
            {reopened && (
              <div className="ma-rise mt-3 pl-3" style={{ borderLeft: `2px solid ${C.amber}88` }}>
                <div className="text-[9px] uppercase tracking-[0.16em] mb-1" style={{ color: `${C.amber}99` }}>
                  reopened because · rubric.json
                </div>
                <div className="text-[11.5px]" style={{ color: C.text }}>
                  “{RUBRIC_LINE}”
                </div>
                <div className="text-[10px] mt-1 tabular-nums" style={{ color: C.dim }}>
                  measured 0.41% · nightly cron · data/rollout.data.json
                </div>
              </div>
            )}
          </div>

          {/* advance-a-day control */}
          <div className="mt-4 flex items-center gap-3">
            <span className="text-[10px] tabular-nums" style={{ color: C.dim }}>
              {day2 ? "day 2" : "day 1 · the morning after"}
            </span>
            {phase === "fresh" && (
              <button
                onClick={advanceDay}
                className="ma-pop text-[11px] px-3 py-2 transition-colors hover:bg-[#101010] active:scale-[0.96]"
                style={{ color: C.text, border: `1px solid ${C.border}`, transitionProperty: "background-color, transform" }}
              >
                advance a day ▸
              </button>
            )}
            {reopened && (
              <span className="ma-rise text-[10px] font-sans" style={{ color: C.muted }}>
                Same folder, same evidence, same rubric. The next agent starts with the whole record.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
