# GitSpace · Nº 02 — evidence-not-vibes

The episode's semantic home: video, VO, blog, and assets all hang off this doc.

## Story (two acts, 120bpm grid, deck bookends)

**ACT 1 — SET THE BAR.** Before an agent starts, you agree on what *done* means.
On the planning surface a HUMAN sets the bar in green (#00ff66 = the human's
authorship): "Refactor checkout. I need proof, not a summary. Write the checks
so you can't game them." Then the AGENT authors the rubric in blue (#4488ff =
the agent's authorship): two requirements land — (1) *Checkout suite passes* ·
kind test-output · judge command · expect exit-zero; (2) *Checkout flow works*
· kind VIDEO · judge human. As it talks, the agent's `space goal requirement
add …` commands stream in a side panel, tagged "agent ran" (never a `$` prompt
a human typed). Each requirement's judge is aimed at what matters.

**ACT 2 — NOW PROVE IT.** The camera moves into the checkout-refactor workspace,
whose chrome-bar chip and card are BLUE — idle, your move (ep01 continuity: blue
= waiting on you, NOT amber). The agent's last line: `done · ready for your
review`. A cursor walks the rubric: requirement 1's command judge streams `bun
test src/checkout` → `142 passed · exit 0`, the row blooms ACCEPTED (green);
requirement 2's VIDEO tile plays a synthetic checkout clip (line item →
subtotal → tax → total → the green Pay button presses), the row blooms ACCEPTED
via the human judge. A highlight lands on each judge showing what it was aimed
at ("the checkout suite specifically" / "the rendered order total") — was the
reviewer looking at the right thing. Readiness types green: "Ready: all
required artifacts passed judgment."

**DECK OUTRO.** The accepted review board re-racks into the deck; the title
card types "Evidence, not vibes." then the stinger types green: "I need proof."

## VO script (PLACEHOLDER — caption timings are stand-ins; retime to vo-02.wav)

> Act 1: Before it starts, we agree on what done means. I set the bar. The
> agent writes the checks. A test that has to pass. A video of the feature
> working. A judge on each, aimed at what matters.
> Act 2: This agent says it's done. Now it has to prove it. Cool, this test
> passes. And this video looks like what we wanted. The reviewer was looking at
> the right thing. Every check accepted.
> Stinger (typed, not captioned): I need proof.

- No VO recorded yet. `index.tsx` leaves a commented `<Audio>` slot for
  `vo-02.wav`; MAIN_CAPTIONS carry placeholder word timings on the 120bpm grid.
- Master the recording with the chain in ../../README.md → `./vo.wav`, then
  retime MAIN_CAPTIONS to the read's silencedetect phrase boundaries and set
  VO_SEGMENTS for pad ducking.

## Design language (reused from ep01 wholesale)

- Deck bookends (`Deck.tsx`), chrome bar (`scenes/ChromeBar.tsx`), theme tokens,
  Pip/Cursor/typed/pulse, KineticCaptions.
- Review-beat content/layout ported (not imported) from the landing page's
  stage-04 review UI (`landing-page/.../ProcessSection.tsx`): requirement rows,
  evidence chips, judging → accepted states, screenshot/video thumbnail,
  readiness sentence.

## Sound (synthesized palette, reused)

pad (ducked) · riser · thunk (card select) · droplet-blue (workspace goes idle)
· bloom-flags + bloom-docs (the two accept-blooms) · sparkle (readiness type +
deck-back) · whoosh (act transition + outro) · click (cursor) · key thocks
(human line, command judge, readiness, tagline, stinger). No new samples.

## Compositions & render

- `ep02-evidence` — 16:9 hero, 720f @30fps (24s). `bun run render:02` →
  `../out/02-evidence.mp4`
- `ep02-evidence-og` — 1200×630 still. `bun run og:02` → `../out/02-evidence-og.png`
- A 9:16 `ep02-evidence-tok` is deferred (ep01's Tok pattern applies).
