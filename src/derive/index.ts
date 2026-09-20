import { hash, subjectRevision } from "../shared/hash.js";
import { VERSION } from "../shared/version.js";
import type {
  Answers,
  AspectDefinition,
  Band,
  CalibrationRow,
  ContextMode,
  DeriveInput,
  Finding,
  Judgement,
  Label,
  ModeCalibration,
  Observation,
  PreparedTarget,
  Question,
  Run,
  RunAspect,
  RunTarget,
} from "../types.js";

const MODES: ContextMode[] = ["focus", "focusprod"];
const BANDS: Band[] = ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"];

const CORE_PROPERTIES = [
  "outcome_unasserted",
  "result_claim_call_only",
  "call_claim_no_call_check",
  "subject_not_in_play",
] as const;
const PARTIAL_PROPERTIES = ["extra_claim_unasserted", "general_claim_single_case"] as const;
const CONTROL_PROPERTIES = ["ctl_own_snippet", "ctl_sibling_snippet"] as const;
const REQUIRED_PROPERTIES = [
  ...CORE_PROPERTIES,
  ...PARTIAL_PROPERTIES,
  "vague_title",
  "assertion_specificity",
  "hinges_on_unseen_rule",
  "verdict",
] as const;

type Property = string;
type Answer = Record<string, unknown>;
type AnswerMap = Map<Property, Answer>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answerObject(value: unknown): value is Answer {
  return object(value);
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function questionProperty(id: string): string {
  const separator = id.lastIndexOf("__");
  return separator < 0 ? id : id.slice(separator + 2);
}

function questionIds(questions: Record<string, unknown> | undefined, property: Property): string[] {
  if (!questions) return [];
  return Object.keys(questions).filter(id => questionProperty(id) === property);
}

function questionFor(target: PreparedTarget, definition: AspectDefinition, property: Property): Question | undefined {
  const targetIds = questionIds(target.questions, property);
  const definitionIds = questionIds(definition.questions, property);
  const targetQuestion = targetIds.length > 0 ? target.questions[targetIds[0]!] : undefined;
  const definitionQuestion = definitionIds.length > 0 ? definition.questions[definitionIds[0]!] : undefined;
  if (targetQuestion && definitionQuestion && targetQuestion.type !== definitionQuestion.type) return undefined;
  return targetQuestion ?? definitionQuestion;
}

function requestedControl(target: PreparedTarget, property: (typeof CONTROL_PROPERTIES)[number]): boolean {
  const status = property === "ctl_own_snippet" ? target.controls?.own : target.controls?.sibling;
  if (status === "not_available") return false;
  if (status === "available") return true;
  return questionIds(target.questions, property).length > 0;
}

function questionCriteria(question: Question): unknown {
  return question.criteria;
}

function probabilitiesObject(value: unknown): value is Record<string, unknown> {
  return object(value);
}

function probabilitySumIsOne(values: Record<string, unknown>): boolean {
  const sum = Object.values(values).reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0);
  // Jev returns decimal probabilities rounded independently. Four options can
  // therefore legitimately sum to .99 or 1.01; allow the observed two-point
  // aggregate rounding error while keeping the bound proportional for scores
  // with fewer levels.
  const roundingTolerance = Math.min(0.02, Object.keys(values).length * 0.005) + 1e-6;
  return Math.abs(sum - 1) <= roundingTolerance;
}

function expectedProbabilityKeys(question: Question): string[] | null {
  if (question.type === "score") {
    return Array.isArray(question.criteria) && question.criteria.length >= 2
      ? question.criteria.map((_, index) => String(index))
      : null;
  }
  if (question.type === "choice") {
    return object(question.criteria) ? Object.keys(question.criteria) : null;
  }
  return null;
}

function sameKeys(actual: Record<string, unknown>, expected: string[]): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

/**
 * Validate a single response using the response contract of the requested
 * question. The API response is intentionally checked here rather than
 * allowing malformed values into the composition arithmetic.
 */
