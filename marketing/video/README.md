# GitSpace video series ("GitSpace · Nº NN")

Remotion workspace for the marketing video series. Each video is one "snippet
card" in the 3D deck — the deck bookends are the series device: every episode
opens by flying through the deck and selecting its card, and closes by
re-racking with "keep your fleet green." typed over it.

Episode 01: **fleet-green** — the agent strip; user resolves an idle (blue) and
a question (amber) agent by hand. Blog: `/blog/babysitting-agents-sucks`.

## Layout

```
marketing/
├── out/                  # rendered episodes: NN-<name>.mp4 / .gif
├── archive/              # superseded assets (v1 HyperFrames cuts)
└── video/
    ├── src/
    │   ├── lib/          # SHARED engine: theme.ts (brand tokens), ui.tsx
    │   │                 #   (Pip/Cursor/typed/pulse), Captions.tsx (kinetic VO captions)
    │   ├── episodes/
    │   │   └── 01-fleet-green/
    │   │       ├── EPISODE.md   # episode manifest: story, VO script, blog links, assets
    │   │       ├── index.tsx    # main comp: audio mix, camera, cursor, captions
    │   │       ├── timeline.ts  # 120bpm beat grid (BEAT=15 frames) + DECK bookends
    │   │       ├── fleet.ts     # story state machine + board/chip geometry
    │   │       ├── Deck.tsx     # 3D deck bookends + tagline
    │   │       ├── Tok.tsx      # 9:16 retention-pacing cut (snap camera)
    │   │       ├── vo.wav       # mastered episode VO (imported directly)
    │   │       └── scenes/      # Board, ChromeBar, AskDialog, FlagsDetail, DocsDetail
    │   └── Root.tsx      # registers epNN-* compositions
    ├── scripts/gen-audio.ts   # synthesizes the SHARED palette to public/audio (deterministic)
    ├── tools/record-vo.html   # teleprompter + mic recorder (muted video, cue lines)
    ├── tools/serve.ts         # serves the recorder: bun run vo → localhost:5190
    └── public/audio/          # generated shared palette (pad, cues, keys)
```

## Commands

```bash
bun run studio        # Remotion studio (all episodes)
bun run audio         # regenerate the synthesized sound palette
bun run vo            # VO recorder at http://localhost:5190
bun run render:01     # → ../out/01-fleet-green.mp4
bun run render:01:tok # → ../out/01-fleet-green-tok.mp4
bun run gif:01        # product-only GIF (deck intro cut off; GIFs murder 3D)
```

Preview a single frame fast: `bunx remotion still src/index.ts ep01-fleet-green /tmp/f.png --frame 200`

## Making episode NN

1. `cp -r src/episodes/01-fleet-green src/episodes/NN-<name>` and rewrite
   `timeline.ts` + `fleet.ts` + `scenes/` for the new story. Keep the grid:
   120 BPM, every state change / click / cut on a beat (`b(n)`).
2. Register `epNN-<name>` in `src/Root.tsx`; add `render:NN` + `gif:NN` scripts.
3. Deck: the episode's card should exist in the deck CARDS list (the deck is
   the series roster — 01's cards already tease ask-forms, agent-blame,
   phase-journal, artifacts, kanban, sessions). Point the hero card at the new
   episode's board.
4. Sounds: reuse the palette; add new cues to `scripts/gen-audio.ts`
   (synthesized only — deterministic, seeded noise, no samples).
5. VO: add the episode's script lines to `tools/record-vo.html` (LINES array,
   with cue labels + time windows), render the episode first, `bun run vo`,
   record takes, download → master with the ffmpeg chain below →
   `src/episodes/NN-<name>/vo.wav` (imported directly: `import voSrc from
   './vo.wav'`) → retime caption words to the read.
6. Write the episode's `EPISODE.md` (story, VO script, blog links, assets).

## VO mastering chain

```bash
ffmpeg -y -i ~/Downloads/vo-takeN-lead2000.webm -ss 2.0 -ar 44100 -ac 2 \
  -af "highpass=f=80,acompressor=threshold=-26dB:ratio=3:attack=8:release=120:makeup=3dB,loudnorm=I=-14:TP=-1.5:LRA=9,loudnorm=I=-14:TP=-1.5:LRA=9" \
  public/audio/vo-NN.wav
```

(−14 LUFS integrated, −1.5 dBTP. The `lead2000` suffix = 2s of recording
before video start; `-ss 2.0` trims it.) Then find phrase boundaries for
caption retiming + pad ducking:

```bash
ffmpeg -i public/audio/vo-NN.wav -af "silencedetect=noise=-35dB:d=0.3" -f null -
```

## Hard-won rules

- **TypeScript must stay pinned to 5.9.x** — TS 7 breaks Remotion's bundler.
- **Determinism**: everything is a pure function of `frame`. No Date.now, no
  Math.random (seeded PRNG in gen-audio).
- **Continuous camera paths**: one eased progress value driving all axes;
  piecewise keyframes with per-segment easing = visible hitching.
- **Click punches**: ease in 3f, hold 5f, release 20f at ~2.8% — shorter
  envelopes read as screenshake.
- **Typing sounds**: key thock every 3rd revealed character (~11/s), never
  every character (30/s buzz).
- **Cursor clicks**: hold the cursor at the target through the click window —
  a click ring firing mid-flight looks broken.
- **Match-cut math**: hero card at scale S, world translateZ lands at
  `PERSPECTIVE * (1 - S)` → card exactly fills frame.
- Amber = "asked you a question" (real AskFormDialog), blue = idle/waiting.
  NOT tool-permission prompts. The user resolves everything on camera.
