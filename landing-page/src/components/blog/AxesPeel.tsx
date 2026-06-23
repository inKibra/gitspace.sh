import { useState } from "react";
import { cn } from "../../lib/utils";

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
const STATE_LABEL: Record<S, string> = { active: "active", idle: "idle · your move", closed: "closed" };

export function AxesPeel() {
  const [state, setState] = useState(false);
  const [stage, setStage] = useState(false);

  const toggles = [
    { label: "Idle vs. closed", on: state, set: setState },
    { label: "Stage", on: stage, set: setStage },
  ];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-zinc-500 mr-1">The list only knows “active.” Add back what it collapses:</span>
        {toggles.map((t) => (
          <button
            key={t.label}
            onClick={() => t.set(!t.on)}
            className={cn(
              "text-[12px] px-2.5 py-1 rounded-full border transition-colors",
              t.on ? "border-green-500/50 text-green-400 bg-green-500/10" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            )}
          >
            {t.on ? "– " : "+ "}
            {t.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-zinc-900 font-mono">
        {ITEMS.map((it) => {
          const dimmed = state && it.state === "closed";
          return (
            <li key={it.name} className={cn("px-4 py-3 flex items-center gap-3 transition-all duration-300", dimmed && "opacity-40")}>
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-600 shrink-0" />
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
      <div className="px-4 py-3 border-t border-zinc-800 text-[12px] text-zinc-500">
        {!state && !stage && "Right now this is the thread list: everything reads as “active.”"}
        {state && !stage && "Now you can see which agents are idle (your move) and which you’ve already closed."}
        {stage && "…and where each one sits in its life: plan, code, review, ship."}
      </div>
    </div>
  );
}
