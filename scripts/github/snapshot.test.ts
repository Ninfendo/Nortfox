// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestRepo, type TestRepo } from "../testing/repo.ts";
import {
  changesBetween,
  commitsBetween,
  fetchCommit,
  mergeBase,
  nulSeparated,
  parseCommit,
  parseRawChanges,
  readObjects,
  SnapshotError,
  treePaths,
} from "./snapshot.ts";

const repos: TestRepo[] = [];
const shared: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.remove();
  }
});

afterAll(() => {
  for (const repo of shared.splice(0)) {
    repo.remove();
  }
});

function track(repo: TestRepo): TestRepo {
  repos.push(repo);
  return repo;
}

interface Fixture {
  readonly origin: TestRepo;
  readonly checkout: TestRepo;
  readonly base: string;
  readonly head: string;
}

/** A default branch, a PR on top of it that only origin has, and a checkout of the default branch. */
function setUp(keep: (repo: TestRepo) => TestRepo = track): Fixture {
  const origin = keep(createTestRepo());
  origin.write("kept.md", "kept\n");
  origin.write("gone.md", "gone\n");
  origin.write("old-name.md", "moved\n");
  origin.commitAll("Base");
  const base = origin.git("rev-parse", "HEAD").trim();
  const checkout = keep(createTestRepo({ origin }));
  origin.git("checkout", "--quiet", "-b", "feature/x");
  origin.git("rm", "--quiet", "gone.md");
  origin.git("mv", "old-name.md", "new-name.md");
  origin.write("kept.md", "kept, and changed\n");
  origin.write("same-a.md", "same\n");
  origin.write("same-b.md", "same\n");
  origin.commitAll("Change the files");
  // A link's object holds the path it points to.
  const link = origin.git("hash-object", "-w", "kept.md").trim();
  origin.git("update-index", "--add", "--cacheinfo", `120000,${link},link`);
  origin.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
  origin.git("commit", "--quiet", "-m", "Add a link and a submodule");
  const head = origin.git("rev-parse", "HEAD").trim();
  origin.git("update-ref", "refs/pull/7/head", head);
  origin.git("checkout", "--quiet", "main");
  origin.git("branch", "--quiet", "-D", "feature/x");
  return { origin, checkout, base, head };
}

let built: Fixture | undefined;

/** One fixture for the tests that only read it, with the head commit fetched. Git is slow to start on some machines. */
function fetched(): Fixture {
  if (built === undefined) {
    built = setUp((repo) => {
      shared.push(repo);
      return repo;
    });
    fetchCommit(built.checkout.dir, built.head);
  }
  return built;
}

