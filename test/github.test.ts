import test from "node:test";
import assert from "node:assert/strict";
import {
  githubReportMarker,
  publishGithubReport,
  renderGithubReport,
} from "../src/report/github.js";
import type { Band, ModeCalibration, Run } from "../src/types.js";

const bands: Band[] = ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"];

function calibration(source: ModeCalibration["source"] = "local"): ModeCalibration {
  return {
    source,
    labelsBySource: { human: 2, agent: 1, execution: 0 },
    table: Object.fromEntries(
      bands.map((band) => [
        band,
        {
          valid: band === ">=0.30" ? 2 : 0,
          invalid: band === ">=0.30" ? 1 : 0,
          high: band === ">=0.30" ? 1 : 0,
          prioritized: band === ">=0.30" ? 1 : 0,
          pValid: band === ">=0.30" ? 2 / 3 : null,
          pHigh: band === ">=0.30" ? 1 : null,
        },
      ]),
    ) as ModeCalibration["table"],
  };
}

function fixture(): Run {
  const aspect = {
    id: "test-honesty",
    condition: "condition-abc",
    definition: {},
    calibration: {
      validation: "provisional",
      byContextMode: { focus: calibration(), focusprod: calibration("none") },
    },
    evaluated: 3,
    cannotTell: 1,
    notJudged: 1,
    unjudgeable: 1,
    unevaluated: 1,
    bandsByContextMode: {
      focus: { "0..0.05": 0, "0.05..0.15": 0, "0.15..0.30": 1, ">=0.30": 1 },
      focusprod: { "0..0.05": 0, "0.05..0.15": 0, "0.15..0.30": 0, ">=0.30": 0 },
    },
    open: 1,
    score: 0.4,
    inTotal: true,
    comparison: {
      baselineRun: "old-run",
      new: 1,
      resolved: 2,
      pending: 1,
      scoreDelta: null,
      noiseFloor: null,
    },
  };
  return {
    schema: 1,
    tool: "0.2.0",
    run: {
      id: "run-1",
      at: "2026-09-20T00:00:00.000Z",
      commit: null,
      dirty: false,
      complete: true,
    },
    scope: {
      repositoryId: "owner/repo",
      id: "scope-1",
      paths: ["src"],
      include: ["**/*.ts"],
      exclude: ["**/node_modules/**"],
      languages: ["typescript"],
      selectionPolicy: "files@1",
      enumerationComplete: true,
      files: [
        { file: "src/<bad>.ts", status: "parsed" },
        { file: "src/skipped.ts", status: "skipped", reason: "unsupported" },
        { file: "src/error.ts", status: "error", reason: "parse failed" },
      ],
    },
    aspects: [aspect],
    targets: [
      {
        fingerprint: "f1",
        aspect: "test-honesty",
        location: { file: "src/<bad>.ts", startLine: 10, endLine: 12 },
        target: { path: ["secret"], name: "SECRET_TARGET_NAME" },
        contextMode: "focus",
        inputHash: "input-1",
        subjectRevision: "revision-1",
        controls: { own: "available", sibling: "not_available" },
        outcome: "finding",
        suspicion: 0.876,
        signal: 0.376,
        band: ">=0.30",
      },
    ],
    findings: [
      {
        fingerprint: "f1",
        aspect: "test-honesty",
        status: "new",
        rank: 1,
        evidence: {
          inputHash: "input-1",
          answers: { q: { type: "noul", noul: 0.9 } },
          suspicion: 0.876,
          signal: 0.376,
          band: ">=0.30",
          pValid: 2 / 3,
          pHigh: 1,
        },
        labelTemplate: {
          fingerprint: "f1",
          propositionVersion: "v1",
          subjectRevision: "revision-1",
          evidenceSources: [{ file: "src/<bad>.ts", hash: "hash" }],
        },
        label: null,
      },
    ],
    snapshots: {
      "input-1": {
        state: { source: "secret source" },
        questions: { q: { type: "noul", instructions: "literal question" } },
      },
    },
    topFindings: { "test-honesty": ["f1"] },
    resolved: [],
    pendingComparisons: [],
    total: { score: 0.4, aspects: 1, weights: { "test-honesty": 1 } },
    unmeasured: {
      skippedFiles: 2,
      missRate: null,
      populationPrecisionAtN: null,
      selectionErrors: ["private note"],
    },
    usage: { requests: 3, inputTokens: 900, cacheHits: 1 },
  } as unknown as Run;
}

