# Test honesty: question set for the judge

Companion to `questions.json`. Drafted from `SPEC.md`, `labels.dev.json`, the referenced test
files in HardwareVisualizer (commit `fb00f539`, read-only) and the public docs at
<https://docs.typesafe.ai>. Nothing else was consulted. No API call was made; every
"expected" value below is a prediction, not a measurement.

The dimension asks one thing: does the test, as written in its file, check what its title
states, so that breaking that behaviour would make this test fail?

## 1. What the judge is shown (`state`)

Proposed primary format, an object with two views of the same file:

```json
{
  "file_path": "src/features/.../useSortableDashboard.test.ts",
  "source": "L0001| import { act, renderHook } from \"@testing-library/react\";\nL0002| ...",
  "target_tests": {
    "t0066": {
      "title": "handleDragOver: swaps items when active and over differ",
      "inside": "useSortableDashboard",
      "first_line": "L0066",
      "last_line": "L0079",
      "code": "L0066|   it(\"handleDragOver: swaps items ...\", () => {\n ... L0079|   });"
    }
  }
}
```

- `source` is the entire file, verbatim, every line prefixed with a line id (`L` + zero-padded
  1-based number + `| `). The docs' own line-search cookbook tags lines the same way
  (`L052| ...`) so the model can refer to them.
- `target_tests` holds only the tests asked about in this request. Each test's code is
  duplicated there on purpose. The docs' recommended way to aim a question at part of the
  state is a backticked path (`` `target_tests.t0066.code` ``), and the known-limitations page
  says Jev "struggles with tasks that require numeric precision" and reads dates "as text, not
  as ordered quantities". A path needs no numeric reasoning; "lines 66 to 79" does.
- Every question still carries a `target_test` block with the title, the enclosing `describe`
  titles and the line range, as the brief requires, so the test can also be located inside
  `source` (needed for shared setup and sibling tests).
- Control variant for the spike: `{file_path, source}` only, questions addressed by title and
  line range. `_meta.state_variants` in the JSON gives the mechanical substitution. Run the
  dev set under both and keep the variant with fewer control failures (section 5, R1).

Handled in code, never asked: tests with no `expect` at all, `it.skip` / `it.todo`, line
ranges, the end line of a test, picking control snippets.

## 2. The questions

Twelve per test, all sent in one request with every other asked-about test of the file
(speculative fan-out). Ids are `{test_key}__{property}`; the model never sees them.

Polarity: **problem** = a higher answer is more evidence that the test does not check its
title. **undecidable** = a higher answer is more evidence that this file cannot settle it.
**control** = the right answer is known to the harness.

References are `file:line` as in `labels.dev.json` (paths shortened).

### Core family: the titled behaviour is not what gets checked

| Property | Type | Polarity | Observable property it isolates | Motivated by (valid) | Must stay low on (invalid) |
|---|---|---|---|---|---|
| `outcome_unasserted` | Noul | problem | Every `expect` checks something other than the outcome the title states (a message, a log, mere existence). | `TrayWidgetSettings:595`, `:619` (message and log asserted, "disables" never); `useInsightChart:292`; `useSnapshot.label:165`; `useSortableDashboard:66` | `NavigationRestructureNotice:113`, `usePerformanceLayout:79` (the call at a mocked boundary *is* the outcome); `ElevatedStartupModeToggle:46` |
| `result_claim_call_only` | Noul | problem | Title describes what a result contains; the expects only establish that something was called. | `useSortableDashboard:66` ("swaps items", only `toHaveBeenCalledTimes`) | `NavigationRestructureNotice:113` (title states an action, `toHaveBeenCalledOnce` is that action); `useSettingsAtom:719` |
| `call_claim_no_call_check` | Noul | problem | Title is about a call happening or not; no expect inspects that function's calls. | `useMenu:72` ("does not call setDisplayTargetAtom", only a value asserted); weaker: `AmbientSensorToggle:74` ("no scan starts") | `useHardwareEventListener:294`, `:795` (title is about stored state, not a call); `visiblePolling:105` (call is inspected) |
| `subject_not_in_play` | Noul | problem | The condition, input or mechanism the title names is never created, passed or compared, even counting shared setup. Covers vacuous inputs and stale titles. | `fanTimeline:176` (input has no days at all); `useSnapshot.label:165` (no locale anywhere); `getArchivedRecord:168` (nothing involves ordering) | the missing-context forms, see below |

