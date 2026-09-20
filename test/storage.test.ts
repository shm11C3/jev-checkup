import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRun, validateRun, writeRun } from "../src/cli/storage.js";
import type { Band, CalibrationRow, ModeCalibration, Run } from "../src/types.js";

const bands: Band[] = ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"];

function row(overrides: Partial<CalibrationRow> = {}): CalibrationRow {
  return { valid: 0, invalid: 0, high: 0, prioritized: 0, pValid: null, pHigh: null, ...overrides };
}

function calibration(value: CalibrationRow): ModeCalibration {
  return {
    source: "none",
    labelsBySource: { human: 0, agent: 0, execution: 0 },
    table: Object.fromEntries(bands.map((band, index) => [band, index === 0 ? value : row()])) as ModeCalibration["table"],
  };
}

function bandCounts(): Record<Band, number> {
  return Object.fromEntries(bands.map(band => [band, 0])) as Record<Band, number>;
}

function fixture(value = row()): Run {
  return {
    schema: 1,
    tool: "0.1.0",
    run: { id: "run-1", at: "2026-09-20T00:00:00.000Z", commit: null, dirty: false, complete: true },
    scope: { repositoryId: "repo", id: "scope", paths: ["."], include: ["**/*"], exclude: [], languages: ["typescript"], selectionPolicy: "tests@1", enumerationComplete: true, files: [] },
    aspects: [{
      id: "test-honesty",
      condition: "condition",
      definition: {} as Run["aspects"][number]["definition"],
      calibration: { validation: "provisional", byContextMode: { focus: calibration(value), focusprod: calibration(row()) } },
      evaluated: 0,
      cannotTell: 0,
      notJudged: 0,
      unjudgeable: 0,
      unevaluated: 0,
      bandsByContextMode: { focus: bandCounts(), focusprod: bandCounts() },
      open: 0,
      score: null,
      inTotal: false,
      comparison: { baselineRun: null, new: null, resolved: null, pending: 0, scoreDelta: null, noiseFloor: null },
    }],
    targets: [],
    findings: [],
    snapshots: { "snapshot-1": { state: { source: "fixture" }, questions: {} } },
    topFindings: {},
    resolved: [],
    pendingComparisons: [],
    total: { score: null, aspects: 0, weights: {} },
    unmeasured: { skippedFiles: 0, missRate: null, populationPrecisionAtN: null },
    usage: { requests: 0, inputTokens: 0, cacheHits: 0 },
  };
}

test("validateRun rejects impossible calibration counts", () => {
  const run = fixture(row({ valid: 1, invalid: 0, prioritized: 0, high: 1, pValid: 1, pHigh: null }));
  assert.throws(() => validateRun(run), /Invalid calibration band/);
});

test("valid calibration rows survive run JSON round trips", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jev-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = fixture(row({ valid: 2, invalid: 1, prioritized: 2, high: 1, pValid: 2 / 3, pHigh: 0.5 }));
  const filename = join(directory, "run.json");
  await writeRun(filename, original);
  const loaded = await readRun(filename);
  assert.deepEqual(loaded.aspects[0]!.calibration.byContextMode.focus.table[bands[0]!], original.aspects[0]!.calibration.byContextMode.focus.table[bands[0]!]);
});

test("validateRun accepts calibration rows whose probabilities match their counts", () => {
  const validRows = [
    row(),
    row({ valid: 0, invalid: 2, prioritized: 0, high: 0, pValid: 0, pHigh: null }),
    row({ valid: 3, invalid: 1, prioritized: 2, high: 1, pValid: 0.75, pHigh: 0.5 }),
    row({ valid: 3, invalid: 1, prioritized: 3, high: 1, pValid: 0.75, pHigh: 1 / 3 }),
  ];
  for (const value of validRows) assert.doesNotThrow(() => validateRun(fixture(value)));
});

test("validateRun rejects calibration rows with impossible count order", () => {
  const impossibleRows = [
    row({ valid: 1, invalid: 0, prioritized: 2, high: 1, pValid: 1, pHigh: 0.5 }),
    row({ valid: 2, invalid: 0, prioritized: 1, high: 2, pValid: 1, pHigh: 2 }),
  ];
  for (const value of impossibleRows) assert.throws(() => validateRun(fixture(value)), /Invalid calibration band/);
});

test("validateRun rejects probabilities that do not match calibration counts", () => {
  const wrongProbabilities = [
    row({ valid: 3, invalid: 1, prioritized: 2, high: 1, pValid: 0.7, pHigh: 0.5 }),
    row({ valid: 3, invalid: 1, prioritized: 2, high: 1, pValid: 0.75, pHigh: 0.4 }),
  ];
  for (const value of wrongProbabilities) assert.throws(() => validateRun(fixture(value)), /Invalid calibration band/);
});

test("validateRun requires null probabilities only for zero denominators", () => {
  const wrongNulls = [
    row({ valid: 0, invalid: 0, prioritized: 0, high: 0, pValid: 0, pHigh: null }),
    row({ valid: 3, invalid: 1, prioritized: 2, high: 1, pValid: null, pHigh: 0.5 }),
    row({ valid: 3, invalid: 1, prioritized: 2, high: 1, pValid: 0.75, pHigh: null }),
    row({ valid: 3, invalid: 1, prioritized: 0, high: 0, pValid: 0.75, pHigh: 0 }),
  ];
  for (const value of wrongNulls) assert.throws(() => validateRun(fixture(value)), /Invalid calibration band/);
});

test("validateRun rejects a calibration denominator outside safe integer range", () => {
  const valid = Number.MAX_SAFE_INTEGER;
  const invalid = 1;
  const pValid = valid / (valid + invalid);
  const value = row({ valid, invalid, prioritized: 0, high: 0, pValid, pHigh: null });
  assert.throws(() => validateRun(fixture(value)), /Invalid calibration band/);
});

test("validateRun accepts legacy and current optional persisted metadata", async t => {
  const legacy = fixture();
  assert.doesNotThrow(() => validateRun(legacy));

  const current = fixture();
  current.unmeasured.selectionErrors = ["enumeration_failed"];
  current.snapshots["snapshot-1"]!.questionsHash = "question-hash";
  assert.doesNotThrow(() => validateRun(current));

  const directory = await mkdtemp(join(tmpdir(), "jev-storage-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "run.json");
  await writeRun(filename, legacy);
  const loaded = await readRun(filename);
  assert.equal(loaded.unmeasured.selectionErrors, undefined);
  assert.equal(loaded.snapshots["snapshot-1"]!.questionsHash, undefined);
});

test("validateRun rejects malformed optional persisted metadata", () => {
  const badSelectionErrors = [42, {}, ["ok", 42], null];
  for (const value of badSelectionErrors) {
    const run = fixture();
    (run.unmeasured as unknown as Record<string, unknown>).selectionErrors = value;
    assert.throws(() => validateRun(run), /Invalid selection errors/);
  }

  const badQuestionHashes = [42, {}, ""];
  for (const value of badQuestionHashes) {
    const run = fixture();
    (run.snapshots["snapshot-1"] as unknown as Record<string, unknown>).questionsHash = value;
    assert.throws(() => validateRun(run), /Invalid snapshot/);
  }
});