function validateResponse(question: Question, answer: Answer): string | null {
  if (answer.type !== question.type) return "response_type_mismatch";

  if (question.type === "noul") {
    return probability(answer.noul) ? null : "invalid_noul_probability";
  }

  const expectedKeys = expectedProbabilityKeys(question);
  if (!expectedKeys) return "invalid_question_criteria";
  if (!probabilitiesObject(answer.probabilities) || !sameKeys(answer.probabilities, expectedKeys)) {
    return "invalid_probabilities";
  }
  if (Object.values(answer.probabilities).some(value => !probability(value)) || !probabilitySumIsOne(answer.probabilities)) {
    return "invalid_probabilities";
  }
  if (!probability(answer.confidence)) return "invalid_confidence";

  if (question.type === "score") {
    const maxScore = expectedKeys.length - 1;
    if (!finiteNumber(answer.score) || answer.score < 0 || answer.score > maxScore) return "invalid_score";
    if (!object(answer.legend) || !sameKeys(answer.legend, expectedKeys)
      || Object.values(answer.legend).some(value => typeof value !== "string")) return "invalid_score_legend";
    return null;
  }

  const criteria = questionCriteria(question);
  if (!object(criteria) || typeof answer.choice !== "string" || !has(criteria, answer.choice)) {
    return "invalid_choice";
  }
  return null;
}

function answerCandidates(
  answers: Answers,
  target: PreparedTarget,
  definition: AspectDefinition,
  property: Property,
): [string, Answer][] {
  if (!object(answers)) return [];
  const expectedIds = questionIds(target.questions, property);
  if (expectedIds.length === 0) expectedIds.push(...questionIds(definition.questions, property));
  const entries = Object.entries(answers).filter(([, value]) => answerObject(value));
  return entries.filter(([id]) => expectedIds.includes(id));
}

function collectAnswers(
  answers: Answers,
  target: PreparedTarget,
  definition: AspectDefinition,
): { values: AnswerMap; error?: string } {
  if (!object(answers)) return { values: new Map(), error: "answers_not_object" };
  const values: AnswerMap = new Map();
  const required: string[] = [...REQUIRED_PROPERTIES];
  for (const property of CONTROL_PROPERTIES) {
    if (requestedControl(target, property)) required.push(property);
  }

  for (const property of required) {
    const question = questionFor(target, definition, property);
    if (!question) return { values, error: `missing_question:${property}` };
    const candidates = answerCandidates(answers, target, definition, property);
    if (candidates.length !== 1) {
      return { values, error: candidates.length === 0 ? `missing_answer:${property}` : `duplicate_answer:${property}` };
    }
    const answer = candidates[0]![1];
    const error = validateResponse(question, answer);
    if (error) return { values, error: `${error}:${property}` };
    values.set(property, answer);
  }
  return { values };
}

function validThresholds(definition: AspectDefinition): boolean {
  const values = Object.values(definition.thresholds);
  return values.length === 7 && values.every(value => finiteNumber(value) && value >= 0 && value <= 1);
}

function validWeights(definition: AspectDefinition): boolean {
  return Object.values(definition.weights).every(value => finiteNumber(value) && value >= 0);
}

function validBandEdges(definition: AspectDefinition): boolean {
  return definition.bandEdges.length >= 4
    && definition.bandEdges.slice(0, 4).every(value => finiteNumber(value))
    && definition.bandEdges[0] === 0
    && definition.bandEdges[1]! < definition.bandEdges[2]!
    && definition.bandEdges[2]! < definition.bandEdges[3]!;
}

function bandFor(suspicion: number, definition: AspectDefinition): Band {
  const [, first, second, third] = definition.bandEdges;
  if (suspicion < first!) return BANDS[0]!;
  if (suspicion < second!) return BANDS[1]!;
  if (suspicion < third!) return BANDS[2]!;
  return BANDS[3]!;
}

function invalidJudgement(reason: string): Judgement {
  return { outcome: "not_judged", reason, suspicion: null, signal: null, band: null };
}

