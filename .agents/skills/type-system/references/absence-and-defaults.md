# Absence and defaults

A value that was never supplied is a different fact from a value that was
supplied. Code that replaces the first with the second destroys information at
the boundary, and nothing downstream can recover it.

**Preserve meaningful absence. A default is valid only when it expresses a real
domain rule, not when it invents a required fact to satisfy a type.**

```ts
// WRONG: the boundary decides, and "nobody configured this" is lost
return { egress: partial.egress ?? 'cloud' };

// RIGHT: absence survives; the consumer that owns the meaning resolves it
const egress = profile.egress ?? 'cloud';
```

Both lines contain `?? 'cloud'`. The difference is where: the first runs once at
load and overwrites the fact for every reader; the second runs at the point of
use, where the meaning is known, and leaves the field `undefined` for everyone
else.

## Why this is a type-system rule

A fabricated default makes a misleading contract: callers can no longer tell a
supplied fact from a placeholder. It also turns a configuration error into a
runtime mystery: `apiKey: ''` boots cleanly and fails later as a 401;
`host: 'localhost'` quietly dials the wrong machine.

## Three kinds of field

1. **Required: nothing can stand in.** Credentials, provider identities,
   service addresses, model selection, workspace and machine identity. Absence
   is a failure at the boundary naming the missing path; never `''`.
2. **Optional and meaningful: absence says something.** Feature toggles,
   optional subsystems, overrides. Keep `?:`, let `undefined` propagate, resolve
   at the point of use, and document what absence means.
3. **Genuinely defaultable: a bound nobody needs to know was chosen.** Retry
   counts, buffer sizes, safety caps. Anything naming an external system, an
   identity or a cost does not qualify.

If you cannot say which of the three a field is, it is not (3).

## The type-level form: widening an owner

Re-declaring an owner's required field as optional creates the obligation to
fabricate downstream:

```ts
// WRONG: grants permission to omit, forcing invention at every consumer
type ProfileInput = Pick<InferenceProfile, 'id'> & Partial<Pick<InferenceProfile, 'provider' | 'model'>>;
```

Correct the boundary contract instead. A partial update or unfinished form is a
separate intentional state (its own schema), not a weakened stored entity. The
same applies to a parallel `*Input`/`*Raw` type that is a blanket
`Partial<Omit<…>>` of the type it mirrors: one schema carrying each field's real
optionality removes the merge layer. Where one field genuinely differs at the
boundary, express exactly that and say why.

## Normalizing is not defaulting

Trimming a string or canonicalizing a model ID is fine: it transforms a value
that is present and leaves `undefined` alone. The test is whether the function
can invent a value where there was none.

## Review signals

- A `withDefaults`/`buildDefaults`/`mergeWithDefaults` that returns a complete
  object.
- `?? ''`, `?? 0`, `?? 'localhost'`, or any `??` whose right side names an
  external system, credential, identity or cost.
- zod `.default(...)` on a field of kind (1) or (2).
- `Partial<>` wrapping a `Pick<>` of another module's type.
- Two types for one concept, one of them all-optional.
- A test pinning an invented fallback with no product contract behind it.
