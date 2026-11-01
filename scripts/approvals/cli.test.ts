// SPDX-License-Identifier: AGPL-3.0-only

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub, type Routes } from "../testing/fake-github.ts";
import { main, type Io } from "./cli.ts";

const p = "/repos/o/r";
const head = "c".repeat(40);
const servers: FakeGitHub[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function baseCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "nortfox-approvals-"));
  folders.push(dir);
  mkdirSync(join(dir, ".github"));
  // The repository's own list, as the workflow reads it from the default branch.
  copyFileSync(new URL("../../.github/owner-paths.txt", import.meta.url), join(dir, ".github/owner-paths.txt"));
  return dir;
}

async function run(
  command: string[],
  routes: Routes,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[]; requests: string[] }> {
  const server = await startFakeGitHub(routes);
  servers.push(server);
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: baseCheckout(),
    env: {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_API_URL: server.url,
      PR_NUMBER: "7",
      OWNER_LOGIN: "owner",
      ...env,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: () => Promise.resolve(),
  };
  const code = await main(command, io);
  return { code, out, err, requests: server.requests };
}

function pr(author: string, labels: string[] = [], baseRef = "main"): Routes[string] {
  return {
    body: {
      user: { login: author },
      head: { sha: head, ref: "feature/x", repo: { full_name: "o/r" } },
      base: { ref: baseRef, repo: { default_branch: "main" } },
      labels: labels.map((name) => ({ name })),
    },
  };
}

describe("every command", () => {
  it.each(["outside-approval", "owner-ok", "names-mirror"])("%s fails a PR that is not aimed at the default branch", async (command) => {
    const result = await run([command], { [`GET ${p}/pulls/7`]: pr("owner", [], "feature/base") }, { NAMES_RESULT: "success" });
    expect(result).toMatchObject({
      code: 1,
      err: ["Failed: The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch."],
    });
  });
});

describe("outside-approval", () => {
  it("passes the owner's own PR", async () => {
    const result = await run(["outside-approval"], {
      [`GET ${p}/pulls/7`]: pr("owner"),
      [`GET ${p}/pulls/7/reviews?per_page=100`]: { body: [] },
    });
    expect(result).toMatchObject({ code: 0, out: ["Outside approval: The PR comes from the owner's account."] });
  });

  it("passes another author's PR only with the owner's approval of the head commit", async () => {
    const reviews = (commit: string) => ({
      body: [{ user: { login: "owner" }, state: "APPROVED", commit_id: commit }],
    });
    const approved = await run(["outside-approval"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [`GET ${p}/pulls/7/reviews?per_page=100`]: reviews(head),
    });
    expect(approved.code).toBe(0);
    const stale = await run(["outside-approval"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [`GET ${p}/pulls/7/reviews?per_page=100`]: reviews("d".repeat(40)),
    });
    expect(stale).toMatchObject({
      code: 1,
      err: ["Outside approval: The owner approved an earlier commit. The new commits need the owner's approval too."],
    });
  });

  it("needs OWNER_LOGIN", async () => {
    const result = await run(["outside-approval"], {}, { OWNER_LOGIN: "" });
    expect(result).toMatchObject({ code: 1, err: ["Failed: OWNER_LOGIN must be set."] });
  });
});

