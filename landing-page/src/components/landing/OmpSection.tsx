/**
 * THE RUNTIME — omp deep-dive (task #10).
 *
 * "Proudly built on omp": intro + stat grid, then one row per capability
 * (LSP / DAP / EVAL / TTSR / RECEIPTS) with a fleet translation each.
 * Design language matches ProductShots: flat black, 1px #1a1a1a hairlines,
 * square corners, mono, product status hexes. Every number here is from
 * omp.sh — do not invent new ones.
 */

const C = {
  bg: "#000000",
  surface: "#080808",
  border: "#1a1a1a",
  borderMuted: "#111111",
  text: "#e6e6e6",
  muted: "#9c9c9c",
  dim: "#6a6a6a",
  ghost: "#3a3a3a",
  green: "#00ff66",
};

const OMP_STATS: Array<[string, string]> = [
  ["40+", "model providers"],
  ["32", "built-in tools"],
  ["53", "language servers"],
  ["14", "debug adapters"],
  ["100k+", "lines of Rust core"],
  ["MIT", "licensed"],
];

type Capability = {
  tag: string;
  title: string;
  what: string;
  fleet: string;
};

const CAPABILITIES: Capability[] = [
  {
    tag: "LSP",
    title: "The language server checks every write",
    what: "14 operations against 53 language servers, wired into every file write, with format on write. Renames go through workspace/willRenameFiles, so re-exports, barrel files, and aliased imports all update.",
    fleet:
      "An agent renaming a symbol at 3am can't silently break a barrel file nobody had open. Every edit gets checked the moment it lands, not in your morning review.",
  },
  {
    tag: "DAP",
    title: "It drives a real debugger",
    what: "28 operations, 14 bundled adapters (lldb-dap, dlv, debugpy, more). Attaches over stdio, unix socket, TCP, or pid. omp's line: most agents are still sprinkling print statements.",
    fleet:
      "A wedged service gets breakpoints and an inspected stack, not guesses. The agent steps through the failure while you're away instead of parking on amber to ask what happened.",
  },
  {
    tag: "EVAL",
    title: "Persistent kernels that call back",
    what: "Long-lived Python and Bun kernels. Code inside the kernel can call back into agent tools (tool.read and friends) over a loopback bridge.",
    fleet:
      "State survives between turns, so an agent probes a live system across steps instead of re-running everything to test each theory. Its scripts read the repo through the same tools it does.",
  },
  {
    tag: "TTSR",
    title: "Rules that fire mid-token",
    what: "Time-traveling stream rules: regex rules sit dormant at zero token cost. On a match, omp aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. Rules survive compaction.",
    fleet:
      "Your house rules hold on agent forty as well as agent one. The rule interrupts the exact generation about to break it, even hours into a session, even after compaction.",
  },
];

const RECEIPTS: Array<{ model: string; metric: string; result: string; note: string }> = [
  { model: "Grok Code Fast 1", metric: "pass@1", result: "6.7% → 68.3%", note: "edit format alone" },
  { model: "Gemini 3 Flash", metric: "pass rate", result: "+5pp", note: "vs str_replace" },
  { model: "Grok 4 Fast", metric: "output tokens", result: "−61%", note: "same tasks" },
  { model: "MiniMax", metric: "pass rate", result: "2.1×", note: "" },
];

