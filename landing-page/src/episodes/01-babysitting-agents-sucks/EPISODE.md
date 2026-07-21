# GitSpace · Nº 01 — babysitting-agents-sucks (blog side)

Long-form companion to the fleet-green video. The episode's semantic home is
the video-side manifest: `marketing/video/src/episodes/01-fleet-green/EPISODE.md`.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/` — interactive islands embedded in the post
  (FindTheOne, AxesPeel, WordsVsColor, ResolveFleet)

## Wiring

- Route: `/blog/babysitting-agents-sucks` (registered in `src/app/App.tsx`)
- Static assets: `landing-page/public/blog/`
- Hero embed: `marketing/out/01-fleet-green.mp4` (+ `.gif` fallback)
- Copy-drift tracking: `tools/track-changes.ts` watches this directory

## Thesis (shared with the video)

Idle-vs-closed is the difference; color is enrichment; Codex-the-app is the
foil (we love the model).
