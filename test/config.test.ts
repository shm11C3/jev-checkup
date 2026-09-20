import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config/index.js";

test("configuration rejects moving aliases, cost caps and unsupported aspects", () => {
  assert.throws(() => parseConfig({ model: "jev-latest" }), /pinned/);
  assert.throws(() => parseConfig({ maxCost: 1 }), /unsupported/);
  assert.throws(() => parseConfig({ aspects: ["test-honesty", "naming-honesty"] }), /only/);
  assert.throws(() => parseConfig({ thresholds: { midLow: 0.8, midHigh: 0.2 } }), /midLow/);
  assert.throws(() => parseConfig({ concurrency: 0 }), /positive/);
  assert.throws(() => parseConfig({ concurrency: Infinity }), /positive/);
});

test("configuration has isolated defaults and accepts valid declarative overrides", () => {
  const first = parseConfig({});
  first.thresholds.finding = 0.5;
  first.exclude.push("private/**");
  const second = parseConfig({});
  assert.deepEqual(second.thresholds, {});
  assert.ok(!second.exclude.includes("private/**"));
  assert.equal(parseConfig({ model: "jev-1.13.0", thresholds: { finding: 0.5 } }).thresholds.finding, 0.5);
});

test("YAML failures do not echo sensitive configuration values", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await loadConfig(dir)).model, "jev-1.13.0");
  await writeFile(join(dir, ".jev-checkup.yml"), "model: [super-secret\n");
  await assert.rejects(loadConfig(dir), error => error instanceof Error && !error.message.includes("super-secret"));
  await writeFile(join(dir, ".jev-checkup.yml"), "concurrency: 1\nconcurrency: 2\n");
  await assert.rejects(loadConfig(dir), /Invalid configuration/);
});