/** Derive one target's outcome from validated, raw question responses. */
export function judge(answers: Answers, target: PreparedTarget, definition: AspectDefinition): Judgement {
  if (!validThresholds(definition) || !validWeights(definition) || !validBandEdges(definition)) {
    return invalidJudgement("invalid_definition");
  }
  const collected = collectAnswers(answers, target, definition);
  if (collected.error) return invalidJudgement(collected.error);
  const values = collected.values;
  const n = (property: string): number => values.get(property)!.noul as number;

  const core = Math.max(...CORE_PROPERTIES.map(n));
  const partial = Math.max(...PARTIAL_PROPERTIES.map(n));
  const specificity = values.get("assertion_specificity")!;
  const probabilities = specificity.probabilities as Record<string, unknown>;
  const levels = Object.keys(probabilities).sort((a, b) => Number(a) - Number(b));
  const weak = Number(probabilities[levels[levels.length - 1]!] as number)
    + definition.weights.weakMid * Number(probabilities[levels[Math.floor(levels.length / 2)]!] as number);
  const gate = Math.max(core, partial, n("vague_title"));
  const suspicion = definition.weights.core * core
    + definition.weights.partial * partial * (1 - core)
    + definition.weights.weak * weak * gate;
  if (!finiteNumber(suspicion)) return invalidJudgement("invalid_composition");
  const signal = suspicion - definition.thresholds.finding;

  const own = values.get("ctl_own_snippet")?.noul as number | undefined;
  const sibling = values.get("ctl_sibling_snippet")?.noul as number | undefined;
  const controlsOk = (own === undefined || own >= definition.thresholds.control)
    && (sibling === undefined || sibling <= definition.thresholds.control);
  if (!controlsOk) return invalidJudgement("control_failed");

  const strong = core >= definition.thresholds.strong || partial >= definition.thresholds.strong;
  const unseen = n("hinges_on_unseen_rule");
  const verdict = values.get("verdict")!;
  const choice = verdict.choice;
  const confidence = verdict.confidence as number;
  if (!strong && (unseen >= definition.thresholds.unseen || choice === "cannot_tell_from_file")) {
    return { outcome: "cannot_tell", reason: "insufficient_context", suspicion, signal, band: null };
  }
  if (!strong && core > definition.thresholds.midLow && core < definition.thresholds.midHigh
    && confidence < definition.thresholds.confidence) {
    return { outcome: "cannot_tell", reason: "low_verdict_confidence", suspicion, signal, band: null };
  }
  if (suspicion >= definition.thresholds.finding) {
    return { outcome: "finding", suspicion, signal, band: bandFor(signal, definition) };
  }
  return { outcome: "clean", suspicion, signal, band: null };
}

function conditionFor(definition: AspectDefinition): string {
  return hash({
    model: definition.model,
    propositionVersion: definition.propositionVersion,
    selector: definition.selector,
    parser: definition.parser,
    contextPolicy: definition.contextPolicy,
    composition: definition.composition,
    weights: definition.weights,
    thresholds: definition.thresholds,
    bandEdges: definition.bandEdges,
    questions: definition.questions,
  });
}

function emptyRow(): CalibrationRow {
  return { valid: 0, invalid: 0, high: 0, prioritized: 0, pValid: null, pHigh: null };
}

function emptyTable(): Record<Band, CalibrationRow> {
  return Object.fromEntries(BANDS.map(band => [band, emptyRow()])) as Record<Band, CalibrationRow>;
}

function labelsSourceCounts(): Record<Label["source"], number> {
  return { human: 0, agent: 0, execution: 0 };
}

function currentEvidenceMatches(
  target: PreparedTarget,
  label: Label,
  sourceHashes: Record<string, string>,
): boolean {
  if (label.evidenceSources.length === 0) return false;
  const targetSource = label.evidenceSources.find(source => source.file === target.location.file);
  return targetSource !== undefined
    && targetSource.hash === sourceHashes[target.location.file]
    && label.evidenceSources.every(source => sourceHashes[source.file] === source.hash)
    && subjectRevision(label.propositionVersion, label.evidenceSources) === label.subjectRevision;
}

function latestMatchingLabels(
  labels: Label[],
  selection: DeriveInput["selection"],
  definition: AspectDefinition,
): Map<string, Label> {
  const targets = selection.targets;
  const targetByFingerprint = new Map(targets.map(target => [target.fingerprint, target]));
  const result = new Map<string, Label>();
  for (const label of labels) {
    const target = targetByFingerprint.get(label.fingerprint);
    if (!target || label.propositionVersion !== definition.propositionVersion
      || !currentEvidenceMatches(target, label, selection.sourceHashes)) continue;
    // Labels are append-only records. The last matching record is the current
    // statement for a target's current source revision, including an explicit
    // unknown statement. A reviewer may add evidence files, so the label's
    // revision is recomputed from its own provenance rather than requiring the
    // selector's base evidence list to be identical.
    result.set(label.fingerprint, label);
  }
  return result;
}

