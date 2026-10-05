---
name: type-system
description: Treat TypeScript as a proof engine: preserve connected owner contracts, inference, brands, unions, constraints, validation and typed failures. Use for ALL TypeScript work in GitSpace, especially type errors, assertions, predicates, generics, zod schemas, result-rpc contracts, better-result errors, SDK adapters and type tests.
---

# Type system

## The type checker is a proof engine

Types are not annotations added to JavaScript to make it compile. A declared
union rules out invalid states; a brand distinguishes identities; a generic
connects input evidence to output; a validated boundary carries proof into
trusted code. Every caller relies on those facts. Preserve that proof through
every helper, callback, factory, adapter and stored representation.

Compilation proves only what the declarations express. It cannot prove
behavior hidden behind casts, lying predicates, no-op implementations or
validators nobody runs. Runtime tests and validation complement type proofs;
neither replaces them.

Prefer `type` over `interface`, inference over redundant annotations, and
existing owner helpers over manual reconstruction. Never use `any`,
suppression, widening or casts to make a mismatch disappear.

## Find the actual mismatch

A type error is a diagnosis. Before changing code, read the owner declaration
and the direct callsites (`xd://lsp` definitions/references when available) and
trace where their relationship became false or lost precision. Correct a wrong
caller; correct a wrong declaration at its owner; simplify a representation
generic code cannot honestly construct. Natural-looking caller code does not
prove the declaration wrong. Never replace a rejected line with one the checker
cannot see through.

Do not widen a callback parameter to `unknown`, switch to method syntax to
exploit bivariance, insert shape probes, or add an unrelated result generic as
a repair. Fix the relationship, then delete the compensating casts, guards and
helpers. See [proof rules](references/type-proof-rules.md).

Existing code is not permission to extend an unsound pattern. GitSpace has
known debt (files with `as unknown as`, `as never`, `JSON.parse(...) as T` on
stored rows); do not copy it into new code, and repair it where you touch it.

## Connected types and inference

- Import the canonical type or derive it with indexed access, `Pick`/`Omit`,
  `Parameters`, `typeof`, `z.infer` or owner aliases. Never hand-repeat a domain
  union, wire shape, SDK option bag or result envelope.
- Prefer named owner-exported contracts for public APIs over `ReturnType` of an
  implementation factory. Deriving from an SDK function is fine when that is
  the SDK's only exported contract.
- Tie consumer generics to an owner value: `read<T>(schema: z.ZodType): T` lets
  the caller pick `T` and is a cast in disguise; `read<S extends z.ZodType>(schema: S): z.output<S>`
  is connected. Preserve literal keys through factories instead of widening to
  `Record<string, ...>`.
- Inference needs evidence in a covariant position. Infer from the schema value,
  not from a validator callback's input.
- Do not ship a server runtime object to the browser to recover its type. Share
  `protocol-*` contracts and result-rpc contract definitions.
- Generic code must be able to construct its representation honestly; pick a
  total representation instead of forcing a cast.

See [connectedness](references/connectedness.md).

## IDs, constraints and valid states

Brand identifiers that cross module boundaries (workspace, project, machine,
run, snapshot and conversation IDs) with zod `.brand<'…'>()` at the owning
schema, and use the brand through records, arguments, results and local
helpers. Construct a brand only through the owner's schema or constructor;
never cast a string to it or mint a consumer-local brand for an owned concept.

Use discriminated unions for distinct states rather than optional bags that
allow contradictory combinations. Branch on the declared tag positively and
exhaustively with a `never` check, so a new variant makes the compiler list
every consumer that must handle it. Never classify a closed union by missing
keys (`!('code' in value)`) or resemblance to the success case.

Encode real constraints once in the owning zod schema (`.min(1)`, `.int()`,
`.nonnegative()`, `z.iso.datetime()`, enums) and preserve them. Do not invent
constraints to look precise. Serialized timestamps are ISO strings; parse to
`Date` only where arithmetic needs it.

## Assertions, guards and boundaries

