import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const marker = "jev-checkup-history.json";
const markerBody = '{"schema":1,"kind":"jev-checkup-history"}\n';
const runName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/;
function git(
  cwd: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
  raw = false,
): string {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      input,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return raw ? output : output.trimEnd();
  } catch {
    throw new Error("History Git operation failed; check branch access and concurrent updates");
  }
}
function validateBranch(cwd: string, branch: string): void {
  if (!branch || branch.startsWith("-") || branch === "HEAD")
    throw new Error("Invalid history branch");
  git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
}
/** Fetch only a marked history branch; never check out or execute its content. */
export async function loadHistoryBranch(
  cwd: string,
  branch: string,
  directory: string,
): Promise<string | null> {
  validateBranch(cwd, branch);
  const result = spawnSync(
    "git",
    ["-C", cwd, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 2) {
    await mkdir(directory, { recursive: true });
    return null;
  }
  if (result.status !== 0) throw new Error("Could not discover history branch");
  const head = result.stdout.split(/\s/)[0]!;
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid history branch revision");
  git(cwd, ["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
  // Read the advertised revision, not a different branch that changed FETCH_HEAD.
  const paths = git(cwd, ["ls-tree", "-r", "--name-only", head]).split("\n");
  if (
    !paths.includes(marker) ||
    paths.some((p) => p !== marker && (!p.startsWith("runs/") || !runName.test(p.slice(5))))
  )
    throw new Error("Refusing a branch that is not a dedicated history branch");
  if (git(cwd, ["show", `${head}:${marker}`]) !== markerBody.trimEnd())
    throw new Error("Refusing an unrecognized dedicated history branch");
  await mkdir(directory, { recursive: true });
  for (const path of paths.filter((p) => p.startsWith("runs/"))) {
    await writeFile(
      join(directory, path.slice(5)),
      git(cwd, ["show", `${head}:${path}`], undefined, undefined, true),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
  return head;
}
/** Commit only immutable run files using a private index, then perform a non-force push. */
export async function saveHistoryBranch(
  cwd: string,
  branch: string,
  directory: string,
  head: string | null,
): Promise<void> {
  validateBranch(cwd, branch);
  const temporary = await mkdtemp(join(tmpdir(), "jev-history-index-"));
  const env = {
    GIT_INDEX_FILE: join(temporary, "index"),
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  };
  try {
    git(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"], undefined, env);
    const add = (path: string, body: string) => {
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], body, env);
      git(cwd, ["update-index", "--add", "--cacheinfo", "100644", blob, path], undefined, env);
    };
    add(marker, markerBody);
    const existing = new Set(
      head ? git(cwd, ["ls-tree", "-r", "--name-only", head]).split("\n") : [],
    );
    for (const name of (await readdir(directory)).sort()) {
      if (!runName.test(name)) throw new Error("Unexpected file in history output");
      const body = await readFile(join(directory, name), "utf8");
      const path = `runs/${name}`;
      if (
        existing.has(path) &&
        git(cwd, ["show", `${head}:${path}`], undefined, undefined, true) !== body
      )
        throw new Error("Existing run history is immutable");
      add(path, body);
    }
    const tree = git(cwd, ["write-tree"], undefined, env);
    if (head && tree === git(cwd, ["rev-parse", `${head}^{tree}`])) return;
    const commit = git(
      cwd,
      ["-c", "commit.gpgsign=false", "commit-tree", tree, ...(head ? ["-p", head] : [])],
      "chore: save codebase health history\n",
      env,
    );
    git(cwd, ["push", "origin", `${commit}:refs/heads/${branch}`]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