function calibrationFor(
  mode: ContextMode,
  targets: RunTarget[],
  labels: Map<string, Label>,
  targetByFingerprint: Map<string, PreparedTarget>,
  definition: AspectDefinition,
): ModeCalibration {
  const table = emptyTable();
  const labelsBySource = labelsSourceCounts();
  let usableLabels = 0;
  for (const target of targets) {
    if (target.contextMode !== mode || target.outcome !== "finding" || !target.band) continue;
    const label = labels.get(target.fingerprint);
    if (!label || label.validity === "unknown") continue;
    labelsBySource[label.source]++;
    const row = table[target.band];
    if (label.validity !== "valid" && label.validity !== "invalid") continue;
    usableLabels++;
    if (label.validity === "valid") row.valid++;
    else row.invalid++;
    if (label.validity === "valid" && label.priority !== undefined) {
      row.prioritized++;
      if (label.priority === "high") row.high++;
    }
  }
  for (const row of Object.values(table)) {
    const validityCount = row.valid + row.invalid;
    row.pValid = validityCount > 0 ? row.valid / validityCount : null;
    row.pHigh = row.prioritized > 0 ? row.high / row.prioritized : null;
  }
  return {
    source: usableLabels > 0 ? "local" : "none",
    labelsBySource,
    table,
  };
}

function labelForTarget(
  target: RunTarget,
  labels: Map<string, Label>,
): Label | undefined {
  return labels.get(target.fingerprint);
}

function labelWithoutNote(label: Label | undefined): Omit<Label, "note"> | null {
  if (!label) return null;
  const { note: _note, ...withoutNote } = label;
  return withoutNote;
}

function validObservationAnswers(observation: Observation): observation is Observation & { answers: Answers } {
  return observation.answers !== undefined && object(observation.answers);
}

function judgementFor(
  target: PreparedTarget,
  observation: Observation | undefined,
  definition: AspectDefinition,
): { judgement: Judgement; answers?: Answers } {
  if (target.unjudgeableReason) {
    return { judgement: { outcome: "unjudgeable", reason: target.unjudgeableReason, suspicion: null, signal: null, band: null } };
  }
  if (!observation) {
    return { judgement: { outcome: "unevaluated", reason: "missing_observation", suspicion: null, signal: null, band: null } };
  }
  if (observation.outcome) {
    return {
      judgement: {
        outcome: observation.outcome,
        reason: observation.reason,
        suspicion: null,
        signal: null,
        band: null,
      },
      ...(validObservationAnswers(observation) ? { answers: observation.answers } : {}),
    };
  }
  if (observation.model !== undefined && observation.model !== definition.model) {
    return { judgement: invalidJudgement("model_mismatch") };
  }
  if (!validObservationAnswers(observation)) {
    return { judgement: invalidJudgement("missing_answers") };
  }
  return { judgement: judge(observation.answers, target, definition), answers: observation.answers };
}

function toRunTarget(target: PreparedTarget, judgement: Judgement): RunTarget {
  return {
    fingerprint: target.fingerprint,
    aspect: target.aspect,
    location: { ...target.location },
    target: { path: [...target.target.path], name: target.target.name },
    contextMode: target.contextMode,
    ...(target.contextReason === undefined ? {} : { contextReason: target.contextReason }),
    inputHash: target.inputHash,
    subjectRevision: target.subjectRevision,
    controls: { ...target.controls },
    ...judgement,
  };
}

function compatibleHistory(input: DeriveInput, condition: string): Run[] {
  const metadataAt = Date.parse(input.metadata.at);
  return input.history
    .filter(history => history.run.id !== input.metadata.id
      && history.run.complete
      && history.scope.repositoryId === input.selection.scope.repositoryId
      && history.scope.id === input.selection.scope.id
      && history.scope.enumerationComplete
      && history.aspects.some(aspect => aspect.id === input.definition.id && aspect.condition === condition)
      && Number.isFinite(Date.parse(history.run.at))
      && (!Number.isFinite(metadataAt) || Date.parse(history.run.at) <= metadataAt))
    .sort((a, b) => {
      const byDate = Date.parse(a.run.at) - Date.parse(b.run.at);
      return byDate || a.run.id.localeCompare(b.run.id);
    });
}

