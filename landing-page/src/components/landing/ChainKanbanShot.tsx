/**
 * Chained kanban shot: goals grouped into ordered chains across board columns.
 * Same visual language as ProductShots (flat black, #1a1a1a hairlines, square
 * corners, mono, product hexes). The show-off is the chain lens: hover or tap
 * a chained card and its chain lights up with guide lines and order badges
 * while everything else dims. Click pins the lens. Mirrors the product's
 * goal-chain UX draft: lines hidden by default, one chain at a time.
 *
 * Chain semantics (space-chain skill): the chain is the plan over goals. A
 * goal only holds a workspace while it is actively worked; queued goals are
 * planned (no workspace yet) and shipped goals have had theirs removed.
 *
 * Idle attract loop: when nothing is hovered or pinned and the shot is in
 * view, the lens auto-cycles through the chains (engage ~3s, release, brief
 * all-cards beat, next chain). Any pointer or pin wins instantly; the loop
 * resumes a moment after the pointer leaves. Disabled entirely under
 * prefers-reduced-motion and while off-viewport.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

const COLS = ["QUEUED", "IN FLIGHT", "REVIEW", "SHIPPED"] as const;
type Col = (typeof COLS)[number];

type ChainId = "checkout" | "docs";

interface Chain {
  title: string;
  color: string;
  order: string[]; // goal ids, chain order (1 = first / furthest along)
  foot: string; // stack status line, real `space stack status` vocabulary
}

const CHAINS: Record<ChainId, Chain> = {
  checkout: {
    title: "checkout-cutover",
    color: C.green,
    order: ["billing-schema", "backfill-job", "checkout-flags", "checkout-e2e"],
    foot: "aligned through checkout-flags · next: checkout-e2e (planned)",
  },
  docs: {
    title: "docs-launch",
    color: C.blue,
    order: ["docs-getting-started", "docs-migration", "docs-launch-notes"],
    foot: "1 planned · edge: missing-workspace",
  },
};

interface Goal {
  id: string;
  name: string;
  branch: string; // "planned · no workspace" for planned goals
  col: Col;
  chain?: ChainId;
  dot: string; // status dot color
  pulse?: boolean;
  label: string;
  labelColor: string;
}

const GOALS: Goal[] = [
  // QUEUED
  { id: "docs-launch-notes", name: "docs-launch-notes", branch: "planned · no workspace yet", col: "QUEUED", chain: "docs", dot: C.ghost, label: "planned", labelColor: C.dim },
  { id: "checkout-e2e", name: "checkout-e2e", branch: "planned · no workspace yet", col: "QUEUED", chain: "checkout", dot: C.amber, label: "blocked by checkout-flags", labelColor: C.amber },
  // IN FLIGHT
  { id: "checkout-flags", name: "checkout-flags", branch: "feat/remove-checkout-v2", col: "IN FLIGHT", chain: "checkout", dot: C.green, pulse: true, label: "agent running", labelColor: C.muted },
  { id: "retry-backoff", name: "retry-backoff", branch: "fix/retry-storm", col: "IN FLIGHT", dot: C.green, pulse: true, label: "agent running", labelColor: C.muted },
  { id: "docs-migration", name: "docs-migration", branch: "docs/migration-guide", col: "IN FLIGHT", chain: "docs", dot: C.green, pulse: true, label: "agent running", labelColor: C.muted },
  // REVIEW
  { id: "backfill-job", name: "backfill-job", branch: "goal/backfill-job", col: "REVIEW", chain: "checkout", dot: C.amber, label: "PR #214 · review", labelColor: C.muted },
  { id: "docs-getting-started", name: "docs-getting-started", branch: "docs/getting-started", col: "REVIEW", chain: "docs", dot: C.amber, label: "PR #209 · review", labelColor: C.muted },
  // SHIPPED: merged goals no longer hold a workspace
  { id: "api-hardening", name: "api-hardening", branch: "merged · workspace removed", col: "SHIPPED", dot: C.green, label: "merged", labelColor: C.muted },
  { id: "billing-schema", name: "billing-schema", branch: "merged · workspace removed", col: "SHIPPED", chain: "checkout", dot: C.green, label: "merged", labelColor: C.muted },
];

function chainIndex(goal: Goal): number {
  if (!goal.chain) return 0;
  return CHAINS[goal.chain].order.indexOf(goal.id) + 1;
}

interface Lines {
  w: number;
  h: number;
  color: string;
  paths: string[];
}

const IDLE_DWELL_MS = 3000; // lens engaged on one chain
const IDLE_BEAT_MS = 1400; // all-cards beat between chains
const IDLE_RESUME_MS = 2400; // wait after the pointer leaves before cycling

export function ChainKanbanShot() {
  const [hovered, setHovered] = useState<ChainId | null>(null);
  const [pinned, setPinned] = useState<ChainId | null>(null);
  const [idle, setIdle] = useState<ChainId | null>(null);
  const [pointerOver, setPointerOver] = useState(false);
  const [inView, setInView] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [lines, setLines] = useState<Lines | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const idleStep = useRef(0);

  // user interaction always beats the idle loop
  const active = pinned ?? hovered ?? idle;
  const suppressed = pointerOver || pinned !== null || hovered !== null;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.35 });
    io.observe(root);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || reduced || suppressed) {
      setIdle(null);
      return;
    }
    const ids = Object.keys(CHAINS) as ChainId[];
    let timer = 0;
    const engage = () => {
      setIdle(ids[idleStep.current % ids.length]);
      timer = window.setTimeout(release, IDLE_DWELL_MS);
    };
    const release = () => {
      setIdle(null);
      idleStep.current += 1;
      timer = window.setTimeout(engage, IDLE_BEAT_MS);
    };
    timer = window.setTimeout(engage, IDLE_RESUME_MS);
    return () => {
      window.clearTimeout(timer);
      setIdle(null);
    };
  }, [inView, reduced, suppressed]);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;

    const measure = () => {
      if (!active) {
        setLines(null);
        return;
      }
      const chain = CHAINS[active];
      const base = board.getBoundingClientRect();
      const rects = chain.order
        .map((id) => cardRefs.current.get(id)?.getBoundingClientRect())
        .filter((r): r is DOMRect => Boolean(r));
      const paths: string[] = [];
      for (let i = 0; i < rects.length - 1; i += 1) {
        const a = rects[i];
        const b = rects[i + 1];
        const leftward = b.left + b.width / 2 < a.left + a.width / 2;
        const x1 = (leftward ? a.left : a.right) - base.left;
        const y1 = a.top + a.height / 2 - base.top;
        const x2 = (leftward ? b.right : b.left) - base.left;
        const y2 = b.top + b.height / 2 - base.top;
        const dx = Math.max(36, Math.abs(x2 - x1) * 0.4) * (leftward ? -1 : 1);
        paths.push(
          `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        );
      }
      setLines({ w: board.offsetWidth, h: board.offsetHeight, color: chain.color, paths });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(board);
    return () => ro.disconnect();
  }, [active]);

  const onCardClick = (goal: Goal) => {
    if (!goal.chain) {
      setPinned(null);
      return;
    }
    const chain = goal.chain;
    setPinned((p) => (p === chain ? null : chain));
  };

  return (
    <div
      ref={rootRef}
      className="font-mono text-left border"
      style={{ borderColor: C.border, background: C.bg }}
      onMouseEnter={() => setPointerOver(true)}
      onMouseLeave={() => {
        setPointerOver(false);
        setHovered(null);
      }}
    >
      <style>{`@keyframes gsChainDash { to { stroke-dashoffset: -22; } }`}</style>

      {/* chrome bar */}
      <div
        className="flex items-stretch text-[11px] overflow-hidden"
        style={{ background: C.bar, borderBottom: `1px solid ${C.border}`, height: 40 }}
      >
        <div className="flex items-center gap-2 px-4" style={{ color: C.text }}>
          <span style={{ width: 8, height: 14, background: C.green, display: "inline-block" }} />
          <span className="font-semibold">GitSpace</span>
          <span style={{ color: C.muted }}>acme</span>
        </div>
        <div className="flex items-center px-3 border-l" style={{ borderColor: C.border, background: "#0c0c0c", color: C.text }}>
          ⊞ chains
        </div>
        {(Object.keys(CHAINS) as ChainId[]).map((id) => (
          <div
            key={id}
            className="hidden md:flex items-center gap-1.5 px-3 border-l whitespace-nowrap"
            style={{ borderColor: C.border, color: active === id ? C.text : C.muted }}
          >
            <span style={{ width: 8, height: 8, background: CHAINS[id].color, display: "inline-block", flex: "none" }} />
            {CHAINS[id].title}
            <span className="text-[9px]" style={{ color: C.dim }}>{CHAINS[id].order.length} goals</span>
          </div>
        ))}
        <div className="ml-auto hidden sm:flex items-center px-3" style={{ color: C.dim }}>
          space chain show
        </div>
      </div>

      {/* board: horizontally scrollable on small screens, lens works on tap */}
      <div className="overflow-x-auto" onMouseLeave={() => setHovered(null)}>
        <div ref={boardRef} className="relative grid grid-cols-4 gap-6 p-6 min-w-[760px]">
          {COLS.map((col) => {
            const members = GOALS.filter((g) => g.col === col);
            return (
              <div key={col}>
                <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
                  {col} <span style={{ color: C.ghost }}>· {members.length}</span>
                </div>
                <div className="space-y-3">
                  {members.map((g) => {
                    const chain = g.chain ? CHAINS[g.chain] : null;
                    const inLens = active !== null && g.chain === active;
                    const dimmed = active !== null && !inLens;
                    const idx = chainIndex(g);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        ref={(el) => {
                          if (el) cardRefs.current.set(g.id, el);
                          else cardRefs.current.delete(g.id);
                        }}
                        onMouseEnter={() => setHovered(g.chain ?? null)}
                        onFocus={() => setHovered(g.chain ?? null)}
                        onClick={() => onCardClick(g)}
                        className="relative block w-full text-left p-3 transition-opacity duration-150 cursor-pointer"
                        style={{
                          background: inLens && chain ? `${chain.color}0d` : C.surface,
                          border: `1px solid ${inLens && chain ? `${chain.color}88` : C.border}`,
                          borderLeft: chain
                            ? `2px solid ${chain.color}${inLens ? "" : "55"}`
                            : `1px solid ${C.border}`,
                          boxShadow: inLens && chain ? `0 0 20px ${chain.color}1a` : "none",
                          opacity: dimmed ? 0.25 : g.dot === C.amber && g.label.startsWith("blocked") ? 0.7 : 1,
                        }}
                      >
                        {/* order badge: appears when the chain lens is on */}
                        {chain && (
                          <span
                            className="absolute flex items-center justify-center font-semibold transition-all duration-150"
                            style={{
                              top: -7,
                              right: -7,
                              width: 16,
                              height: 16,
                              fontSize: 9,
                              background: chain.color,
                              color: "#000",
                              opacity: inLens ? 1 : 0,
                              transform: inLens ? "scale(1)" : "scale(0.6)",
                            }}
                          >
                            {idx}
                          </span>
                        )}
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] truncate" style={{ color: C.text }}>{g.name}</span>
                          {chain && (
                            <span
                              className="ml-auto px-1 text-[8px] tracking-wider"
                              style={{ color: chain.color, border: `1px solid ${chain.color}44`, flex: "none" }}
                            >
                              {idx}/{chain.order.length}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] mb-2.5 truncate" style={{ color: C.dim }}>{g.branch}</div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <span
                            className={g.pulse ? "animate-pulse" : ""}
                            style={{ width: 8, height: 8, background: g.dot, boxShadow: `0 0 6px ${g.dot}66`, flex: "none", display: "inline-block" }}
                          />
                          <span className="truncate" style={{ color: g.labelColor }}>{g.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* guide lines: only the active chain, drawn card to card */}
          {lines && (
            <svg
              className="absolute inset-0 pointer-events-none"
              width={lines.w}
              height={lines.h}
              viewBox={`0 0 ${lines.w} ${lines.h}`}
              aria-hidden="true"
            >
              {lines.paths.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={lines.color}
                  strokeOpacity={0.65}
                  strokeWidth={1.5}
                  strokeDasharray="5 6"
                  strokeLinecap="round"
                  style={{
                    animation: reduced ? undefined : "gsChainDash 1.1s linear infinite",
                    filter: `drop-shadow(0 0 6px ${lines.color}44)`,
                  }}
                />
              ))}
            </svg>
          )}
        </div>
      </div>

      {/* lens strip: chain summary when active, hint otherwise */}
      <div
        className="flex items-center gap-3 px-4 text-[10px] whitespace-nowrap overflow-hidden"
        style={{ borderTop: `1px solid ${C.borderMuted}`, background: C.bar, height: 34 }}
      >
        {active ? (
          <>
            <span className="font-semibold" style={{ color: CHAINS[active].color }}>{CHAINS[active].title}</span>
            <span className="truncate" style={{ color: C.dim }}>{CHAINS[active].order.join(" → ")}</span>
            <span className="ml-auto hidden sm:inline" style={{ color: C.muted }}>
              {CHAINS[active].foot}
              {pinned === active && <span style={{ color: C.ghost }}> · pinned</span>}
            </span>
          </>
        ) : (
          <span style={{ color: C.ghost }}>hover or tap a chained card to trace its goal chain · click to pin</span>
        )}
      </div>
    </div>
  );
}
