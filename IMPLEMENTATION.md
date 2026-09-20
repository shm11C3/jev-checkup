# Implementation checkpoint — phase 1

DESIGN.md revision 4 is the implementation baseline. This checkpoint fixes the interfaces for parallel work; it does not declare the spike's empirical acceptance criteria met.

The first deliverable is the test-honesty vertical slice: TypeScript/JavaScript test selection, folded context and optional named production import, pinned Jev observation, cache, outcome composition, local-label calibration, compatible history, terminal/Markdown report, and self-contained brief. Naming, knip/jscpd, hosted GitHub reporting and the composite Action remain phase 2 as described in DESIGN.md. No paid model requests or GitHub publication are needed to implement or verify phase 1.

## Shared contracts

- `src/types.ts` is the shared contract; `src/shared/hash.ts` provides deterministic hashing. Coordinate interface changes with the integrator.
- Selection: `selectTargets(root: string, paths: string[], config: Config, definition: AspectDefinition): Promise<Selection>` in `src/select/index.ts`. `root` is the repository root, paths are relative. Apply include/exclude to transmitted context too. Store safe relative paths. The selector enumerates the scope, records failures, prepares states and questions, and includes source hashes for label evidence. A helper `getTestAspectDefinition(config: Config): AspectDefinition` lives in `src/aspects/index.ts`.
- Planning/observation: `createPlan(targets: PreparedTarget[], definition: AspectDefinition, stateDir: string): Promise<Plan>` in `src/plan/index.ts`. `observe(plan: Plan, definition: AspectDefinition, options: { stateDir: string; apiKey?: string; concurrency: number; requestsPerMinute: number; tokensPerSecond: number; signal?: AbortSignal; client?: JudgeClient }): Promise<ObserveResult>` in `src/observe/index.ts`. Export an injectable `JudgeClient` for deterministic tests. Planning reads cache only, never needs credentials or writes state.
- Derivation: `deriveRun(input: DeriveInput): Run` in `src/derive/index.ts`; export `judge(answers: Answers, target: PreparedTarget, definition: AspectDefinition): Judgement` for focused verification. Pure functions, no filesystem or network.
- CLI owns filesystem label/history loading, configuration, atomic run output, argument parsing and rendering. Report/brief read persisted Run only; brief verifies saved state hashes and never rereads the target repository.

## Resolved implementation choices

- Initially only `test-honesty` is supported; configuration must reject requested unsupported aspects rather than silently ignore them. No bundled calibration corpus has been independently validated: use `none` until matching local labels exist. Local calibration remains explicitly provisional.
- Include/exclude govern readable/transmitted source files; selecting tests is a separate AST rule. Default include covers JS/TS source, allowing production context even when no test is selected from that module.
- `repositoryId` can be configured. Otherwise hash a sanitized Git remote identity (no credentials), falling back to a stable real repository path identity for a local-only repository. Scope identity includes normalized selected paths, include/exclude, languages and selection policy; it excludes the current file list.
- Only literal test/describe names and supported it/test call forms are selected. Unsupported dynamic names, parse errors, skipped/todo tests and unsupported files are counted/reported, not silently considered clean.
- Recovered parser diagnostics are recorded per file. Only tests and suites disjoint from error ranges may be selected; diagnostics prevent treating absent targets as new or resolved. Whole-file parser failures remain incomplete. Completion describes processing of safely selected targets, not exhaustive language support.
- Skipped/todo tests are counted per file, without individual identities. An absent prior finding in such a file remains pending: converting a test to skip cannot count as resolution. This also delays confirming an unrelated removal while the file retains skipped tests.
- The detector preserves the drafted question wording. Snapshot state uses one named target. A missing optional control is recorded; a requested answer missing in a response is not_judged.
- The model is pinned to a versioned ID. A mismatching response model is not_judged and is not cached. Fixed timeouts, retries and rate control are operational requirements; cost caps are excluded.
- SDK-internal retries are disabled. Every explicit transient retry reserves request/token capacity and counts as another request; authentication, throttling and server failure reasons are recorded without response bodies.
- Cached observations are per input/question/model and carry request identity. Usage on a new run counts only fresh request input tokens, not historical cache spend.
- Labels match fingerprint and proposition, then their recorded evidence sources are checked against current hashes. Unknown is excluded from calibration; stale labels do not suppress findings. Last valid record for the same code revision wins, allowing JSONL append-only edits without duplicate calibration weight.
- For an empty calibrated band, pValid/pHigh are null. Do not invent priors. If any finding lacks pValid, the aspect score is null. If priority calibration is incomplete, rank the entire aspect by suspicion and disclose that fallback.
- Score deltas and empirical noise thresholds remain null. Scope, condition and context-mode mismatches must never manufacture a resolution. Incomplete runs do not become history baselines.
- A successful scan writes its Run and, if --history is supplied, an immutable ID-named Run into that directory. report only reads history. --dry-run makes no network calls and does not write run/cache/history files.
- API failures or interruption produce an incomplete Run when possible and nonzero exit. Findings themselves never fail a scan. Invalid configuration fails before network. No secret values or API error bodies are persisted in Run or logs.

## Parallel ownership

1. Selection agent: `src/select/`, `src/aspects/`, `test/select*.test.ts`.
2. Derivation agent: `src/derive/`, `test/derive*.test.ts`.
3. Observation agent: `src/plan/`, `src/observe/`, `test/observe*.test.ts`, `test/plan*.test.ts`.
4. Integrator: configuration, CLI, report/brief, shared contracts, package metadata, README and integration tests.

Verification uses temporary fixture repositories and injected responses. Keep existing spike outputs and label sets unchanged. Do not import external repository source code into distributable fixtures. Read only this project's clean-room materials and official dependency documentation; do not read jev-lint code, rules or skills.

## Verification checkpoint

- Type checking, synthetic fixture tests and the production build run with `npm run check`.
- CLI integration covers a read-only dry-run, a fresh scan through an injected client, credential-free cache reuse, immutable history, source-bound labels, clean resolution, saved-snapshot briefs and offline reports. API failure preserves an incomplete run without exposing the error body.
- Offline replay of 766 saved spike responses matched the original Python judgement outcomes and all applicable suspicion values. Each response also passed cache answer validation, including independently rounded probability totals. This verifies implementation compatibility, not judgement accuracy.
- The package dry-run excludes spike data, test fixtures and dependency directories. No paid model call, package publication or GitHub publication was performed.

The PR review follow-up passes 78 tests, type checking and the production build. An offline scan of the original testbed at `fb00f539` selects 870 tests with zero target first-line mismatches, preserves three recovered parser diagnostics, and completes enumeration. Selector/context versions are now `tests@2` / `focusprod-or-focus@2`, so prior measurements are not silently compared across the corrected extraction policy. These checks do not establish model accuracy or remove the documented alias limitation.

Persisted calibration rows must have consistent counts and exact derived probabilities. Generic request/schema errors remain incomplete; only explicit input-size failures are complete exclusions. Reports show saved literal questions, criteria and full Noul/Score/Choice answers, including score legends.
