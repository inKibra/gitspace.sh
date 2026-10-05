# Type connectedness

A type is **connected** when a change to its canonical source either updates it
automatically or fails compilation at an explicit mapping boundary. Structural
assignability is not connectedness: two independently declared shapes compile
today and drift tomorrow.

## Contract

- Find the canonical owner before declaring a new type.
- Import or derive from that owner whenever the new type is the same concept or
  a mechanical projection of it.
- Preserve source identity for fields, parameters, returns, events, schemas,
  brands and SDK contracts.
- Use an explicit mapper plus validation when a boundary intentionally
  decouples its wire or storage model.
- Never copy an external package's request, response, event, session, options
  or module interface to make an adapter compile.

## GitSpace owners

| Concept | Owner | Consumers |
|---|---|---|
| Wire and domain contracts (relay frames, RPC payloads, environment, lifecycle, workspace, agent failures) | zod schemas in `packages/protocol*/src`; types via `z.infer`/`z.input`/`z.output` | Import the schema or its inferred type; never restate the shape |
| RPC procedures and their error contracts | result-rpc contract definitions | Server handlers and `result-rpc/client`/`result-rpc/react` callers use the contract's inferred types |
| Expected errors | `TaggedError` classes beside their contract (for example `protocol-agent/src/errors.ts`) | Match on `_tag`; serialize through the class's `toJSON()` to the owner failure schema |
| Durable Object and SQLite rows | The schema of the record being stored | Parse rows on read; do not cast `JSON.parse` output |
| Agent SDK types (OMP today; Pi after the runtime cutover) | The SDK's exported types | Only the adapter package imports the SDK; it maps SDK values into GitSpace contracts |
| UI state that mirrors server data | The protocol contract | Components take derived types, not hand-copied props |

## Workflow

### 1. Locate the owner

1. Search for the concept, field names, producer and consumer.
2. Use `xd://lsp` definition/references for existing symbols; do not infer
   ownership from a similar name.
3. Check package exports, `protocol-*` schemas, result-rpc contracts and the
   dependency's own `.d.ts` exports.
4. Identify the system that can authoritatively change the data.

If no owner exists, create one at the narrowest package that owns the concept.
Do not create a shared type because two small shapes happen to match.

### 2. Choose the strongest connection

| Need | Connected form |
|---|---|
| Same contract under another name | `type Local = Canonical` or import it directly |
| Schema-owned contract | `z.infer<typeof Schema>`; `z.input` for pre-transform input |
| One field | `Canonical['field']`, `Canonical['parent']['field']` |
| Subset or removal | `Pick<Canonical, 'a' \| 'b'>`, `Omit<Canonical, 'internal'>`, or `Schema.pick({...})` |
| Superset | `Canonical & { extra: Extra }` or `Schema.extend({...})` |
| Union member | `Extract<Union, { kind: 'x' }>` |
| Function input or output | `Parameters<typeof fn>[N]`, `Awaited<ReturnType<typeof fn>>` (only when the function is the owner's sole contract) |
| Dynamically loaded SDK | top-level `import type`; keep only the runtime value import dynamic |
| Stable external boundary | explicit local DTO plus SDK-to-domain mapper, validation and a contract test |

### 3. Keep intentional boundaries explicit

A copied shape is not an anti-corruption layer. An intentional local DTO needs:

- a distinct purpose and owner;
- an explicit conversion function at the boundary;
- validation of untrusted input where applicable;
- `satisfies` or a type test against the source contract when compile-time
  connection is possible;
- a comment stating why direct reuse is wrong;
- no broad cast or whole-object spread hiding unmapped fields.

Prefer field-by-field mapping so provider additions and removals are visible.

### 4. SDK adapters and dynamic imports

The dependency owns its input, output, callback, event and module shapes.

```ts
import type { createAgentSession } from '@oh-my-pi/pi-coding-agent';

type CreateSession = typeof createAgentSession;
type CreateSessionOptions = Parameters<CreateSession>[0];
type Session = Awaited<ReturnType<CreateSession>>;

async function startSession(options: CreateSessionOptions): Promise<Session> {
  const { createAgentSession } = await import('@oh-my-pi/pi-coding-agent');
  return createAgentSession(options);
}
```

Prefer exported SDK types when available. If the SDK exposes no stable type,
isolate the minimum `unknown` at one adapter, validate it and map it into a
GitSpace-owned type. Never reproduce the dependency's module as a local
index-signature facade.

When one value is both an SDK schema and a GitSpace contract (for example a
tool's parameters that are also a protocol payload), keep one owner: the zod
schema, converted for the SDK with `z.toJSONSchema(Schema)`.

### 5. Cut over every caller

1. Export the canonical type if it is not public.
2. Replace every shadow declaration and hand-written field type.
3. Update imports and callers; use LSP references for exported symbols.
4. Delete obsolete declarations, casts and aliases that only preserve the old
   path.
5. Run `bun run typecheck:packages` and the focused tests.

## High-confidence smells

- The same exported type name and shape appears twice.
- Two types share three or more domain fields and differ only in order.
- A local `*Options`, `*Event`, `*Session`, `*Response`, `*Request`, `*Config`,
  `*Payload` or `*Result` type sits in a file that imports the package it
  models.
- A type repeats a producer's parameter or return shape.
- A zod schema and a hand-written `type` describe the same payload.
- A signature widens an owner's branded or constrained type to its primitive.
- A derived type re-declares an owner's required field as optional to enable a
  defaults layer.
- A parallel `*Input`/`*Raw` type is a blanket `Partial` of the type it mirrors.

## False positives

Do not consolidate solely because two bounded contexts both use `{ id, name }`,
request and response DTOs match today, a wire or storage projection
deliberately turns brands or dates into strings, union variants share envelope
fields, or generated files mirror a schema. Keep those boundaries explicit and
connect them through a mapper, derived field types, validation or a type test.

For syntactic candidate searches, use the `ast-grep` skill; confirm every
candidate through symbols, imports and callsites before changing code.

## Checklist

- [ ] Canonical owner identified for every new boundary-facing type.
- [ ] Existing schema, contract or SDK type reused where semantically identical.
- [ ] Mechanical variants use derivation, not copied fields.
- [ ] Intentional DTO boundaries have explicit mapping and validation.
- [ ] No broad cast, index signature or spread hides drift.
- [ ] Signatures preserve owner semantic types through the whole call chain.
- [ ] Exported-symbol callers migrated.
- [ ] Typecheck and focused behavioral checks pass.
