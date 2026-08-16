import { useState } from "react";
import { Play, RotateCcw, ArrowRight } from "lucide-react";
import { cn } from "../../../lib/utils";

type Row = { name: string; recency: string; idle: boolean };
type Phase = "introW" | "runW" | "introC" | "runC" | "done";

const NAMES = [
  "billing-webhooks", "search-index", "auth-refactor", "rate-limiter", "mobile-nav", "csv-export", "onboarding-flow", "staging-deploy",
  "payment-retries", "webhook-replay", "user-merge", "feature-flags", "image-resize", "email-digest", "audit-log", "session-cache",
];
const RECENCY = ["1m", "3m", "6m", "11m", "18m", "24m", "37m", "52m", "1h", "1h", "2h", "3h", "5h", "8h", "1d", "2d"];

// Fresh random target every round, anywhere in the list — so you have to scan
// (and often scroll) for it, and can never just remember where it was.
function makeList(): Row[] {
  const target = Math.floor(Math.random() * NAMES.length);
  return NAMES.map((name, i) => ({ name, recency: `${RECENCY[i]} ago`, idle: i === target }));
}

function Stat({ label, value, active, tone }: { label: string; value?: number; active: boolean; tone: "words" | "color" }) {
  const has = value != null;
  return (
    <div className="bg-[#050505] px-4 py-4">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      <div
        className={cn(
          "text-3xl font-semibold tabular-nums transition-colors",
          !has && !active && "text-zinc-700",
          active && "text-zinc-500 animate-pulse",
          has && (tone === "color" ? "text-blue-400" : "text-zinc-100")
        )}
      >
        {active ? "timing…" : has ? `${value!.toFixed(2)}s` : "—"}
      </div>
    </div>
  );
}

export function WordsVsColor() {
  const [phase, setPhase] = useState<Phase>("introW");
  const [list, setList] = useState<Row[]>(makeList);
  const [start, setStart] = useState<number | null>(null);
  const [times, setTimes] = useState<{ words?: number; color?: number }>({});

  const armed = phase === "runW" || phase === "runC";
  const mode = phase === "introW" || phase === "runW" ? "words" : "color";

  function startWords() {
    setList(makeList());
    setTimes({});
    setStart(performance.now());
    setPhase("runW");
  }
  function startColor() {
    setList(makeList());
    setStart(performance.now());
    setPhase("runC");
  }
  function reset() {
    setTimes({});
    setStart(null);
    setList(makeList());
    setPhase("introW");
  }
  function pick(r: Row) {
    if (!armed || !r.idle) return;
    const dt = Math.round(((performance.now() - (start as number)) / 1000) * 100) / 100;
    setStart(null);
    if (phase === "runW") {
      setTimes((t) => ({ ...t, words: dt }));
      setPhase("introC");
    } else {
      setTimes((t) => ({ ...t, color: dt }));
      setPhase("done");
    }
  }

  const factor = times.words && times.color ? times.words / times.color : null;

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 3 · reading vs. seeing</div>
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
      {/* header */}
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
        <span className="text-sm text-zinc-300 font-medium">Same list, timed twice</span>
        {(times.words != null || times.color != null) && (
          <button onClick={reset} className="text-[12px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> reset
          </button>
        )}
      </div>

      {/* the two times — the whole point */}
      <div className="grid grid-cols-2 gap-px bg-[#1a1a1a]">
        <Stat label="Reading the words" value={times.words} active={phase === "runW"} tone="words" />
        <Stat label="Spotting the color" value={times.color} active={phase === "runC"} tone="color" />
      </div>

      {/* the list — same shape as the thread sidebar, gated behind a frosted overlay */}
      <div className="relative border-t border-[#1a1a1a]">
        <div className={cn("h-[280px] overflow-y-auto divide-y divide-[#111111]", !armed && "overflow-hidden pointer-events-none")}>
          {list.map((r) => (
            <button key={r.name} onClick={() => pick(r)} className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-[#0c0c0c] transition-colors">
              <span className="w-12 shrink-0 flex items-center">
                {mode === "color" ? (
                  <span className={cn("h-2.5 w-2.5", r.idle ? "bg-blue-500" : "bg-green-500")} />
                ) : (
                  // same neutral styling for every row — you have to read it
                  <span className="font-mono text-[11px] text-zinc-400">{r.idle ? "idle" : "active"}</span>
                )}
              </span>
              <span className="font-mono text-sm text-zinc-300 flex-1 truncate">{r.name}</span>
              <span className="text-[11px] text-zinc-600 tabular-nums shrink-0">{r.recency}</span>
            </button>
          ))}
        </div>

        {!armed && (
          <div className="absolute inset-0 flex items-center justify-center backdrop-blur-md bg-[#050505]/55 p-4 text-center">
            {phase === "introW" && (
              <button onClick={startWords} className="group flex flex-col items-center gap-2">
                <span className="flex items-center gap-2 px-4 py-2.5 border border-white/10 bg-white/10 text-zinc-100 text-sm font-medium shadow-lg group-hover:bg-white/[0.16] transition-colors">
                  <Play className="w-4 h-4 text-green-400 fill-green-400" /> Click to find the idle agent
                </span>
                <span className="text-[12px] text-zinc-400">Scroll the list and read each row. Timer starts on click.</span>
              </button>
            )}
            {phase === "introC" && (
              <button onClick={startColor} className="group flex flex-col items-center gap-3 max-w-sm">
                <span className="text-zinc-300 text-sm">
                  <span className="text-zinc-100 font-semibold tabular-nums">{times.words?.toFixed(2)}s</span> reading. Same list, same idle agent; now
                  <span className="text-blue-300"> don’t read.</span>
                </span>
                <span className="flex items-center gap-2 px-4 py-2.5 border border-blue-400/30 bg-blue-500/15 text-blue-200 text-sm font-medium shadow-lg group-hover:bg-blue-500/25 transition-colors">
                  Spot it by color <ArrowRight className="w-4 h-4" />
                </span>
              </button>
            )}
            {phase === "done" && (
              <div className="flex flex-col items-center gap-3 max-w-md">
                <div className="text-lg text-zinc-100">
                  <span className="tabular-nums text-zinc-300">{times.words?.toFixed(2)}s</span> reading{" "}
                  <ArrowRight className="inline w-4 h-4 text-zinc-600" /> <span className="tabular-nums text-blue-400 font-semibold">{times.color?.toFixed(2)}s</span> by color
                </div>
                {factor && factor > 1.1 && <div className="text-3xl font-bold text-green-400">{factor.toFixed(1)}× faster</div>}
                <p className="text-[13px] text-zinc-400 leading-relaxed">
                  Sixteen rows and you already feel it. A real fleet is a sidebar you scroll forever, and reading every name doesn’t keep up. Color does.
                  That’s the whole reason the bar works.
                </p>
                <button onClick={reset} className="text-[12px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 mt-1">
                  <RotateCcw className="w-3 h-3" /> play again
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* contextual line while playing */}
      {armed && (
        <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px] text-zinc-500">
          {mode === "words" ? "Scroll and read: find the row that says “idle.”" : "Scroll if you must, just spot the blue dot."}
        </div>
      )}
      </div>
    </div>
  );
}
