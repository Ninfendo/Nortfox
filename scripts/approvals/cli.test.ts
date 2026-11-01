// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, ".github/owner-paths.txt"), "# Owner paths\n.github/**\nLICENSE\n");
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

function pr(author: string, labels: string[] = []): Routes[string] {
  return { body: { user: { login: author }, head: { sha: head }, labels: labels.map((name) => ({ name })) } };
}

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

  it("passes a PR that changes no owner path", async () => {
    const result = await run(
      ["owner-ok"],
      { [`GET ${p}/pulls/7`]: pr("owner"), [`GET ${p}/pulls/7/files?per_page=100`]: files(["README.md"]) },
      { NAMES_RESULT: "success", EVENT_ACTION: "opened" },
    );
    expect(result).toMatchObject({ code: 0, out: ["Owner OK: The PR changes no owner path."] });
  });

  it("fails a PR that moves a file out of an owner path, and lists the path", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner"),
        [`GET ${p}/pulls/7/files?per_page=100`]: {
          body: [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" }],
        },
      },
      { NAMES_RESULT: "success", EVENT_ACTION: "opened" },
    );
    expect(result).toMatchObject({
      code: 1,
      out: ["Owner path: .github/workflows/ci.yml"],
      err: ["Owner OK: The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label."],
    });
  });

  it("fails while the names check has not passed, without listing any path", async () => {
    const result = await run(
      ["owner-ok"],
      { [`GET ${p}/pulls/7`]: pr("owner"), [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]) },
      { EVENT_ACTION: "opened" },
    );
    expect(result).toMatchObject({
      code: 1,
      out: [],
      err: ["Owner OK: The names check did not pass (missing). Owner OK waits for it."],
    });
  });

  it("removes the owner-ok label when a push touches an owner path", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner", ["owner-ok"]),
        [`GET ${p}/compare/b1...a1`]: { body: { status: "ahead", files: [{ filename: "LICENSE" }] } },
        [`DELETE ${p}/issues/7/labels/owner-ok`]: { body: [] },
        [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]),
      },
      { NAMES_RESULT: "success", EVENT_ACTION: "synchronize", BEFORE_SHA: "b1", AFTER_SHA: "a1" },
    );
    expect(result.requests).toContain(`DELETE ${p}/issues/7/labels/owner-ok`);
    expect(result).toMatchObject({
      code: 1,
      out: ["Owner OK: the new commits touch owner paths, so the owner-ok label is removed.", "Owner path: LICENSE"],
    });
  });

  it("keeps the label when a push touches no owner path", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner", ["owner-ok"]),
        [`GET ${p}/compare/b1...a1`]: { body: { status: "ahead", files: [{ filename: "README.md" }] } },
        [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE", "README.md"]),
      },
      { NAMES_RESULT: "success", EVENT_ACTION: "synchronize", BEFORE_SHA: "b1", AFTER_SHA: "a1" },
    );
    expect(result.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    expect(result.code).toBe(0);
  });

  it("removes the label after a force push, which the compare cannot read", async () => {
    const result = await run(
      ["owner-ok"],
      {
        [`GET ${p}/pulls/7`]: pr("owner", ["owner-ok"]),
        [`DELETE ${p}/issues/7/labels/owner-ok`]: { status: 404 },
        [`GET ${p}/pulls/7/files?per_page=100`]: files(["LICENSE"]),
      },
      { NAMES_RESULT: "success", EVENT_ACTION: "synchronize", BEFORE_SHA: "b1", AFTER_SHA: "a1" },
    );
    expect(result.code).toBe(1);
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
