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

function requestError(
  status: number | undefined,
  extra: Record<string, unknown> = {},
): Error & Record<string, unknown> {
  const error = new Error(`request failed with secret body ${status ?? "transport"}`) as Error & Record<string, unknown>;
  if (status !== undefined) error.status = status;
  Object.assign(error, extra);
  return error;
}

function fastObserveOptions(stateDir: string, client: JudgeClient) {
  return {
    stateDir,
    concurrency: 1,
    requestsPerMinute: Number.POSITIVE_INFINITY,
    tokensPerSecond: Number.POSITIVE_INFINITY,
    retryBackoffMs: 0,
    client,
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

test("retries transient failures through the limiter and counts each attempt", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-retry-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prepared = target({ source: "transient source" });
  const plan = await createPlan([prepared], definition, stateDir);
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    if (calls < 3) throw requestError(503);
    return response(["q"], `request-${calls}`);
  } };

  const result = await observe(plan, definition, fastObserveOptions(stateDir, client));
  assert.equal(calls, 3);
  assert.equal(result.usage.requests, 3);
  assert.equal(result.observations[0]?.answers.q?.noul, 0.8);
});

test("classifies final transient failures and preserves sanitized reasons", async t => {
  const cases: [string, number | undefined, string][] = [
    ["rate limit", 429, "rate_limited"],
    ["server failure", 529, "server_error"],
    ["transport failure", undefined, "request_failed"],
  ];
  for (const [label, status, reason] of cases) {
    await t.test(label, async subtest => {
      const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-final-failure-"));
      subtest.after(() => rm(stateDir, { recursive: true, force: true }));
      const prepared = target({ source: label });
      const plan = await createPlan([prepared], definition, stateDir);
      let calls = 0;
      const client: JudgeClient = { systemOne: async () => {
        calls++;
        throw requestError(status);
      } };

      const result = await observe(plan, definition, fastObserveOptions(stateDir, client));
      assert.equal(calls, 3);
      assert.equal(result.usage.requests, 3);
      assert.equal(result.observations[0]?.outcome, "unevaluated");
      assert.equal(result.observations[0]?.reason, reason);
      assert.ok(!JSON.stringify(result).includes("secret body"));
    });
  }
});

test("a transient retry must wait for request capacity", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-retry-capacity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const plan = await createPlan([target({ source: "retry capacity" })], definition, stateDir);
  const controller = new AbortController();
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    setTimeout(() => controller.abort(), 5);
    throw requestError(429);
  } };
  const result = await observe(plan, definition, {
    ...fastObserveOptions(stateDir, client), requestsPerMinute: 60, signal: controller.signal,
  });
  assert.equal(calls, 1);
  assert.equal(result.usage.requests, 1);
  assert.equal(result.observations[0]?.reason, "aborted");
});

test("a server delay outside the retry window never triggers an early retry", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-long-delay-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const plan = await createPlan([target({ source: "long retry delay" })], definition, stateDir);
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    throw requestError(429, { headers: { "retry-after": "3600" } });
  } };
  const result = await observe(plan, definition, fastObserveOptions(stateDir, client));
  assert.equal(calls, 1);
  assert.equal(result.observations[0]?.reason, "rate_limited");
});

test("does not retry authentication failures and stops queued work", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-auth-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const plan = await createPlan([
    target({ source: "authentication failure" }),
    target({ source: "queued after authentication failure" }),
  ], definition, stateDir);
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    throw requestError(401);
  } };

  const result = await observe(plan, definition, {
    ...fastObserveOptions(stateDir, client),
    concurrency: 2,
    requestsPerMinute: 1_200,
  });
  assert.equal(calls, 1);
  assert.equal(result.usage.requests, 1);
  assert.deepEqual(result.observations.map(observation => observation.reason), ["auth_failed", "auth_failed"]);
});

test("honors a zero Retry-After and aborts while backing off", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-retry-abort-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prepared = target({ source: "retry then abort" });
  const plan = await createPlan([prepared], definition, stateDir);
  const controller = new AbortController();
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    if (calls === 1) {
      throw requestError(429, { headers: new Headers({ "Retry-After": "0" }) });
    }
    throw requestError(503);
  } };
  const running = observe(plan, definition, {
    ...fastObserveOptions(stateDir, client),
    retryBackoffMs: 1_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  const result = await running;
  assert.equal(calls, 2);
  assert.equal(result.usage.requests, 2);
  assert.equal(result.observations[0]?.reason, "aborted");
});

test("aborts a request waiting in the limiter queue", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-queued-abort-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const plan = await createPlan([
    target({ source: "first queued request" }),
    target({ source: "second queued request" }),
  ], definition, stateDir);
  const controller = new AbortController();
  let calls = 0;
  const client: JudgeClient = { systemOne: async () => {
    calls++;
    return new Promise(() => undefined);
  } };
  const running = observe(plan, definition, {
    ...fastObserveOptions(stateDir, client),
    concurrency: 2,
    requestsPerMinute: 1_200,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  const result = await running;
  assert.equal(calls, 1);
  assert.equal(result.usage.requests, 1);
  assert.deepEqual(result.observations.map(observation => observation.reason), ["aborted", "aborted"]);
});

test("classifies only unambiguous input limits as unjudgeable", async t => {
  const cases: [string, number, Record<string, unknown>, string][] = [
    ["generic invalid input", 400, { message: "invalid input" }, "request_failed"],
    ["invalid token", 422, { error: { message: "token invalid" } }, "request_failed"],
    ["invalid token limit parameter", 422, { message: "invalid token limit parameter" }, "request_failed"],
    ["invalid context", 422, { detail: "invalid context" }, "request_failed"],
    ["invalid maximum context length setting", 422, { detail: "invalid maximum context length setting" }, "request_failed"],
    ["payload schema", 400, { error: "payload schema invalid" }, "request_failed"],
    ["413 status", 413, { message: "request rejected" }, "input_limit"],
    ["explicit size code", 400, { error: { code: "input_too_large" } }, "input_limit"],
    ["explicit size phrase", 422, { detail: "maximum context length exceeded" }, "input_limit"],
  ];
  for (const [label, status, body, reason] of cases) {
    await t.test(label, async subtest => {
      const stateDir = await mkdtemp(join(tmpdir(), "jev-observe-input-limit-"));
      subtest.after(() => rm(stateDir, { recursive: true, force: true }));
      const plan = await createPlan([target({ source: label })], definition, stateDir);
      let calls = 0;
      const client: JudgeClient = { systemOne: async () => {
        calls++;
        throw requestError(status, { body });
      } };

      const result = await observe(plan, definition, fastObserveOptions(stateDir, client));
      assert.equal(calls, 1);
      assert.equal(result.usage.requests, 1);
      assert.equal(result.observations[0]?.outcome, reason === "input_limit" ? "unjudgeable" : "unevaluated");
      assert.equal(result.observations[0]?.reason, reason);
      assert.ok(!JSON.stringify(result).includes("invalid input"));
    });
  }
});
