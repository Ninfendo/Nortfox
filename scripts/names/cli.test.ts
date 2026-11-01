// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeAnswer, type FakeGitHub, type Routes } from "../testing/fake-github.ts";
import { createTestRepo, FAKE_LIST, FAKE_WORDS, type TestRepo } from "../testing/repo.ts";
import { main, WAITING, type Io } from "./cli.ts";

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
  /** Repositories that several tests read and none changes, removed after the last test. */
  const kept: TestRepo[] = [];

  afterAll(() => {
    for (const r of kept.splice(0)) {
      r.remove();
    }
  });

  interface Pr {
    /** The repository the PR lives in. */
    readonly origin: TestRepo;
    /** The default branch's checkout, with its history, as the workflow makes it. */
    readonly checkout: TestRepo;
    /** The PR's head commit. Only origin has it. */
    readonly head: string;
  }

  /**
   * A default branch with an empty marker allowlist, a checkout of it, and a
   * PR on top of it that only origin has, under refs/pull/7/head as GitHub
   * keeps it.
   */
  function pullRequest(
    build: (origin: TestRepo) => void,
    options: { readonly base?: (origin: TestRepo) => void; readonly keep?: boolean } = {},
  ): Pr {
    const owned = options.keep === true ? kept : repos;
    const origin = createTestRepo();
    owned.push(origin);
    origin.write(".github/protected-name-allowlist.txt", "");
    origin.write("docs/old.md", "Gone in the PR: zarquon\n");
    options.base?.(origin);
    origin.commitAll("Base");
    const checkout = createTestRepo({ origin });
    owned.push(checkout);
    origin.git("checkout", "--quiet", "-b", "feature/x");
    build(origin);
    const head = origin.git("rev-parse", "HEAD").trim();
    origin.git("update-ref", "refs/pull/7/head", head);
    origin.git("checkout", "--quiet", "main");
    origin.git("branch", "--quiet", "-D", "feature/x");
    return { origin, checkout, head };
  }

  /** A PR with a planted name in each place it can hide, a removed file and a submodule. */
  function plantEverything(origin: TestRepo): void {
    origin.git("rm", "--quiet", "docs/old.md");
    origin.write("docs/a.md", "fine\nzarquon\n");
    origin.write("adapters/a1/.protected-name-ok", "");
    origin.write("adapters/a2/notes.md", "reads zarquon");
    origin.commitAll("Start");
    origin.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
    origin.git("commit", "--quiet", "--author=Blirvex <blirvex@example.invalid>", "-m", "Add\n\nAbout zarquon");
  }

  function plantNothing(origin: TestRepo): void {
    origin.write("docs/a.md", "fine\n");
    origin.commitAll("Start");
  }

  let planted: Pr | undefined;
  let clean: Pr | undefined;
  /** The PR with every planted name, made once. */
  const everything = (): Pr => (planted ??= pullRequest(plantEverything, { keep: true }));
  /** A clean PR with one file and one commit, made once. */
  const nothing = (): Pr => (clean ??= pullRequest(plantNothing, { keep: true }));

  /** The PR as the API gives it. */
  function prData(head: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 7,
      title: "Add the zarquon import",
      body: "Line one\n\nb1irvex",
      state: "open",
      user: { login: "owner" },
      head: { sha: head, ref: "feature/x" },
      base: { ref: "main", repo: { default_branch: "main" } },
      ...overrides,
    };
  }

  /** The API. Each read of the PR gives the next of `reads`, and the last one from then on. */
  async function fakeApi(reads: readonly FakeAnswer[], extra: Routes = {}, number = 7): Promise<FakeGitHub> {
    let calls = 0;
    const server = await startFakeGitHub({
      [`GET ${p}/pulls/${String(number)}`]: () => {
        const answer = reads[Math.min(calls, reads.length - 1)] ?? { status: 500 };
        calls += 1;
        return answer;
      },
      [`GET ${p}/pulls/${String(number)}/reviews?per_page=100`]: { body: [] },
      ...extra,
    });
    servers.push(server);
    return server;
  }

  function prEnv(
    server: FakeGitHub,
    head: string,
    extra: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      PROTECTED_NAMES: FAKE_LIST,
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_API_URL: server.url,
      PR_NUMBER: "7",
      OWNER_LOGIN: "owner",
      HEAD_SHA: head,
      TRIGGERING_ACTOR: "owner",
      ...extra,
    };
  }

  const MOVED = "names: The PR changed while the check read it, so this run gives no result. The run for that change checks it.";
  const read = `GET ${p}/pulls/7`;

  it("checks the files at the head commit, their paths, the markers, the title, the body, the squash commit message, the branch and each commit", async () => {
    const pr = everything();
    const server = await fakeApi([{ body: prData(pr.head) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    const commit = pr.head.slice(0, 7);
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        "names: adapters/a1/.protected-name-ok is a .protected-name-ok marker outside the marker allowlist.",
        "names: adapters/a2/notes.md:1 holds a protected name.",
        "names: docs/a.md:2 holds a protected name.",
        "names: vendor/sub has contents the names check cannot get, such as a submodule.",
        "names: PR title holds a protected name.",
        "names: PR body line 3 holds a protected name.",
        "names: PR title and body line 1 holds a protected name.",
        "names: PR title and body line 5 holds a protected name.",
        "names: squash commit message line 1 holds a protected name.",
        "names: squash commit message line 5 holds a protected name.",
        `names: commit ${commit} line 3 holds a protected name.`,
        `names: commit ${commit} author holds a protected name.`,
        "names: checked 4 files and 11 texts; 12 to fix. The check never shows what it found. Reword the text at each place.",
      ],
    });
    // The PR is read at the start and at the end. Its files and commits come from git, at no cost in requests.
    expect(server.requests).toEqual([read, read]);
    expectNoWord([...result.out, ...result.err]);
  });

  it("reads the head commit that the event names, never a newer commit on the PR's branch", async () => {
    const pr = pullRequest(plantNothing);
    pr.origin.git("checkout", "--quiet", "-b", "later", pr.head);
    pr.origin.write("docs/a.md", "zarquon\n");
    pr.origin.commitAll("About zarquon");
    pr.origin.git("update-ref", "refs/pull/7/head", "HEAD");
    pr.origin.git("checkout", "--quiet", "main");
    const server = await fakeApi([{ body: prData(pr.head, { title: "Fine", body: null }) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result).toEqual({ code: 0, out: ["names: checked 1 files and 8 texts. Nothing found."], err: [] });
  });

  it.each([
    ["head commit", (data: Record<string, unknown>) => ({ ...data, head: { sha: "f".repeat(40), ref: "feature/x" } })],
    ["branch", (data: Record<string, unknown>) => ({ ...data, head: { ...(data["head"] as object), ref: "feature/y" } })],
    ["title", (data: Record<string, unknown>) => ({ ...data, title: "Add the import" })],
    ["body", (data: Record<string, unknown>) => ({ ...data, body: "Line one" })],
    ["base", (data: Record<string, unknown>) => ({ ...data, base: { ref: "next", repo: { default_branch: "main" } } })],
  ])("gives no result, not even a count, when the PR's %s changed while the check read it", async (_what, change) => {
    const pr = everything();
    for (const author of ["owner", "someone"]) {
      const first = prData(pr.head, { user: { login: author } });
      const server = await fakeApi([{ body: first }, { body: change(first) }], {
        [`GET ${p}/pulls/7/reviews?per_page=100`]: {
          body: [{ user: { login: "owner" }, state: "APPROVED", commit_id: pr.head }],
        },
      });
      const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
      expect(result).toEqual({ code: 1, out: [], err: [MOVED] });
    }
  });

  it("reads nothing when the PR's head is not the commit that the event names", async () => {
    const pr = everything();
    const server = await fakeApi([{ body: prData(pr.head) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, "e".repeat(40)) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        "names: could not read what to check: The PR's head commit is not the one this run was started for. The run for its new head commit checks it.",
      ],
    });
    expect(server.requests).toEqual([read]);
  });

  it("fails when the PR cannot be read again at the end", async () => {
    const pr = nothing();
    const server = await fakeApi([{ body: prData(pr.head) }, { status: 502 }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["names: could not read what to check: GitHub answered 502 to GET /repos/o/r/pulls/7."],
    });
  });

  it("finds a name split between the title and the body, as the squash merge joins them", async () => {
    const pr = nothing();
    const server = await fakeApi([{ body: prData(pr.head, { title: "Add zar", body: "quon support" }) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result.err).toEqual([
      "names: PR title and body line 1 holds a protected name.",
      "names: checked 1 files and 8 texts; 1 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
  });

  it("finds a name that the PR number completes in the squash commit message", async () => {
    // "(#20)" folds to the letter o, which joins the end of the title to the start of the body.
    const pr = nothing();
    const server = await fakeApi(
      [{ body: prData(pr.head, { number: 20, title: "Add zarqu", body: "n support" }) }],
      {},
      20,
    );
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head, { PR_NUMBER: "20" }) });
    expect(result.err).toEqual([
      "names: squash commit message line 1 holds a protected name.",
      "names: checked 1 files and 8 texts; 1 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
  });

  it("finds a name wrapped across two lines of the body, and one in a title shaped like an integrity digest", async () => {
    const pr = nothing();
    for (const [data, place] of [
      [{ title: "Fine", body: "We read the files of Zar\nquon, one by one." }, "names: PR body line 1 holds a protected name."],
      [{ title: "Add the sha1-ZarquonImportAdapterForSIE", body: null }, "names: PR title holds a protected name."],
    ] as const) {
      const server = await fakeApi([{ body: prData(pr.head, data) }]);
      const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
      expect(result.err).toContain(place);
    }
  });

  it("finds a name in each commit whose encoding header git cannot use, in its message, author and committer", async () => {
    // git writes the text as it is and only adds the header. Where git cannot
    // convert the text, git log shows it as it is, so the check reads it so too.
    // The texts are not ASCII, so their UTF-8 and Latin-1 readings differ, and
    // a place that both find is still counted once.
    const encodings = ["unicodefffe", "csunicode", "utf-16le", "utf-16le"];
    const pr = pullRequest((origin) => {
      origin.write("docs/a.md", "fine\n");
      origin.git("add", "--all");
      for (const [index, encoding] of encodings.entries()) {
        origin.git(
          "-c",
          "user.name=Åsa Zarquon",
          "-c",
          "user.email=ann@example.invalid",
          "-c",
          `i18n.commitEncoding=${encoding}`,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          `Tidy the zarquon café notes${"s".repeat(index)}`,
        );
      }
    });
    const commits = pr.origin.git("rev-list", "--reverse", pr.head, "--not", "main").trim().split("\n");
    expect(commits).toHaveLength(encodings.length);
    // The two UTF-16 commits have an odd and an even length, so git fails to convert one and converts the other.
    expect(commits.slice(2).map((commit) => Number(pr.origin.git("cat-file", "-s", commit)) % 2).sort()).toEqual([0, 1]);
    const server = await fakeApi([{ body: prData(pr.head, { title: "Fine", body: null }) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        ...commits.flatMap((commit) => {
          const field = `names: commit ${commit.slice(0, 7)}`;
          return [`${field} holds a protected name.`, `${field} author holds a protected name.`, `${field} committer holds a protected name.`];
        }),
        "names: checked 1 files and 17 texts; 12 to fix. The check never shows what it found. Reword the text at each place.",
      ],
    });
    expectNoWord([...result.out, ...result.err]);
  });

  it("honours a marker in an allowlisted folder of the head commit, also one that the PR does not change", async () => {
    const pr = pullRequest(
      (origin) => {
        origin.write("adapters/a1/.protected-name-ok", "");
        origin.write("adapters/a2/notes.md", "reads zarquon");
        origin.commitAll("Start");
      },
      {
        base: (origin) => {
          origin.write(".github/protected-name-allowlist.txt", "adapters/a2\nadapters/a3\n");
          origin.write("adapters/a2/.protected-name-ok", "");
        },
      },
    );
    const server = await fakeApi([{ body: prData(pr.head, { title: "Add an import", body: null }) }]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result.err).toEqual([
      "names: adapters/a1/.protected-name-ok is a .protected-name-ok marker outside the marker allowlist.",
      "names: checked 2 files and 8 texts; 1 to fix. The check never shows what it found. Reword the text at each place.",
    ]);
  });

  it("fails, and passes nothing, in a checkout without the history of the default branch", async () => {
    const origin = repo();
    origin.write(".github/protected-name-allowlist.txt", "");
    origin.commitAll("Base");
    const base = origin.git("rev-parse", "HEAD").trim();
    origin.write("b.md", "fine\n");
    origin.commitAll("Later on main");
    origin.git("checkout", "--quiet", "-b", "feature/x", base);
    origin.write("a.md", "zarquon\n");
    origin.commitAll("Start");
    const head = origin.git("rev-parse", "HEAD").trim();
    origin.git("update-ref", "refs/pull/7/head", head);
    origin.git("checkout", "--quiet", "main");
    const checkout = createTestRepo({ origin, depth: 1 });
    repos.push(checkout);
    const server = await fakeApi([{ body: prData(head, { title: "Fine", body: null }) }]);
    const result = await run(["--pr"], { cwd: checkout.dir, env: prEnv(server, head) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["names: could not read what to check: git could not find where the PR branched off the default branch."],
    });
  });

  describe("from outside the owner's account", () => {
    const outside = { user: { login: "someone" } };
    const approval = (commit: string): Routes => ({
      [`GET ${p}/pulls/7/reviews?per_page=100`]: {
        body: [{ user: { login: "owner" }, state: "APPROVED", commit_id: commit }],
      },
    });

    it("in a run that the author started, reads neither the PR's files nor the list, even once approved", async () => {
      const pr = pullRequest(plantEverything);
      const server = await fakeApi([{ body: prData(pr.head, outside) }], approval(pr.head));
      for (const extra of [
        { TRIGGERING_ACTOR: "someone" },
        // A list that the check would refuse, if it read it.
        { TRIGGERING_ACTOR: "someone", PROTECTED_NAMES: "ab" },
        { TRIGGERING_ACTOR: undefined },
      ]) {
        const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head, extra) });
        expect(result).toEqual({ code: 1, out: [], err: [`names: ${WAITING}`] });
      }
      expect(server.requests).toEqual([read, read, read]);
      expect(() => pr.checkout.git("cat-file", "-e", pr.head)).toThrow();
    });

    it("in a run that the owner started, waits for the owner's approval of the head commit, on an open PR", async () => {
      const pr = everything();
      for (const [data, routes] of [
        [outside, {}],
        [outside, approval("e".repeat(40))],
        [{ ...outside, state: "closed" }, approval(pr.head)],
      ] as const) {
        const server = await fakeApi([{ body: prData(pr.head, data) }], routes);
        const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
        expect(result).toEqual({ code: 1, out: [], err: [`names: ${WAITING}`] });
      }
    });

    it("once approved, in a run that the owner started, says how many places it found, but never where", async () => {
      const pr = everything();
      const server = await fakeApi([{ body: prData(pr.head, outside) }], approval(pr.head));
      const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
      expect(result).toEqual({
        code: 1,
        out: [],
        err: [
          "names: checked 4 files and 11 texts; 12 to fix. For a PR from outside the owner's account the check does not say where. The owner finds the places with the list.",
        ],
      });
    });

    it("once approved, in a run that the owner started, passes a clean PR", async () => {
      const pr = nothing();
      const server = await fakeApi(
        [{ body: prData(pr.head, { ...outside, title: "Fine", body: null }) }],
        approval(pr.head),
      );
      const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
      expect(result).toEqual({ code: 0, out: ["names: checked 1 files and 8 texts. Nothing found."], err: [] });
    });
  });

  it("refuses a PR that is not aimed at the default branch", async () => {
    const pr = everything();
    const server = await fakeApi([
      { body: prData(pr.head, { base: { ref: "feature/base", repo: { default_branch: "main" } } }) },
    ]);
    const result = await run(["--pr"], { cwd: pr.checkout.dir, env: prEnv(server, pr.head) });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        "names: could not read what to check: The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch.",
      ],
    });
  });

  it("needs the pull request settings", async () => {
    const cwd = repo().dir;
    const settings = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7", OWNER_LOGIN: "owner" };
    for (const [env, message] of [
      [{ OWNER_LOGIN: "owner" }, "GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER must be set."],
      [{}, "OWNER_LOGIN must be set."],
      [settings, "HEAD_SHA must be set."],
    ] as const) {
      const result = await run(["--pr"], { cwd, env: { PROTECTED_NAMES: FAKE_LIST, ...env } });
      expect(result.err).toEqual([`names: could not read what to check: ${message}`]);
    }
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
