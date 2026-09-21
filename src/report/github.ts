import { hashText } from "../shared/hash.js";
import type { Band, Run, RunAspect } from "../types.js";

const MAX_REPORT_LENGTH = 60_000;
const MAX_TOP_FINDINGS = 20;
const MAX_HISTORY_ROWS = 3;
const bands: Band[] = ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"];

function text(value: unknown, limit = 240): string {
  const sanitised = Array.from(String(value), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  return sanitised.replace(/\s+/g, " ").trim().slice(0, limit);
}

function markdown(value: unknown, limit = 240): string {
  return text(value, limit)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}|]/g, "\\$&");
}

function number(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function score(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";
}

function reportMarker(run: Run): string {
  const identity = hashText(`${run.scope.repositoryId}\u0000${run.scope.id}`).slice(0, 32);
  return `<!-- jev-checkup:github:v1 identity=${identity} -->`;
}

function list(values: string[], limit = 20): string {
  const selected = values.slice(0, limit).map((value) => markdown(value, 160));
  if (values.length > limit) selected.push(`+${values.length - limit} more`);
  return selected.join(", ") || "—";
}

function fileCounts(run: Run): { parsed: number; skipped: number; errors: number } {
  return run.scope.files.reduce(
    (counts, file) => {
      if (file.status === "parsed") counts.parsed++;
      else if (file.status === "skipped") counts.skipped++;
      else counts.errors++;
      return counts;
    },
    { parsed: 0, skipped: 0, errors: 0 },
  );
}

function calibrationSummary(aspect: RunAspect): string {
  return Object.entries(aspect.calibration.byContextMode)
    .map(([mode, calibration]) => {
      const labels = Object.entries(calibration.labelsBySource)
        .map(([source, count]) => `${source} ${number(count)}`)
        .join(", ");
      const labelled = bands.reduce((total, band) => {
        const row = calibration.table[band];
        return total + (row?.valid ?? 0) + (row?.invalid ?? 0);
      }, 0);
      return `${mode}: ${calibration.source}; labels ${labelled} (${labels})`;
    })
    .join("; ");
}

function topFindingLines(run: Run, aspect: RunAspect): string[] {
  const byFingerprint = new Map(
    run.findings
      .filter((finding) => finding.aspect === aspect.id)
      .map((finding) => [finding.fingerprint, finding]),
  );
  const targets = new Map(
    run.targets
      .filter((target) => target.aspect === aspect.id)
      .map((target) => [target.fingerprint, target]),
  );
  const lines = ["Top findings:"];
  let included = 0;
  for (const fingerprint of (run.topFindings[aspect.id] ?? []).slice(0, MAX_TOP_FINDINGS)) {
    const finding = byFingerprint.get(fingerprint);
    const target = targets.get(fingerprint);
    if (!finding || !target) continue;
    lines.push(
      `- ${markdown(target.location.file, 180)}:${target.location.startLine}-${target.location.endLine}; suspicion ${score(finding.evidence.suspicion)}; status ${markdown(finding.status)}`,
    );
    included++;
  }
  if (included === 0) lines.push("- None.");
  return lines;
}

function compatibleHistory(run: Run, history: Run[], aspect: RunAspect): Run[] {
  return history
    .filter(
      (candidate) =>
        candidate.run.id !== run.run.id &&
        candidate.run.complete &&
        candidate.run.at <= run.run.at &&
        candidate.scope.repositoryId === run.scope.repositoryId &&
        candidate.scope.id === run.scope.id &&
        candidate.aspects.some(
          (previous) => previous.id === aspect.id && previous.condition === aspect.condition,
        ),
    )
    .sort((a, b) => a.run.at.localeCompare(b.run.at))
    .slice(-MAX_HISTORY_ROWS);
}

function historyLines(run: Run, history: Run[]): string[] {
  const lines = ["History:"];
  for (const aspect of run.aspects) {
    const compatible = compatibleHistory(run, history, aspect);
    if (compatible.length === 0) {
      lines.push(`${markdown(aspect.id)}: no compatible completed history supplied.`);
      continue;
    }
    for (const candidate of compatible) {
      const previous = candidate.aspects.find(
        (item) => item.id === aspect.id && item.condition === aspect.condition,
      );
      if (!previous) continue;
      lines.push(
        `- ${markdown(candidate.run.at, 40)} ${markdown(aspect.id)}: open ${number(previous.open)}; evaluated ${number(previous.evaluated)}; cannot tell ${number(previous.cannotTell)}; not judged ${number(previous.notJudged)}; unjudgeable ${number(previous.unjudgeable)}; unevaluated ${number(previous.unevaluated)}`,
      );
    }
  }
  return lines;
}

function bound(lines: string[]): string {
  const full = `${lines.join("\n")}\n`;
  if (full.length <= MAX_REPORT_LENGTH) return full;
  let output = `${lines[0]}\n# Jev Checkup\n\n`;
  for (const line of lines.slice(1)) {
    if (output.length + line.length + 1 > MAX_REPORT_LENGTH - 40) break;
    output += `${line}\n`;
  }
  return `${output}...\n`;
}

export function renderGithubReport(run: Run, history: Run[] = []): string {
  const files = fileCounts(run);
  const lines = [
    reportMarker(run),
    "# Jev Checkup",
    "",
    `Status: ${run.run.complete ? "complete" : "INCOMPLETE"}`,
    `Scope: ${markdown(run.scope.id)}; paths ${list(run.scope.paths)}; files parsed ${files.parsed}, skipped ${files.skipped}, errors ${files.errors}`,
    `Enumeration: ${run.scope.enumerationComplete ? "complete" : "incomplete"}; selection errors ${number(run.unmeasured.selectionErrors?.length ?? 0)}`,
    `Usage: requests ${number(run.usage.requests)}; input tokens ${number(run.usage.inputTokens)}; cached questions ${number(run.usage.cacheHits)}`,
    `Total score: ${score(run.total.score)}; scored aspects ${number(run.total.aspects)}; weights ${list(Object.entries(run.total.weights).map(([id, weight]) => `${id} ${score(weight)}`))}`,
    "",
  ];
  for (const aspect of run.aspects) {
    const targetCount = run.targets.filter((target) => target.aspect === aspect.id).length;
    lines.push(
      `## ${markdown(aspect.id)}`,
      `Condition: ${markdown(aspect.condition)}`,
      `Score: ${score(aspect.score)}; evaluated ${number(aspect.evaluated)} of ${targetCount}; cannot tell ${number(aspect.cannotTell)}; not judged ${number(aspect.notJudged)}; unjudgeable ${number(aspect.unjudgeable)}; unevaluated ${number(aspect.unevaluated)}`,
      `Open: ${number(aspect.open)}; new ${number(aspect.comparison.new)}; resolved ${number(aspect.comparison.resolved)}; pending ${number(aspect.comparison.pending)}`,
      `Calibration: ${markdown(aspect.calibration.validation)}; ${markdown(calibrationSummary(aspect))}`,
      ...topFindingLines(run, aspect),
      "",
    );
  }
  lines.push(
    ...historyLines(run, history),
    "",
    "The dashboard contains aggregate results and review locations; detailed artifacts remain local.",
  );
  return bound(lines);
}

export interface PublishGithubOptions {
  repo: string;
  issue: "new" | number;
  token?: string;
  fetch?: typeof globalThis.fetch;
  history?: Run[];
}

export interface PublishGithubResult {
  url: string;
  warnings: string[];
}

type GithubObject = Record<string, unknown>;

const ISSUE_TITLE = "Jev Checkup dashboard";
const MAX_ISSUE_PAGES = 100;

function object(value: unknown): GithubObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as GithubObject)
    : null;
}

function issueNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function issueUrl(repo: string, number: number): string {
  const [owner, name] = repo.split("/");
  return `https://github.com/${owner}/${name}/issues/${number}`;
}

function parseRepository(value: string): { owner: string; name: string; repo: string } {
  const repo = value.trim();
  const parts = repo.split("/");
  const validSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (
    parts.length !== 2 ||
    parts.some((part) => !validSegment.test(part) || part === "." || part === "..")
  ) {
    throw new Error("GitHub repository must be owner/name");
  }
  const [owner, name] = parts as [string, string];
  return { owner, name, repo: `${owner}/${name}` };
}

function headers(token: string, hasBody = false): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

function nextPage(response: Response, base: string, fallback: string | null): string | null {
  const link = response.headers.get("link");
  if (!link) return fallback;
  const match = link.match(/<([^>]+)>\s*;\s*rel=["']next["']/i);
  if (!match?.[1]) return fallback;
  try {
    const candidate = new URL(match[1]);
    const expected = new URL(`${base}/issues`);
    const allowedQuery = new Set(["page", "per_page", "state"]);
    const state = candidate.searchParams.get("state");
    if (
      candidate.origin !== expected.origin ||
      candidate.pathname !== expected.pathname ||
      candidate.username ||
      candidate.password ||
      candidate.hash ||
      [...candidate.searchParams.keys()].some((key) => !allowedQuery.has(key)) ||
      (state !== null && state !== "open")
    )
      return fallback;
    const page = Number(candidate.searchParams.get("page"));
    if (!Number.isSafeInteger(page) || page < 1) return fallback;
    const perPage = candidate.searchParams.get("per_page");
    if (
      perPage !== null &&
      (!Number.isSafeInteger(Number(perPage)) || Number(perPage) < 1 || Number(perPage) > 100)
    )
      return fallback;
    return candidate.toString();
  } catch {
    return fallback;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

async function requestJson(
  transport: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      response = await transport(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      throw new Error("GitHub request failed");
    }
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error("GitHub request returned invalid JSON");
    }
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

function issueRecord(value: unknown): GithubObject | null {
  const result = object(value);
  return issueNumber(result?.number) ? result : null;
}

function issueBodyHasMarker(value: GithubObject, marker: string): boolean {
  return typeof value.body === "string" && value.body.includes(marker);
}

function updatePayload(body: string): string {
  return JSON.stringify({ title: ISSUE_TITLE, body });
}

async function updateIssue(
  transport: typeof globalThis.fetch,
  token: string,
  base: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ issue: GithubObject; url: string; nodeId: string | null }> {
  const result = await requestJson(transport, `${base}/issues/${number}`, {
    method: "PATCH",
    headers: headers(token, true),
    body: updatePayload(body),
  });
  const issue = issueRecord(result.data);
  if (!issue) throw new Error("GitHub update issue response was invalid");
  const nodeId =
    typeof issue.node_id === "string" && issue.node_id.length > 0 ? issue.node_id : null;
  return {
    issue,
    url: issueUrl(repo, number),
    nodeId,
  };
}

async function findOpenIssue(
  transport: typeof globalThis.fetch,
  token: string,
  base: string,
  marker: string,
): Promise<GithubObject | null> {
  let pageUrl: string | null = `${base}/issues?state=open&per_page=100&page=1`;
  for (let page = 1; page <= MAX_ISSUE_PAGES && pageUrl; page++) {
    const result = await requestJson(transport, pageUrl, { headers: headers(token) });
    if (!Array.isArray(result.data)) throw new Error("GitHub issues response was invalid");
    for (const item of result.data) {
      const issue = issueRecord(item);
      if (issue && !issue.pull_request && issueBodyHasMarker(issue, marker)) return issue;
    }
    const fallback =
      result.data.length >= 100 ? `${base}/issues?state=open&per_page=100&page=${page + 1}` : null;
    pageUrl = nextPage(result.response, base, fallback);
  }
  if (pageUrl) throw new Error("GitHub open issue pagination limit reached");
  return null;
}

async function pinIssue(
  transport: typeof globalThis.fetch,
  token: string,
  nodeId: string,
): Promise<void> {
  const result = await requestJson(transport, "https://api.github.com/graphql", {
    method: "POST",
    headers: headers(token, true),
    body: JSON.stringify({
      query:
        "mutation PinIssue($input: PinIssueInput!) { pinIssue(input: $input) { issue { id } } }",
      variables: { input: { issueId: nodeId } },
    }),
  });
  const data = object(result.data);
  const mutation = object(data?.data);
  if (!object(mutation?.pinIssue)?.issue) throw new Error("GitHub pin response was invalid");
}

async function bestEffortPin(
  transport: typeof globalThis.fetch,
  token: string,
  nodeId: string | null,
): Promise<string | null> {
  if (!nodeId) return "Dashboard issue was updated, but pinning was unavailable.";
  try {
    await pinIssue(transport, token, nodeId);
    return null;
  } catch {
    return "Dashboard issue was updated, but pinning failed.";
  }
}

export async function publishGithubReport(
  run: Run,
  options: PublishGithubOptions,
): Promise<PublishGithubResult> {
  const { owner, name, repo } = parseRepository(options.repo);
  const selectedIssue = options.issue;
  if (selectedIssue !== "new" && issueNumber(selectedIssue) === null) {
    throw new Error("Issue must be new or a positive integer");
  }
  const token = options.token?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GITHUB_TOKEN is required for GitHub publication");
  const transport = options.fetch ?? globalThis.fetch;
  if (!transport) throw new Error("GitHub fetch transport is unavailable");

  const body = renderGithubReport(run, options.history ?? []);
  const marker = reportMarker(run);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let existing: GithubObject | null;
  if (selectedIssue === "new") {
    existing = await findOpenIssue(transport, token, base, marker);
  } else {
    const number = selectedIssue;
    const result = await requestJson(transport, `${base}/issues/${number}`, {
      headers: headers(token),
    });
    existing = issueRecord(result.data);
    if (!existing || !issueBodyHasMarker(existing, marker)) {
      throw new Error("GitHub issue does not contain the Jev Checkup marker");
    }
  }

  let number: number;
  let nodeId: string | null = null;
  if (existing) {
    if (existing.pull_request) throw new Error("GitHub issue target is a pull request");
    const existingNumber = issueNumber(existing.number);
    if (!existingNumber) throw new Error("GitHub issue response was invalid");
    number = existingNumber;
    nodeId =
      typeof existing.node_id === "string" && existing.node_id.length > 0 ? existing.node_id : null;
  } else {
    const result = await requestJson(transport, `${base}/issues`, {
      method: "POST",
      headers: headers(token, true),
      body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
    const created = issueRecord(result.data);
    const createdNumber = issueNumber(created?.number);
    if (!created || !createdNumber) throw new Error("GitHub create issue response was invalid");
    number = createdNumber;
    nodeId =
      typeof created.node_id === "string" && created.node_id.length > 0 ? created.node_id : null;
  }

  const updated = await updateIssue(transport, token, base, repo, number, body);
  nodeId = updated.nodeId ?? nodeId;
  const warnings: string[] = [];
  const pinWarning = await bestEffortPin(transport, token, nodeId);
  if (pinWarning) warnings.push(pinWarning);
  return {
    url: updated.url,
    warnings,
  };
}

export { reportMarker as githubReportMarker };