test("renders a bounded source-free GitHub summary", () => {
  const report = renderGithubReport(fixture());
  assert.match(
    report,
    new RegExp(githubReportMarker(fixture()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.ok(!report.includes("owner/repo"));
  assert.match(report, /INCOMPLETE|complete/);
  assert.match(report, /condition-abc/);
  assert.match(report, /Calibration/);
  assert.match(report, /src\/&lt;bad&gt;\.ts:10-12/);
  assert.match(report, /0\.876/);
  assert.match(report, /parsed 1/);
  assert.match(report, /skipped 1/);
  assert.match(report, /errors 1/);
  assert.ok(!report.includes("SECRET_TARGET_NAME"));
  assert.ok(!report.includes("secret source"));
  assert.ok(!report.includes("literal question"));
  assert.ok(!report.includes('"noul"'));
  assert.ok(!report.includes("private note"));
  assert.ok(report.length < 65_536);
});

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function callMethod(call: { init?: RequestInit }): string {
  return call.init?.method ?? "GET";
}

test("publishes a new dashboard by creating, updating, and pinning an issue", async () => {
  const run = fixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse([]),
    jsonResponse({
      number: 7,
      node_id: "I_7",
      html_url: "https://test-token@github.com/other/repo/issues/99",
    }),
    jsonResponse({
      number: 7,
      node_id: "I_7",
      html_url: "https://test-token@github.com/other/repo/issues/99",
    }),
    jsonResponse({ data: { pinIssue: { issue: { id: "I_7" } } } }),
  ];
  const transport: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fake request");
    return response;
  };

  const result = await publishGithubReport(run, {
    repo: "owner/repo",
    issue: "new",
    token: "test-token",
    fetch: transport,
  });

  assert.equal(result.url, "https://github.com/owner/repo/issues/7");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.map(callMethod), ["GET", "POST", "PATCH", "POST"]);
  assert.match(calls[0]!.url, /\/issues\?state=open&per_page=100&page=1$/);
  assert.match(calls[3]!.url, /\/graphql$/);
  for (const call of calls) {
    const requestHeaders = call.init?.headers as Record<string, string>;
    assert.equal(requestHeaders.Authorization, "Bearer test-token");
    assert.equal(call.init?.redirect, "error");
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
  const create = JSON.parse(String(calls[1]!.init?.body)) as { title: string; body: string };
  assert.equal(create.title, "Jev Checkup dashboard");
  assert.ok(create.body.includes(githubReportMarker(run)));
  assert.ok(!create.body.includes("SECRET_TARGET_NAME"));
});

test("searches all open-issue pages and updates only the matching dashboard", async () => {
  const run = fixture();
  const marker = githubReportMarker(run);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    body: "other issue",
  }));
  pageOne[0] = {
    number: 1,
    body: marker,
    pull_request: { url: "https://github.com/owner/repo/pull/1" },
  } as (typeof pageOne)[number];
  const responses = [
    jsonResponse(pageOne, 200, {
      link: '<https://api.github.com/repos/owner/repo/issues?state=open&per_page=100&page=2>; rel="next"',
    }),
    jsonResponse([
      {
        number: 19,
        node_id: "I_19",
        body: marker,
        html_url: "https://github.com/owner/repo/issues/19",
      },
    ]),
    jsonResponse({
      number: 19,
      node_id: "I_19",
      html_url: "https://github.com/owner/repo/issues/19",
    }),
    jsonResponse({ data: { pinIssue: { issue: { id: "I_19" } } } }),
  ];
  const transport: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fake request");
    return response;
  };

  const result = await publishGithubReport(run, {
    repo: "owner/repo",
    issue: "new",
    token: "token",
    fetch: transport,
  });

  assert.equal(result.url, "https://github.com/owner/repo/issues/19");
  assert.deepEqual(calls.map(callMethod), ["GET", "GET", "PATCH", "POST"]);
  assert.match(calls[1]!.url, /page=2$/);
  assert.equal(
    calls.filter((call) => call.init?.method === "POST" && call.url.endsWith("/issues")).length,
    0,
  );
});

test("requires the matching marker before overwriting a supplied issue", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ number: 12, body: "a different issue" });
  };

  await assert.rejects(
    publishGithubReport(fixture(), {
      repo: "owner/repo",
      issue: 12,
      token: "secret-token",
      fetch: transport,
    }),
    (error) =>
      error instanceof Error &&
      error.message === "GitHub issue does not contain the Jev Checkup marker",
  );
  assert.equal(calls.length, 1);
});

test("rejects a supplied pull request even when it carries the dashboard marker", async () => {
  const run = fixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      number: 12,
      body: githubReportMarker(run),
      pull_request: { url: "https://github.com/owner/repo/pull/12" },
    });
  };

  await assert.rejects(
    publishGithubReport(run, { repo: "owner/repo", issue: 12, token: "token", fetch: transport }),
    (error) => error instanceof Error && error.message === "GitHub issue target is a pull request",
  );
  assert.equal(calls.length, 1);
});

