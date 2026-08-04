# CONSTRUCT_RUNTIME_STREAM_VALIDATION_BOUNDARY_REFACTOR_PLAN

## Goal
Cleanly cut over construct runtime stream validation so `@inkibra/streams` stays generic, ai-construct owns construct runtime transport schemas/key derivation/validator composition, apps pass only namespace/runtime stream infrastructure, durable domain events are validated in their owner domains, and all revised DoD evidence is checked under `docs/reviews/construct-runtime-stream-validation/`.

## Hard constraints
- Do not edit toward any public or intermediate app-facing `createConstructRuntimeStreamsClient` API that accepts matchers, families, schemas, schema maps, validators, event maps, schema arrays, `additionalFamilies`, validation modules/domains, or domain validators.
- App/host construct-runtime setup is namespace/config-only: Redis/driver/logger/defaults/retention/read mode/ensure options/service event hook plus normal ai-construct module registration only.
- ai-construct derives construct runtime stream keys and composes validators from runtime state plus already registered modules/domains.
- `@inkibra/streams` public API names remain fixed: `StreamValidationResult`, `StreamEventValidator`, `StreamFamilySchema`, `StreamFamilyDefinition`, `StreamFamilyMatcher`, `defineStreamFamilySchema`, `defineStreamFamily`.
- Runtime persisted transport keys and route-only SSE lifecycle keys are disjoint sets.
- Browser snapshot durable kinds are prefixed `zerbly.browserSnapshot.*`.
- Required checked review evidence lives under `docs/reviews/construct-runtime-stream-validation/`, not `tmp/`.
- Final DoD evidence has no TODOs, unchecked items, or open questions.

## Checked review artifacts
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`
- `docs/reviews/construct-runtime-stream-validation/producer-inventory.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`
- `docs/reviews/construct-runtime-stream-validation/guardrail-canaries/`

## Phase 1 — Keep `@inkibra/streams` generic and fail-closed

### Goal
Make the streams package a generic keyed validation layer whose append/read/stream/replay validation resolves exactly one schema and selects validators by envelope event key.

### Files
- `packages/inkibra/streams/types.ts`
- `packages/inkibra/streams/client.ts`
- `packages/inkibra/streams/index.ts`
- `packages/inkibra/streams/**/*.test.ts`
- `packages/inkibra/streams/package.json`
- `scripts/bypass-registry.ts`
- `scripts/construct-graph-guardrails.config.json`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Preserve only the fixed generic public API names:
   - `StreamValidationResult`
   - `StreamEventValidator`
   - `StreamFamilySchema`
   - `StreamFamilyDefinition`
   - `StreamFamilyMatcher`
   - `defineStreamFamilySchema`
   - `defineStreamFamily`
2. Remove construct/router/recordless/zerbly/app-specific exports, schema maps, route names, construct runtime family helpers, and typia adapters from `@inkibra/streams`.
3. Implement schema resolution as exactly-one matching family for a stream key:
   - no schema: throw with stream key and failure kind;
   - multiple schemas: throw with stream key and matched schema/family names;
   - one schema: validate by `schema.events[event]`.
4. Append validation must reject event keys absent from `schema.events` and validate payloads with exactly `schema.events[event]`.
5. Read/stream/replay validation must use each stored envelope's `event` field, not caller generics, event filters, family order, or expected event type.
6. Make any lower-level unvalidated persistence API internal-only and guardrailed from production callers.
7. Keep errors actionable and safe: include stream key, schema/family name when available, event name, and failure kind; do not stringify whole payloads.

### Tests
- Append accepts valid event payloads and rejects unknown event keys and invalid payloads.
- Read/stream/replay accept valid stored events and reject no-schema, ambiguous-schema, unknown stored event key, and invalid stored payload.
- Filtering for one event cannot validate another stored event with the wrong validator.
- Error assertions include stream key, schema/family name where applicable, event name, and failure kind.
- Dependency/import guardrail proves `packages/inkibra/streams/**` has no `typia`, ai-construct, zerbly, recordless, router, construct runtime, or app-host imports.

### Verification commands
- `bun test packages/inkibra/streams`
- `bun run --filter @inkibra/streams typecheck`
- `bun run lint:stream-boundaries`
- `bun run lint:construct-graph`
- `bun run bypass:check`

## Phase 2 — Move typia adaptation to schema-owner packages

### Goal
Keep typia adaptation out of `@inkibra/streams`; owner packages expose validators that return streams-local `StreamValidationResult`.

### Files
- `packages/inkibra/ai-construct/**/adapt-typia*.ts`
- `packages/inkibra/ai-construct/**/*.schemas.ts`
- `packages/inkibra/ai-construct/**/*adapt*typia*.test.ts`
- `packages/inkibra/streams/**`
- `scripts/construct-graph-guardrails.config.json`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Define owner-local typia adapter(s) outside `@inkibra/streams`.
2. Adapter success returns typia-produced `result.data`, never `input as T`.
3. Adapter failure preserves typia `errors` and returns the streams-local validation result shape.
4. Restrict adapter callsites to owner-local `.schemas.ts` or schema-owner files.

### Tests
- Adapter valid input returns typia-normalized data.
- Invalid input preserves typia errors.
- Success path does not cast raw input into success.
- Guardrails prove `adaptTypia` is not defined in or exported by `@inkibra/streams`.

### Verification commands
- `bun test packages/inkibra/ai-construct --filter adapt-typia`
- `bun run --filter @inkibra/ai-construct typecheck`
- `bun run lint:stream-boundaries`

## Phase 3 — Define ai-construct-owned runtime transport and route schemas

### Goal
Centralize construct runtime transport schema, route schema, route-only protocol keys, relayable keys, and exact key validation in ai-construct backend/runtime code.

### Files
- `packages/inkibra/ai-construct/backend/construct-runtime-stream.schemas.ts`
- `packages/inkibra/ai-construct/backend/stream-routes.ts`
- `packages/inkibra/ai-construct/backend/stream-relay.ts`
- `packages/inkibra/ai-construct/backend/**/*.test.ts`
- `packages/inkibra/recordless.tempo-api/**/trainer-persona-runtime-events.schemas.ts`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`

