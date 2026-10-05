# Focused type review

Use these questions when reviewing a changed type boundary or diagnosing lost
information. If the request is review-only, report findings without editing.

## Inspect the actual boundary

Start with changed declarations and their direct callers. Use `xd://lsp`
references and definitions, then inspect the canonical owner (`protocol-*`
schema, result-rpc contract, SDK `.d.ts`). Compilation proves assignability,
not common ownership.

1. What system owns this concept? Is the new shape the same concept or only
   structurally similar?
2. Does it import or derive from that owner, or does an intentionally different
   representation have an explicit mapper?
3. Are branded IDs, constraints, discriminants, literal keys and callback
   correlations preserved through local and exported signatures?
4. Does absence keep its meaning, or has a fallback or blanket `Partial`
   invented a fact?
5. Does each real ingress run the owner's zod schema and use the parsed data?
6. Are expected errors carried as owner `TaggedError` results rather than
   thrown, swallowed or turned into false success?
7. Does every assertion or predicate prove its claim? Are generics
   constructible without caller-chosen result types or widened `unknown`
   parameters?
8. Have callers and meaningful type tests moved to the intended contract?

A type error does not by itself mean the declaration is wrong. Establish the
intended behavior and fix the caller, owner signature or representation
responsible.

## Findings that matter

Report a concrete owner, the disconnected or weakened declaration, a plausible
failure and a precise repair. Examples: copied SDK options, a hand-written type
shadowing a zod schema, an ID widened to `string`, an optional bag allowing
contradictory states, a generic result unconnected to its input, a default
hiding missing required data, a stored row cast instead of parsed.

Intentional wire, view, form and storage projections are legitimate when their
purpose and mapping are clear. Do not demand wrappers, brands or tests only to
improve a score. Keep findings concise and evidence-backed.
