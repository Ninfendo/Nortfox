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
      'packages/client/src/x.ts says "AGPL-3.0-only", but files there say exactly "SPDX-License-Identifier: MIT".',
    );
    expect(spdxProblem("apps/web/src/x.css", "/* SPDX-License-Identifier: MIT */\n")).toBe(
      'apps/web/src/x.css says "MIT", but files there say exactly "SPDX-License-Identifier: AGPL-3.0-only".',
    );
  });

  it.each([
    ["packages/client/src/x.ts", "// SPDX-License-Identifier: MIT AND AGPL-3.0-only", "MIT AND AGPL-3.0-only"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier: MIT OR AGPL-3.0-only", "MIT OR AGPL-3.0-only"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier: (MIT)", "(MIT)"],
    ["packages/client/src/x.ts", "/* SPDX-License-Identifier: MIT WITH LLVM-exception */", "MIT WITH LLVM-exception"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier: MIT-0", "MIT-0"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier:MIT", "MIT"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier:  MIT", "MIT"],
    ["packages/client/src/x.ts", "// SPDX-License-Identifier: MIT */ AGPL-3.0-only", "MIT */ AGPL-3.0-only"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only OR MIT", "AGPL-3.0-only OR MIT"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only AND MIT", "AGPL-3.0-only AND MIT"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only WITH Classpath-exception-2.0", "AGPL-3.0-only WITH Classpath-exception-2.0"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: (AGPL-3.0-only OR MIT)", "(AGPL-3.0-only OR MIT)"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-or-later", "AGPL-3.0-or-later"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only+", "AGPL-3.0-only+"],
    ["apps/web/index.html", "<!-- SPDX-License-Identifier: AGPL-3.0-only OR MIT -->", "AGPL-3.0-only OR MIT"],
    ["apps/server/src/x.ts", "// SPDX-License-Identifier:", ""],
  ])("fails %s with %j", (path, line, said) => {
    const expected = path.startsWith("packages/client/") ? "MIT" : "AGPL-3.0-only";
    expect(spdxProblem(path, `${line}\n\nexport const x = 1;\n`)).toBe(
      `${path} says "${said}", but files there say exactly "SPDX-License-Identifier: ${expected}".`,
    );
  });

  it("fails a second SPDX line at the top, whatever it says", () => {
    expect(spdxProblem("packages/client/src/x.ts", "// SPDX-License-Identifier: MIT\n// SPDX-License-Identifier: AGPL-3.0-only\n")).toBe(
      'packages/client/src/x.ts has 2 SPDX-License-Identifier lines at the top. Keep one: "SPDX-License-Identifier: MIT".',
    );
    expect(spdxProblem("apps/server/src/x.ts", "// SPDX-License-Identifier: AGPL-3.0-only\n\n// SPDX-License-Identifier: AGPL-3.0-only\n")).toBe(
      'apps/server/src/x.ts has 2 SPDX-License-Identifier lines at the top. Keep one: "SPDX-License-Identifier: AGPL-3.0-only".',
    );
  });

  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts", "d.mts", "d.cts"])(
    "checks every .%s file",
    (extension) => {
      expect(spdxProblem(`apps/server/src/x.${extension}`, "export const x = 1;\n")).toContain("has no SPDX");
      expect(spdxProblem(`packages/client/src/x.${extension}`, "// SPDX-License-Identifier: AGPL-3.0-only\n")).toContain(
        'says "AGPL-3.0-only"',
      );
      expect(spdxProblem(`packages/client/src/x.${extension}`, "// SPDX-License-Identifier: MIT\n")).toBeUndefined();
    },
  );

  it("passes the right line in each comment style and files that carry none", () => {
    expect(spdxProblem("packages/client/src/x.ts", "// SPDX-License-Identifier: MIT\n")).toBeUndefined();
    expect(spdxProblem("packages/client/src/x.ts", "// SPDX-License-Identifier: MIT\r\n")).toBeUndefined();
    expect(spdxProblem("apps/web/src/x.css", "/* SPDX-License-Identifier: AGPL-3.0-only */\n")).toBeUndefined();
    expect(spdxProblem("apps/web/index.html", "<!doctype html>\n<!-- SPDX-License-Identifier: AGPL-3.0-only -->\n")).toBeUndefined();
    expect(spdxProblem(".githooks/pre-push", "#!/usr/bin/env bash\n# SPDX-License-Identifier: AGPL-3.0-only\n")).toBeUndefined();
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
