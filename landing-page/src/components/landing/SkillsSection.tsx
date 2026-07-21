/**
 * SkillsExplorer — a man-page/terminal browser for the ten agent skills the
 * harness installs (src/lib/tmux-lite/agents/skills/). Left: selectable skill
 * list grouped by flow stage (keyboard up/down works). Right: the selected
 * skill's "page" — its real frontmatter description, a contract line quoted
 * from the SKILL.md, and a verbatim command example. All content traces to the
 * real SKILL.md files; no invented syntax.
 *
 * Visual language: flat black, 1px #1a1a1a hairlines, square corners, mono,
 * product status hexes (#00ff66).
 */

import { useState } from "react";

type CmdLine = {
  /** cmd = "$ …" line · cont = continuation (indented) · comment = "# …" · out = printed output */
  t: "cmd" | "cont" | "comment" | "out";
  s: string;
};

type SkillDef = {
  name: string;
  group: "plan" | "build" | "review" | "operate";
  /** one-liner for the list rail */
  blurb: string;
  /** the skill's real frontmatter `description:` (trimmed where long) */
  desc: string;
  /** what it does — condensed from the SKILL.md body */
  about: string;
  /** a contract line quoted from the SKILL.md */
  quote: string;
  example: CmdLine[];
};

// the flow, shipped as agent skills (src/lib/tmux-lite/agents/skills/<name>/SKILL.md)
const SKILLS: SkillDef[] = [
  {
    name: "space-goal",
    group: "plan",
    blurb: "state the goal; the rubric derives from it",
    desc: "Drive the GitSpace goal validation contract — declare artifact requirements, fulfill them, judge them, and read plain-language readiness.",
    about:
      "Requirements carry rubrics; evidence attaches to requirements; judgments move status missing → review → accepted. `space goal status` prints readiness as one quotable sentence: the sentence is the deliverable, not the table.",
    quote: "Do not invent artifacts. Every attached artifact must satisfy a declared requirement.",
    example: [
      { t: "cmd", s: "space goal requirement add \\" },
      { t: "cont", s: '--title "Focused tests pass" --kind test-output \\' },
      { t: "cont", s: '--rubric "Suite completes with 0 failures. Exit code 0." \\' },
      { t: "cont", s: '--gen command --gen-command "bun test src/…" --expect exit-zero' },
      { t: "cmd", s: 'space goal artifact run --requirement "Focused tests pass"' },
      { t: "cmd", s: "space goal status" },
      { t: "out", s: "Ready: all required artifacts passed judgment." },
    ],
  },
  {
    name: "space-chain",
    group: "plan",
    blurb: "chain goals into a delivery plan",
    desc: "Plan and operate a stacked chain of GitSpace goals — planned vs workspace-backed, phase progression, ancestor-blocked descendants, and stack alignment.",
    about:
      "A chain is a linear sequence of goals, each planned or workspace-backed, advancing plan → code → review → ship. Stack alignment is git-level and independent of phase: a `needs-rebase` edge means the agent has rebase work to do.",
    quote: "A descendant cannot outpace an ancestor. Moving an ancestor backward requires a cascade.",
    example: [
      { t: "cmd", s: "space chain show" },
      { t: "cmd", s: 'space chain add-after --goal billing-schema --title "Backfill job"' },
      { t: "cmd", s: "space chain create-workspace --goal billing-ui" },
      { t: "cmd", s: "space stack status" },
      { t: "comment", s: "# per edge: aligned | needs-rebase | missing-workspace | dirty-worktree" },
    ],
  },
  {
    name: "phase-journal",
    group: "build",
    blurb: "declare intent, record outcome, every phase",
    desc: "Journal workflow phases at their boundaries — declare intent at phase start, record outcome at phase end. The system snapshots goal/workflow/review state and auto-commits; you only write the narrative.",
    about:
      "You write intent before the work, honestly. The review guide quotes it verbatim. phase-start prints the phase's owed contract; phase-end stays blocked until every owed required requirement is accepted.",
    quote: "You narrate; the system snapshots.",
    example: [
      { t: "cmd", s: 'gssh space journal phase-start --phase "<short phase name>" \\' },
      { t: "cont", s: '--intent "<what you\'re about to do, why, and what you expect to touch>"' },
      { t: "comment", s: "# … the phase's work happens …" },
      { t: "cmd", s: "gssh space journal phase-end \\" },
      { t: "cont", s: '--outcome "<first line becomes the commit headline>" \\' },
      { t: "cont", s: '--decision "<notable choice>" --surprise "<anything unexpected>"' },
    ],
  },
  {
    name: "space-notes",
    group: "build",
    blurb: "durable notes agents and humans share",
    desc: "Use GitSpace workspace notes as markdown context without confusing notes for verified facts.",
    about:
      "Durable markdown context shared by agents and humans: decisions, todos, leads. Notes complement the goal contract, never replace it; verify a note's claims against repo state before acting on them.",
    quote: "Treat notes as leads until confirmed against current repo state, command output, or user instruction.",
    example: [
      { t: "cmd", s: 'space notes add --body "Routing decision: connectors go through the anchor map."' },
      { t: "cmd", s: "space notes add --stdin --todo --priority high" },
      { t: "cmd", s: "space notes list --format json" },
      { t: "cmd", s: "space notes done --id <id>" },
    ],
  },
  {
    name: "space-artifacts",
    group: "build",
    blurb: "capture evidence into the artifacts repo",
    desc: "The workspace artifacts filesystem — the goal-keyed tree at .gitspace/artifacts, every artifact kind and its contract, local:// drafts + promote, and share links.",
    about:
      ".gitspace/artifacts is a real git worktree: one disjoint folder per goal, so roll-up merges are mechanically conflict-free. Draft as typeless local:// files; promoting is the moment a draft gains a type and becomes visible to the product.",
    quote: "Could a future agent (or reviewer) reconstruct WHY from what you left behind?",
    example: [
      { t: "cmd", s: 'p="$(space artifacts scratch-path local://PLAN.md)"' },
      { t: "cmd", s: "space artifacts promote local://PLAN.md reports/my-findings.report.json" },
      { t: "cmd", s: 'space artifacts commit reports/my-findings.report.json -m "capture findings"' },
      { t: "cmd", s: "space artifacts share local://PLAN.md --ttl 7d" },
    ],
  },
  {
    name: "space-review",
    group: "review",
    blurb: "run the rubric; attach the evidence",
    desc: "Review GitSpace workspace changes with grounded evidence and focused verification.",
    about:
      "Findings belong in review threads anchored to hunks, lines, or files, not only in prose. Threads round-trip with GitHub PRs: import before reviewing so you don't re-raise what a human already raised; push one formal review when done.",
    quote: "Do not present compile success as correctness.",
    example: [
      { t: "cmd", s: "space review hunks src/core/goal-validation.ts --format text" },
      { t: "cmd", s: "space review add-hunk src/core/goal-validation.ts --index 2 \\" },
      { t: "cont", s: '--reject --body "Re-executes the suite when commands drift"' },
      { t: "cmd", s: "space review import --pr 42" },
      { t: "cmd", s: "space review push --pr 42" },
    ],
  },
  {
    name: "review-guide-narrator",
    group: "review",
    blurb: "narrate the diff as a build-order story",
    desc: "Write the guided review for this workspace's diff as a build-order story — the analyzer computes structure (foundations → exposers → wiring → surfaces → tests), you narrate each beat, grounded in the phase journal.",
    about:
      "The analyzer pre-splits the diff into build-order beats; you narrate only the stale clusters, grounding every motive in journal intent written when the work happened. Never invent motives; never reorder sections.",
    quote: "The story of HOW THE CHANGE WAS BUILT, not a file inventory.",
    example: [
      { t: "cmd", s: "gssh space guide analyze" },
      { t: "comment", s: "# read .gitspace/artifacts/goals/*/review/analysis.json, narrate stale beats" },
      { t: "cmd", s: "gssh space guide submit --file sections.json" },
      { t: "cmd", s: "gssh space guide show" },
    ],
  },
  {
    name: "space-run-process",
    group: "operate",
    blurb: "start and watch services, safely",
    desc: "Run and inspect GitSpace workspace processes without masking startup, readiness, or crash failures.",
    about:
      "Prefer the workspace's process abstraction over ad-hoc shell commands. The state ladder is configured → started → running → ready. Only readiness proof (health check, URL response, or explicit ready event) counts as success.",
    quote: "Starting a process is not success; readiness is success.",
    example: [
      { t: "cmd", s: "space service list" },
      { t: "cmd", s: "space service start --name web" },
      { t: "cmd", s: "space service attach --name web" },
      { t: "cmd", s: "space service open --name web --local" },
    ],
  },
  {
    name: "space-process-config",
    group: "operate",
    blurb: "declare what a workspace needs running",
    desc: "Configure and start GitSpace workspace processes with explicit ports, health checks, and observable events.",
    about:
      "A process config must say how the process starts, how it picks a port, and how to detect readiness. The loader won't catch mistakes. After editing, verify the behavior you configured actually happens (kill the process; confirm it really restarts).",
    quote: "Do not hide port selection.",
    example: [
      { t: "comment", s: "# .gitspace/processes.json" },
      { t: "out", s: '{ "processes": [{' },
      { t: "out", s: '    "name": "web", "command": "bun", "args": ["run", "dev"],' },
      { t: "out", s: '    "ports": [{ "name": "web", "protocol": "http" }],' },
      { t: "out", s: '    "events": { "enabled": true },' },
      { t: "out", s: '    "restart": { "policy": "on-failure", "maxAttempts": 5 } }] }' },
    ],
  },
  {
    name: "space-event-logs",
    group: "operate",
    blurb: "read the workspace's event history",
    desc: "Use GitSpace structured event logs to understand process lifecycle, readiness, errors, and correlated workflows.",
    about:
      "Prefix-based wide events (process.start → process.url → process.ready → process.exit) with correlation ids to follow one workflow across events. Saved excerpts become goal evidence when attached to a requirement.",
    quote: "Do not infer success from absence of errors.",
    example: [
      { t: "cmd", s: "space events tail --process web --level error --limit 50" },
      { t: "cmd", s: "space events list --correlation-id req_123 --limit 200" },
      { t: "cmd", s: "space events tail --correlation-id req_123 --follow" },
    ],
  },
];

