---
name: blog-humanize
description: Use when the user wants to add their own voice to a blog post draft. Runs a live-reaction loop, the user reads the draft and dumps raw reactions, then the draft is rewritten around those reactions. Their words replace polished words. Invoke after a draft exists, before publishing.
---

# Humanize a blog post

A draft written by an agent reads like an agent wrote it. This flow fixes that
by harvesting the user's live, unfiltered reactions and rebuilding the prose
around them. The user's throwaway phrasing is the product; the polished draft
is scaffolding.

## The loop

### 1. Set up the read

Open the draft in the browser. Tell the user:

> Read it top to bottom. As you go, dump reactions in chat, raw and unedited.
> Anything counts: "lol", "boring", "i'd never say this", "this reminds me of
> the time...", "cut this", "more of this". Prefix with the section heading or
> paste a phrase so I can place it. Don't fix anything yourself, just react.

Voice works too: if they have a transcript from talking through the post,
accept it as-is.

### 2. Map reactions to sections

Build a table: section → reaction(s) → signal. Signals:

- **Lit up** (laughed, "yes", "exactly", told a story) → expand, keep their energy
- **Bored** ("meh", skimmed, no comment on a long section) → cut hard or kill
- **Disowned** ("i'd never say this", "sounds like AI") → rewrite in their words
- **Corrected** (gave a fact, a number, an opinion) → their version wins, verbatim where possible
- **Story** (an anecdote surfaced) → this becomes a centerpiece, not a footnote

### 3. Rewrite

- Splice their exact phrases into the prose. Do not smooth their grammar; a
  slightly crooked sentence in their voice beats a straight one in yours.
- Sections nobody reacted to are suspect. Shorten them and note it.
- Where a personal story would land but none surfaced, ask. At most two or
  three targeted questions, e.g. "Was there a specific night an agent sat
  idle for hours while you thought it was working?" Never invent an anecdote.
- Run the blog-writing skill rules as the final pass, but their voice
  overrides the rules: if they say "supercharge" in real life, it stays.

### 4. Show the delta

Present a short per-section summary of what changed and why, quoting the
reaction that drove each change. Then let them run the loop again on the new
draft. Two rounds is typical; stop when reactions turn into "ship it".

## Rules

- Never publish or commit the humanized draft without the user reading the
  final version.
- Keep every reaction quote in the working notes; do not paraphrase them away.
- If reactions conflict with facts in the draft, the user's claim wins in the
  prose, but verify numbers before publishing and flag mismatches.
