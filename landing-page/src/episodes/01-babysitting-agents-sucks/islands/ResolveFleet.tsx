import { useState } from "react";
import { Zap, RotateCcw } from "lucide-react";
import { cn } from "../../lib/utils";

type Status = "green" | "blue" | "amber";
type Agent = { name: string; s: Status };

const INIT: Agent[] = [
  { name: "billing-webhooks", s: "amber" },
  { name: "search-index", s: "blue" },
  { name: "auth-refactor", s: "green" },
  { name: "mobile-nav", s: "green" },
  { name: "rate-limiter", s: "amber" },
  { name: "staging-deploy", s: "blue" },
  { name: "csv-export", s: "green" },
];

const DOT: Record<Status, string> = { green: "bg-green-500", blue: "bg-blue-500", amber: "bg-amber-400" };
const HINT: Record<Status, string> = { green: "", blue: "your move →", amber: "answer →" };

export function ResolveFleet() {
  const [fleet, setFleet] = useState<Agent[]>(INIT);
  const [bar, setBar] = useState(true);

  const greenN = fleet.filter((f) => f.s === "green").length;
  const pct = Math.round((greenN / fleet.length) * 100);
  const allGreen = greenN === fleet.length;

  function resolve(i: number) {
    setFleet((f) => f.map((x, j) => (j === i ? { ...x, s: "green" } : x)));
  }
  function reset() {
    setFleet(INIT);
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        <span className="text-[12px] text-zinc-500">Resolve the fleet — answer the amber escalations, pick up the idle blues.</span>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-zinc-400 cursor-pointer select-none">
          <input type="checkbox" checked={bar} onChange={(e) => setBar(e.target.checked)} className="accent-green-500" />
          show color
        </label>
        <button onClick={reset} className="text-[12px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
          <RotateCcw className="w-3 h-3" /> reset
        </button>
      </div>

      <div className="p-4 flex flex-wrap gap-2">
        {fleet.map((a, i) => (
          <button
            key={a.name}
            onClick={() => a.s !== "green" && resolve(i)}
            disabled={a.s === "green"}
            className={cn(
              "group flex items-center gap-2 px-2.5 py-1.5 rounded text-sm font-mono transition-colors",
              a.s === "green" ? "bg-zinc-900/60 cursor-default" : "bg-zinc-900 hover:bg-zinc-800 cursor-pointer",
              bar && a.s === "amber" && "ring-1 ring-amber-400/40"
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                bar ? DOT[a.s] : "bg-zinc-600",
                bar && a.s === "green" && "shadow-[0_0_6px] shadow-green-500/60"
              )}
            />
            <span className={cn(bar && a.s === "amber" ? "text-amber-300" : "text-zinc-400")}>{a.name}</span>
            {bar && a.s === "amber" && <Zap className="w-3.5 h-3.5 text-amber-400" />}
            {a.s !== "green" && (
              <span className="text-[10px] text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">{HINT[a.s]}</span>
            )}
          </button>
        ))}
      </div>

      {/* health meter */}
      <div className="px-4 pb-4">
        <div className="flex items-center justify-between text-[12px] mb-1.5">
          <span className="text-zinc-500">Fleet health</span>
          <span className={cn("tabular-nums", allGreen ? "text-green-400" : "text-zinc-400")}>{pct}% green</span>
        </div>
        <div className="h-2 rounded-full bg-zinc-900 overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-500"
            style={{ width: `${pct}%`, boxShadow: allGreen ? "0 0 12px rgba(34,197,94,0.6)" : "none" }}
          />
        </div>
        <div className="mt-2 text-[12px]">
          {allGreen ? (
            <span className="text-green-400">Fleet green. Fully utilized, fully attended. That’s the whole game.</span>
          ) : bar ? (
            <span className="text-zinc-500">One goal, one color. You always know what’s next.</span>
          ) : (
            <span className="text-zinc-500">Without color it’s just names — which one needs you?</span>
          )}
        </div>
      </div>
    </div>
  );
}