function noBaselineReason(input: DeriveInput, condition: string): string {
  const metadataAt = Date.parse(input.metadata.at);
  const prior = input.history.filter(history => history.run.id !== input.metadata.id
    && Number.isFinite(Date.parse(history.run.at))
    && (!Number.isFinite(metadataAt) || Date.parse(history.run.at) <= metadataAt)
    && history.scope.repositoryId === input.selection.scope.repositoryId);
  if (prior.some(history => history.scope.id !== input.selection.scope.id)) return "scope_changed";
  if (prior.some(history => history.scope.id === input.selection.scope.id
    && history.aspects.some(aspect => aspect.id === input.definition.id && aspect.condition !== condition))) {
    return "condition_changed";
  }
  return "no_baseline";
}

type Reference =
  | { kind: "none" }
  | { kind: "already_gone" }
  | { kind: "conclusive"; run: Run; target: RunTarget }
  | { kind: "context_mismatch"; run: Run; target: RunTarget }
  | { kind: "pending"; run: Run; target?: RunTarget; reason: string };

function latestConclusive(runs: Run[], fingerprint: string): { run: Run; target: RunTarget } | undefined {
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    const target = run.targets.find(candidate => candidate.fingerprint === fingerprint);
    if (target && (target.outcome === "finding" || target.outcome === "clean")) return { run, target };
  }
  return undefined;
}

function referenceFor(
  runs: Run[],
  fingerprint: string,
  contextMode: ContextMode,
  currentExists: boolean,
  currentScope: DeriveInput["selection"]["scope"],
  currentTarget?: RunTarget,
): Reference {
  if (runs.length === 0) return { kind: "none" };

  // A recoverable parser/selection diagnostic may omit a target from a run.
  // Keep its last known location so that omission can be distinguished from
  // a diagnostic-free run in which the target population is known absent.
  const knownTarget = [...runs].reverse()
    .flatMap(run => run.targets)
    .find(target => target.fingerprint === fingerprint);
  const locationTarget = knownTarget ?? currentTarget;
  const currentUncertain = !currentExists
    && locationTarget !== undefined
    && targetRemovalUncertain(currentScope, locationTarget);

  let sawNonconclusive = false;
  let sawSelectionDiagnostic = false;
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    const target = run.targets.find(candidate => candidate.fingerprint === fingerprint);
    if (!target) {
      if (locationTarget !== undefined && targetRemovalUncertain(run.scope, locationTarget)) {
        sawSelectionDiagnostic = true;
        continue;
      }
      return currentExists ? { kind: "none" } : { kind: "already_gone" };
    }
    if (target.contextMode !== contextMode) {
      const fallback = latestConclusive(runs.slice(0, index + 1), fingerprint);
      return {
        kind: "context_mismatch",
        run: fallback?.run ?? run,
        target: fallback?.target ?? target,
      };
    }
    if (target.outcome === "finding" || target.outcome === "clean") {
      if (currentUncertain) {
        return { kind: "pending", run, target, reason: "selection_diagnostic" };
      }
      if (!currentExists && sawNonconclusive && target.outcome === "finding") {
        return { kind: "pending", run, target, reason: "prior_run_not_conclusive" };
      }
      return { kind: "conclusive", run, target };
    }
    sawNonconclusive = true;
  }

  const fallback = latestConclusive(runs, fingerprint);
  if (fallback) {
    return {
      kind: "pending",
      run: fallback.run,
      target: fallback.target,
      reason: currentUncertain ? "selection_diagnostic" : "prior_run_not_conclusive",
    };
  }
  if (sawSelectionDiagnostic) {
    return { kind: "pending", run: runs[runs.length - 1]!, reason: "selection_diagnostic" };
  }
  return { kind: "none" };
}

function appendPending(
  pending: { fingerprint: string; baselineRun: string; reason: string }[],
  entry: { fingerprint: string; baselineRun: string; reason: string },
): void {
  if (!pending.some(existing => existing.fingerprint === entry.fingerprint
    && existing.baselineRun === entry.baselineRun && existing.reason === entry.reason)) pending.push(entry);
}

