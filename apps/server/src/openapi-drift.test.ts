// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderOpenApi } from "./app.ts";
import { OPENAPI_FILE, openApiDrift } from "./openapi-file.ts";
import { readServerVersion } from "./version.ts";

describe("packages/client/openapi.json", () => {
  it("matches the server's routes", () => {
    const committed = readFileSync(OPENAPI_FILE, "utf8");
    const drift = openApiDrift(committed, renderOpenApi({ version: readServerVersion() }));
    expect(drift, drift).toBeUndefined();
  });
});

describe("openApiDrift", () => {
  it("passes the same text, also with Windows line ends", () => {
    expect(openApiDrift('{\n  "a": 1\n}\n', '{\n  "a": 1\n}\n')).toBeUndefined();
    expect(openApiDrift('{\r\n  "a": 1\r\n}\r\n', '{\n  "a": 1\n}\n')).toBeUndefined();
  });

  it("fails on a changed file and names the command that fixes it", () => {
    expect(openApiDrift('{"a":1}\n', '{"a":2}\n')).toBe(
      "packages/client/openapi.json is out of date. Run `pnpm openapi` and commit the result.",
    );
  });
});