### Changes
1. Define `constructRuntimeStreamSchema` inside `@inkibra/ai-construct/runtime/backend` or the backend schema owner.
2. Define `RUNTIME_TRANSPORT_STREAM_EVENT_KEYS` exactly as:
   - `streamCursor`
   - `constructEvent`
   - `thinkingDelta`
   - `responseThinkingDelta`
   - `responseDelta`
   - `sourceFactLifecycle`
   - `ingressAccepted`
   - `ingressCommitted`
   - `ingressStalled`
   - `frontierAdvanced`
3. Define route-only protocol/base event keys separately and export `CONSTRUCT_RUNTIME_ROUTE_EVENT_KEYS` as route protocol/base keys plus `RUNTIME_TRANSPORT_STREAM_EVENT_KEYS`.
4. Ensure route-only keys are valid only at the SSE/route lifecycle boundary and cannot be appended, read, replayed, persisted, or relayed as runtime transport stream events.
5. Derive `RELAYABLE_CONSTRUCT_STREAM_EVENTS` from `constructRuntimeStreamSchema.events` when practical; otherwise test exact equality with schema keys and `RUNTIME_TRANSPORT_STREAM_EVENT_KEYS`.
6. Remove permissive route validators such as broad `Record<string, unknown>` construct route payloads or unguarded `typia.createValidate<Partial<...EventTypes>>()`.
7. Ensure recordless trainer-persona runtime schemas reuse/adapt ai-construct-owned route/runtime schema rather than keeping a permissive copy.

### Tests
- Exact key equality between `constructRuntimeStreamSchema.events`, `RUNTIME_TRANSPORT_STREAM_EVENT_KEYS`, and relayable keys.
- Exact route schema equality with `CONSTRUCT_RUNTIME_ROUTE_EVENT_KEYS`.
- Exact disjointness between route-only protocol keys and runtime transport keys.
- Positive append/stream/route/relay coverage for every runtime transport key.
- Negative coverage for unknown runtime keys, route-only protocol keys, durable-domain-only keys such as `zerbly.browserSnapshot.completed`, obsolete app-only effect event names, and malformed payloads for every runtime transport key.
- Route schema rejects malformed timestamp/cursor, missing event-specific fields, wrong payload shape, durable-domain-only keys, and route-only persisted-stream attempts.

