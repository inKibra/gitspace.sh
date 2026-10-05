# Type-proof rules and positive patterns

Concrete rules for deciding whether an assertion, predicate, helper or generic
is honest. Each rule gives a one-line test, what it rejects and what to do
instead.

## Rules

### A. Only the producer may bless a value

- **Test:** a cast is admissible only when the current module owns the target
  type, the immediately preceding code constructed the value to that type's
  spec, the cast is one direct hop (`expr as T`), and no `unknown`/`any`/`never`
  waypoint appears.
- **Rejects:** `undefined as TResult`; `auth as never` to silence a union
  mismatch; `JSON.parse(row.data) as LifecycleState` on a stored row.
- **Do instead:** make the representation honest (`TResult = undefined` when
  absence is real), fix the union so the natural branch type-checks, or parse
  the row with the owner's schema.
- **Accepted:** `return context as HandlerContext` at the end of the owner
  function that just built every field from owner inputs.

### B. Predicates are casts and must be truthful

- **Test:** for `function f(x): x is T`, every property promised by `T` is
  established by the body or by an owner parser it calls.
- **Rejects:** `isRecord(v): v is Record<string, unknown>` that checks only
  `typeof v === 'object' && v !== null`, then indexes freely.
- **Do instead:** narrow the claim to what is proven, or parse with a schema.

### C. Never weaken to `unknown` after a typed boundary

- **Test:** if the caller's value already has a declared type, a new helper may
  not accept it as `unknown` unless the value is crossing a real dynamic
  boundary.
- **Do instead:** type the helper against the owner union or member.

### D. Helpers must beat direct code

- **Test:** a helper's parameter and return types preserve at least the
  precision of every direct callsite it replaces.
- **Rejects:** `failureMessage(response: { error: unknown })` replacing direct
  `.error.message`.
- **Do instead:** keep direct access, or derive the parameter from the exact
  owner type (`Extract<…>`, indexed access, `Parameters`).

### E. Owners export classifiers

- **Test:** constructors, classifiers and parsers for a type declared in
  package P live in P, not in consumers.
- **Do instead:** export them beside the schema in `protocol-*` (or the owning
  package) and import them.

### F. Reference, don't restate

- **Test:** if a type can be expressed by referring to its source
  (`Type['field']`, `typeof value`, `z.infer<typeof Schema>`, `Pick`, `Omit`,
  `Parameters`, `satisfies`, `as const`), do not hand-write it.

### G. Fix the cause, not the diagnostic

- **Test:** intended behavior, the caller and the declaration chain were
  inspected before adding a guard, cast, helper or widened parameter.
- Both callers and declarations can be wrong. Local laundering preserves the
  mismatch.

### H. Positive discriminants and exhaustiveness

- **Test:** a closed union is classified by its declared discriminant and
  handled exhaustively; `!('k' in x)` is not a primary classifier.
- **Do instead:** `result.status === 'error'`, `error._tag === 'SessionRuntimeError'`,
  `failure.code === 'AGENT_DISCONNECTED'`, or an exhaustive `switch` with a
  `never` default.

### I. Negative type tests are proof artifacts

- **Test:** an unused `@ts-expect-error` in a negative test is a widening
  regression until the forbidden program is rejected again or the invariant is
  explicitly removed by design.

### J. Seam parameters keep their variance

- **Test:** public callbacks may not replace specific parameter types with
  `unknown`, or switch to method syntax to exploit bivariance.
- **Do instead:** solve variance in the API type with an owner alias or
  factory that makes assignability true without erasure.

### K. No guard sediment

- **Test:** every guard narrows a currently possible declared variant or parses
  a dynamic boundary value; otherwise delete it.

### L. No useless assertions

- **Test:** if removing an assertion leaves the same type and no error, delete
  it.

### M. Consumer results derive from the owner value

- **Test:** changing the owner value argument mechanically changes the return
  type; callers cannot choose it independently.
- **Rejects:** `readJson<T>(key: string): T`; `decode<T>(schema: z.ZodType): T`.
- **Do instead:** `decode<S extends z.ZodType>(schema: S, raw: unknown): Result<z.output<S>, DecodeError>`.

### N. Inference evidence must be covariant

- **Test:** a generic inferred only from callback input positions is not
  trusted to preserve the concrete contract.
