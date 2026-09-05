/**
 * ChainBuilder: the reader composes a goal chain with the one planning verb,
 * add-after. Pick an anchor goal on the track, add the next goal after it;
 * the track and order badges grow and a mono log echoes the real command
 * (`space chain add-after --goal <id> --title "..."`). Marking the active
 * goal done removes its workspace and visibly unblocks the next goal, which
 * binds a workspace (create-workspace, branching from the ancestor's HEAD).
 *
 * Semantics mirror the space-chain skill exactly:
 * - a chain is a plan over goals; a goal holds a workspace ONLY while an
 *   agent actively works it ("planned · no workspace yet" before, "merged ·
 *   workspace removed" after);
 * - inserts are phase-enforced: a new goal reads as phase `plan`, so
 *   add-after refuses when any goal after the insert point has advanced
 *   past plan. Refusal, not warning.
 */

import { useState } from "react";

const C = {
  surface: "#080808",
  bar: "#050505",
  border: "#1a1a1a",
  text: "#e6e6e6",
  muted: "#9c9c9c",
  dim: "#6a6a6a",
  ghost: "#3a3a3a",
  green: "#00ff66",
  amber: "#ffcc00",
};

type Status = "merged" | "active" | "planned";

interface Node {
  id: string;
  title: string;
  status: Status;
}

interface LogLine {
  text: string;
  kind: "cmd" | "note" | "err";
}

const PHASE: Record<Status, string> = { merged: "ship", active: "code", planned: "plan" };

const SEED: Node[] = [{ id: "billing-schema", title: "Billing schema", status: "active" }];

const POOL = ["Backfill job", "Checkout flags", "Invoice UI", "Checkout e2e", "Ship notes"];