`subject_not_in_play` is the question most exposed to the failure that produced most wrong
flags before (arrangement outside the test body). Its `setup_scope` field and its `false`
criterion enumerate the forms found in the invalid examples:

| Form of out-of-body arrangement | Example |
|---|---|
| helper function that renders and hydrates state | `DashboardItems.motherboardSensors:95` (`renderMotherboard()`) |
| `beforeEach` setting the condition | `AppUpdate:80` (`meta: null`), `AmbientSensorToggle:169` (`hardwareArchiveEnabled = true`), `SystemSpecifications:70` |
| hoisted mock default at the top of the file | `ElevatedStartupModeToggle:46` (`platform: () => "windows"`) |
| translation mock mapping key to asserted text | `AmbientSensorToggle:93` |
| fixture builders with defaults | `thermalTimeline:273` (`trendPoint` / `band`), `useHardwareEventListener` (`makePayload`) |
| the condition is just the initial or empty state (nothing set up, a fixture default, an empty list that *is* the titled condition) | `MotherboardSensorsPanel:21`, `PerCorePanel:20`, `TrayWidgetFlyout:66`, `gpuIdentity:250`, `:321`. Contrast `fanTimeline:176`, where the empty list removes the titled condition |
| sibling tests supply the other half of an "only" | `sensorNotice:5` (handled in `general_claim_single_case`) |

`setup_scope` is repeated in `outcome_unasserted` and `verdict` because questions are
evaluated independently and Jev reads literally: a rule stated in one question does not
exist for another.

### Partial family: part of the title is not checked

| Property | Type | Polarity | Observable property | Motivated by (valid) | Must stay low on (invalid) |
|---|---|---|---|---|---|
| `extra_claim_unasserted` | Noul | problem | Title joins two or more checkable claims; one is asserted, another has no expect. | `useBgImage:192` ("deleted and ... reset", only reset); `useStickyObserver:37` ("create ... and not call", only the second); `thermalTimeline:636` ("same bucket axis"); `getArchivedRecord:168` ("with ORDER BY"); `useSnapshot.label:71` ("time-only"); `PerCorePanel:50` ("one bar per") | `thermalTimeline:57` ("for display only" is a design remark); `gpuIdentity:250`; `NavigationRestructureNotice:75` and `SystemSpecifications:70` (compound titles, every half asserted); `usePerformanceLayout:171` |
| `general_claim_single_case` | Noul | problem | Title generalises (every, each, only, again); the test exercises one occurrence. | `useHardwareEventListener:393` ("on every live update", one emit) | `sensorNotice:5` ("only": siblings in the same `describe` cover the other cases); `visiblePolling:105` |

### Modifiers

| Property | Type | Polarity | Observable property | Motivated by | Note |
|---|---|---|---|---|---|
| `vague_title` | Noul | problem | Title names no expected result ("correctly", "handles"). Needs the title only. | `useInsightChart:265`, `useSnapshot.label:225` | Never a finding by itself. It only opens the gate for weak assertions (section 3). `useSnapshot.label:247` is labelled invalid with the same shape, so expect disagreement here. |
| `assertion_specificity` | Score, 3 levels | problem (level 0 fine, last level worst) | How specific the strongest `expect` is: exact value or specific absence / pattern or partial shape / existence, non-empty, "was called". | top level: `useInsightChart:292`, `useSnapshot.label:165`, `useSortableDashboard:66`. Middle: `useInsightChart:265`, `useSnapshot.label:71`, `:225` | This is what separates the four `priority: high` examples from most `low` ones: three of the four highs have nothing but top-level assertions. A Score is the documented type for a position on a described spectrum, and its answer returns `legend`, so the report can print the matched level text verbatim. Levels describe situations, not degrees, and contain no numbers. "Asserts that a specific thing is absent" sits in level 0 so that honest negative tests (`useHardwareEventListener:294`, `AppUpdate:80`) are not scored as weak. |

### Undecidable, cross-check, controls

| Property | Type | Polarity | What it is for | Motivated by |
|---|---|---|---|---|
| `hinges_on_unseen_rule` | Noul | undecidable | The test's arrangement only makes sense given a number, limit or timing rule that the file neither shows nor mentions. | `useHardwareEventListener:1278` (emit sequence built around "retired after 3 missed samples", constant not in the file; label is invalid, so the right product answer is "cannot tell", not a flag); `useScatterChartZoom:250` (whether the null guard matters is only visible in production code) |
| `verdict` | Choice, 4 options | mixed (stated per option in `_meta.properties`) | One broad question, kept out of the suspicion value. It gives the doc-native way to say "cannot tell" (an explicit option plus `confidence`, which Nouls do not have) and a cross-check: if it ranks the dev set as well as the composite, decomposition is not earning its cost; if it disagrees with the atomic answers on a test, that test is worth a look. | the citation-check cookbook's `supports / contradicts / says_nothing` shape |
| `ctl_own_snippet`, `ctl_sibling_snippet` | Noul | control (expected yes / no) | Known-answer checks that the judge is reading the addressed test and not a neighbour. | risk R1 |