An assertion is admissible only in the owning producer that just constructed
the value to its declared spec, in one direct hop. No `as unknown as T`,
`as any`, `as never`, or casting a received object to gain indexing. Delete
assertions that change nothing. `as const` and `satisfies` keep evidence; they
are not permission to assert an unrelated domain type.

A predicate (`x is T`) is an unchecked cast: it must prove every property it
claims. Owners export reusable classifiers and constructors; consumers do not
fork them. A helper must preserve at least the precision of the direct code it
replaces. Remove guards that cannot narrow anything.

`unknown` belongs at real external boundaries only: relay frames, RPC bodies,
IPC messages, Durable Object storage rows, `JSON.parse` output, environment
variables, files, provider responses, tool arguments. If an owned API returns
`unknown` while knowing the type, fix that signature.

Validate each ingress once with the owner's zod schema (`safeParse`), then pass
`.data` inward and drop the raw value. A validation failure is an explicit
failure, never a silently dropped event with its cursor acknowledged. Keep
absent, invalid, rejected and failed distinct where the owner distinguishes
them. Use `z.strictObject`/`.strict()` only where rejecting extra keys is a real
boundary invariant.

## Errors are owned data

- Expected failures are values: `better-result` `Result` with errors defined as
  `TaggedError('Name')<{ ... }>` classes beside their contract. Domain failures
  that cross the wire serialize to their owner schema (`AgentFailure`,
  `WorkspaceFailure`: `{ domain, code, message, context }`) via `toJSON()`. Do
  not create parallel string-code taxonomies or bare `Error` unions.
- Expected failures include invalid input, missing records, conflicts,
  authorization rejection, timeout/cancellation and provider/storage/relay
  failures, even when the current function cannot resolve them.
- Compose with `Result.ok`/`Result.err`, `andThen`/`andThenAsync`, `map`,
  `mapError`, `match`, `Result.gen`. Never throw an `Err` to move it through a
  `catch`. Do not wrap infallible helpers in `Result`.
- Contain foreign throwing APIs (fetch, SDKs, `JSON.parse`, Durable Object
  storage) in the smallest owning adapter with `Result.try`/`Result.tryPromise`
  and map once into an owned error. Do not catch and rethrow at every layer.
- Map variants at the boundary that owns policy (result-rpc error contract, UI
  message, retry), exhaustively for closed unions. Never collapse distinct
  failures into a generic error or a success-shaped default.
- Throw only for broken established invariants, impossible branches or
  unrecoverable bootstrap.

## Absence and cutovers

Required facts are supplied or fail at their boundary. Meaningfully optional
facts stay optional and are interpreted where their meaning lives. A default is
valid when it is a real domain rule, not an empty-string or zero seed that
fakes a complete object. No blanket `Partial` over a required owner to justify
a merge layer. See [absence and defaults](references/absence-and-defaults.md).

Cut callers over to the intended contract and delete obsolete declarations,
aliases and compatibility paths. Never replace a required capability with a
no-op because its signature compiles.

## Type tests are executable proof obligations

Keep positive and negative compile-time tests for contracts whose precision can
regress: brand separation, literal/key preservation, correlated generics,
schema-to-type agreement and invalid union states. Exercise the real exported
schema, factory or contract, not a copied test type.

A positive assignment alone cannot detect widening to `any`; pair it with a
forbidden case under `@ts-expect-error`. An unused `@ts-expect-error` means the
forbidden program now compiles: find the lost proof; never delete the
directive to get green.

Put type tests in `src/**/*.typecheck.ts` so the package's
`tsgo --noEmit -p tsconfig.json` compiles them; run `bun run typecheck:packages`.
`bun test` transpiles and proves nothing about types. See
[type tests](references/type-tests.md).

## References

- [Connectedness](references/connectedness.md): owners, derivation, SDK adapters, intentional boundaries.
- [Proof rules](references/type-proof-rules.md): assertions, predicates, variance, representation patterns.
- [Type tests](references/type-tests.md): positive and negative compile-time contracts.
- [Absence and defaults](references/absence-and-defaults.md): required, optional and defaultable facts.
- [Review questions](references/review-rubric.md): focused ownership review of a changed boundary.
