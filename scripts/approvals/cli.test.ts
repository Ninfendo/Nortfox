// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The repository's own list, as the workflow reads it from the default branch. It is empty. */
const OWN_LIST = readFileSync(new URL("../../.github/owner-paths.txt", import.meta.url), "utf8");

/** A sample list, not the repository's, for the tests that need an owner path. */
const SAMPLE_LIST = "# A sample list\n\n**/LICENSE*\n";

/** A checkout of the default branch, with `ownerPaths` as its owner path list. */
function baseCheckout(ownerPaths: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nortfox-approvals-"));
  folders.push(dir);
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github/owner-paths.txt"), ownerPaths);
  return dir;
}

async function run(
  command: string[],
  routes: Routes,
  env: Record<string, string> = {},
  ownerPaths: string = OWN_LIST,
): Promise<{ code: number; out: string[]; err: string[]; requests: string[] }> {
  const server = await startFakeGitHub(routes);
  servers.push(server);
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: baseCheckout(ownerPaths),
    env: {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_API_URL: server.url,
      PR_NUMBER: "7",
      OWNER_LOGIN: "owner",
      HEAD_SHA: head,
      ...env,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const code = await main(command, io);
  return { code, out, err, requests: server.requests };
}

/** The PR as the API gives it. `changed` is how many files it changes. */
function prData(author: string, labels: string[] = [], baseRef = "main", changed = 1): Record<string, unknown> {
  return {
    title: "Add the ledger",
    body: null,
    user: { login: author },
    head: { sha: head, ref: "feature/x", repo: { full_name: "o/r", owner: { login: "o" } } },
    base: { ref: baseRef, repo: { default_branch: "main" } },
    labels: labels.map((name) => ({ name })),
    changed_files: changed,
  };
}

function pr(author: string, labels: string[] = [], baseRef = "main", changed = 1): Routes[string] {
  return { body: prData(author, labels, baseRef, changed) };
}

describe("every command", () => {
  it.each(["outside-approval", "owner-ok"])("%s fails a PR that is not aimed at the default branch", async (command) => {
    const result = await run([command], { [`GET ${p}/pulls/7`]: pr("owner", [], "feature/base") }, { NAMES_RESULT: "success" });
    expect(result).toMatchObject({
      code: 1,
      err: ["Failed: The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch."],
    });
  });

  it.each(["outside-approval", "owner-ok"])("%s fails when the PR's head is not the commit the event names", async (command) => {
    const result = await run([command], { [`GET ${p}/pulls/7`]: pr("owner") }, { NAMES_RESULT: "success", HEAD_SHA: "d".repeat(40) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        "Failed: The PR's head commit is not the one this run was started for. The run for its new head commit checks it.",
      ],
      requests: [`GET ${p}/pulls/7`],
    });
  });

  it.each(["outside-approval", "owner-ok"])("%s needs HEAD_SHA", async (command) => {
    const result = await run([command], {}, { HEAD_SHA: "" });
    expect(result).toMatchObject({ code: 1, err: ["Failed: HEAD_SHA must be set."], requests: [] });
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

  it("fails a PR that the owner opened from a branch in another account's fork", async () => {
    const data = { ...prData("owner"), head: { sha: head, ref: "feature/x", repo: { full_name: "someone/r", owner: { login: "someone" } } } };
    const result = await run(["outside-approval"], {
      [`GET ${p}/pulls/7`]: { body: data },
      [`GET ${p}/pulls/7/reviews?per_page=100`]: { body: [] },
    });
    expect(result).toMatchObject({
      code: 1,
      err: [
        "Outside approval: The owner opened this PR from a branch in another account's fork, and that account can push to it. So it needs the owner's approval of its head commit, which GitHub does not let the owner give to their own PR. To take the work over, make the changes again as new commits on your own machine, where the git hooks check them, run pnpm names, and push those commits to a branch in this repository. Never push that account's commits or branch here: on a PR from the owner's account, Names shows where it finds a name, also in text that the other account wrote.",
      ],
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
    [`GET ${p}/pulls/7`]: pr("owner", ["owner-ok"], "main", 2),
    [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE", "README.md"]),
    [remove]: { body: [] },
    ...routes,
  });
  const env = { NAMES_RESULT: "success" };

  it("passes a PR that changes no owner path, such as the workflows and the checks", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner", [], "main", 4),
        [`GET ${p}/pulls/7/files?per_page=100`]: files([
          "README.md",
          ".github/workflows/approvals.yml",
          "scripts/approvals/cli.ts",
          "package.json",
        ]),
      },
      env,
      SAMPLE_LIST,
    );
    expect(result).toMatchObject({ code: 0, out: ["Owner OK: The PR changes no owner path."] });
  });

  it("fails a PR that moves a file out of an owner path, and lists the path", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner"),
        [`GET ${p}/pulls/7/files?per_page=100`]: {
          body: [{ filename: "docs/terms.md", previous_filename: "LICENSE" }],
        },
      },
      env,
      SAMPLE_LIST,
    );
    expect(result).toMatchObject({
      code: 1,
      out: ["Owner path: LICENSE"],
      err: ["Owner OK: The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label."],
    });
  });

  it("passes on Names alone while the repository's list is empty, also a PR that changes a licence or a marker", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner", [], "main", 5),
        [`GET ${p}/pulls/7/files?per_page=100`]: files([
          "LICENSE",
          "packages/client/LICENSE",
          "adapters/a1/.protected-name-ok",
          ".github/owner-paths.txt",
          "db/migrations/0001_start.sql",
        ]),
      },
      env,
    );
    expect(result).toEqual({
      code: 0,
      out: ["Owner OK: The PR changes no owner path."],
      err: [],
      requests: [`GET ${p}/pulls/7`, `GET ${p}/pulls/7/files?per_page=100`, `GET ${p}/pulls/7`],
    });
  });

  it("still removes an owner-ok label that does not count while the repository's list is empty", async () => {
    const result = await run(
      ["owner-ok"],
      ownerPathPr({ [events]: labelled("someone", "2026-11-01T10:00:01Z"), [activity]: pushes(head, "2026-11-01T10:00:00Z") }),
      env,
    );
    expect(result.requests).toContain(remove);
    expect(result).toMatchObject({
      code: 0,
      out: [
        "Owner OK: The owner-ok label was set by an account that is not the owner's. The owner-ok label is removed.",
        "Owner OK: The PR changes no owner path.",
      ],
    });
  });

  it("fails while the names check has not passed, without listing any path", async () => {
    const result = await run(
      ["owner-ok"],
      { [`GET ${p}/pulls/7`]: pr("owner"), [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]) },
      {},
      SAMPLE_LIST,
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
      SAMPLE_LIST,
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
      SAMPLE_LIST,
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
      SAMPLE_LIST,
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
      SAMPLE_LIST,
    );
    expect(result.requests).toContain(remove);
    expect(result.code).toBe(1);
  });

  it.each([
    ["the issue events", { [events]: { status: 502 } }],
    ["the branch history", { [events]: labelled("owner", "2026-11-01T10:00:01Z"), [activity]: { status: 503 } }],
  ])("removes the label and fails when GitHub cannot give %s", async (_what, routes) => {
    const result = await run(["owner-ok"], ownerPathPr(routes), env, SAMPLE_LIST);
    expect(result.requests).toContain(remove);
    expect(result.code).toBe(1);
    expect(result.out[0]).toMatch(
      /^Owner OK: Owner OK could not read when the label was set and when the PR's branch last moved \(GitHub answered 50[23] to GET .+\)\. The owner-ok label is removed\.$/,
    );
  });

  it("fails a PR with more files than GitHub lists, without listing them", async () => {
    const result = await run(["owner-ok"], { [`GET ${p}/pulls/7`]: pr("owner", [], "main", 3001) }, env);
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["Owner OK: The PR changes more than 3000 files, and GitHub lists only 3000. Split it."],
      requests: [`GET ${p}/pulls/7`],
    });
  });

  it("fails when GitHub lists another number of files than the PR changes", async () => {
    const result = await run(
      ["owner-ok"],
      { [`GET ${p}/pulls/7`]: pr("owner", [], "main", 3), [`GET ${p}/pulls/7/files?per_page=100`]: files(["README.md"]) },
      env,
    );
    expect(result).toMatchObject({
      code: 1,
      out: [],
      err: ["Owner OK: GitHub listed 1 changed files, but the PR changes 3. Run the check again."],
    });
  });

  it("fails, and lists no path, when the PR's head commit moved while it read the files", async () => {
    let reads = 0;
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: () => {
          reads += 1;
          const data = prData("owner");
          return { body: reads === 1 ? data : { ...data, head: { sha: "d".repeat(40), ref: "feature/x" } } };
        },
        [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]),
      },
      env,
      SAMPLE_LIST,
    );
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["Failed: The PR changed while the check read it, so this run gives no result. The run for that change checks it."],
      requests: [`GET ${p}/pulls/7`, `GET ${p}/pulls/7/files?per_page=100`, `GET ${p}/pulls/7`],
    });
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

describe("the command line", () => {
  it.each([[[]], [["nope"]], [["owner-ok", "extra"]]])("refuses %j", async (args) => {
    const result = await run(args, {});
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe("Usage: node scripts/approvals/cli.ts outside-approval | owner-ok");
  });

  it("fails when GitHub fails", async () => {
    const result = await run(["outside-approval"], { [`GET ${p}/pulls/7`]: { status: 500 } });
    expect(result).toMatchObject({ code: 1, err: ["Failed: GitHub answered 500 to GET /repos/o/r/pulls/7."] });
  });
});
