import { appendFile, copyFile, mkdir, mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { runCli } from "../cli/index.js";
import { loadHistoryBranch, saveHistoryBranch } from "./history.js";

export interface ActionOptions {
  workspace: string;
  eventName?: string;
  paths?: string;
  config?: string;
  stateDir?: string;
  historyBranch?: string;
  issue?: string;
  repository?: string;
  summaryPath?: string;
  outputPath?: string;
}
export async function runAction(
  options: ActionOptions,
  dependencies: { cli?: typeof runCli; log?: (message: string) => void } = {},
): Promise<number> {
  const log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
  if (options.eventName?.startsWith("pull_request")) {
    const message =
      "Skipped: pull request events are not scanned or published by the scheduled dashboard Action.\n";
    if (options.summaryPath) await appendFile(options.summaryPath, message);
    log(message.trim());
    return 0;
  }
  const cli = dependencies.cli ?? (await import("../cli/index.js")).runCli;
  const temporary = await mkdtemp(join(tmpdir(), "jev-action-"));
  const history = join(temporary, "history"),
    output = join(temporary, "run.json");
  try {
    const workspace = resolve(options.workspace);
    const state = resolve(workspace, options.stateDir || ".jev-checkup");
    if (/[\r\n]/.test(state)) throw new Error("Invalid state path");
    const branch = options.historyBranch ?? "jev-checkup-history";
    const head = branch ? await loadHistoryBranch(workspace, branch, history) : null;
    await mkdir(history, { recursive: true });
    const args = [
      "scan",
      ...(options.paths || ".")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      "--state-dir",
      state,
      "--out",
      output,
      "--history",
      history,
    ];
    if (options.config) args.push("--config", options.config);
    const env = {
      cwd: workspace,
      stdout: (_value: string) => undefined,
      stderr: log,
      summaryPath: options.summaryPath,
    };
    const scanExit = await cli(args, env);
    try {
      await access(output);
    } catch {
      return scanExit || 2;
    }
    const saved = join(state, "run.json");
    await mkdir(dirname(saved), { recursive: true });
    await copyFile(output, saved);
    if (options.outputPath) await appendFile(options.outputPath, `run-json=${saved}\n`);
    const reportArgs = ["report", output, "--format", "github", "--history", history];
    if (options.issue) reportArgs.push("--issue", options.issue);
    if (options.repository) reportArgs.push("--repo", options.repository);
    const reportExit = await cli(reportArgs, env);
    if (branch) await saveHistoryBranch(workspace, branch, history, head);
    return scanExit || reportExit;
  } catch {
    log(
      "Dashboard action failed; inspect the CLI result and history branch permissions or concurrent updates.",
    );
    return 2;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runAction({
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    paths: process.env.JEV_PATHS,
    config: process.env.JEV_CONFIG,
    stateDir: process.env.JEV_STATE_DIR,
    historyBranch: process.env.JEV_HISTORY_BRANCH,
    issue: process.env.JEV_ISSUE,
    repository: process.env.GITHUB_REPOSITORY,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
    outputPath: process.env.GITHUB_OUTPUT,
  });
}
