import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../shared/hash.js";
import type {
  Answers,
  AspectDefinition,
  Json,
  Plan,
  PlanItem,
  PreparedTarget,
  Question,
  Questions,
} from "../types.js";

/** The limits used by the pinned Jev model.  Estimates are deliberately approximate. */
export const MAX_INPUT_TOKENS_PER_QUESTION = 32_000;
export const MAX_INPUT_TOKENS_PER_REQUEST = 64_000;

/** Cache records are kept under the state directory, one JSON document per answer. */
export const CACHE_DIRECTORY = "observations";
export const CACHE_SCHEMA = 1;

export interface CacheRecord {
  schema: typeof CACHE_SCHEMA;
  key: string;
  model: string;
  inputHash: string;
  questionHash: string;
  answer: Record<string, unknown>;
  requestId: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  observedAt: string;
}

/**
 * Return the exact cache key for one question.  The model is part of the key so
 * that changing the pinned model never reuses an observation from another model.
 */
export function cacheKeyFor(
  model: string,
  inputHash: string,
  question: Question,
): string {
  return hash({ model, inputHash, question });
}

export function cachePathFor(stateDir: string, key: string): string {
  return join(stateDir, CACHE_DIRECTORY, `${key}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(probability);
}

function questionCriteriaLabels(question: Question): string[] {
  if (question.type !== "choice" || !isRecord(question.criteria)) return [];
  return Object.keys(question.criteria);
}

function scoreCriteriaCount(question: Question): number | undefined {
  if (question.type !== "score" || !Array.isArray(question.criteria)) return undefined;
  return question.criteria.length;
}

function hasExpectedProbabilityKeys(
  probabilities: Record<string, number>,
  expected: string[],
): boolean {
  const actual = Object.keys(probabilities).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function probabilitiesSumToOne(probabilities: Record<string, number>): boolean {
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  // Each probability is rounded independently; use the same bound as derivation.
  const roundingTolerance = Math.min(0.02, Object.keys(probabilities).length * 0.005) + 1e-6;
  return Math.abs(sum - 1) <= roundingTolerance;
}

/** Validate the answer shape required before an observation may enter cache. */
export function isValidAnswer(
  question: Question,
  answer: unknown,
): answer is Record<string, unknown> {
  if (!isRecord(answer) || answer.type !== question.type) return false;

  if (question.type === "noul") {
    return probability(answer.noul);
  }

  if (question.type === "score") {
    if (!finiteNumber(answer.score) || !probability(answer.confidence)) return false;
    if (!isRecord(answer.legend) || !isProbabilityMap(answer.probabilities)) return false;
    if (!probabilitiesSumToOne(answer.probabilities)) return false;
    const count = scoreCriteriaCount(question);
    if (count !== undefined) {
      if (count < 2 || answer.score < 0 || answer.score > count - 1) return false;
      const expected = Array.from({ length: count }, (_, index) => String(index));
      if (!hasExpectedProbabilityKeys(answer.probabilities, expected)) return false;
      if (!hasExpectedProbabilityKeys(answer.legend as Record<string, number>, expected)) return false;
      if (Object.values(answer.legend).some(value => typeof value !== "string")) return false;
    }
    return true;
  }

  if (typeof answer.choice !== "string" || answer.choice.length === 0) return false;
  const labels = questionCriteriaLabels(question);
  if (labels.length > 0 && !labels.includes(answer.choice)) return false;
  if (!probability(answer.confidence) || !isProbabilityMap(answer.probabilities)) return false;
  if (labels.length > 0 && !hasExpectedProbabilityKeys(answer.probabilities, labels)) return false;
  if (!probabilitiesSumToOne(answer.probabilities)) return false;
  return true;
}

function isValidCacheRecord(
  value: unknown,
  key: string,
  model: string,
  inputHash: string,
  question: Question,
): value is CacheRecord {
  if (!isRecord(value)) return false;
  if (value.schema !== CACHE_SCHEMA) return false;
  if (value.key !== key) return false;
  if (value.model !== model || value.inputHash !== inputHash) return false;
  if (value.questionHash !== hash(question)) return false;
  if (!isRecord(value.answer) || !isValidAnswer(question, value.answer)) return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (typeof value.observedAt !== "string" || value.observedAt.length === 0) return false;
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) return false;
    for (const keyName of ["inputTokens", "outputTokens"]) {
      const tokenValue = value.usage[keyName];
      if (tokenValue !== undefined && (!finiteNumber(tokenValue) || tokenValue < 0)) return false;
    }
  }
  return true;
}

/** Read one cache entry without creating a directory or changing any state. */
export async function readCacheRecord(
  stateDir: string,
  key: string,
  model: string,
  inputHash: string,
  question: Question,
): Promise<CacheRecord | null> {
  let text: string;
  try {
    text = await readFile(cachePathFor(stateDir, key), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isValidCacheRecord(parsed, key, model, inputHash, question)) return parsed;
    // A present but corrupt/mismatched record is a safe miss.
    return null;
  } catch {
    return null;
  }
}

/** A conservative, JSON-size based token estimate used only for planning. */
export function approximateTokens(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (serialized === undefined) return Number.POSITIVE_INFINITY;
  return Math.ceil(serialized.length / 3);
}

function serializedLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : serialized.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Approximate state plus question input size without claiming tokenizer accuracy. */
export function approximateRequestTokens(state: Json, questions: Questions): number {
  const stateLength = serializedLength(state);
  const questionsLength = Object.values(questions).reduce(
    (sum, question) => sum + serializedLength(question),
    0,
  );
  if (!Number.isFinite(stateLength) || !Number.isFinite(questionsLength)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil((stateLength + questionsLength) / 3);
}

function approximateSingleQuestionTokens(state: Json, question: Question): number {
  const stateLength = serializedLength(state);
  const questionLength = serializedLength(question);
  if (!Number.isFinite(stateLength) || !Number.isFinite(questionLength)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil((stateLength + questionLength) / 3);
}

function targetQuestions(target: PreparedTarget, definition: AspectDefinition): Questions {
  // Selection normally materializes target.questions with its target key.  The
  // fallback keeps planning useful for callers that construct a target fixture
  // from the aspect definition directly.
  return Object.keys(target.questions).length > 0 ? target.questions : definition.questions;
}

function inputLimitReason(
  target: PreparedTarget,
  questions: Questions,
): string | undefined {
  const entries = Object.values(questions);
  if (entries.length === 0) return "no_questions";
  const longest = Math.max(...entries.map((question) => approximateSingleQuestionTokens(target.state, question)));
  const total = approximateRequestTokens(target.state, questions);
  if (longest > MAX_INPUT_TOKENS_PER_QUESTION || total > MAX_INPUT_TOKENS_PER_REQUEST) {
    return "input_limit";
  }
  return undefined;
}

async function planTarget(
  target: PreparedTarget,
  definition: AspectDefinition,
  stateDir: string,
): Promise<PlanItem> {
  const questions = targetQuestions(target, definition);
  const cachedAnswers: Answers = {};
  const missingQuestions: Questions = {};

  await Promise.all(Object.entries(questions).map(async ([name, question]) => {
    const key = cacheKeyFor(definition.model, target.inputHash, question);
    const record = await readCacheRecord(stateDir, key, definition.model, target.inputHash, question);
    if (record) cachedAnswers[name] = record.answer;
    else missingQuestions[name] = question;
  }));

  const estimatedTokens = approximateRequestTokens(target.state, missingQuestions);
  let blockedReason = target.unjudgeableReason;
  // A fully cached target does not need to send its state again.  This keeps
  // offline/cache-only runs useful even when an old state would now exceed the
  // current approximate limits.
  if (!blockedReason && Object.keys(missingQuestions).length > 0) {
    blockedReason = inputLimitReason(target, missingQuestions);
  }

  return { target, cachedAnswers, missingQuestions, estimatedTokens, ...(blockedReason ? { blockedReason } : {}) };
}

/**
 * Build a read-only observation plan.  This function never creates or writes
 * state and never reads credentials.
 */
export async function createPlan(
  targets: PreparedTarget[],
  definition: AspectDefinition,
  stateDir: string,
): Promise<Plan> {
  const items = await Promise.all(targets.map((target) => planTarget(target, definition, stateDir)));
  return {
    items,
    requests: items.filter((item) => !item.blockedReason && Object.keys(item.missingQuestions).length > 0).length,
    cacheHits: items.reduce((sum, item) => sum + Object.keys(item.cachedAnswers).length, 0),
    unjudgeable: items.filter((item) => Boolean(item.blockedReason)).length,
  };
}