describe("owner-ok", () => {
  const files = (names: string[]) => ({ body: names.map((filename) => ({ filename })) });
  const events = `GET ${p}/issues/7/events?per_page=100`;
  const activity = `GET ${p}/activity?ref=refs%2Fheads%2Ffeature%2Fx&direction=desc&per_page=10`;
  const remove = `DELETE ${p}/issues/7/labels/owner-ok`;
  const labelled = (actor: string, at: string) => ({
    body: [
      { event: "labeled", actor: { login: "owner" }, created_at: "2026-11-01T09:00:00Z", label: { name: "owner-ok" } },
      { event: "unlabeled", actor: { login: "owner" }, created_at: "2026-11-01T09:10:00Z", label: { name: "owner-ok" } },
      { event: "labeled", actor: { login: actor }, created_at: at, label: { name: "owner-ok" } },
      { event: "labeled", actor: { login: "owner" }, created_at: "2026-11-01T12:00:00Z", label: { name: "other" } },
    ],
  });
  /** The branch history, newest first: the last push left the branch at `after`. */
  const pushes = (after: string, at: string) => ({
    body: [
      { ref: "refs/heads/feature/x", after: "b".repeat(40), timestamp: "2026-11-01T08:00:00Z", activity_type: "push" },
      { ref: "refs/heads/feature/x", after, timestamp: at, activity_type: "push" },
      { ref: "refs/heads/other", after: "e".repeat(40), timestamp: "2026-11-01T23:00:00Z", activity_type: "push" },
    ],
  });
  const ownerPathPr = (routes: Routes): Routes => ({
    [`GET ${p}/pulls/7`]: pr("owner", ["owner-ok"]),
    [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE", "README.md"]),
    [remove]: { body: [] },
    ...routes,
  });
  const env = { NAMES_RESULT: "success" };

  it("passes a PR that changes no owner path, such as the workflows and the checks", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner"),
        [`GET ${p}/pulls/7/files?per_page=100`]: files([
          "README.md",
          ".github/workflows/approvals.yml",
          "scripts/approvals/cli.ts",
          "package.json",
        ]),
      },
      env,
    );
    expect(result).toMatchObject({ code: 0, out: ["Owner OK: The PR changes no owner path."] });
  });

  it("fails a PR that moves a file out of an owner path, and lists the path", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner"),
        [`GET ${p}/pulls/7/files?per_page=100`]: {
          body: [{ filename: "db/0001_start.sql", previous_filename: "db/migrations/0001_start.sql" }],
        },
      },
      env,
    );
    expect(result).toMatchObject({
      code: 1,
      out: ["Owner path: db/migrations/0001_start.sql"],
      err: ["Owner OK: The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label."],
    });
  });

  it("fails while the names check has not passed, without listing any path", async () => {
    const result = await run(
      ["owner-ok"],
      { [`GET ${p}/pulls/7`]: pr("owner"), [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]) },
      {},
    );
    expect(result).toMatchObject({
      code: 1,
      out: [],
      err: ["Owner OK: The names check did not pass (missing). Owner OK waits for it."],
    });
  });

  it("passes owner paths when the owner set the label after the last push, which is the head commit", async () => {
    const result = await run(
      ["owner-ok"],
      ownerPathPr({ [events]: labelled("owner", "2026-11-01T10:00:01Z"), [activity]: pushes(head, "2026-11-01T10:00:00Z") }),
      env,
    );
    expect(result.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    expect(result).toMatchObject({
      code: 0,
      out: ["Owner path: LICENSE", "Owner OK: The PR changes owner paths, and the owner set the owner-ok label."],
    });
  });

  it("removes a label set before the last push, on whatever event it runs", async () => {
    // A push while the PR was closed sends no synchronize event; the reopen
    // run, or any later one, still finds the push.
    const result = await run(
      ["owner-ok"],
      ownerPathPr({ [events]: labelled("owner", "2026-11-01T10:00:00Z"), [activity]: pushes(head, "2026-11-01T11:00:00Z") }),
      { ...env, EVENT_ACTION: "reopened" },
    );
    expect(result.requests).toContain(remove);
    expect(result).toMatchObject({
      code: 1,
      out: [
        "Owner OK: The owner-ok label was set before the last push to the PR's branch. It counts only for the head commit it was set on. The owner-ok label is removed.",
        "Owner path: LICENSE",
      ],
      err: ["Owner OK: The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label."],
    });
  });

  it("removes a label that another account set", async () => {
    const result = await run(
      ["owner-ok"],
      ownerPathPr({ [events]: labelled("someone", "2026-11-01T10:00:01Z"), [activity]: pushes(head, "2026-11-01T10:00:00Z") }),
      env,
    );
    expect(result.requests).toContain(remove);
    expect(result.code).toBe(1);
  });

  it("removes the label when the branch's last push is not the head commit", async () => {
    const result = await run(
      ["owner-ok"],
      ownerPathPr({
        [events]: labelled("owner", "2026-11-01T10:00:01Z"),
        [activity]: pushes("f".repeat(40), "2026-11-01T10:00:00Z"),
      }),
      env,
    );
    expect(result.requests).toContain(remove);
    expect(result.code).toBe(1);
  });

  it.each([
    ["the issue events", { [events]: { status: 502 } }],
    ["the branch history", { [events]: labelled("owner", "2026-11-01T10:00:01Z"), [activity]: { status: 503 } }],
  ])("removes the label and fails when GitHub cannot give %s", async (_what, routes) => {
    const result = await run(["owner-ok"], ownerPathPr(routes), env);
    expect(result.requests).toContain(remove);
    expect(result.code).toBe(1);
    expect(result.out[0]).toMatch(
      /^Owner OK: Owner OK could not read when the label was set and when the PR's branch last moved \(GitHub answered 50[23] to GET .+\)\. The owner-ok label is removed\.$/,
    );
  });

  it("fails when the label cannot be removed", async () => {
    const result = await run(
      ["owner-ok"],
      ownerPathPr({ [events]: { body: [] }, [remove]: { status: 403 } }),
      env,
    );
    expect(result).toMatchObject({ code: 1, err: [`Failed: GitHub answered 403 to DELETE ${p}/issues/7/labels/owner-ok.`] });
  });
});

