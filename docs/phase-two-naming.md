# Phase 2 — naming and combined scans

This increment adds an opt-in naming aspect for named functions and class/object methods and allows test-honesty and naming-honesty to run together. Variable and module naming, knip/jscpd adapters and independent empirical validation remain subsequent increments. No claim of naming accuracy or calibration is inherited from test honesty.

## Contracts and acceptance

- `AspectId = "test-honesty" | "naming-honesty"`. `Config.aspects` is an optional list; absence keeps test-honesty only. Both may be enabled together. Unsupported or empty lists fail before sending code. Existing threshold overrides apply to test honesty only; naming starts with a separate fixed, provisional definition.
- Naming selects named function declarations, identifier-bound arrow/function expressions, and literal class/object methods with bodies. Anonymous callbacks, constructors, accessors, computed/dynamic names and signatures without implementations are omitted with visible limitations. Context is the declaration, including adjacent documentation, rather than an arbitrary dependency. Fingerprints include aspect, file, declaration kind, qualified enclosing name and duplicate occurrence, never line numbers. Scope, include/exclude, parser failures and input limits follow the existing selector contract. `focus` means local context for naming.
- Naming state has `source` and `target_symbol` containing kind, qualified name, name and declaration text. Three fixed English Noul questions cover `behavior_mismatch`, `hidden_side_effect` and `context_sufficient`. Insufficient context below 0.7 yields `cannot_tell`. Otherwise suspicion is the maximum of mismatch and side effect, a finding requires suspicion at least 0.5, and the signal is suspicion minus 0.5. The definition uses naming-honesty@1, naming@1 selector, declaration@1 context, and naming-max@1 composition; all are provisional. Test composition remains unchanged.
- Selection and derivation run per aspect with a shared repository/path scope. History, labels and findings remain partitioned by aspect. Aspect results merge into one `Run`, aggregate usage once, retain per-aspect top lists, and average calibrated aspect scores over scored aspects only. No calibrated aspect means total score `null`. Any incomplete aspect makes the run incomplete. State and question snapshots remain integrity-checked.

## Verification

Use fixture repositories and injected responses. Verify naming extraction, declaration ranges, stable identity, incomplete context, malformed responses, independent calibration/history and combined scans. Verify read-only dry-run output, per-aspect selection diagnostics and cache reuse. Do not run real paid scans or publish packages during implementation.