function targetRemovalUncertain(
  scope: DeriveInput["selection"]["scope"],
  target: RunTarget,
): boolean {
  const file = scope.files.find(candidate => candidate.file === target.location.file);
  // A parser/selection diagnostic means that the target population in this
  // file is not fully known. Its absence cannot establish target_gone.
  return file !== undefined && (file.status !== "parsed" || file.reason !== undefined);
}

function applyHistory(
  findings: Finding[],
  targets: RunTarget[],
  currentComplete: boolean,
  runs: Run[],
  preparedByFingerprint: Map<string, PreparedTarget>,
  absentBaselineReason: string,
  scope: DeriveInput["selection"]["scope"],
): {
  resolved: Run["resolved"];
  pending: Run["pendingComparisons"];
  comparison: RunAspect["comparison"];
} {
  const baseline = runs.length > 0 ? runs[runs.length - 1]! : undefined;
  const resolved: Run["resolved"] = [];
  const pending: Run["pendingComparisons"] = [];
  const currentByFingerprint = new Map(targets.map(target => [target.fingerprint, target]));
  const baselineRun = baseline?.run.id ?? null;
  const allFingerprints = new Set<string>([
    ...targets.map(target => target.fingerprint),
    ...runs.flatMap(run => run.targets.map(target => target.fingerprint)),
  ]);

  const currentFindings = new Map(findings.map(finding => [finding.fingerprint, finding]));
  let newCount = 0;
  for (const fingerprint of allFingerprints) {
    const current = currentByFingerprint.get(fingerprint);
    const prepared = preparedByFingerprint.get(fingerprint);
    const mode = current?.contextMode
      ?? [...runs].reverse().flatMap(run => run.targets).find(target => target.fingerprint === fingerprint)?.contextMode;
    if (!mode) continue;
    const reference = referenceFor(runs, fingerprint, mode, current !== undefined, scope, current);
    const currentFinding = currentFindings.get(fingerprint);

    if (!currentComplete) {
      if (currentFinding) currentFinding.status = "uncompared";
      if (reference.kind === "conclusive" && reference.target.outcome === "finding") {
        appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: "incomplete_run" });
      }
      continue;
    }

    if (!current) {
      if (reference.kind === "conclusive" && reference.target.outcome === "finding") {
        if (currentComplete && prepared === undefined && !targetRemovalUncertain(scope, reference.target)) {
          resolved.push({ fingerprint, baselineRun: reference.run.run.id, reason: "target_gone" });
        } else {
          appendPending(pending, {
            fingerprint,
            baselineRun: reference.run.run.id,
            reason: targetRemovalUncertain(scope, reference.target) ? "selection_diagnostic" : "enumeration_incomplete",
          });
        }
      } else if (reference.kind === "pending" && reference.target?.outcome === "finding") {
        appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: reference.reason });
      } else if (reference.kind === "context_mismatch" && reference.target.outcome === "finding") {
        appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: "context_mode_changed" });
      }
      continue;
    }

    if (reference.kind === "context_mismatch") {
      if (currentFinding) currentFinding.status = "uncompared";
      if (reference.target.outcome === "finding" || current.outcome === "finding") {
        appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: "context_mode_changed" });
      }
      continue;
    }
    if (reference.kind === "pending") {
      if (currentFinding) currentFinding.status = "uncompared";
      if (reference.target?.outcome === "finding" || current.outcome === "finding") {
        appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: reference.reason });
      }
      continue;
    }
    if (reference.kind !== "conclusive") {
      if (currentFinding) {
        // A compatible completed baseline with no manifest entry means this
        // target is newly selected (or has reappeared). The very first run has
        // no baseline at all, so it remains explicitly uncompared.
        if (runs.length > 0 && reference.kind === "none") {
          currentFinding.status = "new";
          newCount++;
        } else {
          currentFinding.status = "uncompared";
        }
      }
      continue;
    }

    if (current.outcome === "finding") {
      if (currentFinding) currentFinding.status = reference.target.outcome === "finding" ? "persisting" : "new";
      if (reference.target.outcome !== "finding") newCount++;
    } else if (current.outcome === "clean") {
      if (reference.target.outcome === "finding") {
        resolved.push({ fingerprint, baselineRun: reference.run.run.id, reason: "value_dropped" });
      }
    } else if (reference.target.outcome === "finding") {
      appendPending(pending, { fingerprint, baselineRun: reference.run.run.id, reason: "current_run_not_conclusive" });
    }
  }

  return {
    resolved,
    pending,
    comparison: {
      baselineRun,
      new: baselineRun === null ? null : newCount,
      resolved: baselineRun === null ? null : resolved.length,
      pending: pending.length,
      ...(baselineRun === null ? { reason: absentBaselineReason } : pending.length > 0 ? { reason: "comparison_pending" } : {}),
      scoreDelta: null,
      noiseFloor: null,
    },
  };
}

