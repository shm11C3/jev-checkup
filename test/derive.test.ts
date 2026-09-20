import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { deriveRun, judge } from "../src/derive/index.js";
import { hash, subjectRevision } from "../src/shared/hash.js";
import type {
  Answers,
  AspectDefinition,
  DeriveInput,
  Label,
  PreparedTarget,
  Question,
  Run,
  Selection,
} from "../src/types.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version: string };

const properties = [
  "outcome_unasserted",
  "result_claim_call_only",
  "call_claim_no_call_check",
  "subject_not_in_play",
  "extra_claim_unasserted",
  "general_claim_single_case",
  "vague_title",
  "assertion_specificity",
  "hinges_on_unseen_rule",
  "verdict",
  "ctl_own_snippet",
  "ctl_sibling_snippet",
];

function question(property: string): Question {
  if (property === "assertion_specificity") return {
    type: "score",
    instructions: property,
    criteria: ["exact", "partial", "existence"],
  };
  if (property === "verdict") return {
    type: "choice",
    instructions: property,
    criteria: {
      verifies: "verifies",
      verifies_part: "part",
      does_not_verify: "does not",
      cannot_tell_from_file: "unknown",
    },
  };
  return { type: "noul", instructions: property, criteria: { true: "yes", false: "no" } };
}

const definition: AspectDefinition = {
  id: "test-honesty",
  propositionVersion: "test-honesty@1",
  model: "jev-1.13.0",
  selector: "tests@1",
  parser: "parser@1",
  contextPolicy: "focusprod-or-focus@1",
  composition: "test-honesty@1",
  weights: { core: 0.6, partial: 0.25, weak: 0.4, weakMid: 0.5 },
  thresholds: { strong: 0.8, unseen: 0.7, midLow: 0.35, midHigh: 0.65, confidence: 0.5, finding: 0.3, control: 0.5 },
  bandEdges: [0, 0.05, 0.15, 0.3],
  questions: Object.fromEntries(properties.map(property => [`t0001__${property}`, question(property)])),
};

function noul(value: number): Record<string, unknown> {
  return { type: "noul", noul: value };
}

function answers(prefix = "t0001", overrides: Record<string, Record<string, unknown>> = {}): Answers {
  const values: Answers = {};
  for (const property of properties) {
    const id = `${prefix}__${property}`;
    if (property === "assertion_specificity") {
      values[id] = { type: "score", score: 0, confidence: 1, legend: { "0": "exact", "1": "partial", "2": "existence" }, probabilities: { "0": 1, "1": 0, "2": 0 } };
    } else if (property === "verdict") {
      values[id] = { type: "choice", choice: "verifies", confidence: 1, probabilities: { verifies: 1, verifies_part: 0, does_not_verify: 0, cannot_tell_from_file: 0 } };
    } else {
      values[id] = noul(0.05);
    }
  }
  values[`${prefix}__ctl_own_snippet`] = noul(0.95);
  return { ...values, ...Object.fromEntries(Object.entries(overrides).map(([property, value]) => [`${prefix}__${property}`, value])) };
}

function target(
  fingerprint: string,
  options: Partial<PreparedTarget> = {},
): PreparedTarget {
  const state = { file_path: "src/example.test.ts", target: fingerprint } as const;
  const evidenceSources = options.evidenceSources ?? [{ file: "src/example.test.ts", hash: "file-hash" }];
  return {
    fingerprint,
    aspect: "test-honesty",
    location: { file: "src/example.test.ts", startLine: 1, endLine: 5 },
    target: { path: ["test"], name: fingerprint },
    contextMode: "focus",
    inputHash: hash(state),
    subjectRevision: subjectRevision(definition.propositionVersion, evidenceSources),
    evidenceSources,
    state,
    questions: Object.fromEntries(properties.filter(property => options.controls?.own !== "not_available" || property !== "ctl_own_snippet")
      .filter(property => options.controls?.sibling !== "not_available" || property !== "ctl_sibling_snippet")
      .map(property => [`t0001__${property}`, question(property)])),
    controls: { own: "available", sibling: "available" },
    ...options,
  };
}

function selection(targets: PreparedTarget[], sourceHashes: Record<string, string> = { "src/example.test.ts": "file-hash" }): Selection {
  return {
    scope: {
      repositoryId: "repo",
      id: "scope",
      paths: ["src"],
      include: ["**/*.ts"],
      exclude: [],
      languages: ["typescript"],
      selectionPolicy: "tests@1",
      enumerationComplete: true,
      files: [{ file: "src/example.test.ts", status: "parsed", hash: "file-hash" }],
    },
    targets,
    sourceHashes,
    errors: [],
  };
}