const GROUPS: Array<{ id: SkillDef["group"]; label: string }> = [
  { id: "plan", label: "PLAN" },
  { id: "build", label: "BUILD" },
  { id: "review", label: "REVIEW" },
  { id: "operate", label: "OPERATE" },
];

const C = {
  border: "#1a1a1a",
  green: "#00ff66",
};

function CommandBlock({ lines }: { lines: CmdLine[] }) {
  return (
    <div
      className="border bg-[#050505] p-4 overflow-x-auto font-mono text-[12px] leading-[1.7]"
      style={{ borderColor: "#111111" }}
    >
      <pre className="min-w-max">
        {lines.map((l, i) => (
          <div key={i}>
            {l.t === "cmd" && (
              <>
                <span style={{ color: C.green }}>$ </span>
                <span className="text-zinc-200">{l.s}</span>
              </>
            )}
            {l.t === "cont" && <span className="text-zinc-200">{"    " + l.s}</span>}
            {l.t === "comment" && <span className="text-zinc-600">{l.s}</span>}
            {l.t === "out" && <span className="text-zinc-500">{l.s}</span>}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function SkillsSection() {
  const [selected, setSelected] = useState(SKILLS[0].name);
  const idx = SKILLS.findIndex((s) => s.name === selected);
  const skill = SKILLS[idx] ?? SKILLS[0];

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(SKILLS.length - 1, next));
    setSelected(SKILLS[clamped].name);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(SKILLS.length - 1);
    }
  };

  return (
    <>
      {/* ── SKILLS: the flow ships as agent skills ──────────────────── */}
      <section className="py-24 px-4">
        <style>{`
          @keyframes skillsCaretBlink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
          @keyframes skillsPanelIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        `}</style>
        <div className="container mx-auto max-w-6xl">
          <div className="mb-10 max-w-3xl">
            <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">Ships with skills</div>
            <h2 className="text-3xl md:text-5xl font-bold mb-4 [text-wrap:balance]">The flow ships as skills.</h2>
            <p className="text-lg text-zinc-400 leading-relaxed [text-wrap:pretty]">
              Fleet Green isn’t a doc your agents are supposed to read. The harness installs skills in every agent.
              The skills teach the flow as actions: journal the phase, narrate the review, capture the evidence. Your
              fleet already knows the choreography.
            </p>
          </div>

          {/* the explorer */}
          <div className="border bg-black" style={{ borderColor: C.border }}>
            {/* chrome bar */}
            <div
              className="flex items-center font-mono text-[11px] h-10 px-4 gap-2"
              style={{ background: "#050505", borderBottom: `1px solid ${C.border}` }}
            >
              <span style={{ width: 8, height: 14, background: C.green, display: "inline-block" }} />
              <span className="font-semibold text-zinc-200">skills</span>
              <span className="text-zinc-600 hidden sm:inline truncate">src/lib/tmux-lite/agents/skills/</span>
              <span className="ml-auto text-zinc-600 tabular-nums whitespace-nowrap">
                {SKILLS.length} skills · installed into every agent
              </span>
            </div>

            {/* mobile: horizontal chip rail */}
            <div
              className="flex md:hidden overflow-x-auto font-mono text-[11px]"
              style={{ borderBottom: `1px solid ${C.border}` }}
              role="tablist"
              aria-label="Agent skills"
            >
              {SKILLS.map((s) => {
                const active = s.name === selected;
                return (
                  <button
                    key={s.name}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelected(s.name)}
                    className="px-3 py-2.5 whitespace-nowrap border-r transition-colors"
                    style={{
                      borderColor: C.border,
                      color: active ? C.green : "#71717a",
                      background: active ? "#0a0a0a" : "transparent",
                      boxShadow: active ? `inset 0 -2px 0 ${C.green}` : "none",
                    }}
                  >
                    /{s.name}
                  </button>
                );
              })}
            </div>

            <div className="flex">
              {/* desktop: skill list */}
              <div
                className="hidden md:block w-[250px] shrink-0 py-2 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#00ff66]/50 -outline-offset-1"
                style={{ borderRight: `1px solid ${C.border}` }}
                role="listbox"
                aria-label="Agent skills"
                aria-activedescendant={`skill-opt-${selected}`}
                tabIndex={0}
                onKeyDown={onListKeyDown}
              >
                {GROUPS.map((g) => (
                  <div key={g.id}>
                    <div className="px-4 pt-3 pb-1 font-mono text-[10px] tracking-[0.2em] text-zinc-600">{g.label}</div>
                    {SKILLS.filter((s) => s.group === g.id).map((s) => {
                      const active = s.name === selected;
                      return (
                        <button
                          key={s.name}
                          id={`skill-opt-${s.name}`}
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          onClick={() => setSelected(s.name)}
                          className="w-full text-left flex items-center min-h-[40px] px-4 font-mono text-[12px] transition-colors"
                          style={{
                            color: active ? C.green : "#71717a",
                            background: active ? "#0a0a0a" : "transparent",
                            boxShadow: active ? `inset 2px 0 0 ${C.green}` : "none",
                          }}
                        >
                          /{s.name}
                        </button>
                      );
                    })}
                  </div>
                ))}
                <div className="px-4 pt-4 pb-2 font-mono text-[10px] text-zinc-700">↑↓ to browse</div>
              </div>

              {/* the skill's page */}
              <div className="flex-1 min-w-0 md:min-h-[460px]">
                {/* panel header */}
                <div
                  className="flex items-center gap-2 px-4 sm:px-5 py-3.5 font-mono text-[13px]"
                  style={{ borderBottom: `1px solid ${C.border}` }}
                >
                  <span style={{ color: C.green }}>/{skill.name}</span>
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 14,
                      background: C.green,
                      display: "inline-block",
                      animation: "skillsCaretBlink 1.1s step-end infinite",
                    }}
                  />
                  <span className="ml-auto text-[10px] text-zinc-600 tabular-nums whitespace-nowrap">
                    SKILL.md · {idx + 1}/{SKILLS.length}
                  </span>
                </div>

                {/* panel body — re-keyed per skill so the enter animation runs */}
                <div key={skill.name} className="px-4 sm:px-5 py-5 space-y-5">
                  <div style={{ animation: "skillsPanelIn 0.24s cubic-bezier(0.2, 0, 0, 1) both" }}>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-600 mb-2">DESCRIPTION</div>
                    <p className="text-[14px] text-zinc-300 leading-relaxed [text-wrap:pretty]">{skill.desc}</p>
                    <p className="mt-2 text-[13px] text-zinc-500 leading-relaxed [text-wrap:pretty]">{skill.about}</p>
                  </div>

                  <div style={{ animation: "skillsPanelIn 0.24s cubic-bezier(0.2, 0, 0, 1) 0.04s both" }}>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-600 mb-2">CONTRACT</div>
                    <p
                      className="text-[13px] text-zinc-400 leading-relaxed pl-3"
                      style={{ borderLeft: `2px solid ${C.green}66` }}
                    >
                      “{skill.quote}”
                    </p>
                  </div>

                  <div style={{ animation: "skillsPanelIn 0.24s cubic-bezier(0.2, 0, 0, 1) 0.08s both" }}>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-600 mb-2">EXAMPLE</div>
                    <CommandBlock lines={skill.example} />
                    <div className="mt-2 font-mono text-[10px] text-zinc-700 truncate">
                      src/lib/tmux-lite/agents/skills/{skill.name}/SKILL.md
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
