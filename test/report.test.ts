import test from "node:test";
import assert from "node:assert/strict";
import { renderBrief, renderReport } from "../src/report/index.js";
import { validateRun } from "../src/cli/storage.js";
import { hash } from "../src/shared/hash.js";
import { getTestAspectDefinition } from "../src/aspects/index.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import type { Band, ModeCalibration, Run } from "../src/types.js";

function fixture(): Run {
  const state = { source: 'it("test", () => { /* ``` */ expect(actual).toBe(expected); });' };
  const inputHash = hash(state);
  const bandKeys: Band[] = ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"];
  const calibration = (): ModeCalibration => ({ source: "none", labelsBySource: { human: 0, agent: 0, execution: 0 }, table: Object.fromEntries(bandKeys.map(b => [b, { valid: 0, invalid: 0, high: 0, prioritized: 0, pValid: null, pHigh: null }])) as ModeCalibration["table"] });
  const counts = (): Record<Band, number> => ({ "0..0.05": 0, "0.05..0.15": 0, "0.15..0.30": 1, ">=0.30": 0 });
  return {
    schema: 1, tool: "0.1.0", run: { id: "r1", at: "2026-09-20T00:00:00Z", commit: null, dirty: false, complete: true },
    scope: { repositoryId: "repo", id: "scope", paths: ["."], include: ["**/*"], exclude: [], languages: ["typescript"], selectionPolicy: "v1", enumerationComplete: true, files: [{ file: "x.test.ts", status: "parsed" }] },
    aspects: [{ id: "test-honesty", condition: "condition", definition: getTestAspectDefinition(DEFAULT_CONFIG),
      calibration: { validation: "provisional", byContextMode: { focus: calibration(), focusprod: calibration() } },
      evaluated: 1, cannotTell: 0, notJudged: 0, unjudgeable: 0, unevaluated: 0, bandsByContextMode: { focus: counts(), focusprod: { ...counts(), "0.15..0.30": 0 } },
      open: 1, score: null, inTotal: false, comparison: { baselineRun: null, new: null, resolved: null, pending: 0, reason: "no_baseline", scoreDelta: null, noiseFloor: null } }],
    targets: [{ fingerprint: "f1", aspect: "test-honesty", location: { file: "x.test.ts", startLine: 1, endLine: 1 }, target: { path: [], name: "contains <script> and | pipes" },
      contextMode: "focus", inputHash, subjectRevision: "rev", controls: { own: "available", sibling: "not_available" }, outcome: "finding", suspicion: 0.54, signal: 0.24, band: "0.15..0.30" }],
    findings: [{ fingerprint: "f1", aspect: "test-honesty", status: "uncompared", rank: 1, evidence: { inputHash, answers: { outcome_unasserted: { type: "noul", noul: 0.9 } }, suspicion: 0.54, signal: 0.24, band: "0.15..0.30", pValid: null, pHigh: null },
      labelTemplate: { fingerprint: "f1", propositionVersion: "v1", subjectRevision: "rev", evidenceSources: [{ file: "x.test.ts", hash: "file-hash" }] }, label: null }],
    snapshots: { [inputHash]: { state, questions: { outcome_unasserted: { type: "noul", instructions: "Does this test omit the outcome assertion?" } } } },
    topFindings: { "test-honesty": ["f1"] }, resolved: [], pendingComparisons: [], total: { score: null, aspects: 0, weights: { "test-honesty": 1 } },
    unmeasured: { skippedFiles: 0, missRate: null, populationPrecisionAtN: null }, usage: { requests: 1, inputTokens: 300, cacheHits: 0 },
  };
}

test("brief uses saved context and refuses missing or altered snapshots", () => {
  const run = fixture();
  const brief = renderBrief(run);
  assert.match(brief, /expect\(actual\)\.toBe\(expected\)/);
  assert.match(brief, /````json/);
  assert.match(brief, /"source":"agent"/);
  const inputHash = run.findings[0]!.evidence.inputHash;
  run.snapshots[inputHash]!.state = "tampered";
  assert.throws(() => renderBrief(run), /hash does not match/);
  delete run.snapshots[inputHash];
  assert.throws(() => renderBrief(run), /missing/);
});

test("report keeps uncalibrated score missing and escapes code-derived Markdown", () => {
  const report = renderReport(fixture(), "markdown");
  assert.match(report, /Score: —/);
  assert.match(report, /uncalibrated priority/);
  assert.ok(!report.includes("<script>"));
  assert.match(report, /&lt;script&gt;/);
  assert.match(report, /score-noise threshold: unmeasured/);
});

test("saved calibration counts must be valid before a report can display them", () => {
  const run = fixture();
  validateRun(run);
  run.aspects[0]!.calibration.byContextMode.focus.table["0.15..0.30"].valid = -1;
  assert.throws(() => validateRun(run), /Invalid calibration band/);
});

test("compatible history is re-scored with current calibration, not historic score", () => {
  const run = fixture();
  const past = structuredClone(run);
  past.run.id = "past"; past.run.at = "2026-09-19T00:00:00Z"; past.aspects[0]!.score = 0.123;
  const current = run.aspects[0]!;
  current.calibration.byContextMode.focus.source = "local";
  current.calibration.byContextMode.focus.table["0.15..0.30"].pValid = 0.75;
  Object.assign(current.calibration.byContextMode.focus.table["0.15..0.30"], { valid: 3, invalid: 1, prioritized: 2, high: 1 });
  const report = renderReport(run, "terminal", [past]);
  assert.match(report, /score 0\.250/);
  assert.match(report, /validity labels 4 \(valid 3, invalid 1\); prioritized valid labels 2 \(high 1\)/);
  assert.ok(!report.includes("score 0.123"));
  past.scope.id = "other";
  assert.match(renderReport(run, "terminal", [past]), /no compatible completed history/);
});
