# GitSpace marketing video workspace

Read `README.md` in this directory first — it has the full structure, episode
checklist, commands, and the hard-won rules (camera continuity, punch
envelopes, typing-sound pacing, match-cut math).

Quick facts:

- Remotion + bun. TypeScript is pinned to 5.9.x — do NOT upgrade to 7 (breaks
  Remotion's bundler with `typescript.sys` undefined).
- `src/lib/` is the shared series engine; `src/episodes/NN-*/` is per-episode.
- All audio is synthesized by `scripts/gen-audio.ts` (deterministic, seeded).
  Never add sample files; regenerate with `bun run audio`.
- Rendered outputs go to `../out/NN-<name>.mp4` via `bun run render:NN`.
- Compositions must be pure functions of `frame` (Remotion determinism).
- Brand: tokens in `src/lib/theme.ts`, sampled from the product's
  `web/index.css`. Product UI shown in videos must stay faithful to the real
  components (AskFormDialog, GlobalChromeBar).
