import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, isValidAnswer, MAX_INPUT_TOKENS_PER_QUESTION } from "../src/plan/index.js";
import { hash } from "../src/shared/hash.js";
import type { AspectDefinition, PreparedTarget, Question } from "../src/types.js";

const question: Question = {
  type: "noul",
  instructions: "Does the test omit its stated outcome?",
  criteria: { true: "yes", false: "no" },
};

const definition: AspectDefinition = {
  id: "test-honesty",
  propositionVersion: "test-title-honesty@1",
  model: "jev-1.13.0",
  selector: "tests@1",
  parser: "parser@1",
  contextPolicy: "focusprod-or-focus@1",
  composition: "test-honesty@1",
  weights: { core: 0.6, partial: 0.25, weak: 0.4, weakMid: 0.5 },
  thresholds: { strong: 0.8, unseen: 0.7, midLow: 0.35, midHigh: 0.65, confidence: 0.5, finding: 0.3, control: 0.5 },
  bandEdges: [0.05, 0.15, 0.3],
  questions: { q: question },
};

function target(state: PreparedTarget["state"], questions = { q: question }): PreparedTarget {
  return {
    fingerprint: hash(state), aspect: "test-honesty",
    location: { file: "src/example.test.ts", startLine: 1, endLine: 3 },
    target: { path: ["example"], name: "does the thing" },
    contextMode: "focus", inputHash: hash(state), subjectRevision: "revision",
    evidenceSources: [{ file: "src/example.test.ts", hash: "source-hash" }],
    state, questions, controls: { own: "available", sibling: "not_available" },
  };
}

test("planning reads cache only and does not create state", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-plan-"));
  await rm(stateDir, { recursive: true, force: true });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const plan = await createPlan([target({ source: 'it("does the thing", () => expect(true).toBe(true))' })], definition, stateDir);
  assert.equal(plan.requests, 1);
  assert.equal(plan.cacheHits, 0);
  await assert.rejects(access(stateDir));
});

test("planning marks approximate input-limit violations unjudgeable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-plan-limit-"));
  try {
    const huge = "x".repeat(MAX_INPUT_TOKENS_PER_QUESTION * 3);
    const plan = await createPlan([target({ source: huge })], definition, stateDir);
    assert.equal(plan.requests, 0);
    assert.equal(plan.unjudgeable, 1);
    assert.equal(plan.items[0]?.blockedReason, "input_limit");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cache validation accepts independently rounded probabilities but rejects corrupt totals", () => {
  const q: Question = { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B", c: "C", d: "D" } };
  const answer = { type: "choice", choice: "d", confidence: 0.79, probabilities: { a: 0.04, b: 0.02, c: 0.14, d: 0.79 } };
  assert.equal(isValidAnswer(q, answer), true);
  assert.equal(isValidAnswer(q, { ...answer, probabilities: { ...answer.probabilities, d: 0.5 } }), false);
});