function input(overrides: Partial<DeriveInput> = {}): DeriveInput {
  const first = target("a");
  return {
    selection: selection([first]),
    definition,
    observations: [{ fingerprint: "a", answers: answers() }],
    usage: { requests: 1, inputTokens: 10, cacheHits: 0 },
    labels: [],
    history: [],
    metadata: { id: "run-1", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    top: 10,
    ...overrides,
  };
}

test("judge composes the drafted weighted rule and buckets signal", () => {
  const result = judge(answers("t0001", {
    outcome_unasserted: noul(0.8),
    extra_claim_unasserted: noul(0),
    general_claim_single_case: noul(0),
    vague_title: noul(0),
    assertion_specificity: { type: "score", score: 2, confidence: 1, legend: { "0": "exact", "1": "partial", "2": "existence" }, probabilities: { "0": 0, "1": 0, "2": 1 } },
  }), target("a"), definition);
  assert.equal(result.outcome, "finding");
  assert.equal(result.suspicion, 0.8);
  assert.equal(result.signal, 0.5);
  assert.equal(result.band, ">=0.30");
});

test("missing requested answers are not judged while omitted controls are optional", () => {
  const noControls = target("a", { controls: { own: "not_available", sibling: "not_available" } });
  const result = judge(answers("t0001", {
    // The control entries are deliberately left out by deleting them below.
  }), noControls, definition);
  assert.equal(result.outcome, "clean");

  const missing = { ...answers() };
  delete missing["t0001__vague_title"];
  assert.equal(judge(missing, target("a"), definition).outcome, "not_judged");
});

test("malformed probability and choice responses are not judged", () => {
  const malformedScore = answers("t0001", {
    assertion_specificity: { type: "score", score: 0, confidence: 1, legend: { "0": "exact", "1": "partial", "2": "existence" }, probabilities: { "0": 2, "1": -1, "2": 0 } },
  });
  assert.equal(judge(malformedScore, target("a"), definition).outcome, "not_judged");
  const malformedChoice = answers("t0001", { verdict: { type: "choice", choice: "verifies", confidence: 1, probabilities: { verifies: 0.5 } } });
  assert.equal(judge(malformedChoice, target("a"), definition).outcome, "not_judged");
});

test("an uncalibrated clean scan has no score or total", () => {
  const run = deriveRun(input());
  assert.equal(run.targets[0]!.outcome, "clean");
  assert.equal(run.aspects[0]!.score, null);
  assert.equal(run.aspects[0]!.inTotal, false);
  assert.equal(run.total.score, null);
  assert.equal(run.total.aspects, 0);
});

test("run metadata uses the package version", () => {
  assert.equal(deriveRun(input()).tool, packageMetadata.version);
});

test("review actions close findings without changing raw evidence or score", () => {
  const prepared = target("a");
  const label: Label = {
    fingerprint: prepared.fingerprint,
    propositionVersion: definition.propositionVersion,
    subjectRevision: prepared.subjectRevision,
    evidenceSources: prepared.evidenceSources,
    validity: "valid",
    priority: "high",
    source: "human",
  };
  const baseline = deriveRun(input({
    selection: selection([prepared]),
    observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
    labels: [label],
  }));
  assert.equal(baseline.findings.length, 1);
  assert.equal(baseline.aspects[0]!.open, 1);
  assert.equal(baseline.aspects[0]!.score, 0);

  for (const resolution of ["accept", "defer", "dismiss"] as const) {
    const run = deriveRun(input({
      selection: selection([prepared]),
      observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
      labels: [{ ...label, resolution }],
    }));
    assert.equal(run.findings.length, 1);
    assert.equal(run.aspects[0]!.open, 0);
    assert.equal(run.aspects[0]!.score, baseline.aspects[0]!.score);
    assert.deepEqual(run.topFindings[definition.id], []);
  }
});

test("labels use current source hashes, recomputed revisions, and agent labels as provisional calibration", () => {
  const prepared = target("a");
  const extra = { file: "docs/fixture.md", hash: "extra-hash" };
  const label: Label = {
    fingerprint: "a",
    propositionVersion: definition.propositionVersion,
    evidenceSources: [...prepared.evidenceSources, extra],
    subjectRevision: subjectRevision(definition.propositionVersion, [...prepared.evidenceSources, extra]),
    validity: "valid",
    priority: "high",
    source: "agent",
  };
  const run = deriveRun(input({
    selection: selection([prepared], { "src/example.test.ts": "file-hash", "docs/fixture.md": "extra-hash" }),
    observations: [{ fingerprint: "a", answers: answers("t0001", {
      outcome_unasserted: noul(0.8),
      extra_claim_unasserted: noul(0),
      general_claim_single_case: noul(0),
      vague_title: noul(0),
      assertion_specificity: { type: "score", score: 2, confidence: 1, legend: { "0": "exact", "1": "partial", "2": "existence" }, probabilities: { "0": 0, "1": 0, "2": 1 } },
    }) }],
    labels: [label],
  }));
  const calibration = run.aspects[0]!.calibration.byContextMode.focus;
  assert.equal(calibration.source, "local");
  assert.equal(calibration.table[">=0.30"].pValid, 1);
  assert.equal(calibration.table[">=0.30"].pHigh, 1);
  assert.equal(run.findings[0]!.label?.source, "agent");
});

test("invalid observation makes the run incomplete and is retained in the target manifest", () => {
  const run = deriveRun(input({
    observations: [{ fingerprint: "a", outcome: "unevaluated", reason: "network" }],
  }));
  assert.equal(run.run.complete, false);
  assert.equal(run.targets[0]!.outcome, "unevaluated");
});

test("selection errors persist when no file was selected", () => {
  const selected = selection([]);
  selected.scope.files = [];
  selected.errors = ["enumeration_failed"];
  const run = deriveRun(input({ selection: selected, observations: [] }));
  assert.equal(run.run.complete, false);
  assert.deepEqual(run.unmeasured.selectionErrors, ["enumeration_failed"]);
  selected.errors.push("later_error");
  assert.deepEqual(run.unmeasured.selectionErrors, ["enumeration_failed"]);
});

test("snapshot question hashes track instruction and criteria changes", () => {
  const prepared = target("a");
  const observation = [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }];
  const original = deriveRun(input({ selection: selection([prepared]), observations: observation }));
  const inputHash = prepared.inputHash;
  const originalSnapshot = original.snapshots[inputHash]!;
  assert.equal(originalSnapshot.questionsHash, hash(originalSnapshot.questions));

  const instructionsChanged = target("a");
  const outcomeQuestion = instructionsChanged.questions["t0001__outcome_unasserted"]!;
  instructionsChanged.questions = {
    ...instructionsChanged.questions,
    "t0001__outcome_unasserted": { ...outcomeQuestion, instructions: "Changed wording" },
  };
  const changedInstructionsRun = deriveRun(input({ selection: selection([instructionsChanged]), observations: observation }));
  assert.equal(instructionsChanged.inputHash, inputHash);
  assert.notEqual(changedInstructionsRun.snapshots[inputHash]!.questionsHash, originalSnapshot.questionsHash);

  const criteriaChanged = target("a");
  const specificityQuestion = criteriaChanged.questions["t0001__assertion_specificity"]!;
  criteriaChanged.questions = {
    ...criteriaChanged.questions,
    "t0001__assertion_specificity": { ...specificityQuestion, criteria: ["exact", "partial", "changed"] },
  };
  const changedCriteriaRun = deriveRun(input({ selection: selection([criteriaChanged]), observations: observation }));
  assert.equal(criteriaChanged.inputHash, inputHash);
  assert.notEqual(changedCriteriaRun.snapshots[inputHash]!.questionsHash, originalSnapshot.questionsHash);
});

