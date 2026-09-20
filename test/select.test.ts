import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getTestAspectDefinition } from "../src/aspects/index.js";
import { selectTargets } from "../src/select/index.js";
import type { Config } from "../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    model: "jev-1.13.0",
    include: [],
    exclude: [],
    concurrency: 1,
    requestsPerMinute: 1_200,
    tokensPerSecond: 250_000,
    top: 10,
    thresholds: {},
    ...overrides,
  };
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jev-checkup-select-"));
  for (const [relativePath, source] of Object.entries(files)) {
    const destination = join(root, relativePath);
    await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await writeFile(destination, source);
  }
  return root;
}

test("selects literal test forms with AST ranges and folds sibling bodies", async () => {
  const root = await fixture({
    "widget.ts": "export const add = (a: number, b: number) => a + b;\n",
    "widget.test.ts": [
      'import { add } from "./widget";',
      'describe("widget", () => {',
      '  it("adds values", () => {',
      '    expect(add(1, 2)).toBe(3);',
      '  });',
      '  it.each([[1, 2]])("adds %s", ([a, b]) => {',
      '    expect(add(a, b)).toBe(3);',
      '  });',
      '  test.concurrent.only("concurrent form", function () {',
      '    expect(add(1, 2)).toBe(3);',
      '  });',
      '  it.skip("ignored", () => {',
      '    expect(true).toBe(true);',
      '  });',
      '});',
      "",
    ].join("\n"),
  });
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, getTestAspectDefinition(cfg));
    assert.equal(selection.targets.length, 3);
    assert.equal(selection.targets[0]?.contextMode, "focusprod");
    assert.deepEqual(selection.targets[0]?.target.path, ["widget"]);
    assert.equal(selection.targets[0]?.target.name, "adds values");
    assert.match(JSON.stringify(selection.targets[0]?.state), /body of this other test omitted/);
    assert.match(JSON.stringify(selection.targets[0]?.state), /P0001\| export const add/);
    assert.ok(Object.keys(selection.targets[0]?.questions ?? {}).every((key) => !key.includes("{test_key}")));
    assert.ok(selection.scope.files.some((file) => file.reason?.includes("skipped tests: 1")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps production context inside include/exclude and records source hashes", async () => {
  const root = await fixture({
    "src/widget.ts": "export const answer = 42;\n",
    "src/widget.test.ts": [
      'import { answer } from "./widget";',
      'it("returns the answer", () => {',
      '  expect(answer).toBe(42);',
      "});",
      "",
    ].join("\n"),
    "src/other.ts": "export const other = true;\n",
  });
  try {
    const cfg = config({ include: ["src/**/*.test.ts"], exclude: [] });
    const selection = await selectTargets(root, ["src"], cfg, getTestAspectDefinition(cfg));
    assert.equal(selection.targets.length, 1);
    assert.equal(selection.targets[0]?.contextMode, "focus");
    assert.equal(selection.targets[0]?.contextReason, "no_unique_named_import");
    assert.ok(selection.sourceHashes["src/widget.test.ts"]);
    assert.equal(selection.sourceHashes["src/widget.ts"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses occurrence identity for duplicate titles and reports dynamic names", async () => {
  const root = await fixture({
    "sample.ts": [
      'describe("same", () => {',
      '  it("repeats", () => { expect(1).toBe(1); });',
      '  it("repeats", () => { expect(2).toBe(2); });',
      '  it(dynamicTitle, () => { expect(3).toBe(3); });',
      "});",
      "",
    ].join("\n"),
  });
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, getTestAspectDefinition(cfg));
    assert.equal(selection.targets.length, 2);
    assert.notEqual(selection.targets[0]?.fingerprint, selection.targets[1]?.fingerprint);
    assert.ok(selection.scope.files.some((file) => file.reason?.includes("dynamic or unsupported test")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folds Japanese and emoji source using JavaScript string offsets", async () => {
  const root = await fixture({ "unicode.test.ts": [
    "// 日本語 😀",
    'it("値を返す😀", () => { expect("保持😀").toBe("保持😀"); });',
    'it("別の確認", () => { expect("隠す😀").toBe("隠す😀"); });',
  ].join("\n") });
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, getTestAspectDefinition(cfg));
    assert.equal(selection.targets.length, 2);
    assert.equal(selection.targets[0]?.target.name, "値を返す😀");
    const state = selection.targets[0]!.state as { source: string };
    assert.ok(state.source.includes('expect("保持😀").toBe("保持😀")'));
    assert.ok(!state.source.includes('expect("隠す😀")'));
    assert.ok(state.source.includes('it("別の確認", () => {'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an invalid scope never widens into a repository-wide selection", async () => {
  const root = await fixture({ "sample.test.ts": 'it("selected only on purpose", () => { expect(1).toBe(1); });' });
  try {
    const cfg = config();
    const selection = await selectTargets(root, [".."], cfg, getTestAspectDefinition(cfg));
    assert.equal(selection.targets.length, 0);
    assert.equal(selection.scope.enumerationComplete, false);
    assert.ok(selection.errors.some(e => e.includes("unsafe scope path")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
