import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.js";
import { readRun, writeRun } from "../src/cli/storage.js";
import type { Answers, Questions } from "../src/types.js";
import type { JudgeClient } from "../src/observe/index.js";

function answers(questions: Questions, finding: boolean): Answers {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const property = id.split("__").at(-1)!;
    if (question.type === "noul") return [id, { type: "noul", noul: property === "ctl_own_snippet" ? 1 : property === "outcome_unasserted" && finding ? 0.9 : 0 }];
    if (question.type === "score") return [id, { type: "score", score: 0, confidence: 1, probabilities: { "0": 1, "1": 0, "2": 0 }, legend: { "0": "Exact asserted result", "1": "Partial shape", "2": "Existence only" } }];
    const criteria = question.criteria as Record<string, unknown>;
    const choice = "verifies" in criteria ? "verifies" : Object.keys(criteria)[0]!;
    return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])) }];
  }));
}

async function repository(t: { after(fn: () => Promise<unknown>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jev-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "double.ts"), "export function double(n: number) { return n * 2; }\n");
  await writeFile(join(root, "double.test.ts"), `import { double } from './double';
describe('double', () => {
  it('doubles the number', () => {
    const result = double(2);
    expect(result).toBeDefined();
  });
});
`);
  return root;
}

function output() {
  let stdout = "", stderr = "";
  return { stdout: (s: string) => { stdout += s; }, stderr: (s: string) => { stderr += s; }, get out() { return stdout; }, get err() { return stderr; } };
}

test("dry-run needs no credentials, plans context and makes no writes or model calls", async t => {
  const cwd = await repository(t);
  const io = output();
  const exit = await runCli(["scan", "--dry-run"], { cwd, apiKey: null, ...io, client: { systemOne: async () => { throw new Error("must not be called"); } } });
  assert.equal(exit, 0, io.err);
  const plan = JSON.parse(io.out);
  assert.equal(plan.targetCount, 1);
  assert.equal(plan.requests, 1);
  assert.equal(plan.targets[0].contextMode, "focusprod");
  assert.deepEqual((await readdir(cwd)).sort(), ["double.test.ts", "double.ts"]);
});

