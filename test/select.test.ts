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
    include: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
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

test("preserves target lines after folding multiple preceding siblings", async () => {
  const source = [
    'describe("並び", () => {',
    '  it("一行", () => { expect("隠す一行").toBe("隠す一行"); });',
    '  it("空の改行", () => {',
    '  });',
    '  it("複数行😀", () => {',
    '    expect("隠す複数行😀").toBe("隠す複数行😀");',
    '  });',
    '  it("対象😀", () => {',
    '    expect("保持😀").toBe("保持😀");',
    '  });',
    '});',
    "",
  ].join("\n");
  const root = await fixture({ "ordered.test.ts": source });
  try {
    const selection = await selectTargets(root, ["."], config(), getTestAspectDefinition(config()));
    const target = selection.targets.find((candidate) => candidate.target.name === "対象😀");
    assert.ok(target);
    const state = target.state as { source: string; target_tests: Record<string, { first_line: string; last_line: string; code: string }> };
    const key = Object.keys(state.target_tests)[0]!;
    const targetTest = state.target_tests[key]!;
    const sourceLines = state.source.split("\n");
    const firstLine = sourceLines.find((line) => line.startsWith(`${targetTest.first_line}| `));
    assert.ok(firstLine?.includes('it("対象😀"'));
    assert.ok(targetTest.code.split("\n")[0]?.includes('it("対象😀"'));
    assert.equal(source.split("\n").length, state.source.split("\n").length);
    assert.equal(targetTest.last_line, "L0010");
    for (const candidate of selection.targets) {
      const candidateState = candidate.state as { source: string; target_tests: Record<string, { first_line: string; code: string }> };
      const candidateTest = candidateState.target_tests[Object.keys(candidateState.target_tests)[0]!]!;
      assert.ok(candidateTest.code.split("\n")[0]?.includes(candidate.target.name));
      assert.ok(candidateState.source.split("\n").find((line) => line.startsWith(`${candidateTest.first_line}| `))?.includes(candidate.target.name));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not select tagged-table each calls and records a diagnostic", async () => {
  const root = await fixture({
    "tagged.test.ts": [
      "test.each`value`(\"tagged test\", () => { expect(true).toBe(true); });",
      "describe.each`value`(\"tagged suite\", () => {",
      "  it(\"nested\", () => { expect(true).toBe(true); });",
      "});",
      "",
    ].join("\n"),
  });
  try {
    const selection = await selectTargets(root, ["."], config(), getTestAspectDefinition(config()));
    assert.equal(selection.targets.length, 0);
    assert.match(selection.scope.files[0]?.reason ?? "", /dynamic or unsupported (?:test|describe)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps an explicit empty include allow-list empty", async () => {
  const root = await fixture({ "sample.test.ts": 'it("never selected", () => { expect(true).toBe(true); });' });
  try {
    const selection = await selectTargets(root, ["."], config({ include: [] }), getTestAspectDefinition(config({ include: [] })));
    assert.equal(selection.targets.length, 0);
    assert.deepEqual(selection.scope.include, []);
    assert.equal(selection.scope.files[0]?.reason, "not_included");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resolves NodeNext runtime extensions and index modules deterministically", async () => {
  const root = await fixture({
    "widget.test.ts": 'import { value } from "./widget.js"; it("widget", () => { expect(value).toBe(1); });',
    "widget.ts": "export const value = 1;",
    "feature.test.ts": 'import { value } from "./feature.mjs"; it("feature", () => { expect(value).toBe(1); });',
    "feature.mts": "export const value = 1;",
    "legacy.test.ts": 'import { value } from "./legacy.cjs"; it("legacy", () => { expect(value).toBe(1); });',
    "legacy.cts": "export const value = 1;",
    "indexcase.test.ts": 'import { value } from "./indexcase/index.js"; it("indexcase", () => { expect(value).toBe(1); });',
    "indexcase/index.ts": "export const value = 1;",
    "ambiguous.test.ts": 'import { value } from "./ambiguous.js"; it("ambiguous", () => { expect(value).toBe(1); });',
    "ambiguous.ts": "export const value = 1;",
    "ambiguous.tsx": "export const value = 1;",
  });
  try {
    const selection = await selectTargets(root, ["."], config(), getTestAspectDefinition(config()));
    for (const [name, production] of [["widget", "widget.ts"], ["feature", "feature.mts"], ["legacy", "legacy.cts"], ["indexcase", "indexcase/index.ts"]] as const) {
      const target = selection.targets.find((candidate) => candidate.target.name === name);
      assert.ok(target);
      assert.equal(target.contextMode, "focusprod");
      assert.ok((target.state as { source: string }).source.includes(`production module under test: ${production}`));
    }
    const ambiguous = selection.targets.find((candidate) => candidate.target.name === "ambiguous");
    assert.equal(ambiguous?.contextMode, "focus");
    assert.equal(ambiguous?.contextReason, "no_unique_named_import");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovers parser diagnostics outside tests but skips overlapping tests", async () => {
  const safeRoot = await fixture({
    "safe.test.tsx": [
      'const link = <a href="https://example.test?x=y&labels=bug&body=z">link</a>;',
      'it("safe one", () => { expect(link).toBeDefined(); });',
      'it("safe two", () => { expect(link).toBeDefined(); });',
      "",
    ].join("\n"),
  });
  const unsafeRoot = await fixture({
    "unsafe.test.tsx": [
      'it("bad", () => { const link = <a href="https://example.test?x=y&labels=bug&body=z">link</a>; expect(link).toBeDefined(); });',
      'it("safe", () => { expect(true).toBe(true); });',
      "",
    ].join("\n"),
  });
  try {
    const safe = await selectTargets(safeRoot, ["."], config(), getTestAspectDefinition(config()));
    assert.equal(safe.targets.length, 2);
    assert.equal(safe.scope.enumerationComplete, true);
    assert.match(safe.scope.files[0]?.reason ?? "", /parse_diagnostic/);
    assert.deepEqual(safe.errors, []);

    const unsafe = await selectTargets(unsafeRoot, ["."], config(), getTestAspectDefinition(config()));
    assert.equal(unsafe.targets.length, 1);
    assert.equal(unsafe.targets[0]?.target.name, "safe");
    assert.equal(unsafe.scope.enumerationComplete, true);
    assert.match(unsafe.scope.files[0]?.reason ?? "", /parse_diagnostic/);
  } finally {
    await rm(safeRoot, { recursive: true, force: true });
    await rm(unsafeRoot, { recursive: true, force: true });
  }
});

test("keeps a whole-file parser failure incomplete", async () => {
  const root = await fixture({ "broken.ts": "<<<" });
  try {
    const selection = await selectTargets(root, ["."], config(), getTestAspectDefinition(config()));
    assert.equal(selection.targets.length, 0);
    assert.equal(selection.scope.enumerationComplete, false);
    assert.ok(selection.errors.some((error) => error.includes("parse error")));
    assert.equal(selection.scope.files[0]?.reason, "parse_error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expands placeholders once so literal tokens in titles, suites and snippets survive", async () => {
  const root = await fixture({
    "literal.test.ts": [
      'describe("suite {title}", () => {',
      '  it("title {describe_path}", () => {',
      '    expect("{describe_path}").toBe("{describe_path}");',
      "  });",
      '  it("sibling {title}", () => {',
      '    expect("{title}").toBe("{title}");',
      "  });",
      "});",
      "",
    ].join("\n"),
  });
  try {
    const cfg = config();
    const definition = getTestAspectDefinition(cfg);
    definition.questions = {
      "{test_key}__literal_{title}": {
        type: "noul",
        instructions: "title={title}; suite={describe_path}; own={own_snippet}; sibling={sibling_snippet}",
      },
    };
    const selection = await selectTargets(root, ["."], cfg, definition);
    const target = selection.targets.find((candidate) => candidate.target.name === "title {describe_path}");
    assert.ok(target);
    const keys = Object.keys(target.questions);
    assert.deepEqual(keys, ["t0002__literal_title {describe_path}"]);
    assert.equal(
      target.questions[keys[0]!]!.instructions,
      'title=title {describe_path}; suite=suite {title}; own=expect("{describe_path}").toBe("{describe_path}"); sibling=expect("{title}").toBe("{title}")',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not attach a production module reached only through a mocked equivalent specifier", async () => {
  const root = await fixture({
    "widget.test.ts": [
      'import { value } from "./widget.js";',
      'jest.mock("./widget");',
      'it("widget", () => { expect(value).toBe(1); });',
      "",
    ].join("\n"),
    "widget.ts": "export const value = 1;",
    "directory.test.ts": [
      'import { value } from "./directory/index.js";',
      'vi.mock("./directory");',
      'it("directory", () => { expect(value).toBe(1); });',
      "",
    ].join("\n"),
    "directory/index.ts": "export const value = 1;",
    "raw.test.ts": [
      'import { value } from "./raw.js";',
      'jest.mock("./raw.js");',
      'it("raw", () => { expect(value).toBe(1); });',
      "",
    ].join("\n"),
    "raw.ts": "export const value = 1;",
  });
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, getTestAspectDefinition(cfg));
    for (const name of ["widget", "directory", "raw"]) {
      const target = selection.targets.find((candidate) => candidate.target.name === name);
      assert.ok(target);
      assert.equal(target.contextMode, "focus");
      assert.equal(target.contextReason, "no_unique_named_import");
      assert.equal(target.evidenceSources.length, 1);
      assert.ok(!(target.state as { source: string }).source.includes("production module under test:"));
    }
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
