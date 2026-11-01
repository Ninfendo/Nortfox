// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitText, nulList } from "../names/git.ts";
import { manifestProblems, spdxProblem } from "./licences.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string): string | undefined {
  try {
    return readFileSync(`${ROOT}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

const tracked = nulList(gitText(ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));

describe("the repository", () => {
  it("names the right licence at the top of every source file", () => {
    const problems = tracked
      .map((path) => spdxProblem(path, read(path) ?? ""))
      .filter((problem) => problem !== undefined);
    expect(problems).toEqual([]);
  });

  it("has both licence files and the right licence in every package.json", () => {
    const manifests = tracked.filter((path) => path.endsWith("package.json"));
    expect(manifests.length).toBeGreaterThanOrEqual(5);
    expect(manifestProblems(read, manifests)).toEqual([]);
  });
});

describe("the licence guard", () => {
  it("fails a source file without an SPDX line", () => {
    expect(spdxProblem("apps/server/src/x.ts", "export const x = 1;\n")).toBe(
      'apps/server/src/x.ts has no SPDX-License-Identifier line at the top. Add "SPDX-License-Identifier: AGPL-3.0-only".',
    );
    expect(spdxProblem(".githooks/pre-push", "#!/usr/bin/env bash\n")).toContain("has no SPDX");
  });

  it("fails the wrong licence on either side of the line", () => {
    expect(spdxProblem("packages/client/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only\n")).toBe(
      "packages/client/src/x.ts says AGPL-3.0-only, but files there are MIT.",
    );
    expect(spdxProblem("apps/web/src/x.css", "/* SPDX-License-Identifier: MIT */\n")).toBe(
      "apps/web/src/x.css says MIT, but files there are AGPL-3.0-only.",
    );
  });

  it("passes the right line and files that carry none", () => {
    expect(spdxProblem("packages/client/src/x.ts", "// SPDX-License-Identifier: MIT\n")).toBeUndefined();
    expect(spdxProblem("README.md", "# NortFox\n")).toBeUndefined();
    expect(spdxProblem("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")).toBeUndefined();
  });

  it("fails a missing licence file and a wrong package licence", () => {
    const files: Record<string, string> = {
      LICENSE: "MIT License",
      "packages/client/package.json": '{"license":"AGPL-3.0-only"}',
      "apps/web/package.json": "{}",
    };
    expect(manifestProblems((path) => files[path], ["packages/client/package.json", "apps/web/package.json", "x/package.json"])).toEqual([
      "packages/client/LICENSE is missing.",
      "LICENSE is not the GNU Affero General Public License.",
      "packages/client/LICENSE is not the MIT licence.",
      'packages/client/LICENSE must name the holder in one line: "Copyright (C) 2026 The NortFox authors".',
      'packages/client/package.json must say "license": "MIT".',
      'apps/web/package.json must say "license": "AGPL-3.0-only".',
      'x/package.json must say "license": "AGPL-3.0-only".',
    ]);
  });

  it.each([
    ["another holder", "MIT License\n\nCopyright (C) 2026 Example Holder\n"],
    ["a second holder", "MIT License\n\nCopyright (C) 2026 The NortFox authors\r\nCopyright (C) 2026 Example Holder\n"],
    ["no holder", "MIT License\n"],
  ])("fails an MIT licence with %s", (_case, mit) => {
    const files: Record<string, string> = { LICENSE: "GNU AFFERO GENERAL PUBLIC LICENSE", "packages/client/LICENSE": mit };
    expect(manifestProblems((path) => files[path], [])).toEqual([
      'packages/client/LICENSE must name the holder in one line: "Copyright (C) 2026 The NortFox authors".',
    ]);
  });
});