test("scan, cache reuse, immutable history, offline report and snapshot brief work together", async t => {
  const cwd = await repository(t);
  let calls = 0;
  let clean = false;
  const client: JudgeClient = { async systemOne(request) {
    calls++;
    return { model: request.model, answers: answers(request.questions, !clean), usage: { input_tokens: 100 } };
  } };
  const firstIO = output();
  assert.equal(await runCli(["scan", "--history", ".jev-checkup/history"], { cwd, apiKey: null, client, ...firstIO }), 0, firstIO.err);
  assert.equal(calls, 1);
  const filename = join(cwd, ".jev-checkup/run.json");
  const first = await readRun(filename);
  assert.equal(first.findings.length, 1);
  assert.equal(first.total.score, null);
  assert.equal(first.usage.requests, 1);
  assert.equal(first.usage.inputTokens, 100);
  assert.equal(first.run.complete, true);
  const briefIO = output();
  assert.equal(await runCli(["brief", filename], { cwd, apiKey: null, ...briefIO }), 0, briefIO.err);
  assert.match(briefIO.out, /toBeDefined/);
  const secondIO = output();
  assert.equal(await runCli(["scan", "--history", ".jev-checkup/history"], { cwd, apiKey: null, ...secondIO }), 0, secondIO.err);
  assert.equal(calls, 1);
  const second = await readRun(filename);
  assert.equal(second.usage.requests, 0);
  assert.equal(second.usage.inputTokens, 0);
  assert.equal(second.findings[0]!.status, "persisting");
  assert.equal((await readdir(join(cwd, ".jev-checkup/history"))).length, 2);
  await assert.rejects(writeRun(join(cwd, ".jev-checkup/history", `${first.run.id}.json`), second, true), /EEXIST/);

  const label = { ...second.findings[0]!.labelTemplate, validity: "valid", priority: "high", resolution: "fix", source: "human" };
  await writeFile(join(cwd, ".jev-checkup/labels.jsonl"), `${JSON.stringify(label)}\n`);
  assert.equal(await runCli(["scan"], { cwd, apiKey: null, ...output() }), 0);
  const calibrated = await readRun(filename);
  assert.equal(calibrated.findings[0]!.evidence.pValid, 1);
  assert.equal(calibrated.total.score, 0);

  const priorPath = join(cwd, ".jev-checkup/history", `${first.run.id}.json`);
  const oldSource = await readFile(join(cwd, "double.test.ts"), "utf8");
  await writeFile(join(cwd, "double.test.ts"), oldSource.replace("toBeDefined()", "toBe(4)"));
  const savedBrief = output();
  assert.equal(await runCli(["brief", priorPath], { cwd, apiKey: null, ...savedBrief }), 0);
  assert.match(savedBrief.out, /toBeDefined/);
  assert.ok(!savedBrief.out.includes("toBe(4)"));
  clean = true;
  const updatedIO = output();
  assert.equal(await runCli(["scan", "--history", ".jev-checkup/history"], { cwd, apiKey: null, client, ...updatedIO }), 0, updatedIO.err);
  const updated = await readRun(filename);
  assert.equal(updated.resolved[0]?.reason, "value_dropped");
  assert.equal(calls, 2);
  const reportIO = output();
  assert.equal(await runCli(["report", filename, "--format", "markdown", "--history", ".jev-checkup/history"], { cwd, apiKey: null, ...reportIO }), 0, reportIO.err);
  assert.match(reportIO.out, /# Codebase Health/);
});

test("API failure writes incomplete observations without leaking credentials or response bodies", async t => {
  const cwd = await repository(t);
  const io = output();
  const exit = await runCli(["scan"], { cwd, apiKey: "test-secret", ...io, client: { async systemOne() { throw new Error("private source / test-secret"); } } });
  assert.equal(exit, 1, io.err);
  const run = await readRun(join(cwd, ".jev-checkup/run.json"));
  assert.equal(run.run.complete, false);
  assert.equal(run.targets[0]!.outcome, "unevaluated");
  assert.ok(!JSON.stringify(run).includes("test-secret"));
  assert.ok(!JSON.stringify(run).includes("private source"));
  assert.ok(!io.out.includes("test-secret"));
});

test("unsupported budget option fails before any request or output write", async t => {
  const cwd = await repository(t);
  const io = output();
  assert.equal(await runCli(["scan", "--max-cost", "1"], { cwd, apiKey: null, ...io }), 2);
  await assert.rejects(access(join(cwd, ".jev-checkup/run.json")));
});

test("an explicit empty allow-list sends nothing and produces no health score", async t => {
  const cwd = await repository(t);
  await writeFile(join(cwd, ".jev-checkup.yml"), "include: []\n");
  const io = output();
  let calls = 0;
  const client: JudgeClient = { async systemOne() { calls++; throw new Error("must not send source"); } };
  assert.equal(await runCli(["scan"], { cwd, apiKey: null, client, ...io }), 0, io.err);
  assert.equal(calls, 0);
  const run = await readRun(join(cwd, ".jev-checkup/run.json"));
  assert.equal(run.targets.length, 0);
  assert.equal(run.total.score, null);
  assert.equal(run.usage.requests, 0);
});

test("a recoverable TSX diagnostic outside tests is visible without blocking safe tests", async t => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "example.test.tsx"), `const link = <a href="https://example.test?x=y&labels=bug&body=z">link</a>;
it('preserves the link', () => { expect(link).toBeDefined(); });
`);
  const io = output();
  const client: JudgeClient = { async systemOne(request) {
    return { model: request.model, answers: answers(request.questions, false), usage: { input_tokens: 100 } };
  } };
  assert.equal(await runCli(["scan"], { cwd, apiKey: null, client, ...io }), 0, io.err);
  const run = await readRun(join(cwd, ".jev-checkup/run.json"));
  assert.equal(run.run.complete, true);
  assert.equal(run.targets.length, 2);
  assert.ok(run.scope.files.find(f => f.file === "example.test.tsx")?.reason);
  assert.match(io.out, /parse_diagnostic/);
  assert.equal(run.total.score, null);
});