test("stale labels and labels omitting the target source cannot suppress findings", () => {
  for (const evidenceSources of [
    [{ file: "src/example.test.ts", hash: "previous-hash" }],
    [{ file: "docs/fixture.md", hash: "extra-hash" }],
  ]) {
    const label: Label = {
      fingerprint: "a", propositionVersion: definition.propositionVersion,
      evidenceSources, subjectRevision: subjectRevision(definition.propositionVersion, evidenceSources),
      validity: "valid", priority: "high", resolution: "dismiss", source: "human",
    };
    const run = deriveRun(input({
      selection: selection([target("a")], { "src/example.test.ts": "file-hash", "docs/fixture.md": "extra-hash" }),
      observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
      labels: [label],
    }));
    assert.equal(run.findings[0]?.label, null);
    assert.deepEqual(run.topFindings[definition.id], ["a"]);
    assert.equal(run.aspects[0]?.score, null);
  }
});

test("a compatible baseline marks a newly selected finding as new", () => {
  const first = deriveRun(input({ metadata: { id: "run-1", at: "2026-09-19T00:00:00.000Z", commit: null, dirty: false, complete: true } }));
  const currentTarget = target("b");
  const current = deriveRun(input({
    selection: selection([currentTarget]),
    observations: [{ fingerprint: "b", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
    metadata: { id: "run-2", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [first],
  }));
  assert.equal(current.findings[0]!.status, "new");
  assert.equal(current.aspects[0]!.comparison.new, 1);
});

for (const reason of ["dynamic test name", "skipped tests: 1"]) {
  test(`selection diagnostic (${reason}) keeps an omitted prior finding pending`, () => {
    const first = deriveRun(input({ metadata: { id: "run-1", at: "2026-09-19T00:00:00.000Z", commit: null, dirty: false, complete: true }, observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }] }));
    const currentSelection = selection([]);
    currentSelection.scope.files[0] = { file: "src/example.test.ts", status: "parsed", hash: "file-hash", reason };
    const current = deriveRun(input({
      selection: currentSelection,
      observations: [],
      metadata: { id: "run-2", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
      history: [first],
    }));
    assert.equal(current.resolved.length, 0);
    assert.equal(current.pendingComparisons[0]?.reason, "selection_diagnostic");
  });
}

test("a recoverable selection diagnostic does not erase the previous baseline", () => {
  const first = deriveRun(input({
    metadata: { id: "run-1", at: "2026-09-18T00:00:00.000Z", commit: null, dirty: false, complete: true },
    observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
  }));
  const uncertainSelection = selection([]);
  uncertainSelection.scope.files[0] = { file: "src/example.test.ts", status: "parsed", hash: "file-hash", reason: "parse_diagnostic:target_overlap" };
  const uncertain = deriveRun(input({
    selection: uncertainSelection,
    observations: [],
    metadata: { id: "run-2", at: "2026-09-19T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [first],
  }));
  assert.equal(uncertain.pendingComparisons[0]?.reason, "selection_diagnostic");

  const returned = deriveRun(input({
    selection: selection([target("a")]),
    observations: [{ fingerprint: "a", answers: answers() }],
    metadata: { id: "run-3", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [first, uncertain],
  }));
  assert.equal(returned.targets[0]!.outcome, "clean");
  assert.deepEqual(returned.resolved, [{ fingerprint: "a", baselineRun: "run-1", reason: "value_dropped" }]);

  const goneSelection = selection([]);
  const gone = deriveRun(input({
    selection: goneSelection,
    observations: [],
    metadata: { id: "run-3", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [first, uncertain],
  }));
  assert.deepEqual(gone.resolved, [{ fingerprint: "a", baselineRun: "run-1", reason: "target_gone" }]);
});

test("a selection diagnostic does not mark a fresh finding as new", () => {
  const previousSelection = selection([]);
  previousSelection.scope.files[0] = { file: "src/example.test.ts", status: "parsed", hash: "file-hash", reason: "parse_diagnostic:target_overlap" };
  const previous = deriveRun(input({
    selection: previousSelection,
    observations: [],
    metadata: { id: "run-1", at: "2026-09-19T00:00:00.000Z", commit: null, dirty: false, complete: true },
  }));
  const current = deriveRun(input({
    selection: selection([target("fresh")]),
    observations: [{ fingerprint: "fresh", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
    metadata: { id: "run-2", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [previous],
  }));
  assert.equal(current.findings[0]!.status, "uncompared");
  assert.deepEqual(current.pendingComparisons, [{ fingerprint: "fresh", baselineRun: "run-1", reason: "selection_diagnostic" }]);
});

test("an inconclusive prior run prevents target_gone resolution", () => {
  const first = deriveRun(input({
    metadata: { id: "run-1", at: "2026-09-18T00:00:00.000Z", commit: null, dirty: false, complete: true },
    observations: [{ fingerprint: "a", answers: answers("t0001", { outcome_unasserted: noul(0.8) }) }],
  }));
  const inconclusive = deriveRun(input({
    metadata: { id: "run-2", at: "2026-09-19T00:00:00.000Z", commit: null, dirty: false, complete: true },
    observations: [{ fingerprint: "a", answers: answers("t0001", { hinges_on_unseen_rule: noul(0.8) }) }],
    history: [first],
  }));
  const gone = deriveRun(input({
    selection: selection([]),
    observations: [],
    metadata: { id: "run-3", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    history: [first, inconclusive],
  }));
  assert.equal(gone.resolved.length, 0);
  assert.equal(gone.pendingComparisons[0]?.reason, "prior_run_not_conclusive");
});
