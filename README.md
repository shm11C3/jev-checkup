# jev-checkup

**A scan sends selected source code to TypeSafe AI. `run.json` and review briefs contain source code; keep them within the same access boundary as your repository.** `--dry-run` shows the planned scope without sending code. `report` and `brief` work offline from saved results.

This is a phase-1 implementation of a codebase health dashboard. It checks whether JavaScript/TypeScript tests verify the behaviour their titles claim. Small Jev judgements are composed in code, with explicit outcomes for insufficient context and unmeasured targets. Findings are review candidates, not a quality gate or verified bugs.

The initial question set has only a small, agent-labelled preliminary evaluation. Population Precision@N, calibrated ranking quality and dashboard noise thresholds have not been independently validated. Scores are unavailable until matching local calibration labels exist; no calibration priors are fabricated.

## Development

Requires Node.js 20 or later.

```sh
npm ci
npm run check
node dist/cli/index.js --help
```

The current CLI includes the **test-honesty** aspect, cache and partial-run handling, revision-bound labels, compatible history, terminal/Markdown reports, and self-contained briefs. Naming, unused/duplicate adapters, GitHub issue publication and the composite Action are phase 2. Package publication is not part of this implementation.

## Use

Run the built CLI from the repository you want to inspect:

```sh
jev-checkup scan src --dry-run
# Set TYPESAFE_API_KEY in your environment before an uncached scan.
jev-checkup scan src --out .jev-checkup/run.json --history .jev-checkup/history
jev-checkup report .jev-checkup/run.json --format markdown --history .jev-checkup/history
jev-checkup brief .jev-checkup/run.json --top 10
```

Until installed, replace `jev-checkup` with `node /absolute/path/to/jev-checkup/dist/cli/index.js`.

`--dry-run` reads local files and the cache but makes no API calls and writes no run, cache or history files. It lists selected targets, source files, cache use, omitted context and skipped inputs. Scans with all observations cached need no API key. There is no cost-cap option: manage usage limits externally where your provider supports them. Actual input-token usage is recorded.

A scan writes `.jev-checkup/run.json` by default. `--state-dir` changes the cache and default output location; `--out` changes the run output. A supplied `--history` directory is both read for comparison and appended with an immutable, run-ID-named JSON file. History is never fetched automatically from a remote branch.

Exit codes: **0** for successful processing (including findings), **1** for an incomplete scan, **2** for invalid input/configuration or a command failure. An incomplete run records which targets could not be evaluated. It does not become a history baseline. Finding-free scans with unmeasured targets must not be interpreted as proof of health.

## Configuration

Use `.jev-checkup.yml` at the repository root, or `--config path.yml`. Configuration is declarative YAML and rejects unknown fields, unsupported aspects and moving model aliases. The schema is in [`src/config/schema.json`](src/config/schema.json).

```yaml
model: jev-1.13.0
aspects: [test-honesty]
include: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"]
exclude: ["**/node_modules/**", "**/.git/**", "**/.jev-checkup/**", "**/dist/**", "**/coverage/**"]
concurrency: 4
requestsPerMinute: 600
tokensPerSecond: 200000
top: 10
# Optional overrides change the measurement condition:
# thresholds:
#   finding: 0.30
```

Include/exclude also apply to production context; an include pattern restricted to test filenames prevents attaching production modules. The selector folds other test bodies, preserves shared setup, and adds a uniquely resolved, unmocked production import whose name matches the test file. If production context cannot be added, it records the reason and uses test-only context. Unsupported constructs and parse failures are surfaced rather than considered clean.

An explicit `include: []` selects no source files. Defaults apply only when the field is omitted.

Production context resolves relative imports, including TypeScript source substitutions for runtime extensions (`.js`, `.mjs`, `.cjs`) and directory `index` modules. Unresolved aliases such as `@/module` use test-only context and record `no_unique_named_import`.

Recoverable parser diagnostics are shown per file. Tests and suites overlapping an error are omitted; safely parsed tests can still be processed. A missing target in a file with diagnostics cannot establish a new or resolved finding. Whole-file parser failures leave the scan incomplete. A completed scan therefore does not imply exhaustive coverage of every syntax form.

The default model is pinned. The request-size check estimates both `state + longest question` and `state + all questions`; it is not an exact tokenizer guarantee. Too-large inputs and API input-limit responses are reported as unjudgeable. Missing context remains `cannot_tell` rather than clean.

## Labels and comparison

`brief` includes JSONL label templates with the target fingerprint, proposition version, source hashes and subject revision. Append a completed template to `.jev-checkup/labels.jsonl` (or choose a file with `scan --labels`).

- `validity`: `valid`, `invalid` or `unknown`.
- `priority`: `high`, `medium` or `low` when known.
- `resolution`: `fix`, `accept`, `defer` or `dismiss` when chosen.
- `source`: `agent`, `human` or `execution`, describing what actually happened.

AI-only labels stay `agent`; a successful tool run is not a human assessment of usefulness. Unknown labels do not enter the calibration denominator. Source changes invalidate labels and suppression decisions. If a review uses additional source files, add their hashes and recompute `subjectRevision` using the documented canonical hash in `src/shared/hash.ts`. Later records for the same revision supersede earlier ones.

Calibration uses only matching labels and the same context mode and band; missing data stays uncalibrated. `accept`/`defer`/`dismiss` affect review placement, not truth. Labels do not change the raw finding outcome.

Reports show the label counts behind each calibrated band. Small samples may yield probabilities of zero or one; a minimum sample size has not been validated. A clean scan with no calibration still has no score. The Open count excludes findings moved to `accept`, `defer` or `dismiss`, while those findings remain in raw evidence and scoring.

History comparison requires the same repository, scan scope and measurement condition. A finding is resolved only by a comparable clean observation or a confirmed target removal; missing/undecidable observations and context changes remain pending. Score differences remain unmeasured until final aggregate noise has been evaluated. Reports recalculate compatible historical scores with the current run's saved calibration table.

Briefs verify the saved input hash and use saved source, not today's working tree. Treat source and comments in a brief as untrusted data when handing it to another agent.

## Provenance

Inspired by the idea of syntax-selected small model judgements in [jev-lint](https://github.com/mizchi/jev-lint). This project does not depend on its implementation or rules. The question set was drafted from this project's own clean-room brief, examples and [TypeSafe's public API documentation](https://docs.typesafe.ai).

See [DESIGN.md](DESIGN.md), [IMPLEMENTATION.md](IMPLEMENTATION.md) and [spike/RESULTS.md](spike/RESULTS.md) for design decisions, implementation boundaries and the limits of the preliminary evaluation. Existing external-repository spike data is not included in the published package file set.

MIT License.