function priorityComplete(findings: Finding[]): boolean {
  return findings.length === 0 || findings.every(finding => finding.evidence.pValid !== null && finding.evidence.pHigh !== null);
}

function isActionable(finding: Finding): boolean {
  return !["accept", "defer", "dismiss"].includes(finding.label?.resolution ?? "");
}

function rankFindings(findings: Finding[], top: number): { findings: Finding[]; top: string[] } {
  const calibrated = priorityComplete(findings);
  const rankScore = (finding: Finding): number => calibrated
    ? (finding.evidence.pValid! * finding.evidence.pHigh!)
    : finding.evidence.suspicion;
  const ordered = [...findings].sort((a, b) => {
    const bySignal = rankScore(b) - rankScore(a);
    if (bySignal !== 0) return bySignal;
    const bySuspicion = b.evidence.suspicion - a.evidence.suspicion;
    if (bySuspicion !== 0) return bySuspicion;
    return a.fingerprint.localeCompare(b.fingerprint);
  });
  ordered.forEach((finding, index) => { finding.rank = index + 1; });
  const open = ordered.filter(isActionable);
  return { findings: ordered, top: open.slice(0, Math.max(0, top)).map(finding => finding.fingerprint) };
}

function scoreAspect(
  targets: RunTarget[],
  findings: Finding[],
): number | null {
  const evaluated = targets.filter(target => target.outcome === "finding" || target.outcome === "clean");
  if (evaluated.length === 0 || findings.length === 0 || findings.some(finding => finding.evidence.pValid === null)) return null;
  const expectedInvalid = findings.reduce((sum, finding) => sum + (finding.evidence.pValid ?? 0), 0);
  return 1 - expectedInvalid / evaluated.length;
}

function buildAspect(
  definition: AspectDefinition,
  condition: string,
  targets: RunTarget[],
  findings: Finding[],
  labels: Map<string, Label>,
  preparedByFingerprint: Map<string, PreparedTarget>,
  comparison: RunAspect["comparison"],
): RunAspect {
  const byContextMode = {} as Record<ContextMode, ModeCalibration>;
  const targetByFingerprint = preparedByFingerprint;
  for (const mode of MODES) byContextMode[mode] = calibrationFor(mode, targets, labels, targetByFingerprint, definition);
  const bandsByContextMode = {} as RunAspect["bandsByContextMode"];
  for (const mode of MODES) bandsByContextMode[mode] = Object.fromEntries(BANDS.map(band => [band, 0])) as Record<Band, number>;
  for (const target of targets) {
    if (target.outcome === "finding" && target.band) bandsByContextMode[target.contextMode][target.band]++;
  }
  for (const finding of findings) {
    const prepared = preparedByFingerprint.get(finding.fingerprint);
    if (!prepared) continue;
    const mode = prepared.contextMode;
    const row = byContextMode[mode].table[finding.evidence.band];
    finding.evidence.pValid = row.pValid;
    finding.evidence.pHigh = row.pHigh;
    finding.label = labelWithoutNote(labelForTarget(
      targets.find(target => target.fingerprint === finding.fingerprint)!,
      labels,
    ));
  }
  const evaluated = targets.filter(target => target.outcome === "finding" || target.outcome === "clean").length;
  const cannotTell = targets.filter(target => target.outcome === "cannot_tell").length;
  const notJudged = targets.filter(target => target.outcome === "not_judged").length;
  const unjudgeable = targets.filter(target => target.outcome === "unjudgeable").length;
  const unevaluated = targets.filter(target => target.outcome === "unevaluated").length;
  const score = scoreAspect(targets, findings);
  return {
    id: definition.id,
    condition,
    definition,
    calibration: { validation: "provisional", byContextMode },
    evaluated,
    cannotTell,
    notJudged,
    unjudgeable,
    unevaluated,
    bandsByContextMode,
    open: findings.filter(isActionable).length,
    score,
    inTotal: score !== null,
    comparison,
  };
}