describe("names-mirror", () => {
  const checkRuns = `GET ${p}/commits/${head}/check-runs?check_name=Names&filter=all&per_page=100`;
  const suite = (id: number) => `GET ${p}/actions/runs?check_suite_id=${String(id)}&event=pull_request_target&per_page=1`;
  const fromTarget = { body: { workflow_runs: [{ event: "pull_request_target" }] } };
  const fromReview = { body: { workflow_runs: [] } };

  it("repeats the latest full check on the head commit", async () => {
    const result = await run(["names-mirror"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [checkRuns]: {
        body: {
          check_runs: [
            { status: "completed", conclusion: "failure", completed_at: "2026-11-01T10:00:00Z", check_suite: { id: 1 } },
            { status: "completed", conclusion: "success", completed_at: "2026-11-01T11:00:00Z", check_suite: { id: 2 } },
            { status: "completed", conclusion: "failure", completed_at: "2026-11-01T12:00:00Z", check_suite: { id: 3 } },
          ],
        },
      },
      [suite(1)]: fromTarget,
      [suite(2)]: fromTarget,
      [suite(3)]: fromReview,
    });
    expect(result).toMatchObject({ code: 0, out: ["Names: the last full check on this commit ended in success."] });
  });

  it("fails when the latest full check failed", async () => {
    const result = await run(["names-mirror"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [checkRuns]: {
        body: {
          check_runs: [
            { status: "completed", conclusion: "success", completed_at: "2026-11-01T10:00:00Z", check_suite: { id: 1 } },
            { status: "completed", conclusion: "failure", completed_at: "2026-11-01T11:00:00Z", check_suite: { id: 2 } },
          ],
        },
      },
      [suite(1)]: fromTarget,
      [suite(2)]: fromTarget,
    });
    expect(result.code).toBe(1);
  });

  it("waits for a full check that still runs", async () => {
    let calls = 0;
    const result = await run(["names-mirror"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [checkRuns]: () => {
        calls += 1;
        return {
          body: {
            check_runs: [
              calls === 1
                ? { status: "in_progress", check_suite: { id: 1 } }
                : { status: "completed", conclusion: "success", completed_at: "2026-11-01T10:00:00Z", check_suite: { id: 1 } },
            ],
          },
        };
      },
      [suite(1)]: fromTarget,
    });
    expect(calls).toBe(2);
    expect(result.code).toBe(0);
  });

  it("gives up after waiting too long", async () => {
    const result = await run(["names-mirror"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [checkRuns]: { body: { check_runs: [{ status: "queued", check_suite: { id: 1 } }] } },
      [suite(1)]: fromTarget,
    });
    expect(result).toMatchObject({ code: 1, err: ["Names: the full check on this commit did not finish in time."] });
  });

  it("fails when no full check ran yet", async () => {
    const result = await run(["names-mirror"], {
      [`GET ${p}/pulls/7`]: pr("someone"),
      [checkRuns]: { body: { check_runs: [] } },
    });
    expect(result).toMatchObject({
      code: 1,
      err: ["Names: no full check has run on this commit yet. Its own run will report."],
    });
  });
});

describe("the command line", () => {
  it.each([[[]], [["nope"]], [["owner-ok", "extra"]]])("refuses %j", async (args) => {
    const result = await run(args, {});
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe("Usage: node scripts/approvals/cli.ts outside-approval | owner-ok | names-mirror");
  });

  it("fails when GitHub fails", async () => {
    const result = await run(["outside-approval"], { [`GET ${p}/pulls/7`]: { status: 500 } });
    expect(result).toMatchObject({ code: 1, err: ["Failed: GitHub answered 500 to GET /repos/o/r/pulls/7."] });
  });
});