describe("fetchCommit", () => {
  it("fetches the PR's head commit by its SHA, which the checkout did not have", () => {
    const { checkout, head } = setUp();
    expect(() => checkout.git("cat-file", "-e", head)).toThrow();
    fetchCommit(checkout.dir, head);
    expect(checkout.git("cat-file", "-t", head).trim()).toBe("commit");
    expect(checkout.git("for-each-ref", "--format=%(refname)").trim().split("\n")).toEqual([
      "refs/heads/main",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
  });

  it("refuses anything that is not a full SHA before git sees it", () => {
    const { checkout } = fetched();
    for (const name of ["--upload-pack=touch x", "HEAD", "abc123", "A".repeat(40)]) {
      expect(() => {
        fetchCommit(checkout.dir, name);
      }).toThrow(new SnapshotError("A commit or file is named by something that is not a full SHA."));
    }
  });

  it("fails on a commit that origin does not have, and on an object that is not a commit", () => {
    const { checkout } = fetched();
    expect(() => {
      fetchCommit(checkout.dir, "0".repeat(40));
    }).toThrow("git could not fetch the PR's head commit.");
    const blob = checkout.git("rev-parse", "HEAD:kept.md").trim();
    expect(() => {
      fetchCommit(checkout.dir, blob);
    }).toThrow("The PR's head is not a commit.");
  });

  it("fails when git cannot run there", () => {
    expect(() => {
      fetchCommit(`${track(createTestRepo()).dir}/missing-folder`, "0".repeat(40));
    }).toThrow(/^git could not run: /);
  });
});

describe("reading the head commit", () => {
  it("lists every change, a rename as a delete and an add, with the mode and the object at the head", () => {
    const { checkout, base, head } = fetched();
    expect(mergeBase(checkout.dir, "HEAD", head)).toBe(base);
    const changes = changesBetween(checkout.dir, base, head);
    expect(changes.map(({ path, status, mode }) => `${status} ${mode} ${path.toString("utf8")}`)).toEqual([
      "D 000000 gone.md",
      "M 100644 kept.md",
      "A 120000 link",
      "A 100644 new-name.md",
      "D 000000 old-name.md",
      "A 100644 same-a.md",
      "A 100644 same-b.md",
      "A 160000 vendor/sub",
    ]);
    expect(changes.find((change) => change.path.toString("utf8") === "kept.md")?.sha).toBe(
      checkout.git("rev-parse", `${head}:kept.md`).trim(),
    );
    expect(treePaths(checkout.dir, head).map(String)).toEqual(["kept.md", "link", "new-name.md", "same-a.md", "same-b.md", "vendor/sub"]);
    expect(commitsBetween(checkout.dir, "HEAD", head)).toEqual([
      checkout.git("rev-parse", `${head}~1`).trim(),
      head,
    ]);
  });

  it("finds no merge base for a head that shares no history with the base", () => {
    const { origin, checkout } = fetched();
    origin.git("checkout", "--quiet", "--orphan", "other");
    origin.commitAll("Unrelated");
    const unrelated = origin.git("rev-parse", "HEAD").trim();
    fetchCommit(checkout.dir, unrelated);
    expect(() => mergeBase(checkout.dir, "HEAD", unrelated)).toThrow(
      "git could not find where the PR branched off the default branch.",
    );
  });

  it("reads each object once, as stored, and refuses a missing one, the wrong type and a name it was not given", () => {
    const { checkout, head } = fetched();
    const same = checkout.git("rev-parse", `${head}:same-a.md`).trim();
    const blob = readObjects(checkout.dir, [same, same, checkout.git("rev-parse", `${head}:link`).trim()], "blob");
    expect(blob(same).toString("utf8")).toBe("same\n");
    expect(() => blob(head)).toThrow("The check did not read the blob it looks for.");
    expect(() => readObjects(checkout.dir, ["0".repeat(40)], "blob")).toThrow("git could not read one of the PR's blobs.");
    expect(() => readObjects(checkout.dir, [head], "blob")).toThrow("git could not read one of the PR's blobs.");
    // Nothing to read runs no git at all.
    expect(() => readObjects(`${checkout.dir}/missing-folder`, [], "commit")).not.toThrow();
  });
});

describe("paths that are not UTF-8", () => {
  // git stores a path as bytes. 0xF3 alone is not UTF-8; in Latin-1 it is "ó".
  const path = Buffer.concat([Buffer.from("docs/b"), Buffer.from([0xf3]), Buffer.from("k.md")]);

  it("are given as the bytes git stores, in a change and in the tree", () => {
    const origin = track(createTestRepo());
    origin.write("a.md", "a\n");
    origin.commitAll("Base");
    const base = origin.git("rev-parse", "HEAD").trim();
    origin.stageBytes(path, "a\n");
    origin.git("commit", "--quiet", "-m", "Add a path in Latin-1");
    const head = origin.git("rev-parse", "HEAD").trim();
    const blob = origin.git("rev-parse", "HEAD:a.md").trim();
    expect(changesBetween(origin.dir, base, head)).toEqual([{ path, mode: "100644", sha: blob, status: "A" }]);
    expect(treePaths(origin.dir, head)).toEqual([Buffer.from("a.md"), path]);
  });

  it("are split from git's -z lists on their NUL bytes only", () => {
    expect(nulSeparated(Buffer.concat([path, Buffer.from([0]), Buffer.from("b.md"), Buffer.from([0])]))).toEqual([
      path,
      Buffer.from("b.md"),
    ]);
    expect(nulSeparated(Buffer.alloc(0))).toEqual([]);
  });
});

describe("parseRawChanges", () => {
  const sha = "b".repeat(40);
  const zero = "0".repeat(40);
  const raw = (text: string): Buffer => Buffer.from(text, "latin1");

  it("reads each change, and nothing from no change", () => {
    expect(parseRawChanges(raw(`:000000 100644 ${zero} ${sha} A\0a b.md\0:100644 000000 ${sha} ${zero} D\0c.md\0`))).toEqual([
      { path: Buffer.from("a b.md"), mode: "100644", sha, status: "A" },
      { path: Buffer.from("c.md"), mode: "000000", sha: zero, status: "D" },
    ]);
    expect(parseRawChanges(Buffer.alloc(0))).toEqual([]);
  });

  it("keeps a path as its bytes, also bytes that are not UTF-8", () => {
    expect(parseRawChanges(raw(`:000000 100644 ${zero} ${sha} A\0b\xF3k.md\0`))).toEqual([
      { path: raw("b\xF3k.md"), mode: "100644", sha, status: "A" },
    ]);
  });

  it.each([
    ["a line it does not know", `:100644 100644 ${sha} ${sha} R100\0a.md\0b.md\0`],
    ["a change without its path", `:000000 100644 ${zero} ${sha} A\0`],
    ["a list that stops short", `:000000 100644 ${zero} ${sha} A\0a.md`],
  ])("fails on %s", (_what, output) => {
    expect(() => parseRawChanges(raw(output))).toThrow("git listed the changed files in a form the check cannot read.");
  });
});

describe("parseCommit", () => {
  const people = "author Ann Example <ann@example.invalid> 1700000000 +0100\ncommitter Bo <bo@example.invalid> 1700000001 -0230";
  const commit = (headers: string, message: string | Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`tree ${"a".repeat(40)}\n${headers}\n\n`, "latin1"),
      typeof message === "string" ? Buffer.from(message, "latin1") : message,
    ]);

  it("reads the message, and who wrote and committed it without the time", () => {
    expect(
      parseCommit(commit(`${people}\ngpgsig -----BEGIN-----\n \n -----END-----`, "Add the ledger\n\nIt balances.\n")),
    ).toEqual({
      message: ["Add the ledger\n\nIt balances."],
      author: ["Ann Example <ann@example.invalid>"],
      committer: ["Bo <bo@example.invalid>"],
    });
  });

  it("reads the commit in the encoding its header names, and also its bytes as they are", () => {
    const parsed = parseCommit(
      commit("author Bj\xF8rn <b@example.invalid> 1 +0000\ncommitter Bo <bo@example.invalid> 1 +0000\nencoding ISO-8859-1", "Gr\xF8n\n"),
    );
    expect(parsed).toEqual({
      message: ["Gr�n", "Grøn"],
      author: ["Bj�rn <b@example.invalid>", "Bjørn <b@example.invalid>"],
      committer: ["Bo <bo@example.invalid>"],
    });
  });

  // git writes the message and the names as they are and only adds the
  // header. Where git cannot convert them, git log shows them as they are.
  it.each([
    ["a name that git does not know", "unicodefffe", "Add the ledger\n"],
    ["another such name", "csunicode", "Add the ledger\n"],
    ["UTF-16 of an odd length", "UTF-16LE", "Add the ledger\n"],
    ["UTF-16 of an even length", "UTF-16LE", "Add the ledgers\n"],
  ])("reads the bytes as they are when the header names %s", (_what, encoding, message) => {
    const parsed = parseCommit(commit(`${people}\nencoding ${encoding}`, message));
    expect(parsed.message).toContain(message.trimEnd());
    expect(parsed.author).toContain("Ann Example <ann@example.invalid>");
    expect(parsed.committer).toContain("Bo <bo@example.invalid>");
  });

  it("reads UTF-16 in both byte orders, and from either byte of the message", () => {
    for (const [encoding, bytes] of [
      ["UTF-16LE", Buffer.from("Add the ledger", "utf16le")],
      // iconv reads a plain "UTF-16" as big-endian; TextDecoder reads it as little-endian.
      ["UTF-16", Buffer.from("Add the ledger", "utf16le").swap16()],
      // git converts the whole commit, so the message may start in the middle of a unit.
      ["UTF-16LE", Buffer.concat([Buffer.from([0x41]), Buffer.from("Add the ledger", "utf16le")])],
    ] as const) {
      expect(parseCommit(commit(`${people}\nencoding ${encoding}`, bytes)).message).toContain("Add the ledger");
    }
  });

  it("refuses an encoding it cannot read", () => {
    for (const encoding of ["x-no-such-encoding", "utf-7", "iso-2022-kr", ""]) {
      expect(() => parseCommit(commit(`${people}\nencoding ${encoding}`, "Hi"))).toThrow(
        "A commit is written in a text encoding the check cannot read.",
      );
    }
  });

  it("refuses a commit without exactly one author and one committer, and reads one without a message", () => {
    const author = "author A <a@example.invalid> 1 +0000";
    const committer = "committer C <c@example.invalid> 1 +0000";
    expect(() => parseCommit(commit(committer, "Hi"))).toThrow("A commit does not have exactly one author.");
    expect(() => parseCommit(commit(`${author}\n${author}\n${committer}`, "Hi"))).toThrow(
      "A commit does not have exactly one author.",
    );
    expect(() => parseCommit(commit(author, "Hi"))).toThrow("A commit does not have exactly one committer.");
    // A name inside a signature is not a header.
    expect(() => parseCommit(commit(`${author}\ngpgsig x\n ${committer}`, "Hi"))).toThrow(
      "A commit does not have exactly one committer.",
    );
    expect(parseCommit(Buffer.from(`tree ${"a".repeat(40)}\n${author}\n${committer}`))).toEqual({
      message: [""],
      author: ["A <a@example.invalid>"],
      committer: ["C <c@example.invalid>"],
    });
  });
});
