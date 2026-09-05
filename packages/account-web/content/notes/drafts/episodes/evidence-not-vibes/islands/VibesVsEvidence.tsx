import { useState } from "react";
import { Check, Paperclip, ThumbsUp } from "lucide-react";
import { cn } from "../../../lib/utils";

/* The same pull request, reviewed two ways. */

const ROWS = [
  { title: "Checkout tests pass", kind: "test-output", judge: "command", evidence: "test-run.json · exit 0" },
  { title: "No type errors in checkout", kind: "test-output", judge: "command", evidence: "test-run.json · exit 0" },
  { title: "Checkout screenshot", kind: "screenshot", judge: "human", evidence: "checkout-flow.png" },
];

function PrHeader() {
  return (
    <div className="px-4 py-3 border-b border-[#1a1a1a] flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm text-zinc-200">Refactor checkout totals + regional tax</span>
      <span className="text-[12px] font-mono text-zinc-600">#214</span>
      <span className="ml-auto text-[12px] font-mono text-zinc-500">
        <span className="text-[#00ff66]">+412</span> <span className="text-[#ff4444]">−167</span> · 9 files
      </span>
    </div>
  );
}

export function VibesVsEvidence() {
  const [mode, setMode] = useState<"vibes" | "evidence">("vibes");

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">demo 1 · the same PR, twice</div>
      <div className="border border-[#1a1a1a] bg-[#050505]">
        {/* toggle */}
        <div className="flex border-b border-[#1a1a1a]">
          {(["vibes", "evidence"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 px-4 py-2.5 text-[12px] font-mono uppercase tracking-widest transition-colors",
                mode === m ? "bg-[#0c0c0c] text-zinc-100" : "text-zinc-600 hover:text-zinc-400",
                m === "evidence" && "border-l border-[#1a1a1a]"
              )}
            >
              {m === "vibes" ? "the vibe" : "the evidence"}
            </button>
          ))}
        </div>

        <PrHeader />

        {mode === "vibes" ? (
          <div className="p-4">
            <div className="border border-[#1a1a1a] bg-[#0a0a0a]">
              <div className="px-4 py-3 flex items-center gap-3 border-b border-[#1a1a1a]">
                <div className="h-7 w-7 bg-green-500/20 border border-green-500/40 flex items-center justify-center text-green-400 font-mono text-[10px]">
                  YOU
                </div>
                <span className="text-[13px] text-zinc-300">approved these changes</span>
                <ThumbsUp className="w-3.5 h-3.5 text-zinc-500 ml-auto" />
              </div>
              <div className="px-4 py-4 text-lg text-zinc-100">LGTM 👍</div>
              <div className="px-4 pb-3 text-[11px] font-mono text-zinc-600">
                approved 12 seconds after opening · 0 of 9 files viewed
              </div>
            </div>
            <div className="mt-4 text-[12px] text-zinc-500">
              What ran? What was checked? What would have failed this? The record can’t say.
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="border border-[#1a1a1a] bg-[#0a0a0a]">
              {ROWS.map((r) => (
                <div key={r.title} className="px-4 py-3 border-b border-[#1a1a1a] flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="h-2 w-2 bg-[#00ff66] shadow-[0_0_6px] shadow-[#00ff66]/60 shrink-0" />
                  <span className="text-[13px] text-zinc-200">{r.title}</span>
                  <span className="text-[10px] font-mono text-zinc-600 border border-[#1a1a1a] px-1.5 py-0.5">judge: {r.judge}</span>
                  <span className="ml-auto text-[11px] font-mono text-zinc-400 flex items-center gap-1.5">
                    <Paperclip className="w-3 h-3 text-zinc-500" /> {r.evidence}
                  </span>
                  <span className="text-[11px] font-mono text-[#00ff66] flex items-center gap-1">
                    <Check className="w-3 h-3" /> accepted
                  </span>
                </div>
              ))}
              <div className="px-4 py-3 font-mono text-[12px] text-[#00ff66]">Ready: all required artifacts passed judgment.</div>
            </div>
            <div className="mt-4 text-[12px] text-zinc-500">
              Same diff. Every checkmark names its judge and carries the artifact that earned it.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