/** Purely derive a self-contained run from selection, observations, labels and history. */
export function deriveRun(input: DeriveInput): Run {
  const { selection, definition } = input;
  const condition = conditionFor(definition);
  const observationByFingerprint = new Map<string, Observation>();
  for (const observation of input.observations) observationByFingerprint.set(observation.fingerprint, observation);
  const preparedByFingerprint = new Map(selection.targets.map(target => [target.fingerprint, target]));
  const snapshots: Run["snapshots"] = {};
  const runTargets: RunTarget[] = [];
  const answersByFingerprint = new Map<string, Answers>();
  for (const target of selection.targets) {
    const { judgement, answers } = judgementFor(target, observationByFingerprint.get(target.fingerprint), definition);
    runTargets.push(toRunTarget(target, judgement));
    if (answers) answersByFingerprint.set(target.fingerprint, answers);
  }

  const matchingLabels = latestMatchingLabels(input.labels, selection, definition);
  const rawFindings: Finding[] = [];
  for (const target of runTargets) {
    if (target.outcome !== "finding" || target.suspicion === null || target.signal === null || target.band === null) continue;
    const prepared = preparedByFingerprint.get(target.fingerprint)!;
    const answers = answersByFingerprint.get(target.fingerprint);
    if (!answers) continue;
    if (snapshots[target.inputHash] === undefined) snapshots[target.inputHash] = { state: prepared.state, questions: prepared.questions };
    rawFindings.push({
      fingerprint: target.fingerprint,
      aspect: target.aspect,
      status: "uncompared",
      rank: 0,
      evidence: {
        inputHash: target.inputHash,
        answers,
        suspicion: target.suspicion,
        signal: target.signal,
        band: target.band,
        pValid: null,
        pHigh: null,
      },
      labelTemplate: {
        fingerprint: target.fingerprint,
        propositionVersion: definition.propositionVersion,
        subjectRevision: target.subjectRevision,
        evidenceSources: prepared.evidenceSources.map(source => ({ ...source })),
      },
      label: null,
    });
  }

  // Build calibration first so finding evidence can carry calibrated values.
  const baselineRuns = compatibleHistory(input, condition);
  const absentBaselineReason = noBaselineReason(input, condition);
  const currentComplete = input.metadata.complete
    && selection.errors.length === 0
    && selection.scope.enumerationComplete
    && !runTargets.some(target => target.outcome === "not_judged" || target.outcome === "unevaluated");
  const provisionalComparison = applyHistory(rawFindings, runTargets, currentComplete, baselineRuns, preparedByFingerprint, absentBaselineReason, selection.scope);
  const aspect = buildAspect(
    definition,
    condition,
    runTargets,
    rawFindings,
    matchingLabels,
    preparedByFingerprint,
    provisionalComparison.comparison,
  );
  const ranked = rankFindings(rawFindings, input.top);
  const findings = ranked.findings;
  const totalScore = aspect.score;
  return {
    schema: 1,
    tool: VERSION,
    run: { ...input.metadata, complete: currentComplete },
    scope: {
      ...selection.scope,
      paths: [...selection.scope.paths],
      include: [...selection.scope.include],
      exclude: [...selection.scope.exclude],
      languages: [...selection.scope.languages],
      files: selection.scope.files.map(file => ({ ...file })),
    },
    aspects: [aspect],
    targets: runTargets,
    findings,
    snapshots,
    topFindings: { [definition.id]: ranked.top },
    resolved: provisionalComparison.resolved,
    pendingComparisons: provisionalComparison.pending,
    total: {
      score: totalScore,
      aspects: totalScore === null ? 0 : 1,
      weights: { [definition.id]: 1 },
    },
    unmeasured: {
      skippedFiles: selection.scope.files.filter(file => file.status !== "parsed").length,
      missRate: null,
      populationPrecisionAtN: null,
    },
    usage: { ...input.usage },
  };
}
