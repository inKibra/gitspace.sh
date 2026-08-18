/**
 * Marketing shots of the actual app, rebuilt as live React mocks in the
 * product's exact visual language: flat black, 1px #1a1a1a hairlines, square
 * corners, JetBrains-style mono, product status hexes (not Tailwind greens).
 * Same fleet story as video Nº 01, so site, film, and notes all rhyme.
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

type FleetState = "running" | "asked" | "idle";
const STATE: Record<FleetState, { c: string; label: string }> = {
  running: { c: C.green, label: "running" },
  asked: { c: C.amber, label: "asked you a question" },
  idle: { c: C.blue, label: "idle · waiting on you" },
};

const FLEET: Array<{ name: string; branch: string; col: string; state: FleetState; phase: string }> = [
  { name: "api-hardening", branch: "feat/rate-limits", col: "BUILD", state: "running", phase: "build" },
  { name: "checkout-flags", branch: "feat/remove-checkout-v2", col: "BUILD", state: "asked", phase: "build" },
  { name: "retry-backoff", branch: "fix/retry-storm", col: "BUILD", state: "running", phase: "fix" },
  { name: "docs-refresh", branch: "docs/getting-started", col: "DOCS", state: "idle", phase: "docs" },
  { name: "relay-metrics", branch: "feat/relay-metrics", col: "REVIEW", state: "running", phase: "review" },
];

function Dot({ state, size = 8, pulse = false }: { state: FleetState; size?: number; pulse?: boolean }) {
  return (
    <span
      className={pulse ? "animate-pulse" : ""}
      style={{
        width: size,
        height: size,
        background: STATE[state].c,
        boxShadow: `0 0 6px ${STATE[state].c}66`,
        flex: "none",
        display: "inline-block",
      }}
    />
  );
}

/** The chrome bar + fleet board: the money shot. */
export function BoardShot() {
  const cols = ["BUILD", "DOCS", "REVIEW"];
  return (
    <div className="font-mono text-left border" style={{ borderColor: C.border, background: C.bg }}>
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
          ⊞ board
        </div>
        {FLEET.map((w) => (
          <div
            key={w.name}
            className="hidden md:flex items-center gap-1.5 px-3 border-l whitespace-nowrap"
            style={{ borderColor: C.border, color: C.muted }}
          >
            <Dot state={w.state} pulse={w.state === "asked"} />
            {w.name}
            <span className="uppercase text-[8px] tracking-wider" style={{ color: C.dim }}>
              {w.phase}
            </span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-3 px-3" style={{ color: C.dim }}>
          <span className="relative">
            ⚑
            <span
              className="absolute -right-2 -top-1.5 h-3.5 min-w-3.5 rounded-full text-[8px] font-semibold flex items-center justify-center px-0.5"
              style={{ background: C.blue, color: "#000" }}
            >
              2
            </span>
          </span>
          <span className="border px-1.5 text-[9px]" style={{ borderColor: C.border }}>⌘K</span>
        </div>
      </div>

      {/* board */}
      <div className="grid md:grid-cols-3 gap-8 p-7">
        {cols.map((col) => {
          const members = FLEET.filter((w) => w.col === col);
          return (
            <div key={col}>
              <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: C.dim }}>
                {col} <span style={{ color: C.ghost }}>· {members.length}</span>
              </div>
              <div className="space-y-3">
                {members.map((w) => {
                  const s = STATE[w.state];
                  return (
                    <div
                      key={w.name}
                      className="p-4"
                      style={{
                        background: C.surface,
                        border: `1px solid ${w.state === "asked" ? s.c : C.border}`,
                        boxShadow: w.state === "asked" ? `0 0 20px ${s.c}22` : "none",
                      }}
                    >
                      <div className="text-[13px] mb-0.5" style={{ color: C.text }}>{w.name}</div>
                      <div className="text-[10px] mb-3" style={{ color: C.dim }}>{w.branch}</div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <Dot state={w.state} pulse={w.state === "asked"} />
                        <span style={{ color: w.state === "running" ? C.muted : s.c }}>{s.label}</span>
                        {w.state === "asked" && (
                          <span
                            className="ml-auto px-1.5 py-0.5 text-[9px]"
                            style={{ color: C.amber, border: `1px solid ${C.amber}55` }}
                          >
                            1 question
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The native ask form: how agent questions actually get answered. */
export function AskFormShot() {
  const options = [
    { label: "Canary: api first, watch errors 10m (Recommended)", desc: "Safest. Adds about 20 minutes.", on: true },
    { label: "All three at once", desc: "Fastest. One revert point.", on: false },
    { label: "web only, hold the rest", desc: "Partial cleanup with a follow-up PR.", on: false },
  ];
  return (
    <div className="font-mono text-left border" style={{ borderColor: C.border, background: C.surface }}>
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
        <div className="text-[9px] tracking-[0.18em] mb-1.5" style={{ color: C.dim }}>AGENT QUESTIONS</div>
        <div className="text-[15px]" style={{ color: C.text }}>Flag cleanup: rollout order</div>
      </div>
      <div className="p-5">
        <p className="text-[12px] leading-relaxed mb-4" style={{ color: C.text }}>
          checkout_v2 is still referenced by api, web, and worker. How should I roll out the removal?
        </p>
        <div className="space-y-1 mb-4">
          {options.map((o) => (
            <div key={o.label} className="flex items-start gap-2.5 px-2 py-2" style={{ background: o.on ? "#0c0c0c" : "transparent" }}>
              <span
                className="mt-0.5 h-3.5 w-3.5 rounded-full flex items-center justify-center"
                style={{ border: `2px solid ${o.on ? C.green : C.dim}`, flex: "none" }}
              >
                {o.on && <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.green }} />}
              </span>
              <span>
                <span className="block text-[11.5px]" style={{ color: C.text }}>{o.label}</span>
                <span className="block text-[10px] mt-0.5" style={{ color: C.dim }}>{o.desc}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center px-3 h-9 text-[11px] mb-4" style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.dim }}>
          Other (type your own)
        </div>
        <div className="flex justify-end gap-2 text-[11px]">
          <span className="px-4 py-2" style={{ border: `1px solid ${C.border}`, color: C.text }}>Cancel</span>
          <span className="px-4 py-2 font-semibold" style={{ background: C.green, color: "#000" }}>Submit</span>
        </div>
      </div>
    </div>
  );
}