Deliberately not asked: anything that needs counting ("are there four bars?": Jev does not
count reliably; the question is only whether a count is asserted), whether a test is worth
having, mock quality, style, coverage.

## 3. Composition rule

All cutoffs and weights are named constants in code. The values are untuned starting points:
tune on `labels.dev.json` only, then freeze them together with the question wording before
the held-back set is touched.

```text
core    = max(outcome_unasserted, result_claim_call_only,
              call_claim_no_call_check, subject_not_in_play)
partial = max(extra_claim_unasserted, general_claim_single_case)
weak    = P(specificity = last level) + WEAK_MID * P(specificity = middle level)
gate    = max(core, partial, vague_title)

suspicion = W_CORE    * core
          + W_PARTIAL * partial * (1 - core)
          + W_WEAK    * weak * gate

W_CORE = 0.60   W_PARTIAL = 0.25   W_WEAK = 0.40   WEAK_MID = 0.5      (suspicion stays in 0..1)
```

- `max` inside a family: the members are alternative descriptions of one defect. One defect
  seen by three questions must not count three times.
- `(1 - core)`: a partial gap adds nothing once the main claim is already unverified.
- `weak * gate`: weak assertions alone are not a finding (`NavigationRestructureNotice:113`
  asserts only `toHaveBeenCalledOnce()` and is fine). They amplify other evidence. This term
  is what should lift `useSortableDashboard:66`, `useInsightChart:292` and
  `useSnapshot.label:165` above `TrayWidgetSettings:595`-style findings, matching high vs low.
- `weak` reads `probabilities`, not the mean `score`: the docs note that different
  distributions give the same score and warn against interpolating between levels.
- The Choice is not in the formula, so every point of suspicion traces to an atomic question.

Outcome per test:

```text
strong        = core >= T_STRONG or partial >= T_STRONG
controls_ok   = ctl_own_snippet >= T_CTL and ctl_sibling_snippet <= T_CTL

not_judged    : not controls_ok                          (answers discarded, counted as R1)
cannot_tell   : not strong and ( hinges_on_unseen_rule >= T_UNSEEN
                                 or verdict.choice == "cannot_tell_from_file" )      (explicit)
             or not strong and T_MID_LO < core < T_MID_HI
                           and verdict.confidence < T_CONF                           (judge on the fence)
finding       : otherwise, suspicion >= T_FIND           (ranked by suspicion, descending)
clean         : otherwise

T_STRONG = 0.80  T_UNSEEN = 0.70  T_MID_LO = 0.35  T_MID_HI = 0.65  T_CONF = 0.50  T_FIND = 0.30  T_CTL = 0.50
```

"Cannot tell from this file" is therefore one of two answer patterns: (a) the judge says the
arrangement hinges on an unseen rule, or picks the `cannot_tell_from_file` option, while no
structural defect is strongly visible; (b) the core evidence sits in the middle band and the
verdict's own confidence is low. A strongly visible structural defect (for example only
existence checks) overrides both, because it is decidable from the file whatever the
production code does. Cannot-tell items are listed separately and never enter the top N; they
are the natural input for a later version that adds production code to the state.

Report rule (no fabricated rationale): a finding shows the literal `question` sentence and
the returned value of every problem-polarity question at or above `T_SHOW` (start 0.50), led
by the family maximum, plus the `legend` text of the most probable specificity level. Nothing
else is written.

## 4. Expected answers on a sample of dev examples

Sanity check, not a fit. hi / mid / lo are my predictions for the Noul values; `spec` is the
expected nearest specificity level (0 exact, 1 pattern, 2 existence); "band" is where the
composite should land. Rows where I expect the design to disagree with the label are marked.

