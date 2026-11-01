// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub } from "../testing/fake-github.ts";
import { createTestRepo, FAKE_LIST, FAKE_WORDS, type TestRepo } from "../testing/repo.ts";
import { main, type Io } from "./cli.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** Every planted form of the fake words, one file each. */
const PLANTED: Readonly<Record<string, string>> = {
  "case.md": "Read the ZarQuon notes.\n",
  "confusable.md": "fine\nzаrquоn\n",
  "leet.md": "z4rqu0n\n",
  "spaced.md": "z a r q u o n\n",
  "base64.txt": `${base64("about blirvex")}\n`,
  "entities.html": "<p>&#122;arquon</p>\n",
};

const repos: TestRepo[] = [];
const servers: FakeGitHub[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) {
    repo.remove();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function repo(): TestRepo {
  const created = createTestRepo();
  repos.push(created);
  return created;
}

async function run(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; stdin?: string },
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: options.cwd,
    env: options.env ?? { PROTECTED_NAMES: FAKE_LIST },
    stdin: () => options.stdin ?? "",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const code = await main(args, io);
  return { code, out, err };
}

function expectNoWord(lines: readonly string[]): void {
  const text = lines.join("\n").toLowerCase();
  for (const word of FAKE_WORDS) {
    expect(text).not.toContain(word);
  }
  for (const planted of Object.values(PLANTED)) {
    expect(text).not.toContain(planted.trim().toLowerCase());
  }
}

describe("--all", () => {
  it("finds a planted word in each form, in contents and in a path, and the last commit", async () => {
    const r = repo();
    for (const [path, text] of Object.entries(PLANTED)) {
      r.write(`docs/${path}`, text);
    }
    r.write("docs/clean.md", "Nothing here.\n");
    r.write("notes/zarquon-plan.md", "Nothing here either.\n");
    r.commitAll("Add the b1irvex notes");

    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "names: docs/base64.txt:1 holds a protected name.",
      "names: docs/case.md:1 holds a protected name.",
      "names: docs/confusable.md:2 holds a protected name.",
      "names: docs/entities.html:1 holds a protected name.",
      "names: docs/leet.md:1 holds a protected name.",
      "names: docs/spaced.md:1 holds a protected name.",
      "names: tracked file 8 (git ls-files) (its path) holds a protected name.",
      expect.stringMatching(/^names: commit [0-9a-f]{7} holds a protected name\.$/),
      "names: checked 8 files and 3 texts; 8 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
    expectNoWord([...result.out, ...result.err]);
  });

  it("checks who wrote and who committed the last commit", async () => {
    const r = repo();
    r.write("README.md", "An accounting system.\n");
    r.git("add", "--all");
    r.git("-c", "user.name=Ann Blirvex", "commit", "--quiet", "-m", "Start");
    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err.slice(0, 2)).toEqual([
      expect.stringMatching(/^names: commit [0-9a-f]{7} author holds a protected name\.$/),
      expect.stringMatching(/^names: commit [0-9a-f]{7} committer holds a protected name\.$/),
    ]);
    expectNoWord([...result.out, ...result.err]);
  });

  it("passes a clean repository", async () => {
    const r = repo();
    r.write("README.md", "An accounting system.\n");
    r.commitAll("Start");
    const result = await run(["--all"], { cwd: r.dir });
    expect(result).toEqual({ code: 0, out: ["names: checked 1 files and 3 texts. Nothing found."], err: [] });
  });

  it("refuses a binary file", async () => {
    const r = repo();
    r.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    r.commitAll("Add a logo");
    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err[0]).toBe("names: logo.png is a binary file of a type the names check cannot read yet.");
  });

  it("skips the contents of a tracked file that is gone from the working tree", async () => {
    const r = repo();
    r.write("gone.md", "zarquon\n");
    r.commitAll("Add");
    rmSync(join(r.dir, "gone.md"));
    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(0);
  });

  it("reads a folder in the index, such as a submodule, by its path only", async () => {
    const r = repo();
    r.write("sub/zarquon.md", "fine\n");
    r.write("a.md", "fine\n");
    r.git("add", "a.md");
    r.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
    r.git("commit", "--quiet", "-m", "Add a submodule");
    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(0);
  });
});

