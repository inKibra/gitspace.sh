# Type tests: prove accepted and rejected programs

A type test compiles a small consumer of the real contract. Its result is the
compiler accepting intended usage and rejecting forbidden usage. Runtime tests
cannot prove that a factory preserved an exact key union or that one identity
cannot stand in for another.

## What deserves a proof

- A branded ID cannot substitute for another identity or for a raw string.
- A factory preserves literal names and ties each key to its own payload.
- A discriminated union forbids a success value with failure-only fields, or
  forces handling of a new state.
- A schema's input value determines the output type; callers cannot choose an
  unrelated generic to manufacture a result.
- Two representations of one contract stay in agreement (for example a zod
  schema and the SDK schema generated from it).

Use the real exported schema, factory or contract. A hand-copied test type can
keep passing while production widens. Do not fill fixtures with
`as unknown as`, `as any`, `as never` or `stub<T>()`. Owner constructors give
honest values; `declare const` bindings are appropriate when testing
assignability without constructing a runtime value.

## Positive and negative checks belong together

A successful assignment to a broad target proves only assignability; `any`
passes it too. Assert the specific inferred type where it matters and pair it
with a forbidden call or assignment that would become legal if the relationship
widened.

```ts
import { WorkspaceIdSchema, MachineIdSchema, type WorkspaceId } from './ids.js';

declare function openWorkspace(id: WorkspaceId): void;

const workspaceId = WorkspaceIdSchema.parse('ws-1');
const machineId = MachineIdSchema.parse('m-1');
openWorkspace(workspaceId);
// @ts-expect-error a machine ID is not a workspace ID
openWorkspace(machineId);
// @ts-expect-error raw strings must go through the owner schema
openWorkspace('ws-1');
```

Put `@ts-expect-error` on the exact invalid expression with a reason naming the
invariant. Never use `@ts-ignore`, file-wide suppression or a cast to make the
negative case compile. Keep each invalid expression small so an unrelated error
cannot satisfy the directive. When adding a regression, remove the directive
once and read the diagnostic to confirm it fails for the intended reason.

An unused directive is a failed proof obligation. Trace the owner or generic
that lost precision; do not remove the test to get green. If the usage is
intentionally legal now, update the contract and both cases explicitly.

## Placement and execution

- Name compile-only fixtures `*.typecheck.ts` and place them under the package's
  `src/` (beside a single owner, or in `src/__typecheck__/` for cross-module
  proofs). Package `tsconfig.json` files include `src/**/*.ts`, so
  `tsgo --noEmit -p tsconfig.json` compiles them; tests under `test/` are not
  typechecked in most packages.
- Never import a `*.typecheck.ts` file from runtime code, and never put
  intentionally invalid calls in a `*.test.ts`.
- Do not dot-prefix fixtures: tsgo ignores leading-dot files.
- Run `bun run typecheck:packages` (or the package's `bun run typecheck`).
  `bun test` transpiles TypeScript and establishes none of these proofs.
