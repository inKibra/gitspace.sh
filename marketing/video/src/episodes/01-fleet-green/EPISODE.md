# GitSpace · Nº 01 — fleet-green

The episode's semantic home: video, VO, blog, and assets all hang off this doc.

## Story

Babysitting agents doesn't have to suck. The workspace strip shows the whole
fleet while you work; blue = idle (waiting on you), amber = asked you a
question. The user — on camera, cursor visible — answers the question through
the real AskFormDialog and nudges the idle agent through the message box.
Fleet converges green. No errors shown, nothing resolves itself.

## VO script (recorded by Bradley, take 1)

> Babysitting agents doesn't have to suck.
> This is your fleet.
> Blue means idle. Amber means it has a question.
> One answer… one nudge… and everything's moving again.
> Keep your fleet green.

- Source take: `vo-take1-lead2000.webm` (2s lead), mastered → `./vo.wav`
  (−14 LUFS / −1.5 dBTP; chain in ../../README.md)
- Caption word timings in `index.tsx` MAIN_CAPTIONS follow the read's
  silencedetect phrase boundaries; pad ducking segments in VO_SEGMENTS.

## Blog post (the long-form companion)

- Route: `/blog/babysitting-agents-sucks` (landing-page app)
- Page: `landing-page/src/episodes/01-babysitting-agents-sucks/index.tsx`
- Interactive islands: `landing-page/src/episodes/01-babysitting-agents-sucks/islands/`
  (FindTheOne, AxesPeel, WordsVsColor, ResolveFleet)
- Episode manifest: `landing-page/src/episodes/01-babysitting-agents-sucks/EPISODE.md`
- Thesis shared with the video: idle-vs-closed is the difference; color is
  enrichment; Codex-the-app is the foil (we love the model).
- Hero embed: `marketing/out/01-fleet-green.mp4` (+ `.gif` fallback).

## Assets

- `../../out/01-fleet-green.mp4` — hero (19s, VO, sound)
- `../../out/01-fleet-green.gif` — product-only cut for embeds
- `../../out/01-fleet-green-tok.mp4` — 9:16 draft (captions stale, no VO;
  parked pending a decision on vertical framing)