describe("the marker", () => {
  function adapterRepo(): TestRepo {
    const r = repo();
    r.write("adapters/a1/.protected-name-ok", "");
    r.write("adapters/a1/notes.md", "This adapter reads from zarquon.\n");
    r.write(".github/protected-name-allowlist.txt", "# The marker allowlist\n");
    r.commitAll("Start");
    return r;
  }

  it("outside the allowlist, fails the check and silences nothing", async () => {
    const r = adapterRepo();
    const result = await run(["--all", "--base", "HEAD"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "names: adapters/a1/.protected-name-ok is a .protected-name-ok marker outside the marker allowlist.",
    );
    expect(result.err).toContain("names: adapters/a1/notes.md:1 holds a protected name.");
  });

  it("counts the allowlist of the base branch, not of the working tree", async () => {
    const r = adapterRepo();
    r.write(".github/protected-name-allowlist.txt", "adapters/a1\n");
    r.commitAll("Allowlist the adapter on this branch");
    const result = await run(["--all", "--base", "HEAD~1"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err).toContain("names: adapters/a1/notes.md:1 holds a protected name.");
  });

  it("in an allowlisted folder on the base branch, lets the folder name the system", async () => {
    const r = adapterRepo();
    r.write(".github/protected-name-allowlist.txt", "adapters/a1\n");
    r.commitAll("Allowlist the adapter");
    const result = await run(["--all", "--base", "HEAD"], { cwd: r.dir });
    expect(result).toMatchObject({ code: 0, err: [] });
  });

  it("treats a base that does not exist as an empty allowlist", async () => {
    const r = adapterRepo();
    const result = await run(["--all"], { cwd: r.dir });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("outside the marker allowlist");
  });
});

describe("--staged", () => {
  it("checks the staged contents and the branch name", async () => {
    const r = repo();
    r.write("a.md", "fine\n");
    r.commitAll("Start");
    r.git("checkout", "--quiet", "-b", "feature/zarquon");
    r.write("a.md", "fine\nblirvex\n");
    r.write("b.md", "fine\n");
    r.git("add", "a.md");
    r.write("a.md", "fine\n");

    const result = await run(["--staged"], { cwd: r.dir });
    expect(result.err).toEqual([
      "names: a.md:2 holds a protected name.",
      "names: branch name holds a protected name.",
      "names: checked 1 files and 3 texts; 2 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
    expect(result.code).toBe(1);
  });

  it("checks the name and e-mail address the next commit will carry", async () => {
    const r = repo();
    r.write("a.md", "fine\n");
    r.commitAll("Start");
    r.git("config", "user.email", "ann@zarquon.example");
    r.write("a.md", "still fine\n");
    r.git("add", "a.md");
    const result = await run(["--staged"], { cwd: r.dir });
    expect(result.err).toEqual([
      "names: author (git var GIT_AUTHOR_IDENT) holds a protected name.",
      "names: committer (git var GIT_COMMITTER_IDENT) holds a protected name.",
      "names: checked 1 files and 3 texts; 2 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
  });

  it("works on a detached head, without a branch name", async () => {
    const r = repo();
    r.write("a.md", "fine\n");
    r.commitAll("Start");
    r.git("checkout", "--quiet", "--detach");
    const result = await run(["--staged"], { cwd: r.dir });
    expect(result).toEqual({ code: 0, out: ["names: checked 0 files and 2 texts. Nothing found."], err: [] });
  });
});

describe("--text", () => {
  it("checks standard input under its label", async () => {
    const r = repo();
    const result = await run(["--text", "--label", "commit message"], {
      cwd: r.dir,
      stdin: "Add the ledger\n\nIt reads from Z4RQU0N.\n",
    });
    expect(result.code).toBe(1);
    expect(result.err[0]).toBe("names: commit message line 3 holds a protected name.");
  });

  it("passes clean text", async () => {
    const r = repo();
    const result = await run(["--text"], { cwd: r.dir, stdin: "Add the ledger" });
    expect(result.code).toBe(0);
  });
});

describe("the word list", () => {
  it("is required in CI", async () => {
    const r = repo();
    const result = await run(["--text"], { cwd: r.dir, env: { GITHUB_ACTIONS: "true", PROTECTED_NAMES: "" } });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "names: the protected names list is missing. CI reads it from the PROTECTED_NAMES secret, and the check never passes without it.",
    ]);
  });

  it("is optional on a laptop, with a one-line note", async () => {
    const r = repo();
    const result = await run(["--all"], {
      cwd: r.dir,
      env: { NORTFOX_PROTECTED_NAMES_FILE: `${r.dir}/no-such-file.txt` },
    });
    expect(result).toEqual({
      code: 0,
      out: ["names: no protected names list on this machine, so the check is skipped here. CI runs it on every pull request."],
      err: [],
    });
  });

  it("is read from the local file", async () => {
    const r = repo();
    r.write("list.txt", FAKE_LIST);
    const result = await run(["--text"], {
      cwd: r.dir,
      env: { NORTFOX_PROTECTED_NAMES_FILE: `${r.dir}/list.txt` },
      stdin: "zarquon",
    });
    expect(result.code).toBe(1);
  });

  it("fails on an entry too short to check", async () => {
    const r = repo();
    const result = await run(["--text"], { cwd: r.dir, env: { PROTECTED_NAMES: "ab" } });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["names: Entry 1 of the protected names list is too short to check once folded."],
    });
  });
});

describe("arguments", () => {
  it.each([
    [[], "names: Choose a mode."],
    [["--all", "--text"], "names: Choose one mode."],
    [["--all", "--nope"], 'names: Unknown argument "--nope".'],
    [["--all", "--base"], "names: --base needs a value."],
    [["--text", "--label", "--all"], "names: --label needs a value."],
  ])("refuses %j", async (args, message) => {
    const result = await run(args, { cwd: "." });
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe(message);
  });

  it("reports a source that cannot be read", async () => {
    const result = await run(["--all"], { cwd: `${repo().dir}/missing-folder` });
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/^names: could not read what to check: git /);
  });
});

describe("--pr", () => {
  const p = "/repos/o/r";
  const head = "h".repeat(40);
  const person = (name: string) => ({ name, email: `${name.toLowerCase()}@example.invalid` });

  async function fakeApi(pr: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<FakeGitHub> {
    const server = await startFakeGitHub({
      [`GET ${p}/pulls/7`]: {
        body: {
          number: 7,
          title: "Add the zarquon import",
          body: "Line one\n\nb1irvex",
          user: { login: "owner" },
          head: { sha: head, ref: "feature/x" },
          base: { ref: "main", repo: { default_branch: "main" } },
          changed_files: 4,
          commits: 2,
          ...pr,
        },
      },
      [`GET ${p}/pulls/7/files?per_page=100`]: {
        body: [{ filename: "docs/a.md", status: "added", sha: "blob1" }],
        headers: { link: `<{base}/other>; rel="last", <{base}${p}/pulls/7/files?page=2>; rel="next"` },
      },
      [`GET ${p}/pulls/7/files?page=2`]: {
        body: [
          { filename: "docs/old.md", status: "removed", sha: "blob2" },
          { filename: "vendor/sub", status: "added", sha: null },
          { filename: "adapters/a1/.protected-name-ok", status: "added", sha: "blob3" },
          { filename: "adapters/a2/notes.md", status: "modified", sha: "blob4" },
        ],
      },
      [`GET ${p}/git/blobs/blob1`]: { body: { content: Buffer.from("fine\nzarquon\n").toString("base64") } },
      [`GET ${p}/git/blobs/blob3`]: { body: { content: "" } },
      [`GET ${p}/git/blobs/blob4`]: { body: { content: Buffer.from("reads zarquon").toString("base64") } },
      [`GET ${p}/pulls/7/commits?per_page=100`]: {
        body: [
          { sha: "a".repeat(40), commit: { message: "Start", author: person("Ann"), committer: person("Ann") } },
          {
            sha: "b".repeat(40),
            commit: { message: "Add\n\nAbout zarquon", author: person("Blirvex"), committer: { name: "Ann" } },
          },
        ],
      },
      [`GET ${p}/pulls/7/reviews?per_page=100`]: { body: [] },
      ...extra,
    });
    servers.push(server);
    return server;
  }

  function prEnv(server: FakeGitHub): Record<string, string> {
    return {
      PROTECTED_NAMES: FAKE_LIST,
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_API_URL: server.url,
      PR_NUMBER: "7",
      OWNER_LOGIN: "owner",
    };
  }

  function baseCheckout(allowlist: string): TestRepo {
    const r = repo();
    r.write(".github/protected-name-allowlist.txt", allowlist);
    r.commitAll("Base");
    return r;
  }

  it("checks the files, paths, title, body, branch, and each commit's message, author and committer", async () => {
    const server = await fakeApi({});
    const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "names: adapters/a1/.protected-name-ok is a .protected-name-ok marker outside the marker allowlist.",
      "names: docs/a.md:2 holds a protected name.",
      "names: vendor/sub has contents the names check cannot get, such as a submodule.",
      "names: adapters/a2/notes.md:1 holds a protected name.",
      "names: PR title holds a protected name.",
      "names: PR body line 3 holds a protected name.",
      "names: commit bbbbbbb line 3 holds a protected name.",
      "names: commit bbbbbbb author holds a protected name.",
      "names: checked 4 files and 9 texts; 8 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
    expect(server.requests).not.toContain(`GET ${p}/git/blobs/blob2`);
    expect(server.requests).not.toContain(`GET ${p}/pulls/7/reviews?per_page=100`);
  });

  it("finds a name wrapped across two lines of the body", async () => {
    const server = await fakeApi(
      { title: "Fine", body: "We read the files of Zar\nquon, one by one." },
      { [`GET ${p}/pulls/7/commits?per_page=100`]: { body: [] }, [`GET ${p}/git/blobs/blob1`]: { body: { content: "" } } },
    );
    const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
    expect(result.err).toContain("names: PR body line 1 holds a protected name.");
  });

  it("finds a name in a title shaped like an integrity digest", async () => {
    const server = await fakeApi(
      { title: "Add the sha1-ZarquonImportAdapterForSIE", body: null },
      { [`GET ${p}/pulls/7/commits?per_page=100`]: { body: [] }, [`GET ${p}/git/blobs/blob1`]: { body: { content: "" } } },
    );
    const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
    expect(result.err).toContain("names: PR title holds a protected name.");
  });

  it("honours a marker that the head commit has in an allowlisted folder", async () => {
    const server = await fakeApi(
      { title: "Add an import", body: null },
      {
        [`GET ${p}/contents/adapters/a2/.protected-name-ok?ref=${head}`]: { body: { type: "file" } },
        [`GET ${p}/pulls/7/commits?per_page=100`]: { body: [] },
        [`GET ${p}/git/blobs/blob1`]: { body: { content: "" } },
      },
    );
    const result = await run(["--pr"], { cwd: baseCheckout("adapters/a2\nadapters/a3\n").dir, env: prEnv(server) });
    expect(result.err).toEqual([
      "names: adapters/a1/.protected-name-ok is a .protected-name-ok marker outside the marker allowlist.",
      "names: vendor/sub has contents the names check cannot get, such as a submodule.",
      "names: checked 4 files and 3 texts; 2 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
    expect(server.requests).toContain(`GET ${p}/contents/adapters/a3/.protected-name-ok?ref=${head}`);
  });

  describe("from outside the owner's account", () => {
    const outside = { user: { login: "someone" } };
    const approval = (commit: string) => ({
      [`GET ${p}/pulls/7/reviews?per_page=100`]: {
        body: [{ user: { login: "owner" }, state: "APPROVED", commit_id: commit }],
      },
    });

    it("waits for the owner's approval of the head commit, and reads nothing before it", async () => {
      for (const extra of [{}, approval("e".repeat(40))]) {
        const server = await fakeApi(outside, extra);
        const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
        expect(result).toEqual({
          code: 1,
          out: [],
          err: [
            "names: The PR comes from outside the owner's account, so the check reads it only once the owner has approved its head commit. After approving, run this check again.",
          ],
        });
        expect(server.requests.some((request) => request.includes("/files") || request.includes("/blobs/"))).toBe(false);
      }
    });

    it("once approved, says how many places it found, but never where", async () => {
      const server = await fakeApi(outside, approval(head));
      const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
      expect(result).toEqual({
        code: 1,
        out: [],
        err: [
          "names: checked 4 files and 9 texts; 8 to fix. For a PR from outside the owner's account the check does not say where. The owner finds the places with the list.",
        ],
      });
    });

    it("once approved, passes a clean PR", async () => {
      const server = await fakeApi(
        { ...outside, title: "Fine", body: null },
        {
          ...approval(head),
          [`GET ${p}/pulls/7/files?per_page=100`]: { body: [{ filename: "docs/a.md", status: "added", sha: "blob1" }] },
          [`GET ${p}/git/blobs/blob1`]: { body: { content: "" } },
          [`GET ${p}/pulls/7/commits?per_page=100`]: { body: [] },
        },
      );
      const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
      expect(result).toEqual({ code: 0, out: ["names: checked 1 files and 3 texts. Nothing found."], err: [] });
    });
  });

  it.each([
    [{ changed_files: 3001 }, "The PR changes more than 3000 files; the API cannot list them all. Split it."],
    [{ commits: 251 }, "The PR has more than 250 commits; the API cannot list them all. Squash or split it."],
    [
      { base: { ref: "feature/base", repo: { default_branch: "main" } } },
      "The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch.",
    ],
  ])("refuses a PR it cannot judge: %j", async (pr, message) => {
    const server = await fakeApi(pr);
    const result = await run(["--pr"], { cwd: baseCheckout("").dir, env: prEnv(server) });
    expect(result).toEqual({ code: 1, out: [], err: [`names: could not read what to check: ${message}`] });
  });

  it("needs the pull request settings", async () => {
    const env = { PROTECTED_NAMES: FAKE_LIST, OWNER_LOGIN: "owner" };
    const result = await run(["--pr"], { cwd: baseCheckout("").dir, env });
    expect(result.err).toEqual([
      "names: could not read what to check: GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER must be set.",
    ]);
    const noOwner = await run(["--pr"], { cwd: baseCheckout("").dir, env: { PROTECTED_NAMES: FAKE_LIST } });
    expect(noOwner.err).toEqual(["names: could not read what to check: OWNER_LOGIN must be set."]);
  });
});

describe("the command line", () => {
  it("never prints a word it found, nor the line it found it on", () => {
    const r = repo();
    for (const [path, text] of Object.entries(PLANTED)) {
      r.write(path, text);
    }
    r.commitAll("Plant the words");
    const env = { ...process.env, PROTECTED_NAMES: FAKE_LIST, GITHUB_ACTIONS: "", CI: "" };
    const result = spawnSync(process.execPath, [CLI, "--all"], { cwd: r.dir, env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names: case.md:1 holds a protected name.");
    expectNoWord([result.stdout, result.stderr]);
  });
});