test("does not follow an untrusted pagination link", async () => {
  const run = fixture();
  const marker = githubReportMarker(run);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    body: "other issue",
  }));
  const responses = [
    jsonResponse(pageOne, 200, { link: '<https://evil.example/steal?page=2>; rel="next"' }),
    jsonResponse([{ number: 13, node_id: "I_13", body: marker }]),
    jsonResponse({ number: 13, node_id: "I_13" }),
    jsonResponse({ data: { pinIssue: { issue: { id: "I_13" } } } }),
  ];
  const transport: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fake request");
    return response;
  };

  await publishGithubReport(run, {
    repo: "owner/repo",
    issue: "new",
    token: "token",
    fetch: transport,
  });

  assert.match(calls[1]!.url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/issues\?/);
  assert.ok(!calls.some((call) => call.url.startsWith("https://evil.example/")));
});

test("stops paginated searches before creating a duplicate issue", async () => {
  let requests = 0;
  const transport: typeof globalThis.fetch = async () => {
    requests++;
    const page = requests + 1;
    const body = Array.from({ length: 100 }, (_, index) => ({
      number: page * 100 + index,
      body: "other issue",
    }));
    return jsonResponse(body, 200, {
      link: `<https://api.github.com/repos/owner/repo/issues?state=open&per_page=100&page=${page}>; rel="next"`,
    });
  };

  await assert.rejects(
    publishGithubReport(fixture(), {
      repo: "owner/repo",
      issue: "new",
      token: "token",
      fetch: transport,
    }),
    (error) =>
      error instanceof Error && error.message === "GitHub open issue pagination limit reached",
  );
  assert.equal(requests, 100);
});

test("returns a sanitized warning when pinning fails after update", async () => {
  const responses = [
    jsonResponse([]),
    jsonResponse({ number: 8, node_id: "I_8", html_url: "https://github.com/owner/repo/issues/8" }),
    jsonResponse({ number: 8, node_id: "I_8", html_url: "https://github.com/owner/repo/issues/8" }),
    new Response("private token body", { status: 403 }),
  ];
  const transport: typeof globalThis.fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fake request");
    return response;
  };

  const result = await publishGithubReport(fixture(), {
    repo: "owner/repo",
    issue: "new",
    token: "secret-token",
    fetch: transport,
  });

  assert.equal(result.url, "https://github.com/owner/repo/issues/8");
  assert.deepEqual(result.warnings, ["Dashboard issue was updated, but pinning failed."]);
});

test("sanitizes transport failures and never echoes the token or response body", async () => {
  const transport: typeof globalThis.fetch = async () => {
    throw new Error("secret-token response body");
  };

  await assert.rejects(
    publishGithubReport(fixture(), {
      repo: "owner/repo",
      issue: "new",
      token: "secret-token",
      fetch: transport,
    }),
    (error) =>
      error instanceof Error &&
      !error.message.includes("secret-token") &&
      !error.message.includes("response body"),
  );
});

test("bounds a response body that stalls after headers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCleared = false;
  let clearedBeforeBody: boolean | undefined;
  let fireTimeout: (() => void) | undefined;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
    fireTimeout = () => callback();
    return undefined as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {
    timeoutCleared = true;
  }) as typeof clearTimeout;
  try {
    const transport: typeof globalThis.fetch = async (_input, init) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            clearedBeforeBody = timeoutCleared;
            const abort = () => reject(new Error("secret response body"));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
            queueMicrotask(() => fireTimeout?.());
          }),
      }) as Response;

    await assert.rejects(
      publishGithubReport(fixture(), {
        repo: "owner/repo",
        issue: "new",
        token: "token",
        fetch: transport,
      }),
      (error) => error instanceof Error && error.message === "GitHub request returned invalid JSON",
    );
    assert.equal(clearedBeforeBody, false);
    assert.equal(timeoutCleared, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("shows only compatible completed history counts for each aspect", () => {
  const current = fixture();
  const previous = fixture();
  previous.run.id = "previous";
  previous.run.at = "2026-09-19T00:00:00.000Z";
  const future = fixture();
  future.run.id = "future";
  future.run.at = "2026-09-21T00:00:00.000Z";
  const differentCondition = fixture();
  differentCondition.run.id = "different-condition";
  differentCondition.run.at = "2026-09-18T00:00:00.000Z";
  differentCondition.aspects[0]!.condition = "other-condition";

  const report = renderGithubReport(current, [previous, future, differentCondition]);

  assert.match(report, /2026-09-19T00:00:00\.000Z test-honesty: open 1/);
  assert.ok(!report.includes("2026-09-21T00:00:00.000Z"));
  assert.ok(!report.includes("2026-09-18T00:00:00.000Z"));
  assert.ok(!report.includes("score 0.400"));
});