- **Do instead:** infer from the schema value (`S extends z.ZodType`) and
  derive `z.output<S>`; pin exactness with type tests.

### O. Hosts execute owner validators

- **Test:** every `unknown` value crossing wire, storage or IPC is validated by
  the owner's schema before user code sees it, and the parsed `.data` replaces
  the raw input.
- **Rejects:** a handler that receives the raw body although a schema exists; a
  stream that checks JSON syntax but not the event payload; a malformed frame
  silently dropped while its cursor is acknowledged.

### P. Let factories own their signature

- **Test:** if removing an annotation leaves the same inferred type, remove it.
- **Rejects:** `export const parseRun: (v: unknown) => Run = (v) => RunSchema.parse(v)`
  restating what `RunSchema` already owns.

### Q. Recoverable failures are values

- **Test:** if any caller could reasonably handle, map, retry or report the
  failure, return it in a `Result`; throw only when continuing would violate an
  established invariant.
- **Rejects:** `if (result.status === 'error') throw result.error;` inside a
  `Result.tryPromise` body; `throw new Error('not found')` for a missing record;
  catch-and-return-`undefined` where absence and failure differ.
- **Do instead:** owner `TaggedError` unions composed through `andThen`,
  `mapError`, `match`; foreign exceptions converted once in the smallest
  adapter.

### R. Signatures keep semantic types

- **Test:** any signature or contract position holding an identifier,
  timestamp or constrained value uses the owner's branded or constrained type,
  not raw `string`/`number`, including private helpers and stored records.
- **Rejects:** `function loadRun(runId: string)` when `RunId` exists; a stored
  record declaring `workspaceId: string` when the owner brands it.
- **Scope:** free-form text and unconstrained counts stay raw. The trigger is
  an existing owner type or a real recurring invariant.

## Positive patterns

### 1. Parse boundary data into proof-carrying data

Use when input is outside the type system: JSON, storage rows, relay frames,
RPC bodies, env, files, provider responses.

```ts
const parsed = LifecycleStateSchema.safeParse(JSON.parse(row.data));
if (!parsed.success) return Result.err(new StoredStateInvalid({ spaceId, issues: parsed.error.issues }));
return Result.ok(parsed.data);
```

Return the domain type, a branded value or a discriminated result. Do not
return `void` from validation when the caller needs the proof, and do not keep
`unknown` after parsing. (`JSON.parse` itself throws; contain it with
`Result.try` in the same adapter.)

### 2. Classify closed unions by positive discriminants

```ts
switch (error._tag) {
  case 'SessionWorkspaceUnavailable':
    return showUnavailable(error.workspaceId);
  case 'SessionPossessionDenied':
    return showDenied(error);
  default: {
    const exhaustive: never = error;
    return exhaustive;
  }
}
```

### 3. Export owner classifiers and smart constructors

Put `workspaceIdSchema`, `isTransientFailure`, `agentFailure(...)` beside the
owner schema. Type parameters against the real union, not `unknown`, unless the
helper is itself a boundary parser.

### 4. Derive related types from sources

```ts
type PlacementCheckout = WorkspacePlacement['checkout'];
type CreateRequest = z.input<typeof CreateWorkspaceRequestSchema>;
const route = { method: 'POST', path: '/runs' } as const satisfies RouteConfig;
```

### 5. Bind repeated type arguments once

If the same type arguments repeat at every callsite, export one bound factory
beside the owner and call it without type arguments.

### 6. Strengthen arguments instead of weakening returns

When a function cannot work for every value of its input type, either
strengthen the argument to the representation that makes it total, or return a
discriminated `Result`. Do not accept `unknown` and probe internally when every
caller already has a stronger type.

### 7. Repair root declarations at the pressure source

1. Trace the declared type back to where precision first becomes `unknown`,
   `any`, `never`, overly conditional or restated.
2. Repair that owner declaration.
3. Revert local casts, guards and helpers that only compensated for it.
4. Keep negative type tests proving the bad shape stays illegal.

### 8. Producer blessing only at the owner

```ts
const context = { workspaceId, machine, signal };
return context as HandlerContext;
```

Forbidden: `value as unknown as T`, `value as any`, `value as never`,
`undefined as T`. Consumers never bless values they received.
