// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { honouredFolderOf, isMarker, judgeMarkers, parseAllowlist } from "./markers.ts";

describe("parseAllowlist", () => {
  it("reads one folder per line, without comments or trailing slashes", () => {
    expect(parseAllowlist("# The marker allowlist\n\napps/server/src/modules/import/adapters/a1/\r\nx\n")).toEqual([
      "apps/server/src/modules/import/adapters/a1",
      "x",
    ]);
    expect(parseAllowlist("# empty for now\n")).toEqual([]);
  });
});

describe("isMarker", () => {
  it("knows a marker by its file name", () => {
    expect(isMarker(".protected-name-ok")).toBe(true);
    expect(isMarker("a/b/.protected-name-ok")).toBe(true);
    expect(isMarker("a/b/x.protected-name-ok")).toBe(false);
  });
});

describe("judgeMarkers", () => {
  const alias = (path: string) => `alias of ${path}`;

  it("honours a marker only in an allowlisted folder", () => {
    expect(judgeMarkers(["adapters/a1/.protected-name-ok"], ["adapters/a1"], alias)).toEqual({
      honoured: ["adapters/a1"],
      findings: [],
    });
  });

  it("refuses a marker anywhere else, also at the root", () => {
    expect(
      judgeMarkers([".protected-name-ok", "docs/.protected-name-ok", "adapters/a1/sub/.protected-name-ok"], ["adapters/a1"], alias),
    ).toEqual({
      honoured: [],
      findings: [
        { place: "alias of .protected-name-ok", reason: "marker" },
        { place: "alias of docs/.protected-name-ok", reason: "marker" },
        { place: "alias of adapters/a1/sub/.protected-name-ok", reason: "marker" },
      ],
    });
  });
});

describe("honouredFolderOf", () => {
  it("finds the honoured folder a path lies in", () => {
    expect(honouredFolderOf("adapters/a1/x.ts", ["adapters/a1"])).toBe("adapters/a1");
    expect(honouredFolderOf("adapters/a10/x.ts", ["adapters/a1"])).toBeUndefined();
  });
});
