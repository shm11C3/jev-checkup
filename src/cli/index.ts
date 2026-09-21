#!/usr/bin/env node
import type { Plan, Run } from "../types.js";
import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { loadConfig } from "../config/index.js";
import { getAspectDefinitions } from "../aspects/index.js";
import { selectTargets } from "../select/index.js";
import { createPlan } from "../plan/index.js";
import { observe, type JudgeClient } from "../observe/index.js";
import { deriveRun, mergeAspectRuns } from "../derive/index.js";
import { renderBrief, renderReport } from "../report/index.js";
import { renderGithubReport, publishGithubReport } from "../report/github.js";
import { readHistory, readLabels, readRun, writeRun } from "./storage.js";
import { VERSION } from "../shared/version.js";

const HELP = `jev-checkup — provisional codebase health observations

Source code is sent to TypeSafe AI during scan. run.json and briefs contain code.
Run from your repository (or a subdirectory); paths select the scan scope.

  jev-checkup scan [paths...] [--config file] [--dry-run]
      [--state-dir dir] [--out run.json] [--history dir] [--labels labels.jsonl]
  jev-checkup report run.json [--format terminal|markdown|github] [--issue new|N] [--repo owner/name] [--history dir]
  jev-checkup brief run.json [--top N]

scan reads .jev-checkup.yml at the repository root when present.
Credentials: TYPESAFE_API_KEY for scans; GITHUB_TOKEN for issue publication.
Dry-run, report and brief never call Jev. Cached scans need no API key.
Naming is opt-in via configuration aspects. GitHub issue publication requires --issue.
Cost limits and static aspects are not supported.
`;

export interface CliEnvironment {
  cwd?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  apiKey?: string | null;
  signal?: AbortSignal;
  client?: JudgeClient;
  now?: () => Date;
  githubToken?: string | null;
  githubRepository?: string;
  summaryPath?: string | null;
  fetch?: typeof globalThis.fetch;
}

