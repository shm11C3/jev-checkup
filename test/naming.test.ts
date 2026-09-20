import assert from "node:assert/strict";
import test from "node:test";
import { getAspectDefinitions, getNamingAspectDefinition } from "../src/aspects/index.js";
import { judge } from "../src/derive/index.js";
import { hash, subjectRevision } from "../src/shared/hash.js";
import type { Answers, Config, PreparedTarget, Question } from "../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    model: "jev-1.13.0",
    include: ["**/*.ts"],
    exclude: [],
    concurrency: 1,
    requestsPerMinute: 1_200,
    tokensPerSecond: 250_000,
    top: 10,
    thresholds: {},
    ...overrides,
  };
}

function namingTarget(
  definition = getNamingAspectDefinition(config()),
  symbolKey = "n0001",
): PreparedTarget {
  const state = {
    file_path: "src/example.ts",
    source: "L1| function formatBytes() { return 1; }",
    target_symbol: {
      kind: "function",
      qualified_name: "function:formatBytes",
      name: "formatBytes",
      declaration: "function formatBytes() { return 1; }",
    },
  } as const;
  const questions = Object.fromEntries(
    Object.entries(definition.questions).map(([id, question]) => [
      id.replace("{symbol_key}", symbolKey),
      question as Question,
    ]),
  );
  const evidenceSources = [{ file: "src/example.ts", hash: "file-hash" }];
  return {
    fingerprint: "naming-fingerprint",
    aspect: "naming-honesty",
    location: { file: "src/example.ts", startLine: 1, endLine: 1 },
    target: { path: [], name: "formatBytes" },
    contextMode: "focus",
    inputHash: hash(state),
    subjectRevision: subjectRevision(definition.propositionVersion, evidenceSources),
    evidenceSources,
    state,
    questions,
    controls: { own: "not_available", sibling: "not_available" },
  };
}

function answers(symbolKey = "n0001", mismatch = 0.1, sideEffect = 0.1, context = 0.9): Answers {
  return {
    [`${symbolKey}__behavior_mismatch`]: { type: "noul", noul: mismatch },
    [`${symbolKey}__hidden_side_effect`]: { type: "noul", noul: sideEffect },
    [`${symbolKey}__context_sufficient`]: { type: "noul", noul: context },
  };
}

test("naming definitions are fixed and aspect order is preserved", () => {
  const definition = getNamingAspectDefinition(config({ thresholds: { finding: 0.1 } }));
  assert.equal(definition.id, "naming-honesty");
  assert.equal(definition.propositionVersion, "naming-honesty@1");
  assert.equal(definition.selector, "naming@1");
  assert.equal(definition.contextPolicy, "declaration@1");
  assert.equal(definition.composition, "naming-max@1");
  assert.deepEqual(definition.weights, { core: 1, partial: 0, weak: 0, weakMid: 0 });
  assert.equal(definition.thresholds.finding, 0.5);
  assert.deepEqual(
    Object.keys(definition.questions).map((id) => id.split("__").at(-1)),
    ["behavior_mismatch", "hidden_side_effect", "context_sufficient"],
  );
  assert.deepEqual(
    getAspectDefinitions(config()).map((item) => item.id),
    ["test-honesty"],
  );
  assert.deepEqual(
    getAspectDefinitions(config({ aspects: ["naming-honesty", "test-honesty"] })).map(
      (item) => item.id,
    ),
    ["naming-honesty", "test-honesty"],
  );
});

test("naming uses the provisional max formula and signal bands", () => {
  const definition = getNamingAspectDefinition(config());
  const target = namingTarget(definition);
  const clean = judge(answers("n0001", 0.4, 0.2), target, definition);
  assert.equal(clean.outcome, "clean");
  assert.equal(clean.suspicion, 0.4);
  assert.ok(Math.abs((clean.signal ?? 0) + 0.1) < Number.EPSILON);
  assert.equal(clean.band, null);

  const finding = judge(answers("n0001", 0.5, 0.2), target, definition);
  assert.equal(finding.outcome, "finding");
  assert.equal(finding.suspicion, 0.5);
  assert.equal(finding.signal, 0);
  assert.equal(finding.band, "0..0.05");
});

test("insufficient naming context is cannot_tell and question IDs are exact", () => {
  const definition = getNamingAspectDefinition(config());
  const target = namingTarget(definition);
  const uncertain = judge(answers("n0001", 0.9, 0.8, 0.69), target, definition);
  assert.equal(uncertain.outcome, "cannot_tell");
  assert.equal(uncertain.reason, "insufficient_context");
  assert.equal(uncertain.suspicion, 0.9);

  const malformed = answers("n0001");
  delete malformed["n0001__context_sufficient"];
  malformed["n0001__unknown"] = { type: "noul", noul: 0 };
  assert.equal(judge(malformed, target, definition).outcome, "not_judged");
  assert.equal(
    judge({ ...answers(), n0001: { type: "noul", noul: 0 } }, target, definition).outcome,
    "not_judged",
  );
});
