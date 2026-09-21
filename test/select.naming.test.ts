import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getTestAspectDefinition } from "../src/aspects/index.js";
import { selectTargets } from "../src/select/index.js";
import type { AspectDefinition, Config } from "../src/types.js";

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

function namingDefinition(cfg: Config): AspectDefinition {
  const definition = getTestAspectDefinition(cfg);
  return {
    ...definition,
    id: "naming-honesty",
    propositionVersion: "naming-honesty@1",
    selector: "naming@1",
    contextPolicy: "declaration@1",
    composition: "naming-max@1",
    questions: {
      "{symbol_key}__behavior_mismatch": {
        type: "noul",
        instructions: "Does {symbol_key} match {qualified_name}?",
      },
      "{symbol_key}__hidden_side_effect": {
        type: "noul",
        instructions: "Does {name} hide a side effect?",
      },
      "{symbol_key}__context_sufficient": {
        type: "noul",
        instructions: "Is {declaration} enough context?",
      },
    },
  };
}

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jev-checkup-select-naming-"));
  await writeFile(join(root, "format.ts"), source);
  return root;
}

async function fixtureFiles(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jev-checkup-select-naming-"));
  for (const [relativePath, source] of Object.entries(files)) {
    const destination = join(root, relativePath);
    const directory = destination.slice(0, destination.lastIndexOf("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(destination, source);
  }
  return root;
}

test("selects a documented named function with declaration-local context", async () => {
  const root = await fixture(
    [
      "/** Formats a byte count for display. */",
      "export function formatBytes(value: number) {",
      "  return `${value} B`;",
      "}",
      "render(() => 1);",
      "",
    ].join("\n"),
  );
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    assert.equal(selection.targets.length, 1);
    const target = selection.targets[0]!;
    assert.equal(target.aspect, "naming-honesty");
    assert.equal(target.contextMode, "focus");
    const state = target.state as {
      source: string;
      target_symbol: { kind: string; qualified_name: string; name: string; declaration: string };
    };
    assert.equal(state.target_symbol.kind, "function");
    assert.equal(state.target_symbol.qualified_name, "function:formatBytes");
    assert.equal(state.target_symbol.name, "formatBytes");
    assert.match(state.target_symbol.declaration, /function formatBytes/);
    assert.match(state.source, /Formats a byte count/);
    assert.match(state.source, /function formatBytes/);
    assert.doesNotMatch(state.source, /render/);
    assert.deepEqual(Object.keys(target.questions), [
      "n0001__behavior_mismatch",
      "n0001__hidden_side_effect",
      "n0001__context_sufficient",
    ]);
    assert.equal(
      target.questions["n0001__behavior_mismatch"]?.instructions,
      "Does n0001 match function:formatBytes?",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps declaration context adjacent when documentation blocks repeat", async () => {
  const root = await fixture(
    [
      "/** first docs */",
      "function first() {}",
      "/** second docs */",
      "function second() {}",
      "class Box {",
      "  /** method docs */",
      "  method() {}",
      "}",
      "/* ordinary comment */",
      "function ordinary() {}",
      "",
    ].join("\n"),
  );
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    const second = selection.targets.find((target) => target.target.name === "second");
    assert.ok(second);
    const state = second.state as { source: string };
    assert.match(state.source, /second docs/);
    assert.match(state.source, /function second/);
    assert.doesNotMatch(state.source, /first docs|function first/);
    const method = selection.targets.find((target) => target.target.name === "method");
    assert.ok(method);
    const methodState = method.state as { source: string };
    assert.match(methodState.source, /method docs/);
    assert.match(methodState.source, /L0007\|   method\(\)/);
    assert.doesNotMatch(methodState.source, /first docs|function first/);
    const ordinary = selection.targets.find((target) => target.target.name === "ordinary");
    assert.ok(ordinary);
    const ordinaryState = ordinary.state as { source: string };
    assert.match(ordinaryState.source, /function ordinary/);
    assert.doesNotMatch(ordinaryState.source, /first docs|second docs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects bound functions and literal class/object methods while reporting omissions", async () => {
  const root = await fixture(
    [
      "const add = (value: number) => value + 1;",
      "const named = function implementation() { return 1; };",
      "class Formatter {",
      "  constructor() {}",
      "  format(value: number) { return `${value}`; }",
      '  public get label() { return "label"; }',
      "  static set label(value: string) {}",
      "  [dynamic]() {}",
      '  "quoted"() {}',
      "}",
      "const helpers = {",
      "  convert(value: number) { return value; },",
      '  "quoted"() {},',
      "  [dynamic]() {},",
      "};",
      "const BoundFormatter = class { format() {} };",
      "interface FormatterContract { format(): string; }",
      "function overloaded(value: string): string;",
      "function overloaded(value: number) { return String(value); }",
      "register(() => true);",
      "",
    ].join("\n"),
  );
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    const symbols = selection.targets.map((target) => {
      const symbol = (
        target.state as { target_symbol: { kind: string; qualified_name: string; name: string } }
      ).target_symbol;
      return [symbol.kind, symbol.qualified_name, symbol.name] as const;
    });
    assert.deepEqual(symbols, [
      ["function", "function:add", "add"],
      ["function", "function:named", "named"],
      ["method", "Formatter.format", "format"],
      ["method", "Formatter.quoted", "quoted"],
      ["method", "helpers.convert", "convert"],
      ["method", "helpers.quoted", "quoted"],
      ["method", "BoundFormatter.format", "format"],
      ["function", "function:overloaded", "overloaded"],
    ]);
    const reason = selection.scope.files[0]?.reason ?? "";
    assert.match(reason, /constructor/);
    assert.match(reason, /accessor/);
    assert.match(reason, /computed or dynamic method name/);
    assert.match(reason, /signature without implementation/);
    assert.match(reason, /anonymous function or callback omitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses qualified declaration identity and duplicate occurrence without line numbers", async () => {
  const source = [
    "function duplicate() {}",
    "function duplicate() {}",
    "function outer() { function inner() {} }",
    "class First { run() {} }",
    "class Second { run() {} }",
    "",
  ].join("\n");
  const shiftedSource = ["// moved without changing symbols", "", source].join("\n");
  const firstRoot = await fixture(source);
  const shiftedRoot = await fixture(shiftedSource);
  try {
    const cfg = config();
    const definition = namingDefinition(cfg);
    const first = await selectTargets(firstRoot, ["."], cfg, definition);
    const shifted = await selectTargets(shiftedRoot, ["."], cfg, definition);
    const firstSymbols = first.targets.map((target) => ({
      fingerprint: target.fingerprint,
      symbol: (target.state as { target_symbol: { qualified_name: string } }).target_symbol
        .qualified_name,
      path: target.target.path,
    }));
    const shiftedSymbols = shifted.targets.map((target) => ({
      fingerprint: target.fingerprint,
      symbol: (target.state as { target_symbol: { qualified_name: string } }).target_symbol
        .qualified_name,
      path: target.target.path,
    }));
    assert.deepEqual(
      firstSymbols.map(({ symbol, path }) => ({ symbol, path })),
      [
        { symbol: "function:duplicate", path: [] },
        { symbol: "function:duplicate", path: [] },
        { symbol: "function:outer", path: [] },
        { symbol: "function:outer.inner", path: ["outer"] },
        { symbol: "First.run", path: ["First"] },
        { symbol: "Second.run", path: ["Second"] },
      ],
    );
    assert.deepEqual(
      firstSymbols.map((item) => item.fingerprint),
      shiftedSymbols.map((item) => item.fingerprint),
    );
    assert.notEqual(firstSymbols[0]?.fingerprint, firstSymbols[1]?.fingerprint);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(shiftedRoot, { recursive: true, force: true });
  }
});

test("reuses naming scope filters and recoverable parser diagnostics", async () => {
  const root = await fixtureFiles({
    "src/included.tsx": [
      'const link = <a href="https://example.test?x=y&labels=bug&body=z">link</a>;',
      "export function included() { return link; }",
      'export function unsafe() { return <a href="https://example.test?x=y&labels=bug&body=z">bad</a>; }',
      "",
    ].join("\n"),
    "src/excluded.ts": "export function excluded() { return true; }\n",
    "other.ts": "export function outside() { return true; }\n",
  });
  try {
    const cfg = config({ include: ["src/**/*.tsx", "src/**/*.ts"], exclude: ["src/excluded.ts"] });
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    assert.deepEqual(
      selection.targets.map((target) => target.target.name),
      ["included"],
    );
    assert.equal(selection.scope.enumerationComplete, true);
    const file = selection.scope.files.find((candidate) => candidate.file === "src/included.tsx");
    assert.match(file?.reason ?? "", /parse_diagnostic/);
    assert.equal(
      selection.scope.files.find((candidate) => candidate.file === "src/excluded.ts")?.reason,
      "excluded",
    );
    assert.equal(
      selection.scope.files.find((candidate) => candidate.file === "other.ts")?.reason,
      "not_included",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks oversized named declarations unjudgeable at selection time", async () => {
  const oversizedBody = "x".repeat(100_000);
  const root = await fixture(
    [
      `export function oversized() { return "${oversizedBody}"; }`,
      "export function small() { return true; }",
      "",
    ].join("\n"),
  );
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    const oversized = selection.targets.find((target) => target.target.name === "oversized");
    const small = selection.targets.find((target) => target.target.name === "small");
    assert.equal(oversized?.unjudgeableReason, "input_limit");
    assert.equal(small?.unjudgeableReason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps naming declaration lines aligned for Unicode source and documentation", async () => {
  const root = await fixture(
    [
      'const label = "日本語😀";',
      "// 表示用の値を返します。",
      "export function 表示() {",
      '  return "保持😀";',
      "}",
      "",
    ].join("\n"),
  );
  try {
    const cfg = config();
    const selection = await selectTargets(root, ["."], cfg, namingDefinition(cfg));
    assert.equal(selection.targets.length, 1);
    const target = selection.targets[0]!;
    assert.equal(target.location.startLine, 3);
    assert.equal(target.location.endLine, 5);
    const state = target.state as { source: string; target_symbol: { name: string } };
    assert.equal(state.target_symbol.name, "表示");
    assert.match(state.source, /L0002\| \/\/ 表示用の値を返します。/);
    assert.match(state.source, /L0003\| export function 表示\(\)/);
    assert.match(state.source, /保持😀/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
