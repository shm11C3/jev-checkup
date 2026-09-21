import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAction } from "../src/action/index.js";

test("pull requests skip before checkout, credentials or CLI execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const summary = join(root, "summary");
  let calls = 0;
  assert.equal(
    await runAction(
      { workspace: root, eventName: "pull_request_target", summaryPath: summary },
      {
        cli: async () => {
          calls++;
          throw new Error("must skip");
        },
      },
    ),
    0,
  );
  assert.equal(calls, 0);
  assert.match(await readFile(summary, "utf8"), /Skipped/);
});

test("an incomplete scan still produces a safe summary and saved run without logging source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs: string[] = [],
    commands: string[][] = [];
  const result = await runAction(
    {
      workspace: root,
      historyBranch: "",
      issue: "",
      summaryPath: join(root, "summary"),
      outputPath: join(root, "outputs"),
    },
    {
      log: (s) => logs.push(s),
      cli: async (args, env) => {
        commands.push(args);
        if (args[0] === "scan") {
          const output = args[args.indexOf("--out") + 1]!;
          await writeFile(output, '{"run":{"complete":false},"source":"private-code"}');
          env?.stdout?.("private-code");
          return 1;
        }
        return 0;
      },
    },
  );
  assert.equal(result, 1);
  assert.deepEqual(commands[1]!.slice(2, 4), ["--format", "github"]);
  assert.ok((await readFile(join(root, ".jev-checkup/run.json"), "utf8")).includes("private-code"));
  assert.ok(!logs.join("").includes("private-code"));
  assert.match(await readFile(join(root, "outputs"), "utf8"), /run-json=/);
});

test("a configuration failure never republishes a stale run artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".jev-checkup"));
  await writeFile(join(root, ".jev-checkup/run.json"), "stale snapshot");
  const calls: string[][] = [];
  const result = await runAction(
    { workspace: root, historyBranch: "" },
    {
      log: () => undefined,
      cli: async (args) => {
        calls.push(args);
        return 2;
      },
    },
  );
  assert.equal(result, 2);
  assert.equal(calls.length, 1);
});