const START_LOG: LogLine[] = [
  { text: "# pick an anchor goal on the track, then add the next goal after it", kind: "note" },
];

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function ChainBuilder() {
  const [nodes, setNodes] = useState<Node[]>(SEED);
  const [anchorId, setAnchorId] = useState<string>(SEED[0].id);
  const [log, setLog] = useState<LogLine[]>(START_LOG);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [justUnblocked, setJustUnblocked] = useState<string | null>(null);

  const usedTitles = new Set(nodes.map((n) => n.title));
  const pool = POOL.filter((t) => !usedTitles.has(t));
  const activeNode = nodes.find((n) => n.status === "active") ?? null;
  const firstPlanned = nodes.find((n) => n.status === "planned") ?? null;

  const push = (lines: LogLine[]) => setLog((prev) => [...prev, ...lines].slice(-5));

  const addAfter = (title: string) => {
    const idx = nodes.findIndex((n) => n.id === anchorId);
    if (idx < 0) return;
    const anchor = nodes[idx];
    // Insert guard from the skill: a new goal reads as phase `plan`; refuse if
    // anything after the insert point has already advanced past plan.
    const offender = nodes.slice(idx + 1).find((n) => n.status !== "planned");
    if (offender) {
      push([
        {
          text: `Cannot insert "${title}" after "${anchor.id}": ${PHASE[offender.status]} is further along than plan.`,
          kind: "err",
        },
        { text: "# insert after the advanced work instead", kind: "note" },
      ]);
      return;
    }
    const node: Node = { id: slug(title), title, status: "planned" };
    setNodes((prev) => [...prev.slice(0, idx + 1), node, ...prev.slice(idx + 1)]);
    setAnchorId(node.id);
    setLastAdded(node.id);
    setJustUnblocked(null);
    push([{ text: `space chain add-after --goal ${anchor.id} --title "${title}"`, kind: "cmd" }]);
  };

  const bind = (target: Node, ancestor: Node | null, prefix: LogLine[]) => {
    setNodes((prev) => prev.map((n) => (n.id === target.id ? { ...n, status: "active" as Status } : n)));
    setJustUnblocked(target.id);
    setLastAdded(null);
    push([
      ...prefix,
      { text: `space chain create-workspace --goal ${target.id}`, kind: "cmd" },
      {
        text: `# ${target.id}: planned → workspace-backed${ancestor ? ` · branched from ${ancestor.id} HEAD` : ""}`,
        kind: "note",
      },
    ]);
  };

  const markDone = () => {
    if (!activeNode) return;
    const idx = nodes.findIndex((n) => n.id === activeNode.id);
    const next = nodes[idx + 1] ?? null;
    setNodes((prev) => prev.map((n) => (n.id === activeNode.id ? { ...n, status: "merged" as Status } : n)));
    const mergedLine: LogLine = { text: `# ${activeNode.id}: merged · workspace removed`, kind: "note" };
    if (next) {
      bind(next, activeNode, [mergedLine]);
    } else {
      setJustUnblocked(null);
      push([mergedLine, { text: "# chain complete · no workspaces left, the chain remains", kind: "note" }]);
    }
  };

  const reset = () => {
    setNodes(SEED);
    setAnchorId(SEED[0].id);
    setLog(START_LOG);
    setLastAdded(null);
    setJustUnblocked(null);
  };

  return (
    <div className="font-mono text-left border" style={{ borderColor: C.border, background: "#000" }}>
      <style>{`
        @keyframes gsCbPop { from { opacity: 0; transform: scale(0.88); } to { opacity: 1; transform: scale(1); } }
        @keyframes gsCbUnblock {
          0% { box-shadow: 0 0 0 0 ${C.green}00; }
          35% { box-shadow: 0 0 24px 2px ${C.green}55; }
          100% { box-shadow: 0 0 12px 0 ${C.green}22; }
        }
        @media (prefers-reduced-motion: reduce) {
          .gs-cb-anim { animation: none !important; }
        }
      `}</style>

      {/* chrome bar */}
      <div
        className="flex items-center text-[11px] px-4 gap-2"
        style={{ background: C.bar, borderBottom: `1px solid ${C.border}`, height: 40, color: C.text }}
      >
        <span style={{ width: 8, height: 14, background: C.green, display: "inline-block" }} />
        <span className="font-semibold">space chain</span>
        <span style={{ color: C.muted }}>billing-cutover</span>
        <span className="ml-auto" style={{ color: C.ghost }}>
          {nodes.length} goal{nodes.length === 1 ? "" : "s"} · {nodes.filter((n) => n.status === "active").length} workspace
        </span>
        <button
          type="button"
          onClick={reset}
          className="border px-2 py-0.5 text-[10px] cursor-pointer"
          style={{ borderColor: C.border, color: C.dim, background: "transparent" }}
        >
          reset
        </button>
      </div>

      {/* chain track */}
      <div className="overflow-x-auto">
        <div className="flex items-stretch p-5 min-w-max">
          {nodes.map((n, i) => {
            const isAnchor = n.id === anchorId;
            const anim =
              n.id === justUnblocked
                ? "gsCbUnblock 900ms ease-out"
                : n.id === lastAdded
                  ? "gsCbPop 260ms ease-out"
                  : undefined;
            return (
              <div key={n.id} className="flex items-center">
                {i > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ width: 30, borderTop: `1px dashed ${C.green}55`, flex: "none" }}
                  />
                )}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setAnchorId(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setAnchorId(n.id);
                  }}
                  className="gs-cb-anim relative w-[176px] p-3 cursor-pointer flex-none"
                  style={{
                    background: n.status === "active" ? `${C.green}0d` : C.surface,
                    border: `1px solid ${isAnchor ? `${C.green}88` : C.border}`,
                    borderLeft: `2px solid ${n.status === "planned" ? `${C.green}55` : C.green}`,
                    opacity: n.status === "merged" ? 0.55 : 1,
                    animation: anim,
                  }}
                  aria-label={`${n.title}, goal ${i + 1} of ${nodes.length}, ${n.status}${isAnchor ? ", anchor" : ""}`}
                >
                  {/* order badge */}
                  <span
                    className="absolute flex items-center justify-center font-semibold"
                    style={{
                      top: -7,
                      right: -7,
                      width: 16,
                      height: 16,
                      fontSize: 9,
                      background: C.green,
                      color: "#000",
                    }}
                  >
                    {i + 1}
                  </span>

                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[13px] truncate" style={{ color: n.status === "merged" ? C.dim : C.text }}>
                      {n.id}
                    </span>
                    <span
                      className="ml-auto px-1 text-[8px] tracking-wider flex-none"
                      style={{ color: C.green, border: `1px solid ${C.green}44` }}
                    >
                      {i + 1}/{nodes.length}
                    </span>
                  </div>

                  <div className="text-[10px] mb-2 truncate" style={{ color: C.dim }}>
                    {n.status === "planned" && "planned · no workspace yet"}
                    {n.status === "merged" && "merged · workspace removed"}
                    {n.status === "active" && (
                      <span
                        className="inline-block px-1 border"
                        style={{ color: C.green, borderColor: `${C.green}44`, background: `${C.green}0d` }}
                      >
                        ⌗ ws feat/{n.id}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[10px]">
                    <span
                      className={n.status === "active" ? "animate-pulse" : ""}
                      style={{
                        width: 8,
                        height: 8,
                        flex: "none",
                        display: "inline-block",
                        background: n.status === "planned" ? C.ghost : C.green,
                        boxShadow: n.status === "planned" ? "none" : `0 0 6px ${C.green}66`,
                      }}
                    />
                    <span className="truncate" style={{ color: n.status === "active" ? C.muted : C.dim }}>
                      {n.status === "active" && "agent running · phase code"}
                      {n.status === "planned" && (activeNode ? `blocked by ${activeNode.id}` : "planned · phase plan")}
                      {n.status === "merged" && "merged"}
                    </span>
                  </div>

                  {n.status === "active" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        markDone();
                      }}
                      className="mt-2.5 w-full border px-2 py-1 text-[10px] cursor-pointer"
                      style={{ borderColor: `${C.green}55`, color: C.green, background: "transparent" }}
                    >
                      mark done ✓
                    </button>
                  )}

                  {!activeNode && firstPlanned?.id === n.id && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        bind(n, nodes[i - 1] ?? null, []);
                      }}
                      className="mt-2.5 w-full border px-2 py-1 text-[10px] cursor-pointer"
                      style={{ borderColor: `${C.green}55`, color: C.green, background: "transparent" }}
                    >
                      create workspace →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* add-after affordance */}
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-3 text-[11px]"
        style={{ borderTop: `1px solid ${C.border}`, color: C.dim }}
      >
        <span className="whitespace-nowrap">
          add after <span style={{ color: C.green }}>{anchorId}</span>:
        </span>
        {pool.length > 0 ? (
          pool.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => addAfter(t)}
              className="border px-2 py-1 cursor-pointer"
              style={{ borderColor: C.border, color: C.muted, background: C.surface }}
            >
              + {t}
            </button>
          ))
        ) : (
          <span style={{ color: C.ghost }}>chain planned · mark goals done to walk the line</span>
        )}
      </div>

      {/* command log */}
      <div
        className="px-4 py-3 text-[11px] leading-relaxed"
        style={{ borderTop: `1px solid ${C.border}`, background: C.bar }}
        aria-live="polite"
      >
        {log.map((l, i) => (
          <div
            key={`${i}-${l.text}`}
            className="truncate"
            style={{
              color: l.kind === "cmd" ? C.green : l.kind === "err" ? C.amber : C.ghost,
              opacity: i === log.length - 1 ? 1 : 0.55,
            }}
          >
            {l.kind === "cmd" ? "$ " : ""}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