| Example | Label | outcome | call-only | call-claim | not-in-play | extra | single | vague | spec | unseen | verdict | Band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `useSortableDashboard:66` swaps items | valid high | hi | hi | lo | lo | lo | lo | lo | 2 | lo | does_not_verify | top |
| `useInsightChart:292` shift time ... offset | valid high | hi | lo | lo | lo (`offset: 5` is passed) | lo | lo | mid | 2 | lo | does_not_verify | top |
| `useSnapshot.label:165` system locale | valid high | hi | lo | lo | hi (a comment mentions locale; may pull to mid) | lo | lo | lo | 2 | lo | does_not_verify | top |
| `getArchivedRecord:168` ... with ORDER BY | valid high | lo | lo | lo | mid-hi | hi | lo | lo | 0 | lo | verifies_part | upper-middle. **Under-ranked vs label**: structurally a partial gap; its priority comes from the claim being stale, which only `not-in-play` can see |
| `TrayWidgetSettings:595`, `:619` disables settings | valid low | hi | lo | lo | lo | lo | lo | lo | 0 | lo | does_not_verify | upper. **Over-ranked vs label**; sibling `:580` does assert `toBeDisabled`, which v1 does not look at |
| `useMenu:72` does not call setDisplayTargetAtom | valid low | mid-hi | lo | hi | lo | lo | lo | lo | 0 | lo | does_not_verify | upper. **Over-ranked vs label** |
| `fanTimeline:176` leaves a day ... out of the map | valid low | lo-mid | lo | lo | hi (`days: []`) | lo | lo | lo | 0 | lo | verifies | upper-middle; verdict likely disagrees with the Nouls |
| `useInsightChart:265` labels correctly for long periods | valid low | mid | lo | lo | lo | lo | lo | hi | 1 | lo | verifies_part | middle |
| `useSnapshot.label:225` edge case periods correctly | valid low | mid | lo | lo | lo | lo | lo | hi | 1 | lo | verifies_part | middle |
| `useHardwareEventListener:393` replaces ... on every live update | valid low | lo | lo | lo | lo | lo-mid | hi | lo | 0 | lo | verifies | lower-middle |
| `useBgImage:192` deleted and settings are reset | valid low | lo | lo | lo | lo | hi | lo | lo | 0 | lo | verifies_part | lower-middle |
| `useStickyObserver:37` create ... and not call observe | valid low | lo | lo | lo | lo | hi | lo | lo | 0 | lo | verifies_part | lower-middle |
| `PerCorePanel:50` one bar per logical processor | valid low | lo | lo | lo | lo | mid | lo-mid | lo | 0 | lo | verifies | low; may fall under `T_FIND` |
| `AmbientSensorToggle:74` is off ..., so no scan starts unasked | valid low | lo | lo | mid | lo | mid (the "so" clause reads as rationale) | lo | lo | 0 | lo | verifies | low; **likely missed** |
| `useScatterChartZoom:250` returns early when containerRef is null | valid low | lo (a comment in the test argues it verifies) | lo | lo | lo | lo | lo | lo | 0 | mid | verifies | clean or cannot-tell; **likely missed** (needs production code) |
| `useHardwareEventListener:1278` resets the retirement grace period | invalid (constant unseen) | lo | lo | lo | lo | lo | lo | lo | 0 | hi | verifies or cannot_tell | cannot-tell (the intended outcome) |
| `DashboardItems.motherboardSensors:95` | invalid (helper + beforeEach) | lo | lo | lo | lo if `setup_scope` is honoured | lo | lo | lo | 0 | lo | verifies | clean. Key probe for R2 |
| `ElevatedStartupModeToggle:46` is shown on Windows | invalid (hoisted default) | lo | lo | lo | lo, risk mid | lo | lo | lo | 0 | lo | verifies | clean. Key probe for R2 |
| `AppUpdate:80` no modal when meta is null | invalid (beforeEach) | lo | lo | lo | lo | lo | lo | lo | 0 | lo | verifies | clean |
| `NavigationRestructureNotice:113` persists acknowledgement | invalid | lo | lo, risk mid | lo | lo | lo | lo | lo | 2 | lo | verifies | clean (weak is gated) |
| `sensorNotice:5` ... only from explicit support evidence | invalid (siblings) | lo | lo | lo | lo | mid | mid-hi | lo | 0 | lo | verifies | low; **possible false flag** near `T_FIND` |
| `usePerformanceLayout:355` ... without leaking the rejection | invalid | lo | lo | lo | lo | mid-hi | lo | lo | 0 | mid | verifies_part | low; **possible false flag** (the runner fails on unhandled rejections, which the file cannot show) |
| `thermalTimeline:57` converts to Fahrenheit for display only | invalid | lo | lo | lo | lo | lo-mid | lo | lo | 0 | lo | verifies | clean |
| `useSnapshot.label:247` exactly 1440 minutes ... correctly | invalid | mid | lo | lo | lo | lo | lo | hi | 1 | lo | verifies_part | middle; **false flag**, same shape as `:225` which is labelled valid. I did not word around this. |
| `useHardwareEventListener:294` does not update gpuTempAtom | invalid | lo | lo | lo | lo | lo | lo | lo | 0 | lo | verifies | clean |

