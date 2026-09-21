import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHistoryBranch, saveHistoryBranch } from "../src/action/history.js";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
async function repo(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), "jev-action-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"),
    cwd = join(root, "repo"),
    history = join(root, "history");
  await mkdir(cwd);
  await mkdir(history);
  git(root, "init", "--bare", remote);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  await writeFile(join(cwd, "source.ts"), "private source");
  git(cwd, "add", "source.ts");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "main");
  return { root, cwd, history };
}
test("history is durable on a separate branch and never stages source or changes the checkout", async (t) => {
  const { root, cwd, history } = await repo(t);
  const before = git(cwd, "rev-parse", "HEAD");
  const head = await loadHistoryBranch(cwd, "jev-checkup-history", history);
  assert.equal(head, null);
  await writeFile(join(history, "run-1.json"), '{"run":{"id":"run-1"}}\n');
  await saveHistoryBranch(cwd, "jev-checkup-history", history, head);
  assert.equal(git(cwd, "rev-parse", "HEAD"), before);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.deepEqual(
    git(cwd, "ls-tree", "-r", "--name-only", "refs/remotes/origin/jev-checkup-history").split("\n"),
    ["jev-checkup-history.json", "runs/run-1.json"],
  );
  const restored = join(root, "restored");
  await mkdir(restored);
  assert.ok(await loadHistoryBranch(cwd, "jev-checkup-history", restored));
  assert.equal(await readFile(join(restored, "run-1.json"), "utf8"), '{"run":{"id":"run-1"}}\n');
  await assert.rejects(loadHistoryBranch(cwd, "main", join(root, "unsafe")), /dedicated history/);
});

test("concurrent history writes fail without overwriting prior runs", async (t) => {
  const { root, cwd, history } = await repo(t);
  await loadHistoryBranch(cwd, "jev-checkup-history", history);
  await writeFile(join(history, "run-1.json"), "original\n");
  await saveHistoryBranch(cwd, "jev-checkup-history", history, null);
  const other = join(root, "other");
  const head = await loadHistoryBranch(cwd, "jev-checkup-history", other);
  await writeFile(join(history, "run-2.json"), "second");
  await saveHistoryBranch(cwd, "jev-checkup-history", history, head);
  const latest = git(cwd, "rev-parse", "refs/remotes/origin/jev-checkup-history");
  await writeFile(join(other, "run-3.json"), "third");
  await assert.rejects(
    saveHistoryBranch(cwd, "jev-checkup-history", other, head),
    /History Git operation failed/,
  );
  assert.equal(git(cwd, "rev-parse", "refs/remotes/origin/jev-checkup-history"), latest);
  await writeFile(join(history, "run-1.json"), "altered");
  await assert.rejects(saveHistoryBranch(cwd, "jev-checkup-history", history, latest), /immutable/);
});