### Verification commands
- `bun test packages/inkibra/ai-construct/backend`
- `bun run --filter @inkibra/ai-construct typecheck`
- `bun test packages/inkibra/recordless.tempo-api --filter trainer-persona-runtime-events`
- `bun run lint:stream-boundaries`

## Phase 4 — Make ai-construct derive runtime stream keys and own runtime stream client composition

### Goal
Runtime stream keys and validators are derived inside ai-construct from namespace, construct id, runtime state, and normally registered modules/domains. Apps cannot pass matchers/families/schemas or validation-specific option lists.

### Files
- `packages/inkibra/ai-construct/runtime/backend/**/*stream-key*.ts`
- `packages/inkibra/ai-construct/runtime/backend/**/*stream-family*.ts`
- `packages/inkibra/ai-construct/runtime/backend/**`
- `packages/inkibra/ai-construct/runtime/**/index.ts`
- `packages/inkibra/ai-construct/index.ts`
- `packages/inkibra/ai-construct/backend/index.ts`
- `packages/inkibra/zerbly-app/**/*.{ts,tsx}`
- `packages/inkibra/recordless.web/**/*.{ts,tsx}`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Add/keep ai-construct-owned exact key builders from namespace plus construct id.
2. Bootstrap internal runtime stream families from ai-construct-owned schemas plus registered module/domain runtime state only.
3. Fail deterministically at bootstrap if two internal ai-construct-owned families resolve the same runtime stream key.
4. Migrate all app/host setup to namespace/config-only stream infrastructure.
5. Do not introduce, expose, or keep any app-facing `createConstructRuntimeStreamsClient` that accepts `families`, `schemas`, `schema`, `match`, `matcher`, `runtimeStreamFamily`, `additionalFamilies`, `streamValidationModules`, `streamEventDomains`, `domainValidators`, `streamValidators`, or `eventDomainValidators`.
6. Delete or make internal construct-runtime schema/family/matcher helpers from ai-construct public entrypoints; keep no deprecated aliases or parallel old/new app-facing paths.

### Tests
- Key derivation for namespace plus construct id.
- Bootstrap rejects broad or ambiguous internal family matches.
- App namespace/config-only setup appends and reads valid runtime events through normally registered modules.
- Typecheck catches stale imports of removed public helpers.

### Verification commands
- `bun test packages/inkibra/ai-construct/runtime`
- `bun test packages/inkibra/zerbly-app --filter runtime`
- `bun test packages/inkibra/recordless.web --filter runtime`
- `bun run --filter @inkibra/ai-construct typecheck`
- `bun run --filter @inkibra/zerbly-app typecheck`
- `bun run --filter @inkibra/recordless.web typecheck`
- `bun run lint:construct-graph`
- `bun run lint:stream-boundaries`

## Phase 5 — Validate durable domain events in their owning domains

### Goal
Durable module/domain events are validated by collected owner-domain kind validators at application, persistence, and replay boundaries, never by the top-level runtime transport stream schema.