export function OmpSection() {
  return (
    <section className="py-24 px-4 antialiased border-y" style={{ background: C.bg, borderColor: C.border }}>
      <div className="container mx-auto max-w-6xl">
        {/* ── header: proudly built on omp ─────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-12 items-center mb-16">
          <div>
            <div className="text-[11px] font-mono mb-4 uppercase tracking-[0.18em]" style={{ color: C.green }}>
              The runtime · omp.sh
            </div>
            <h2
              className="text-3xl md:text-5xl font-bold mb-5"
              style={{ color: C.text, textWrap: "balance" }}
            >
              Proudly built on <span className="font-mono">omp</span>.
            </h2>
            <p className="text-lg leading-relaxed mb-4" style={{ color: C.muted, textWrap: "pretty" }}>
              Every agent in the fleet runs on{" "}
              <a
                href="https://omp.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 transition-colors"
                style={{ color: C.text, textDecorationColor: C.ghost }}
              >
                omp
              </a>
              : a coding agent with the IDE wired in. MIT licensed, native on macOS, Linux, and
              Windows (no WSL), built on Mario Zechner's Pi.
            </p>
            <p className="text-lg leading-relaxed" style={{ color: C.muted, textWrap: "pretty" }}>
              GitSpace doesn't wrap a chat window. It runs a fleet of omp agents through a delivery
              lifecycle, unattended for hours at a stretch. Each capability below is a reason the
              fleet can run that way.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 border-t border-l font-mono" style={{ borderColor: C.border }}>
            {OMP_STATS.map(([stat, label]) => (
              <div key={label} className="border-b border-r p-5" style={{ borderColor: C.border, background: C.surface }}>
                <div className="text-2xl mb-1 tabular-nums" style={{ color: C.text }}>{stat}</div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: C.dim }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── capability rows ──────────────────────────────────────── */}
        <div className="border" style={{ borderColor: C.border, background: C.surface }}>
          {CAPABILITIES.map((cap, i) => (
            <div
              key={cap.tag}
              className="grid md:grid-cols-12 gap-x-8 gap-y-4 p-6 md:p-8"
              style={{ borderTop: i === 0 ? "none" : `1px solid ${C.border}` }}
            >
              <div className="md:col-span-3">
                <span
                  className="inline-block font-mono text-[11px] tracking-[0.18em] px-2 py-1 mb-3"
                  style={{ color: C.green, border: `1px solid ${C.green}44` }}
                >
                  {cap.tag}
                </span>
                <h3 className="text-lg font-semibold leading-snug" style={{ color: C.text, textWrap: "balance" }}>
                  {cap.title}
                </h3>
              </div>
              <p className="md:col-span-5 text-sm leading-relaxed" style={{ color: C.muted, textWrap: "pretty" }}>
                {cap.what}
              </p>
              <div className="md:col-span-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: C.green }}>
                  At fleet scale
                </div>
                <p className="text-sm leading-relaxed" style={{ color: C.text, textWrap: "pretty" }}>
                  {cap.fleet}
                </p>
              </div>
            </div>
          ))}

          {/* receipts row: the evidence table */}
          <div className="p-6 md:p-8" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="grid md:grid-cols-12 gap-x-8 gap-y-4 mb-6">
              <div className="md:col-span-3">
                <span
                  className="inline-block font-mono text-[11px] tracking-[0.18em] px-2 py-1 mb-3"
                  style={{ color: C.green, border: `1px solid ${C.green}44` }}
                >
                  RECEIPTS
                </span>
                <h3 className="text-lg font-semibold leading-snug" style={{ color: C.text, textWrap: "balance" }}>
                  Benchmaxxed tools, published numbers
                </h3>
              </div>
              <p className="md:col-span-5 text-sm leading-relaxed" style={{ color: C.muted, textWrap: "pretty" }}>
                omp tunes its tools per model and publishes the results instead of asserting them.
                Method: 16 models, 180 tasks, 3 runs each.
              </p>
              <div className="md:col-span-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: C.green }}>
                  At fleet scale
                </div>
                <p className="text-sm leading-relaxed" style={{ color: C.text, textWrap: "pretty" }}>
                  Model choice becomes a dial, not a bet. Cheap models land edits first try, so the
                  fleet can run wide on models that flail with stock tooling.
                </p>
              </div>
            </div>
            <div className="border overflow-x-auto" style={{ borderColor: C.border, background: C.bg }}>
              <table className="w-full font-mono text-[12px] tabular-nums" style={{ color: C.text }}>
                <thead>
                  <tr
                    className="text-[9px] uppercase tracking-[0.18em] text-left"
                    style={{ color: C.dim, borderBottom: `1px solid ${C.border}` }}
                  >
                    <th className="font-normal px-4 py-2.5">Model</th>
                    <th className="font-normal px-4 py-2.5">Metric</th>
                    <th className="font-normal px-4 py-2.5">Result</th>
                    <th className="font-normal px-4 py-2.5 hidden sm:table-cell">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {RECEIPTS.map((r, i) => (
                    <tr key={r.model} style={{ borderTop: i === 0 ? "none" : `1px solid ${C.borderMuted}` }}>
                      <td className="px-4 py-2.5 whitespace-nowrap">{r.model}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: C.muted }}>{r.metric}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: C.green }}>{r.result}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell" style={{ color: C.dim }}>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── footer line ──────────────────────────────────────────── */}
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[12px]">
          <span style={{ color: C.dim }}>
            MIT · built on Pi · macOS / Linux / Windows, no WSL
          </span>
          <a
            href="https://omp.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center py-2 ml-auto transition-colors hover:brightness-125"
            style={{ color: C.green }}
          >
            omp.sh →
          </a>
        </div>
      </div>
    </section>
  );
}
