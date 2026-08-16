import { useState } from "react";
import { Zap, MousePointerClick, Check, Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

type State = "active" | "idle" | "closed" | "amber";
type WS = { id: string; name: string; recency: string; state: State };

// Sorted by recency, most-recent first — how a thread list presents them.
// In Codex these all read the same: spinning, or not. The target is the IDLE one.
const FLEET: WS[] = [
  { id: "billing-webhooks", name: "billing-webhooks", recency: "2m ago", state: "active" },
  { id: "search-index", name: "search-index", recency: "6m ago", state: "idle" }, // target
  { id: "auth-refactor", name: "auth-refactor", recency: "14m ago", state: "active" },
  { id: "rate-limiter", name: "rate-limiter", recency: "31m ago", state: "amber" },
  { id: "mobile-nav", name: "mobile-nav", recency: "48m ago", state: "active" },
  { id: "csv-export", name: "csv-export", recency: "1h ago", state: "closed" },
  { id: "onboarding-flow", name: "onboarding-flow", recency: "2h ago", state: "active" },
  { id: "staging-deploy", name: "staging-deploy", recency: "yesterday", state: "active" },
];

const DOT: Record<State, string> = { active: "bg-green-500", idle: "bg-blue-500", closed: "bg-zinc-600", amber: "bg-amber-400" };
const WRONG: Record<State, string> = { active: "still working…", closed: "you closed this", amber: "asked you a question", idle: "" };

export function FindTheOne() {
  const [tried, setTried] = useState<string[]>([]);
  const [found, setFound] = useState(false);
  const [revealed, setRevealed] = useState(false);

  function clickRow(w: WS) {
    if (found) return;
    if (w.state === "idle") {
      setFound(true);
      setRevealed(true);
    } else if (!tried.includes(w.id)) {
      setTried((t) => [...t, w.id]);
    }
  }

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 1 · the problem</div>
      <div className="grid md:grid-cols-2 gap-4">
      {/* Codex thread list — spinning, or not. Stopped rows are indistinguishable. */}
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">Codex</span>
          <span className="text-[11px] text-zinc-600 uppercase tracking-wider">Recent threads</span>
        </div>
        {/* the task, where the eye starts — not buried in the footer */}
        {!found && (
          <div className="px-4 py-2 border-b border-[#1a1a1a] bg-blue-500/5 text-[12px] text-zinc-300 flex items-center gap-2">
            <MousePointerClick className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>
              Three agents have stopped spinning. One is <span className="text-blue-300">idle, waiting on you</span>. Click it.
            </span>
          </div>
        )}
        <ul className="divide-y divide-[#111111]">
          {FLEET.map((w) => {
            const isTried = tried.includes(w.id);
            const hit = found && w.state === "idle";
            return (
              <li key={w.id}>
                <button
                  onClick={() => clickRow(w)}
                  disabled={found}
                  className={cn("w-full text-left px-4 py-3 flex items-center gap-3 transition-colors", !found && "hover:bg-[#0c0c0c]", hit && "bg-blue-500/10")}
                >
                  {w.state === "active" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500 shrink-0" />
                  ) : (
                    <span className="h-2 w-2 bg-zinc-600 shrink-0" />
                  )}
                  <span className={cn("font-mono text-sm flex-1 truncate", isTried ? "text-zinc-600 line-through" : "text-zinc-200")}>{w.name}</span>
                  {isTried && <span className="text-[11px] text-zinc-600 shrink-0">{WRONG[w.state]}</span>}
                  {hit && (
                    <span className="text-[11px] text-blue-400 flex items-center gap-1 shrink-0">
                      <Check className="w-3 h-3" /> idle · waiting on you
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-600 tabular-nums w-20 text-right shrink-0">{w.recency}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px] text-zinc-500">
          {found ? (
            <span>
              Found it, after <span className="text-zinc-300">{tried.length + 1}</span> click{tried.length ? "s" : ""}. “Stopped” told you nothing about
              which one was idle.
            </span>
          ) : (
            <span>The stopped rows all look the same. That’s the point.</span>
          )}
        </div>
      </div>

      {/* gitspace strip — four distinct states, not one spinner */}
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden relative">
        <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">gitspace</span>
          <span className="text-[11px] text-zinc-600 uppercase tracking-wider">Workspace strip</span>
        </div>
        <div className={cn("p-4 transition-all duration-500", !revealed && "blur-[6px] opacity-40 select-none")}>
          <div className="flex flex-wrap gap-2">
            {FLEET.map((w) => (
              <div
                key={w.id}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 text-sm font-mono",
                  w.state === "idle" ? "bg-blue-500/10 ring-1 ring-blue-400/50" : "bg-[#0c0c0c]",
                  w.state === "closed" && "opacity-40"
                )}
              >
                <span className={cn("h-2 w-2", DOT[w.state], w.state === "active" && "shadow-[0_0_6px] shadow-green-500/60")} />
                <span className={w.state === "idle" ? "text-blue-300" : w.state === "amber" ? "text-amber-300" : "text-zinc-400"}>{w.name}</span>
                {w.state === "amber" && <Zap className="w-3.5 h-3.5 text-amber-400" />}
              </div>
            ))}
          </div>
        </div>
        {/* no self-spoilers: the reveal unlocks when the game is played */}
        {!revealed && (
          <div className="absolute inset-x-0 bottom-12 top-[41px] flex flex-col items-center justify-center gap-2">
            <span className="px-4 py-2 border border-zinc-700 bg-zinc-900/90 text-zinc-400 text-sm shadow-lg">
              Find the idle one first
            </span>
            <button onClick={() => setRevealed(true)} className="text-[11px] text-zinc-600 hover:text-zinc-400 underline underline-offset-2">
              or skip and reveal →
            </button>
          </div>
        )}
        <div className="px-4 py-3 border-t border-[#1a1a1a] text-[12px]">
          {revealed ? (
            <span className="text-blue-400">The idle one is blue: your move. Working, asking, and closed each get their own color too.</span>
          ) : (
            <span className="text-zinc-500">Same eight agents, same moment.</span>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