### Files
- `packages/inkibra/ai-construct/runtime/processor.ts`
- `packages/inkibra/ai-construct/**/construct-event-domain*.ts`
- `packages/inkibra/ai-construct/**/collect-construct-event-validators*.ts`
- `packages/inkibra/ai-construct/**/apply-construct-event*.ts`
- `packages/inkibra/ai-construct/**/*.test.ts`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`

### Changes
1. `defineConstructEventDomain` requires validators directly, or requires explicit `ownedKinds` plus runtime exhaustiveness verification.
2. Bootstrap fails for:
   - owned kind missing from `domain.validators`;
   - duplicate durable event kind ownership across modules/domains, including equal keys with identical validator function references.
3. `collectConstructEventValidators` returns domain-kind validators for durable event paths only, not construct transport `StreamFamilySchema`.
4. Processor/reducer/persistence/replay boundaries validate `domain_event` payloads before `applyConstructEvent`.
5. Domain validators validate the specific discriminated union member for their kind, not a permissive base shape.
6. Errors include kind, module/domain names, and missing/duplicate/invalid failure kind without logging full payload data.

### Tests
- Missing owned-kind validator fails at bootstrap.
- Duplicate durable kind ownership fails at bootstrap for distinct modules and identical validator references.
- Invalid durable event fails before reducer application, persistence acceptance, or replay acceptance.
- Valid durable events reach the reducer/application path.
- Durable kinds are not accepted as top-level runtime transport, route transport, or relayable runtime events.

### Verification commands
- `bun test packages/inkibra/ai-construct --filter construct-event-domain`
- `bun test packages/inkibra/ai-construct --filter collect-construct-event-validators`
- `bun test packages/inkibra/ai-construct --filter processor`
- `bun run --filter @inkibra/ai-construct typecheck`

## Phase 6 — Move browser snapshot durable domain ownership to the browser module

### Goal
Browser snapshot durable event types, schemas, validators, reducer/domain definition, and tests live with the browser construct module and use `zerbly.browserSnapshot.*` kinds.

### Files
- `packages/inkibra/zerbly/construct/browser/browser-snapshot-event-domain.ts`
- `packages/inkibra/zerbly/construct/browser/browser-snapshot-event-domain.schemas.ts`
- `packages/inkibra/zerbly/construct/browser/**/*.test.ts`
- `packages/inkibra/zerbly/construct/browser/index.ts`
- `packages/inkibra/zerbly-app/**`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`

### Changes
1. Move browser snapshot event domain and schemas under `packages/inkibra/zerbly/construct/browser/**`.
2. Rename durable kinds to `zerbly.browserSnapshot.*`.
3. Register the browser snapshot event domain through normal `zerblyBrowserModule` module registration.
4. Remove direct Zerbly app ownership/wiring for browser snapshot validators or stream validation.

### Tests
- Browser module domain accepts valid and rejects invalid `zerbly.browserSnapshot.*` durable events.
- App runtime collects browser snapshot validators through registered modules, not app-level stream validation wiring.
- Search/guardrail confirms no `zerbly-app` browser snapshot event-domain owner remains.

### Verification commands
- `bun test packages/inkibra/zerbly/construct/browser`
- `bun test packages/inkibra/zerbly-app --filter browser-snapshot`
- `bun run --filter @inkibra/zerbly typecheck`
- `bun run --filter @inkibra/zerbly-app typecheck`
- `bun run lint:stream-boundaries`

## Phase 7 — Preserve non-construct stream ownership

### Goal
Non-ai-construct streams, including ToneTempo generation-status streams, continue to use `@inkibra/streams` directly with owner-local validators and generic stream family primitives.

### Files
- `packages/inkibra/recordless.tempo-api/**/*generation-status*.schemas.ts`
- `packages/inkibra/recordless.web/**/*generation-status*.ts`
- `packages/inkibra/recordless.web/**/*.test.ts`
- `packages/inkibra/streams/**`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Keep ToneTempo generation-status schemas in the owning recordless package.
2. Pass domain-owned validators directly to `createStreamsClient` for non-construct streams.
3. Ensure ai-construct does not import ToneTempo validators and ToneTempo does not import ai-construct runtime schema/family helpers.

### Tests
- ToneTempo generation-status stream accepts valid events and rejects unknown/malformed generation-status events.
- Cross-boundary import guardrail proves no ai-construct/ToneTempo validator coupling.

### Verification commands
- `bun test packages/inkibra/recordless.web --filter generation-status`
- `bun test packages/inkibra/recordless.tempo-api --filter generation-status`
- `bun run --filter @inkibra/recordless.web typecheck`
- `bun run --filter @inkibra/recordless.tempo-api typecheck`
- `bun run lint:construct-graph`
- `bun run lint:stream-boundaries`

## Phase 8 — Inventory producers and prove dispatch coverage

### Goal
Before enforcing validation, inventory every runtime stream producer/wrapper/script and prove every runtime transport key and touched durable domain kind is validated, dispatched, relayed or intentionally not relayed, and not silently dropped.

### Files
- `docs/reviews/construct-runtime-stream-validation/producer-inventory.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`
- `packages/inkibra/zerbly-app/**`
- `packages/inkibra/recordless.web/**`
- `packages/inkibra/recordless.tempo-api/**`
- `packages/inkibra/ai-construct/runtime/**`
- `packages/inkibra/ai-construct/backend/**`
- `packages/inkibra/zerbly/construct/browser/**`

### Changes
1. Create `producer-inventory.md` with a table listing every construct runtime producer/wrapper/script, exact event key(s), owner package, schema validator, valid test coverage, and invalid test coverage.
2. Search all production `append(` calls, publisher helpers, stream publisher callsites, ingress emitters, runtime scripts, and wrappers for construct runtime streams.
3. Map every producer to one of `RUNTIME_TRANSPORT_STREAM_EVENT_KEYS`.
4. Fix producers before validation enforcement if payload shape does not match ai-construct-owned schemas.
5. Create `dispatch-matrix.md` with one row per runtime transport key and one row per touched durable domain kind, including `zerbly.browserSnapshot.*`.
6. For each row, document append/read schema, route schema, relay/filter branch, router/fetch-provider dispatch if applicable, durable validator collection, reducer/application path, and test coverage.

### Tests
- Zerbly runtime `constructEvent` and `frontierAdvanced` producer valid/invalid coverage.
- Recordless runtime publisher valid/invalid coverage.
- Durable-runtime ingress `ingressAccepted`, `ingressCommitted`, and `ingressStalled` producer valid/invalid coverage.
- Tests prove each runtime transport key is produced, validated, routed or explicitly route-only handled, relayed or intentionally non-relayable, and not silently dropped.
- Tests prove each durable kind is collected, validated, applied/reduced or intentionally ignored with explicit behavior, and never treated as a top-level runtime key.

### Verification commands
- `bun test packages/inkibra/zerbly-app --filter runtime`
- `bun test packages/inkibra/recordless.web --filter runtime`
- `bun test packages/inkibra/recordless.tempo-api --filter runtime`
- `bun test packages/inkibra/ai-construct/runtime`
- `bun test packages/inkibra/ai-construct/backend`

## Phase 9 — Add executable boundary guardrails and canaries

### Goal
CI/package verification blocks invalid stream-validation boundaries, fake validators, app-owned construct stream validation composition, validation-specific app options, broad schemas, and forbidden dependencies.

### Files
- `scripts/bypass-registry.ts`
- `scripts/construct-graph-guardrails.config.json`
- `package.json`
- `biome.json`
- `docs/reviews/construct-runtime-stream-validation/guardrail-canaries/**`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Register a dedicated executable stream-validation boundary guardrail through `bun run bypass:check`, `bun run lint:construct-graph`, or `bun run lint:stream-boundaries`.
2. Guardrails must reject:
   - `@inkibra/streams` importing typia/construct/router/app packages;
   - app packages importing construct stream family/schema helpers;
   - app/host runtime setup options named `families`, `schemas`, `schema`, `match`, `matcher`, `runtimeStreamFamily`, `additionalFamilies`, `streamSchemas`, `streamValidationModules`, `streamEventDomains`, `domainValidators`, `streamValidators`, or `eventDomainValidators`;
   - `asValid`;
   - success-with-raw/cast-input validators;
   - `Record<string, unknown>` construct route schemas;
   - unguarded `typia.createValidate<Partial<...EventTypes>>()`;
   - production `append<Record<string, unknown>, string>` for construct runtime streams;
   - internal unvalidated persistence API usage from production packages.
3. Add canary fixtures under `docs/reviews/construct-runtime-stream-validation/guardrail-canaries/` proving each forbidden pattern is caught.
4. Keep allowed exceptions narrow and commented for test fixtures, generated artifacts, owner-local adapters, or non-construct domain streams.

### Tests
- Guardrail command exits nonzero against each canary forbidden pattern.
- Guardrail command exits zero for legitimate owner-local adapters and non-construct domain streams.

### Verification commands
- `bun run lint:stream-boundaries`
- `bun run lint:construct-graph`
- `bun run bypass:check`

## Phase 10 — Regenerate schemas and verify public import parity

### Goal
Every affected package that owns generated typia artifacts has regenerated `.schemas.js` output, reviewed barrel exports, and at least one consumer test importing through the production public schema path.

### Files
- `packages/inkibra/ai-construct/**/*.schemas.ts`
- `packages/inkibra/ai-construct/**/*.schemas.js`
- `packages/inkibra/recordless.tempo-api/**/*.schemas.ts`
- `packages/inkibra/recordless.tempo-api/**/*.schemas.js`
- `packages/inkibra/**/index.ts`
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`

