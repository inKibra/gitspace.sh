import { GitBranch, Globe, ArrowRight } from "lucide-react";

/** Product visual language: flat black, hairlines, square corners, product status hexes. */
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

function Pip({ state, size = 8, pulse = false }: { state: FleetState; size?: number; pulse?: boolean }) {
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

/** Compact workspace list: project header + workspace rows. BoardShot, smaller. */
function SpacesMock() {
  const spaces: Array<{ name: string; branch: string; state: FleetState }> = [
    { name: "api-hardening", branch: "feat/rate-limits", state: "running" },
    { name: "checkout-flags", branch: "feat/remove-checkout-v2", state: "asked" },
    { name: "docs-refresh", branch: "docs/getting-started", state: "idle" },
  ];
  return (
    <div className="font-mono text-left border" style={{ borderColor: C.border, background: C.bg }}>
      {/* chrome bar */}
      <div
        className="flex items-center text-[11px]"
        style={{ background: C.bar, borderBottom: `1px solid ${C.border}`, height: 36 }}
      >
        <div className="flex items-center gap-2 px-4" style={{ color: C.text }}>
          <span style={{ width: 7, height: 12, background: C.green, display: "inline-block" }} />
          <span className="font-semibold">GitSpace</span>
          <span style={{ color: C.muted }}>acme</span>
        </div>
        <div className="ml-auto px-4 text-[10px] tracking-[0.18em]" style={{ color: C.dim }}>
          3 SPACES
        </div>
      </div>
      {/* project header */}
      <div
        className="px-4 py-2.5 text-[10px] tracking-[0.18em]"
        style={{ color: C.dim, borderBottom: `1px solid ${C.borderMuted}` }}
      >
        acme <span style={{ color: C.ghost }}>· workspaces</span>
      </div>
      {/* workspace rows */}
      <div>
        {spaces.map((w, i) => {
          const s = STATE[w.state];
          return (
            <div
              key={w.name}
              className="flex items-center gap-3 px-4 py-3.5"
              style={{
                background: w.state === "asked" ? C.surface : "transparent",
                borderBottom: i < spaces.length - 1 ? `1px solid ${C.borderMuted}` : "none",
              }}
            >
              <Pip state={w.state} pulse={w.state === "asked"} />
              <span className="text-[13px]" style={{ color: C.text }}>{w.name}</span>
              <span className="hidden sm:inline text-[10px]" style={{ color: C.dim }}>{w.branch}</span>
              <span className="ml-auto text-[10px] whitespace-nowrap" style={{ color: w.state === "running" ? C.muted : s.c }}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact fleet strip + inbox: what checking in from your phone looks like. */
function RemoteMock() {
  const strip: Array<{ name: string; state: FleetState }> = [
    { name: "api-hardening", state: "running" },
    { name: "checkout-flags", state: "asked" },
    { name: "retry-backoff", state: "running" },
    { name: "docs-refresh", state: "idle" },
    { name: "relay-metrics", state: "running" },
  ];
  return (
    <div className="font-mono text-left border" style={{ borderColor: C.border, background: C.bg }}>
      {/* fleet strip */}
      <div
        className="flex items-stretch text-[11px] overflow-hidden"
        style={{ background: C.bar, borderBottom: `1px solid ${C.border}`, height: 36 }}
      >
        {strip.map((w, i) => (
          <div
            key={w.name}
            className={`flex items-center gap-1.5 px-3 whitespace-nowrap ${i > 2 ? "hidden md:flex" : "flex"}`}
            style={{ borderRight: `1px solid ${C.border}`, color: C.muted }}
          >
            <Pip state={w.state} pulse={w.state === "asked"} />
            {w.name}
          </div>
        ))}
        <div className="ml-auto flex items-center px-3" style={{ color: C.dim }}>
          <span className="relative">
            ⚑
            <span
              className="absolute -right-2 -top-1.5 h-3.5 min-w-3.5 text-[8px] font-semibold flex items-center justify-center px-0.5"
              style={{ background: C.blue, color: "#000" }}
            >
              2
            </span>
          </span>
        </div>
      </div>
      {/* inbox */}
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
        <span className="text-[10px] tracking-[0.18em]" style={{ color: C.dim }}>
          INBOX <span style={{ color: C.blue }}>· 2 while you were away</span>
        </span>
      </div>
      <div>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${C.borderMuted}` }}>
          <Pip state="asked" pulse />
          <span className="text-[12px]" style={{ color: C.text }}>checkout-flags</span>
          <span className="ml-auto text-[10px]" style={{ color: C.amber }}>asked you a question</span>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <Pip state="idle" />
          <span className="text-[12px]" style={{ color: C.text }}>docs-refresh</span>
          <span className="ml-auto text-[10px]" style={{ color: C.blue }}>idle · waiting on you</span>
        </div>
      </div>
    </div>
  );
}

export function Features() {
  return (
    <section id="features" className="py-24 bg-black relative">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-bold mb-4">One tool. Two superpowers.</h2>
            <div className="h-px w-20 mx-auto" style={{ background: C.border }} />
        </div>

        <div className="space-y-32">

            {/* SPACES */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
                <div>
                    <div className="inline-flex items-center gap-2 font-mono text-sm mb-4 tracking-wider" style={{ color: C.green }}>
                        <GitBranch className="w-5 h-5" />
                        <span>SPACES</span>
                    </div>
                    <h3 className="text-3xl md:text-4xl font-bold mb-6">Work on everything at once.</h3>
                    <p className="text-lg text-zinc-400 leading-relaxed mb-8">
                        Git worktrees let you have multiple branches checked out simultaneously. No more stashing. No more "let me finish this first." Jump between features instantly.
                    </p>
                    <ul className="space-y-3 text-zinc-300">
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.green }} />
                            <span>Each workspace is a full git worktree</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.green }} />
                            <span>Run different branches simultaneously</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.green }} />
                            <span>Custom setup scripts per project</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.green }} />
                            <span>Integrates with Linear issues</span>
                        </li>
                    </ul>
                </div>
                <div>
                    <SpacesMock />
                </div>
            </div>

            {/* REMOTE */}
            <div className="grid lg:grid-cols-2 gap-12 items-center lg:flex-row-reverse">
                 <div className="lg:order-2">
                    <div className="inline-flex items-center gap-2 font-mono text-sm mb-4 tracking-wider" style={{ color: C.blue }}>
                        <Globe className="w-5 h-5" />
                        <span>REMOTE</span>
                    </div>
                    <h3 className="text-3xl md:text-4xl font-bold mb-6">Your terminal, from anywhere.</h3>
                    <p className="text-lg text-zinc-400 leading-relaxed mb-8">
                        Start an AI agent on a big task. Close your laptop. Check in from your phone.
                        The inbox catches what happened while you were away. End-to-end encrypted - we can’t see your terminal.
                    </p>
                    <ul className="space-y-3 text-zinc-300">
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.blue }} />
                            <span>Encrypted access from your phone or any device</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.blue }} />
                            <div className="flex flex-col">
                                <span className="text-zinc-300">Public subdomains on gitspace.sh</span>
                                <span className="text-xs font-semibold mt-1 uppercase tracking-wider" style={{ color: C.green }}>Shipped</span>
                            </div>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.blue }} />
                            <span>End-to-end encrypted relay — we can't see your data</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.blue }} />
                            <span>Owner-only access across devices recovered from your mnemonic</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 mr-3 shrink-0 mt-0.5" style={{ color: C.blue }} />
                            <span>Inbox tracks what happened while you were away</span>
                        </li>
                    </ul>
                </div>
                <div className="lg:order-1">
                    <RemoteMock />
                </div>
            </div>

        </div>
      </div>
    </section>
  );
}
