import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  TypeSafeClient,
  type EntryType,
  type Questions as SdkQuestions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type {
  Answers,
  AspectDefinition,
  Json,
  Observation,
  ObserveResult,
  Plan,
  PlanItem,
  Question,
  Questions,
  Usage,
} from "../types.js";
import { hash } from "../shared/hash.js";
import {
  CACHE_SCHEMA,
  cacheKeyFor,
  cachePathFor,
  isValidAnswer,
  type CacheRecord,
} from "../plan/index.js";

/** Request sent through the injectable model boundary. */
export interface JudgeRequest {
  state: Json;
  questions: Questions;
  model: string;
}

export interface JudgeCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface JudgeUsage {
  input_tokens?: number;
  output_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Parsed response shape returned by a JudgeClient. */
export interface JudgeResponse {
  model: string;
  answers: Answers;
  usage?: JudgeUsage;
  requestId?: string;
}

/**
 * Injectable Jev boundary.  Production uses the official TypeSafe SDK adapter;
 * tests can provide a deterministic implementation without an API key.
 */
export interface JudgeClient {
  systemOne(request: JudgeRequest, options?: JudgeCallOptions): Promise<JudgeResponse>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_BACKOFF_MS = 5_000;
const MAX_RETRY_AFTER_MS = 60_000;

class RequestTimeoutError extends Error {
  constructor() {
    super("request timeout");
    this.name = "RequestTimeoutError";
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super("request aborted");
    this.name = "RequestAbortedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cleanTokenCount(value: unknown): number {
  return finiteNonNegative(value) ? Math.floor(value) : 0;
}

function requestInputTokens(response: unknown): number {
  if (!isRecord(response) || !isRecord(response.usage)) return 0;
  return cleanTokenCount(response.usage.input_tokens ?? response.usage.inputTokens);
}

function responseRequestId(response: unknown): string | undefined {
  if (!isRecord(response) || typeof response.requestId !== "string") return undefined;
  return response.requestId;
}

function responseModel(response: unknown): string | undefined {
  if (!isRecord(response) || typeof response.model !== "string") return undefined;
  return response.model;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.status !== "number") return undefined;
  return error.status;
}

function errorHeader(error: unknown, name: string): string | undefined {
  if (!isRecord(error) || !isRecord(error.headers)) return undefined;
  const headers = error.headers;
  const get = headers.get;
  if (typeof get === "function") {
    const value = get.call(headers, name);
    if (typeof value === "string") return value;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (isRecord(error) && finiteNonNegative(error.retryAfterMs)) return error.retryAfterMs;
  const retryAfterMsHeader = errorHeader(error, "retry-after-ms");
  if (retryAfterMsHeader !== undefined) {
    const value = Number(retryAfterMsHeader);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const retryAfter = errorHeader(error, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function errorMessage(error: unknown): string {
  if (!isRecord(error) || typeof error.message !== "string") return "";
  // Classification only; this string is never returned to callers.
  return error.message.toLowerCase();
}

function errorHints(error: unknown): string {
  if (!isRecord(error)) return "";
  const fields: unknown[] = [error.name, error.code, error.type, error.message];
  if (isRecord(error.body)) {
    fields.push(error.body.name, error.body.code, error.body.type, error.body.message, error.body.error);
  }
  return fields.filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
}

function isInputLimitError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 413) return true;
  if (status !== 400 && status !== 422) return false;
  return /input|token|context|length|too large|payload/.test(errorHints(error) || errorMessage(error));
}

function questionAnswers(
  question: Question,
  answer: unknown,
): answer is Record<string, unknown> {
  return isValidAnswer(question, answer);
}

function validFreshAnswers(
  questions: Questions,
  response: unknown,
): response is JudgeResponse {
  if (!isRecord(response) || !isRecord(response.answers)) return false;
  const expectedNames = Object.keys(questions).sort();
  const actualNames = Object.keys(response.answers).sort();
  if (expectedNames.length !== actualNames.length || !expectedNames.every((name, index) => name === actualNames[index])) {
    return false;
  }
  for (const [name, question] of Object.entries(questions)) {
    if (!questionAnswers(question, response.answers[name])) return false;
  }
  return true;
}

function asAnswers(value: Record<string, unknown>): Answers {
  return value as Answers;
}

function mergeAnswers(cached: Answers, fresh: Record<string, unknown>): Answers {
  return { ...cached, ...asAnswers(fresh) };
}

function resultWithCached(
  item: PlanItem,
  outcome: Observation["outcome"],
  reason: string,
): Observation {
  const answers = Object.keys(item.cachedAnswers).length > 0 ? item.cachedAnswers : undefined;
  return {
    fingerprint: item.target.fingerprint,
    ...(answers ? { answers } : {}),
    ...(outcome ? { outcome } : {}),
    reason,
  };
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new RequestAbortedError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new RequestAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** A serialized start scheduler implementing both request and token limits. */
class StartRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private nextTokenAt = 0;

  constructor(
    private readonly requestIntervalMs: number,
    private readonly tokenRate: number,
  ) {}

  reserve(tokens: number, signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(async () => {
      if (signal?.aborted) throw new RequestAbortedError();
      const now = Date.now();
      const startAt = Math.max(now, this.nextRequestAt, this.nextTokenAt);
      const tokenDelay = this.tokenRate > 0 && Number.isFinite(this.tokenRate)
        ? (Math.max(0, tokens) / this.tokenRate) * 1000
        : 0;
      this.nextRequestAt = startAt + this.requestIntervalMs;
      this.nextTokenAt = startAt + tokenDelay;
      await waitFor(startAt - now, signal);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function positiveOrInfinity(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function requestRateInterval(requestsPerMinute: number): number {
  const rate = positiveOrInfinity(requestsPerMinute);
  return Number.isFinite(rate) ? 60_000 / rate : 0;
}

/**
 * Adapter around the official @typesafe-ai/sdk.  SDK retries are disabled so
 * observation owns attempt scheduling and request accounting.  The adapter
 * only translates the stable internal contract and suppresses SDK request/body
 * logging at the observation boundary.
 */
class TypeSafeJudgeClient implements JudgeClient {
  private readonly client: TypeSafeClient;

  constructor(apiKey: string | undefined, model: string, timeout: number) {
    this.client = new TypeSafeClient({
      ...(apiKey ? { apiKey } : {}),
      defaultModel: model,
      logLevel: "off",
      timeout,
      retry: { maxRetries: 0 },
    });
  }

  async systemOne(request: JudgeRequest, options?: JudgeCallOptions): Promise<JudgeResponse> {
    const sdkQuestions = request.questions as unknown as SdkQuestions;
    const sdkRequest = {
      state: request.state as EntryType,
      questions: sdkQuestions,
      model: request.model,
    };
    const sdkOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    const result = await this.client.systemOne(sdkRequest, sdkOptions).withResponse();
    const data = result.data as SystemOneResult<SdkQuestions>;
    return {
      model: data.model,
      answers: data.answers as unknown as Answers,
      usage: {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      },
      requestId: result.requestId,
    };
  }
}

/** Construct the production adapter.  No network call happens here. */
export function createJudgeClient(
  apiKey: string | undefined,
  model: string,
  timeout = DEFAULT_REQUEST_TIMEOUT_MS,
): JudgeClient {
  return new TypeSafeJudgeClient(apiKey, model, timeout);
}

async function callWithTimeout(
  client: JudgeClient,
  request: JudgeRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onStart?: () => void,
): Promise<JudgeResponse> {
  if (signal?.aborted) throw new RequestAbortedError();

  const controller = new AbortController();
  let rejectAbort: ((error: RequestAbortedError) => void) | undefined;
  const abortResult = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectAbort?.(new RequestAbortedError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = Promise.resolve().then(() => {
      onStart?.();
      return client.systemOne(request, {
        signal: controller.signal,
        timeout: timeoutMs,
      });
    });
    const timeoutResult = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new RequestTimeoutError());
      }, timeoutMs);
    });
    return await Promise.race([result, timeoutResult, ...(signal ? [abortResult] : [])]);
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError();
    if (signal?.aborted || isAbortError(error)) throw new RequestAbortedError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function writeCacheRecord(
  stateDir: string,
  key: string,
  record: CacheRecord,
): Promise<void> {
  const path = cachePathFor(stateDir, key);
  const temporary = join(dirname(path), `.${key}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A cache write is an optimization.  Keep the successful observation even
    // when a read-only or concurrently removed state directory rejects it.
    try {
      await unlink(temporary);
    } catch {
      // Ignore cleanup failures without exposing filesystem details.
    }
  }
}

function cacheRecord(
  key: string,
  model: string,
  inputHash: string,
  question: Question,
  answer: Record<string, unknown>,
  requestId: string,
  usage: JudgeUsage | undefined,
): CacheRecord {
  const inputTokens = usage?.input_tokens ?? usage?.inputTokens;
  const outputTokens = usage?.output_tokens ?? usage?.outputTokens;
  const normalizedUsage = finiteNonNegative(inputTokens) || finiteNonNegative(outputTokens)
    ? {
        ...(finiteNonNegative(inputTokens) ? { inputTokens: Math.floor(inputTokens) } : {}),
        ...(finiteNonNegative(outputTokens) ? { outputTokens: Math.floor(outputTokens) } : {}),
      }
    : undefined;
  return {
    schema: CACHE_SCHEMA,
    key,
    model,
    inputHash,
    questionHash: hash(question),
    answer,
    requestId,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    observedAt: new Date().toISOString(),
  };
}

interface ObserveContext {
  definition: AspectDefinition;
  options: ObserveOptions;
  limiter: StartRateLimiter;
  usage: Usage;
  countedRequestIds: Set<string>;
  client: JudgeClient | undefined;
  clientFailure: string | undefined;
  authFailure: boolean;
  authStopController: AbortController;
}

export interface ObserveOptions {
  stateDir: string;
  apiKey?: string;
  concurrency: number;
  requestsPerMinute: number;
  tokensPerSecond: number;
  signal?: AbortSignal;
  client?: JudgeClient;
  /** Optional test/host override; production defaults to a fixed timeout. */
  timeoutMs?: number;
  /** Optional test/host override for the bounded transient retry budget. */
  maxRetries?: number;
  /** Optional test/host override for the first transient retry backoff. */
  retryBackoffMs?: number;
}

function hasConfiguredApiKey(apiKey: string | undefined): boolean {
  return Boolean(apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim());
}

function addFreshUsage(context: ObserveContext, response: unknown): void {
  const requestId = responseRequestId(response);
  if (requestId && context.countedRequestIds.has(requestId)) return;
  if (requestId) context.countedRequestIds.add(requestId);
  context.usage.inputTokens += requestInputTokens(response);
}

function makeUnevaluated(item: PlanItem, reason: string): Observation {
  return resultWithCached(item, "unevaluated", reason);
}

type RequestFailureReason = "auth_failed" | "rate_limited" | "server_error" | "request_failed";

function requestFailureReason(error: unknown): RequestFailureReason {
  const status = errorStatus(error);
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500 && status <= 599) return "server_error";
  return "request_failed";
}

function isTransientFailure(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 408 || status === 429) return true;
  if (status !== undefined) return status >= 500 && status <= 599;
  return true;
}

function configuredRetryCount(options: ObserveOptions): number {
  return Number.isSafeInteger(options.maxRetries) && options.maxRetries !== undefined && options.maxRetries >= 0
    ? options.maxRetries
    : DEFAULT_MAX_TRANSIENT_RETRIES;
}

function retryDelay(error: unknown, retryIndex: number, options: ObserveOptions): number | undefined {
  const serverDelay = retryAfterMs(error);
  if (serverDelay !== undefined) {
    // Never retry before a server-provided delay that exceeds our bounded
    // retry window; the caller will return the classified failure instead.
    if (serverDelay > MAX_RETRY_AFTER_MS) return undefined;
    return serverDelay;
  }
  const configured = options.retryBackoffMs;
  const initial = finiteNonNegative(configured) ? configured : DEFAULT_RETRY_BACKOFF_MS;
  return Math.min(initial * 2 ** retryIndex, MAX_RETRY_BACKOFF_MS);
}

async function ensureClient(context: ObserveContext): Promise<JudgeClient | undefined> {
  if (context.client) return context.client;
  if (context.clientFailure) return undefined;
  try {
    context.client = createJudgeClient(
      context.options.apiKey,
      context.definition.model,
      context.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    return context.client;
  } catch {
    context.clientFailure = hasConfiguredApiKey(context.options.apiKey)
      ? "client_unavailable"
      : "missing_api_key";
    return undefined;
  }
}

async function observeItem(item: PlanItem, context: ObserveContext): Promise<Observation> {
  const { options, definition } = context;
  if (item.blockedReason) {
    return {
      fingerprint: item.target.fingerprint,
      outcome: "unjudgeable",
      reason: item.blockedReason,
      ...(Object.keys(item.cachedAnswers).length > 0 ? { answers: item.cachedAnswers } : {}),
    };
  }

  const missingEntries = Object.entries(item.missingQuestions);
  context.usage.cacheHits += Object.keys(item.cachedAnswers).length;
  if (missingEntries.length === 0) {
    return {
      fingerprint: item.target.fingerprint,
      answers: item.cachedAnswers,
      model: definition.model,
    };
  }

  if (options.signal?.aborted) return makeUnevaluated(item, "aborted");
  if (context.authFailure) return makeUnevaluated(item, "auth_failed");
  const client = await ensureClient(context);
  if (!client) return makeUnevaluated(item, context.clientFailure ?? "client_unavailable");

  const limiterSignal = context.authStopController.signal;
  const request: JudgeRequest = {
    state: item.target.state,
    questions: item.missingQuestions,
    model: definition.model,
  };
  const maxRetries = configuredRetryCount(options);
  let response: JudgeResponse;
  for (let attempt = 0; ; attempt++) {
    try {
      await context.limiter.reserve(item.estimatedTokens, limiterSignal);
    } catch (error) {
      if (context.authFailure) return makeUnevaluated(item, "auth_failed");
      if (error instanceof RequestAbortedError || options.signal?.aborted) {
        return makeUnevaluated(item, "aborted");
      }
      return makeUnevaluated(item, "rate_limited");
    }

    // An authentication failure ends the run for work that was still queued.
    // Requests already inside the client cannot be recalled, but no new attempt
    // should be started after the shared failure is observed.
    if (context.authFailure) return makeUnevaluated(item, "auth_failed");
    if (options.signal?.aborted) return makeUnevaluated(item, "aborted");

    try {
      response = await callWithTimeout(
        client,
        request,
        options.signal,
        options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        () => { context.usage.requests += 1; },
      );
      break;
    } catch (error) {
      if (error instanceof RequestTimeoutError) return makeUnevaluated(item, "timeout");
      if (error instanceof RequestAbortedError || options.signal?.aborted) return makeUnevaluated(item, "aborted");
      if (isInputLimitError(error)) {
        return resultWithCached(item, "unjudgeable", "input_limit");
      }

      const reason = requestFailureReason(error);
      if (reason === "auth_failed") {
        context.authFailure = true;
        context.authStopController.abort();
      }
      if (!isTransientFailure(error) || attempt >= maxRetries) return makeUnevaluated(item, reason);
      if (context.authFailure) return makeUnevaluated(item, reason);

      try {
        const delay = retryDelay(error, attempt, options);
        if (delay === undefined) return makeUnevaluated(item, reason);
        await waitFor(delay, limiterSignal);
      } catch (waitError) {
        if (context.authFailure) return makeUnevaluated(item, "auth_failed");
        if (waitError instanceof RequestAbortedError || options.signal?.aborted) {
          return makeUnevaluated(item, "aborted");
        }
        return makeUnevaluated(item, reason);
      }
    }
  }

  addFreshUsage(context, response);
  const actualModel = responseModel(response);
  if (actualModel !== definition.model) {
    return resultWithCached(item, "not_judged", "model_mismatch");
  }
  if (!validFreshAnswers(item.missingQuestions, response)) {
    return resultWithCached(item, "not_judged", "invalid_response");
  }

  const fresh = response.answers;
  const merged = mergeAnswers(item.cachedAnswers, fresh);
  const requestId = responseRequestId(response) ?? `local-${randomUUID()}`;
  await Promise.all(Object.entries(item.missingQuestions).map(async ([name, question]) => {
    const answer = fresh[name];
    if (!isRecord(answer)) return;
    const key = cacheKeyFor(definition.model, item.target.inputHash, question);
    await writeCacheRecord(
      options.stateDir,
      key,
      cacheRecord(key, definition.model, item.target.inputHash, question, answer, requestId, response.usage),
    );
  }));
  return {
    fingerprint: item.target.fingerprint,
    answers: merged,
    model: actualModel,
  };
}

/**
 * Execute only the missing questions in a plan, bounded by concurrency and
 * request/token start rates.  Every failed item becomes an incomplete
 * observation so one API failure cannot discard the rest of the scan.
 */
export async function observe(
  plan: Plan,
  definition: AspectDefinition,
  options: ObserveOptions,
): Promise<ObserveResult> {
  const usage: Usage = { requests: 0, inputTokens: 0, cacheHits: 0 };
  const authStopController = new AbortController();
  const onExternalAbort = () => authStopController.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) authStopController.abort();
  const limiter = new StartRateLimiter(
    requestRateInterval(options.requestsPerMinute),
    positiveOrInfinity(options.tokensPerSecond),
  );
  const context: ObserveContext = {
    definition,
    options,
    limiter,
    usage,
    countedRequestIds: new Set(),
    client: options.client,
    clientFailure: undefined,
    authFailure: false,
    authStopController,
  };
  const observations: Observation[] = new Array(plan.items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, plan.items.length || 1));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const item = plan.items[index];
      if (!item) return;
      try {
        observations[index] = await observeItem(item, context);
      } catch {
        // Keep the worker alive and keep failures free of exception/body text.
        observations[index] = makeUnevaluated(item, "request_failed");
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { observations, usage };
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