### Changes
1. Run package-appropriate schema generation for every touched `.schemas.ts` owner package.
2. Review generated `.schemas.js` and schema barrel exports for parity.
3. Make production consumers import through the public schema export path used in production, not private source paths solely for tests.

### Tests
- Consumer tests import via public production schema export path.
- Generated JS validators reject the same malformed payloads as source-level schema owners.

### Verification commands
- `bun run --filter @inkibra/ai-construct generate:schemas`
- `bun run --filter @inkibra/recordless.tempo-api generate:schemas`
- `bun test packages/inkibra/ai-construct --filter schemas`
- `bun test packages/inkibra/recordless.tempo-api --filter schemas`
- `bun run --filter @inkibra/ai-construct typecheck`
- `bun run --filter @inkibra/recordless.tempo-api typecheck`

## Phase 11 — Final verification evidence

### Goal
Record exact targeted commands, exit status, and relevant test files for every affected boundary in checked review artifacts.

### Files
- `docs/reviews/construct-runtime-stream-validation/final-verification.md`
- `docs/reviews/construct-runtime-stream-validation/producer-inventory.md`
- `docs/reviews/construct-runtime-stream-validation/dispatch-matrix.md`

### Changes
1. `final-verification.md` records exact command, exit status, and relevant test files for:
   - generic streams tests/typecheck;
   - ai-construct backend/runtime/domain tests/typecheck;
   - Zerbly browser module and zerbly-app runtime setup tests/typecheck;
   - recordless runtime publisher and ToneTempo generation-status tests/typecheck;
   - schema generation commands;
   - guardrail commands.