function git(root: string, args: string[]): string | null {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

export async function runCli(args: string[], env: CliEnvironment = {}): Promise<number> {
  const stdout = env.stdout ?? (value => process.stdout.write(value));
  const stderr = env.stderr ?? (value => process.stderr.write(value));
  const cwd = resolve(env.cwd ?? process.cwd());
  const apiKey = env.apiKey === null ? undefined : env.apiKey ?? process.env.TYPESAFE_API_KEY;
  const githubToken = env.githubToken === null ? undefined : env.githubToken ?? process.env.GITHUB_TOKEN;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      "dry-run": { type: "boolean" },
      config: { type: "string" },
      "state-dir": { type: "string" },
      out: { type: "string" },
      history: { type: "string" },
      labels: { type: "string" },
      format: { type: "string" },
      top: { type: "string" },
      issue: { type: "string" },
      repo: { type: "string" },
    } });
    if (values.help || args.length === 0) { stdout(HELP); return 0; }
    if (values.version) { stdout(`${VERSION}\n`); return 0; }
    const command = positionals[0];
    const allowed: Record<string, string[]> = {
      scan: ["dry-run", "config", "state-dir", "out", "history", "labels"],
      report: ["format", "history", "issue", "repo"], brief: ["top"],
    };
    if (!command || !allowed[command]) throw new Error("Expected scan, report or brief; use --help");
    if (Object.keys(values).some(k => !allowed[command]!.includes(k))) throw new Error(`Unsupported option for ${command}`);
    if (command !== "scan") {
      if (positionals.length !== 2) throw new Error(`${command} needs exactly one run.json path`);
      const run = await readRun(resolve(cwd, positionals[1]!));
      if (command === "brief") {
        const top = values.top === undefined ? 10 : Number(values.top);
        stdout(renderBrief(run, top));
      } else {
        const format = values.format ?? "terminal";
        if (!["terminal", "markdown", "github"].includes(format)) throw new Error("Report format must be terminal, markdown or github");
        if (format !== "github" && (values.issue || values.repo)) throw new Error("Issue publication requires --format github");
        const history = await readHistory(values.history ? resolve(cwd, values.history) : undefined);
        if (format === "github") {
          const issue = values.issue === "new" ? "new" : values.issue === undefined ? undefined : Number(values.issue);
          if (issue !== undefined && issue !== "new" && (!Number.isSafeInteger(issue) || issue < 1)) throw new Error("Issue must be new or a positive integer");
          const body = renderGithubReport(run, history);
          const summary = env.summaryPath === null ? undefined : env.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
          if (summary) await appendFile(summary, body, "utf8");
          stdout(body);
          if (issue !== undefined) {
            if (!githubToken) throw new Error("GITHUB_TOKEN is required for issue publication");
            const result = await publishGithubReport(run, { repo: values.repo ?? env.githubRepository ?? process.env.GITHUB_REPOSITORY ?? "", issue, token: githubToken, fetch: env.fetch, history });
            stderr(`Updated ${result.url}\n`);
            for (const warning of result.warnings) stderr(`${warning}\n`);
          }
        } else stdout(renderReport(run, format as "terminal" | "markdown", history));
      }
      return 0;
    }
    const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
    const config = await loadConfig(root, values.config ? resolve(cwd, values.config) : undefined);
    const definitions = getAspectDefinitions(config);
    const paths = (positionals.length > 1 ? positionals.slice(1) : ["."]).map(p => relative(root, resolve(cwd, p)).replaceAll("\\", "/") || ".");
    const stateDir = values["state-dir"] ? resolve(cwd, values["state-dir"]) : resolve(root, ".jev-checkup");
    const historyDir = values.history ? resolve(cwd, values.history) : undefined;
    // Validate requested local input before making any network request.
    const labels = await readLabels(values.labels ? resolve(cwd, values.labels) : resolve(stateDir, "labels.jsonl"), !values.labels);
    const history = await readHistory(historyDir);
    const prepared = await Promise.all(definitions.map(async definition => {
      const selection = await selectTargets(root, paths, config, definition);
      const plan = await createPlan(selection.targets, definition, stateDir);
      return { definition, selection, plan };
    }));
    const plan: Plan = { items: prepared.flatMap(p => p.plan.items), requests: 0, cacheHits: 0, unjudgeable: 0 };
    for (const part of prepared) {
      plan.requests += part.plan.requests;
      plan.cacheHits += part.plan.cacheHits;
      plan.unjudgeable += part.plan.unjudgeable;
    }
    const selection = prepared[0]!.selection;
    if (values["dry-run"]) {
      stdout(`${JSON.stringify({
        dryRun: true, model: config.model, aspects: definitions.map(d => d.id),
        repositoryId: selection.scope.repositoryId, scope: selection.scope,
        aspectScopes: prepared.map(p => ({ aspect: p.definition.id, scope: p.selection.scope })),
        targetCount: plan.items.length, requests: plan.requests, cacheHits: plan.cacheHits, unjudgeable: plan.unjudgeable,
        targets: plan.items.map(item => ({
          aspect: item.target.aspect, file: item.target.location.file, title: item.target.target.name,
          contextMode: item.target.contextMode, contextReason: item.target.contextReason,
          sourceFiles: item.target.evidenceSources.map(s => s.file),
          missingQuestions: Object.keys(item.missingQuestions).length,
          blockedReason: item.blockedReason,
        })),
        errors: prepared.flatMap(p => p.selection.errors),
      }, null, 2)}\n`);
      return prepared.some(p => p.selection.errors.length || !p.selection.scope.enumerationComplete) ? 1 : 0;
    }
    const observed = await observe(plan, definitions[0]!, {
      stateDir, apiKey, concurrency: config.concurrency,
      requestsPerMinute: config.requestsPerMinute, tokensPerSecond: config.tokensPerSecond,
      signal: env.signal, client: env.client,
    });
    const metadata: Run["run"] = { id: randomUUID(), at: (env.now?.() ?? new Date()).toISOString(),
      commit: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(git(root, ["status", "--porcelain"])), complete: !env.signal?.aborted };
    const runs = prepared.map(({ definition, selection }) => {
      const fingerprints = new Set(selection.targets.map(target => target.fingerprint));
      return deriveRun({ selection, definition, observations: observed.observations.filter(o => fingerprints.has(o.fingerprint)),
        usage: { requests: 0, inputTokens: 0, cacheHits: 0 }, labels, history, top: config.top, metadata });
    });
    const run = mergeAspectRuns(runs);
    run.usage = { ...observed.usage };
    const output = values.out ? resolve(cwd, values.out) : resolve(stateDir, "run.json");
    const historyPath = historyDir ? resolve(historyDir, `${run.run.id}.json`) : undefined;
    await writeRun(output, run, output === historyPath);
    if (historyPath && historyPath !== output) await writeRun(historyPath, run, true);
    stdout(renderReport(run, "terminal", history));
    stderr(`Saved ${relative(cwd, output) || output}\n`);
    return run.run.complete ? 0 : 1;
  } catch (error) {
    const original = error instanceof Error ? error.message : "Execution failed";
    let redacted = original;
    for (const secret of [apiKey, githubToken]) if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
    stderr(`jev-checkup: ${stripVTControlCharacters(redacted).replace(/[\r\n]/g, " ")}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