Predicted shape of the ranking: the three "only weak assertions" highs on top, then core
findings with specific-but-misdirected assertions, then vague-title and partial findings.
Predicted disagreements: some `low` items rank above `getArchivedRecord:168`; two low items
are missed; two or three invalid items may surface near the bottom of the list.

## 5. Risks and how the spike can detect them

| # | Risk | Detection in the spike | Fallback |
|---|---|---|---|
| R1 | The judge answers about the wrong test in the file. | (a) `ctl_*` controls: failure rate per file, per file size, per position in file. (b) Contrast probe inside one file: `TrayWidgetSettings:580` asserts `toBeDisabled`, `:595` and `:619` do not, with near-identical titles; their `outcome_unasserted` answers must differ. (c) Title-swap probe: present test A's code under test B's title; answers must move. (d) Primary vs control state variant. | Keep the variant with fewer failures; discard a test's answers when its controls fail. |
| R2 | Missing-context false flags survive despite the whole file being visible. | `subject_not_in_play` and `outcome_unasserted` on the seven out-of-body forms listed in section 2. Any value at or above `T_SHOW` there means `setup_scope` is not being honoured. | Extract shared setup in code (enclosing hooks, module-level mocks, called helpers) into `target_tests.<key>.shared_setup` and point the questions at that path. |
| R3 | Context rot: docs say accuracy falls as state grows with unrelated content; the brief fixes state = whole file (largest dev file is about 1.4k lines). | Error rate and control failures against file length. | Elide bodies of non-target tests outside the target's `describe`, keeping titles. |
| R4 | Comments inside tests argue for their own correctness ("the null guard prevented zoom logic", "Year should be included"). Docs: "text that argues for its own classification, can move the answer". | Re-ask with comments stripped from `code` and `source`; compare on `useScatterChartZoom:250`, `useInsightChart:265`, `useSnapshot.label:165`. | Strip comments from `code` only (comments sometimes carry the constant that makes a test decidable). |
| R5 | Several questions are relational ("title says X while the assertions do Y"). Docs advise one condition per Noul. | Share of answers inside the middle band per question; run-to-run spread. | Decompose into single-condition descriptors (`title is about a call`, `no expect inspects calls`, `every expect is a bare call check`) and multiply in code; those descriptors carry no polarity alone, so polarity would be declared on the product. |
| R6 | Literal reading makes `hinges_on_unseen_rule` fire everywhere, since every test calls imported code. | Its base rate on the 35 invalid examples; it should be high on `:1278` only. | Drop it and rely on `verdict`'s `cannot_tell_from_file` option and confidence. |
| R7 | No structural invariants between questions: a Noul and a Choice on the same matter need not agree, and `P(q) + P(not q)` need not be 1. | Confusion table of `verdict.choice` against the outcome of section 3. | Never negate an answer in code to reuse a question with the other polarity; never reuse a Noul cutoff for the Choice. |
| R8 | Run-to-run noise (the consistency cookbook shows Nouls on judgment calls moving by about 0.1). Ranks among near-ties are then arbitrary. | Send each request three times; report top-N overlap and rank correlation between runs. | Rank on the mean of repeats; treat ties within the noise as equal. |
| R9 | Overfitting wording and weights to 53 examples. | Freeze wording and constants before the held-back set; log every wording revision; report dev and held-back numbers side by side. | n/a |
| R10 | Priority is not purely structural. `getArchivedRecord:168` is high because the claim is stale; the `TrayWidgetSettings` pair is low partly because a sibling asserts the same effect. | Top-N usefulness on dev with and without `subject_not_in_play` in `core`. | v2 candidate, reassurance polarity: "another test in the same describe block asserts this outcome under a similar condition". Left out of v1: multi-hop and opposite polarity. |
| R11 | Label noise. `useSnapshot.label:225` (valid) and `:247` (invalid) have the same structure. | Inspect disagreements by hand before changing any wording. | n/a |
| R12 | Parsing edge cases: `it.each` title templates (`%s`), duplicate titles, expects inside helpers, zero-expect tests. | Count how often each occurs in the repo; controls catch the first two. | `test_key` by start line; zero-expect handled in code. |
| R13 | Non-English titles or comments. Docs: English is the primary language; others, CJK included, have lower accuracy. | Flag files containing non-ASCII titles; compare error rates. | Report them as lower-trust. |