2. `producer-inventory.md` and `dispatch-matrix.md` are complete checked artifacts outside tmp.
3. Final evidence contains no unchecked items, TODOs, or open questions.

### Verification commands
- `bun test packages/inkibra/streams`
- `bun test packages/inkibra/ai-construct/backend`
- `bun test packages/inkibra/ai-construct/runtime`
- `bun test packages/inkibra/ai-construct --filter construct-event-domain`
- `bun test packages/inkibra/zerbly/construct/browser`
- `bun test packages/inkibra/zerbly-app --filter runtime`
- `bun test packages/inkibra/recordless.web --filter runtime`
- `bun test packages/inkibra/recordless.web --filter generation-status`
- `bun test packages/inkibra/recordless.tempo-api --filter generation-status`
- `bun run --filter @inkibra/streams typecheck`
- `bun run --filter @inkibra/ai-construct typecheck`
- `bun run --filter @inkibra/zerbly typecheck`
- `bun run --filter @inkibra/zerbly-app typecheck`
- `bun run --filter @inkibra/recordless.web typecheck`
- `bun run --filter @inkibra/recordless.tempo-api typecheck`
- `bun run --filter @inkibra/ai-construct generate:schemas`
- `bun run --filter @inkibra/recordless.tempo-api generate:schemas`
- `bun run lint:stream-boundaries`
- `bun run lint:construct-graph`
- `bun run bypass:check`

## Sequencing
1. Phase 1 first: generic streams semantics and fail-closed validation are the foundation.
2. Phase 2 after Phase 1: owner-local typia adapters depend on the streams-local result shape.
3. Phase 3 after Phase 2: ai-construct schemas use owner-local adapters and exact runtime/route key sets.
4. Phase 4 after Phase 3: runtime setup consumes ai-construct-owned schema/key builders and removes app-facing composition paths.
5. Phase 5 and Phase 6 after Phase 4: durable domain validation and browser snapshot module ownership depend on normal module registration.
6. Phase 7 can run after Phase 1 and in parallel with construct-specific phases if it only touches non-construct stream owners.
7. Phase 8 starts before enforcement and finishes after Phases 3–7 so inventory and dispatch matrix match final producers and schemas.
8. Phase 9 runs before final verification and blocks regressions.
9. Phase 10 runs after all `.schemas.ts` changes.
10. Phase 11 closes the work only after all commands and checked artifacts are complete.