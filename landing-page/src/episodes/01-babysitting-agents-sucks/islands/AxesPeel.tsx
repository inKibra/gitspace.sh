import { useState } from "react";
import { cn } from "../../../lib/utils";

type S = "active" | "idle" | "closed";
type Item = { name: string; stage: "Plan" | "Code" | "Review" | "Ship"; state: S };

const ITEMS: Item[] = [
  { name: "billing-webhooks", stage: "Code", state: "active" },
  { name: "search-index", stage: "Code", state: "idle" },
  { name: "auth-refactor", stage: "Review", state: "active" },
  { name: "rate-limiter", stage: "Code", state: "idle" },
  { name: "onboarding-flow", stage: "Plan", state: "closed" },
  { name: "staging-deploy", stage: "Ship", state: "active" },
];

const STAGE: Record<string, string> = { Plan: "text-zinc-500", Code: "text-zinc-400", Review: "text-zinc-400", Ship: "text-zinc-400" };
const STATE_LABEL: Record<S, string> = { active: "active", idle: "idle · waiting on you", closed: "closed" };

export function AxesPeel() {
  const [state, setState] = useState(false);
  const [stage, setStage] = useState(false);
  const untouched = !state && !stage;

  const toggles = [
    { label: "idle vs. closed", on: state, set: setState },
    { label: "stage", on: stage, set: setStage },
  ];

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 2 · the missing columns</div>
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-zinc-400 mr-1">This list only knows “active.” Click to add the columns back:</span>
        {toggles.map((t, i) => (
          <button
            key={t.label}
            onClick={() => t.set(!t.on)}
            className={cn(
              "text-[12px] px-3 py-1.5 border font-medium transition-colors",
              t.on
                ? "border-green-500/50 text-green-400 bg-green-500/10"
                : "border-zinc-600 text-zinc-200 bg-[#0c0c0c] hover:border-zinc-400",
              untouched && i === 0 && "animate-pulse border-green-500/60 text-green-300"
            )}
          >
            {t.on ? "✓ " : "+ "}
            {t.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-[#111111] font-mono">
        {ITEMS.map((it) => {
          const dimmed = state && it.state === "closed";
          return (
            <li key={it.name} className={cn("px-4 py-3 flex items-center gap-3 transition-all duration-300", dimmed && "opacity-40")}>
              <span className="h-2.5 w-2.5 bg-zinc-600 shrink-0" />
              <span className="text-sm text-zinc-200 flex-1 truncate">{it.name}</span>
              <span
                className={cn(
                  "text-[11px] uppercase tracking-wide shrink-0 w-28 text-right",
                  !state ? "text-zinc-600" : it.state === "idle" ? "text-zinc-200" : "text-zinc-500"
                )}
              >
                {state ? STATE_LABEL[it.state] : "active"}
              </span>
              {stage && <span className={cn("text-[11px] uppercase tracking-wide shrink-0 w-14 text-right", STAGE[it.stage])}>{it.stage}</span>}
            </li>
          );
        })}
      </ul>
      <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px] text-zinc-500">
        {!state && !stage && "Right now this is the thread list: everything reads as “active.”"}
        {state && !stage && "Now you can see which agents are idle (your move) and which you’ve already closed."}
        {stage && !state && "Now you can see where each one sits in its life: plan, code, review, ship."}
        {stage && state && (
          <span>
            State and stage, restored. But notice: it’s still all words, and you’re still <span className="text-zinc-300">reading every row</span> to
            find your move. That’s the next problem.
          </span>
        )}
      </div>
      </div>
    </div>
  );
}