## 6. What the public docs constrain

Pages read: `llms.txt`, `primitives`, `primitives/noul`, `primitives/choice`, `primitives/score`,
`primitives/advanced`, `concepts/state`, `concepts/system-one`,
`concepts/how-to-build-with-system-one`, `confidence`, `patterns/fan-out`,
`patterns/composite-scoring`, `patterns/confidence-routing`, `api`, `models`,
`model-jaggedness/jev-1.13`, `agent-skill`, and the cookbooks `semantic_find`,
`citation_check`, `parallel_questions`, `consistency_noul_cookbook` (all under
`https://docs.typesafe.ai/`).

1. **Request shape.** `POST https://api.typesafe.ai/v1/systemone`, bearer key, body `state`
   (string, object or array; text only), `model`, `questions` (map id to `{type, instructions,
   criteria}`). `instructions` and every criteria entry may be string, object or array. Noul
   `criteria` is optional `{true, false}`; Choice `criteria` is a map (at most 255 options, a
   value may be `null`); Score `criteria` is an ordered array ("at least two levels; the API
   accepts up to 10"). Malformed questions return 422.
2. **Ids are invisible.** "Question IDs are for your code. They are not sent to the model.
   Write the complete question in `instructions`, even when the ID seems self-explanatory."
3. **Independence.** "Every question in a request sees the same state, is evaluated
   independently"; "One question's answer is not hidden context for another." Shared reading
   rules must be repeated in each question that needs them.
4. **Limits (jev-1.13.0).** "64k tokens per request; 32k tokens for `state` plus the longest
   question." Input is charged ($0.042 per million tokens), output is free. 1,200 requests per
   minute and 250,000 tokens per second, "can change without notice"; 429 and 529 call for
   backoff. Rough offline estimate: about 2.4k tokens of questions per test, about 17k tokens
   for the largest dev file with line ids, so roughly 19 tests per request there.
5. **Version pinning.** "An alias moves when a new release ships ... pin that version's ID
   instead of the alias." The response's `model` field reports the version that answered. The
   limitations page applies to `jev-1.13`, last reviewed 2026-09-17.
6. **How certainty is reported.** A Noul is "the probability that the answer is yes" and "has
   no separate `confidence`"; near 0.5 means undecided, and "values in the middle can go to a
   person rather than either code path". Choice and Score return `probabilities` plus a
   `confidence` "computed from how `probabilities` is spread". Low Score confidence "usually
   means ... the levels overlap for this state, the question is measuring more than one thing,
   or the state doesn't say enough to place it." "Thresholds live in your code"; "start with
   conservative thresholds, test with your own data".
7. **Instruction style.** One snap judgment per question; "Ask one yes/no question per Noul";
   "Phrase the question so that a high value means yes"; make the yes/no boundary unambiguous
   and use `criteria` when it is subtle; "Keep questions short"; put code-supplied data in its
   own field instead of splicing it into the sentence; point at state with backticked
   dot-and-index paths; field names are free and visible to the model, "so use short names
   that label what follows". For open option sets add an `other` style option so the model can
   say none fit (the basis for `cannot_tell_from_file`).
8. **Score levels.** "Describe situations, not degrees." "Every level is evaluated separately.
   The model doesn't see a level's number or its neighbours ... numbers in the descriptions or
   the instructions don't help." One dimension per Score. Normalise by `len(criteria) - 1`.
   Do not interpolate magnitudes from a score; thresholding and ranking are fine.
9. **Known limitations that touch this design.** Literal reading ("answers the question you
   wrote, not the one you meant"); unreliable counting and number ordering; double negatives
   and multi-hop indirection cost accuracy; "accuracy falls as the state grows with content
   unrelated to the decision"; state content such as "text that argues for its own
   classification, can move the answer"; instructions and criteria must not contradict each
   other; no structural
   invariants across questions ("Don't carry a threshold tuned on a Noul over to a Choice").
10. **Batching.** Put every question for one state in one request; the parallel-questions
    cookbook reports no change in answers from batching. Two requests only when the second
    cannot be built without the first answer, which is not the case here.
11. **Language.** English is the primary training language; other languages "are accepted but
    currently have lower accuracy".
