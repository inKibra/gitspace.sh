# gitspace.sh — site thesis

What this site is for, agreed before any rewrite. Update this doc when the
positioning moves; the site follows it, not the other way around.

## The one-liner (from the inkibra draft, our anchor)

> "An independent engineering harness for planning, context, implementation,
> review, and AI-assisted software delivery."

gitspace.sh exists to establish credibility in the harness space. The proof:
inkibra (which owns GitSpace) used it to stand up an agent factory for real
client work. The site shows the working tool and the prescribed flow; it does
not sell services, but it must fit the inkibra universe and hand off cleanly.

## The universe

- **inkibra.com** — "AI systems built for control." Services (Zerbly, custom
  extensions, product engineering, private deployment, audits) + products
  (AI Construct API, Zerbly, ToneTempo, Gitspace). Process: Understand →
  Design → Build → Evolve. CTA: "Talk to us."
- **gitspace.sh** — the independent harness. Product-first, own brand,
  "by inkibra" quietly. Enterprise tier hands off to inkibra's agent-factory
  engagement (mailto/contact into inkibra).
- Shared vocabulary: *control*. inkibra sells systems built for control;
  gitspace demonstrates agents under control (the fleet console, idle vs.
  question states, answer the ambers). The blog thesis IS the control story.

## What GitSpace is now (not what the old site says)

Not "worktrees + remote terminal." A lifecycle harness:

1. **Plan** — goals, chains, plans as artifacts humans and agents both read
2. **Context** — workspaces (worktrees), bundles, scripts, Linear
3. **Implement** — the agent fleet: strip, states (running / idle / asked-you-
   a-question), ask forms, remote access, E2E relay
4. **Review** — rubrics, command-judge evidence, change guides, phase journal,
   agent blame
5. **Deliver & operate** — ship, project view, operations management for
   shipped goals

The prescribed flow is the centerpiece (the HumanLayer lesson: methodology
first, features second). It needs a NAME (open decision below).

## Pricing story (honest version)

| Tier | Status | What it is |
|---|---|---|
| Open Source Preview | Now | Whole tool, self-hosted. "Open code" / source-available — NOT "MIT" (license has a non-compete clause; never claim OSI open source) |
| Self-Service Cloud | Coming soon | Hosted relay + gitspace.sh subdomains |
| Enterprise Rollout | Contact | The inkibra engagement: agent factory standup, private deployment, the dev-shop. This is the actual revenue story |

## Site map v2

1. Hero — fleet console + video (Nº 01), claim built on "harness for
   planning → delivery under control"
2. The prescribed flow — named methodology walkthrough (plan → context →
   implement → review → operate), each stage with a real UI proof
3. The fleet (implement stage deep-dive) — the strip, states, ask forms;
   reuse blog demos/assets
4. Review & evidence — rubrics, change guides, agent blame
5. Credibility — "Built by inkibra to run its agent factory for client work"
   (one honest block; no fake testimonials)
6. Open + self-host + security (fix license wording)
7. Pricing (three honest tiers above)
8. Blog (the thought-leadership layer; Nº series)
9. Footer — quiet inkibra links (About/Company → inkibra.com; Blog → /blog)

## Kill list (from the audit)

- Roadmap section (CI/CD, Firecracker deploys) — not being built
- Git Stack (pricing + comparison) — dead concept
- Fake testimonials (UseCases)
- "All MIT licensed" claim
- VS Code / Slack "planned" checkboxes
- Footer Blog → inkibra.com/ink/blog (now /blog)
- Stale "Coming Soon" on shipped subdomains

## Blog slate (the Nº series — each post = essay + interactive demos + film)

Each post owns one stage of the Fleet Green flow. The video episode, the blog
demos, and the site section for that stage all ship together and cross-link.

- **Nº 01 · Implement — "Babysitting agents sucks."** SHIPPED. The strip,
  idle vs. question, answer the ambers. Film + 4 interactive demos live.
- **Nº 02 · Review — "Evidence, not vibes."** Hook: "'Looks good to me' is
  not a review when the author is a machine." Demos: a live rubric you can
  run (checks fire command judges, captured output appears as evidence); an
  agent-blame game (here's a diff — which conceptual change produced it?);
  a change-guide explorer. Film ep02: amber → review → evidence → merge.
- **Nº 03 · Operate — "Shipped isn't done."** Hook: merge is the midpoint;
  goals have an afterlife. Demos: project view across goals; a shipped goal
  reopening on a regression signal; the board the morning after shipping.
- (Reserve: Nº 04 · Plan — "State the goal." Goal chains, plans as artifacts
  both humans and agents read.)

## Content inventory (raw material for site sections + posts)

- **Shipped skills** (src/lib/tmux-lite/agents/skills/): space-goal, space-chain,
  phase-journal, space-notes, space-artifacts, space-review,
  review-guide-narrator, space-run-process, space-process-config,
  space-event-logs. Featured on v2 ("The flow ships as skills"). Each is also
  a potential post section (the skill IS the prescription).
- **omp (omp.sh)**: the agent runtime; say it proudly. Talking points: "the
  coding agent with the IDE wired in", LSP on every write (53 servers),
  DAP real debugger (14 adapters), benchmaxxed edit formats with published
  receipts (e.g. Grok Code Fast pass@1 6.7%→68.3%), eval kernels that call
  agent tools, TTSR stream rules, 40+ providers, MIT, built on Pi. Featured
  on v2 ("Proudly built on omp").
- **HTML mocks in the workspace** (future post/section material):
  docs/agent-blame.html (→ Nº 02 review/blame), docs/agent-surfaces-mockup.html,
  workspace-chain-kanban-ux.html (→ Nº 03/04 chains + board),
  workspace-notes-ui-mockup.html, workspace-delete-taskbar-ux.html.

## Design language (the migration rule)

The site adopts the app's system, elevated: flat black (#000/#080808), 1px
#1a1a1a hairlines, SQUARE corners (no rounded), mono kickers and UI text,
product status hexes inside product shots (#00ff66 / #ffcc00 / #4488ff),
square status pips (the app's pips are square, not round). Rounded-corner
zinc cards are the OLD language — migrate on touch. Done: v2 sections,
ProductShots, Security, Pricing. Remaining: Navbar, Footer, Features,
Comparison, CTA, blog demo islands.

## Open decisions (provisional picks marked ▸, pending Bradley's confirmation)

1. **Name the prescribed flow.** ▸ "Fleet Green" — already the video tagline,
   blog thesis, and asset motif. (Alternatives considered: "the Goal Chain,"
   unnamed.)
2. **Enterprise handoff mechanics.** ▸ /enterprise page framing the
   agent-factory engagement, then linking to inkibra. (Interim: mailto.)
3. **PM/lifecycle story prominence.** ▸ Stage-level ("operate" stage of the
   flow), not hero-level, while the ops features are young.
