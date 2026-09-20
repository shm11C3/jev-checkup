import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "../src/plan/index.js";
import { observe, type JudgeClient } from "../src/observe/index.js";
import { hash } from "../src/shared/hash.js";
import type { AspectDefinition, PreparedTarget, Question } from "../src/types.js";

const question: Question = {
  type: "noul",
  instructions: "Does the test omit its stated outcome?",
  criteria: { true: "yes", false: "no" },
};
const secondQuestion: Question = {
  type: "noul",
  instructions: "Does the title describe a call without checking it?",
  criteria: { true: "yes", false: "no" },
};
const definition: AspectDefinition = {
  id: "test-honesty", propositionVersion: "test-title-honesty@1", model: "jev-1.13.0",
  selector: "tests@1", parser: "parser@1", contextPolicy: "focusprod-or-focus@1", composition: "test-honesty@1",
  weights: { core: 0.6, partial: 0.25, weak: 0.4, weakMid: 0.5 },
  thresholds: { strong: 0.8, unseen: 0.7, midLow: 0.35, midHigh: 0.65, confidence: 0.5, finding: 0.3, control: 0.5 },
  bandEdges: [0.05, 0.15, 0.3], questions: { q: question },
};

function target(state: PreparedTarget["state"], questions = { q: question }): PreparedTarget {
  return {
    fingerprint: hash(state), aspect: "test-honesty", location: { file: "example.test.ts", startLine: 1, endLine: 2 },
    target: { path: ["example"], name: "does the thing" }, contextMode: "focus", inputHash: hash(state), subjectRevision: "revision",
    evidenceSources: [{ file: "example.test.ts", hash: "source-hash" }], state, questions,
    controls: { own: "available", sibling: "not_available" },
  };
}

function response(questionNames: string[], requestId = "request-1") {
  return {
    model: definition.model,
    requestId,
    answers: Object.fromEntries(questionNames.map(name => [name, { type: "noul", noul: 0.8 }])),
    usage: { input_tokens: 123, output_tokens: 5 },
  };
}

test("observes fresh answers, atomically caches them, and reuses cache without a key", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prepared = target({ source: 'it("does the thing", () => expect(true).toBe(true))' });
  const plan = await createPlan([prepared], definition, stateDir);
  let calls = 0;
  const client: JudgeClient = { systemOne: async request => {
    calls++;
    assert.deepEqual(Object.keys(request.questions), ["q"]);
    return response(["q"]);
  } };
  const first = await observe(plan, definition, { stateDir, concurrency: 2, requestsPerMinute: 1200, tokensPerSecond: 1_000_000, client });
  assert.equal(calls, 1);
  assert.equal(first.usage.requests, 1);
  assert.equal(first.usage.inputTokens, 123);
  assert.equal(first.observations[0]?.answers.q?.noul, 0.8);
  const files = await readdir(join(stateDir, "observations"));
  assert.equal(files.length, 1);
  const cacheText = await readFile(join(stateDir, "observations", files[0]!), "utf8");
  assert.ok(!cacheText.includes("it(\"does the thing\""));

  const cachedPlan = await createPlan([prepared], definition, stateDir);
  assert.equal(cachedPlan.requests, 0);
  assert.equal(cachedPlan.cacheHits, 1);
  const cached = await observe(cachedPlan, definition, { stateDir, concurrency: 1, requestsPerMinute: 1, tokensPerSecond: 1 });
  assert.equal(calls, 1);
  assert.equal(cached.usage.requests, 0);
  assert.equal(cached.usage.cacheHits, 1);
  assert.equal(cached.observations[0]?.answers.q?.noul, 0.8);
});

test("requests only the missing question and rejects mismatched responses without caching", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-partial-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const questions = { q: question, second: secondQuestion };
  const prepared = target({ source: "source" }, questions);
  const initialPlan = await createPlan([prepared], definition, stateDir);
  const firstClient: JudgeClient = { systemOne: async request => response(Object.keys(request.questions)) };
  await observe(initialPlan, definition, { stateDir, concurrency: 1, requestsPerMinute: 1200, tokensPerSecond: 1_000_000, client: firstClient });
  const partialPlan = await createPlan([prepared], definition, stateDir);
  assert.equal(partialPlan.requests, 0);

  // Corrupt one question's record; planning must treat only that answer as a miss.
  const files = await readdir(join(stateDir, "observations"));
  const firstPath = join(stateDir, "observations", files[0]!);
  const original = JSON.parse(await readFile(firstPath, "utf8"));
  original.answer = { type: "noul", noul: 2 };
  await import("node:fs/promises").then(fs => fs.writeFile(firstPath, JSON.stringify(original)));
  const missPlan = await createPlan([prepared], definition, stateDir);
  assert.equal(missPlan.requests, 1);
  assert.equal(Object.keys(missPlan.items[0]!.missingQuestions).length, 1);
  const invalid: JudgeClient = { systemOne: async request => ({ ...response(Object.keys(request.questions)), model: "jev-other" }) };
  const result = await observe(missPlan, definition, { stateDir, concurrency: 1, requestsPerMinute: 1200, tokensPerSecond: 1_000_000, client: invalid });
  assert.equal(result.observations[0]?.outcome, "not_judged");
  assert.equal(result.observations[0]?.reason, "model_mismatch");
  assert.equal(result.usage.requests, 1);
});

test("aborts a client that does not observe its signal", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-abort-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prepared = target({ source: "slow source" });
  const plan = await createPlan([prepared], definition, stateDir);
  const controller = new AbortController();
  const client: JudgeClient = { systemOne: async () => new Promise(() => undefined) };
  const running = observe(plan, definition, {
    stateDir, concurrency: 1, requestsPerMinute: 1200, tokensPerSecond: 1_000_000,
    signal: controller.signal, client,
  });
  controller.abort();
  const result = await running;
  assert.equal(result.observations[0]?.outcome, "unevaluated");
  assert.equal(result.observations[0]?.reason, "aborted");
});

test("turns a fixed request timeout into an unevaluated observation", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-timeout-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prepared = target({ source: "timeout source" });
  const plan = await createPlan([prepared], definition, stateDir);
  const client: JudgeClient = { systemOne: async () => new Promise(resolve => setTimeout(() => resolve(response(["q"])), 50)) };
  const result = await observe(plan, definition, {
    stateDir, concurrency: 1, requestsPerMinute: 1200, tokensPerSecond: 1_000_000,
    timeoutMs: 5, client,
  });
  assert.equal(result.observations[0]?.outcome, "unevaluated");
  assert.equal(result.observations[0]?.reason, "timeout");
});
