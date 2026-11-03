// SPDX-License-Identifier: AGPL-3.0-only

// CI fails when packages/client/openapi.json is not what the registry gives:
// this test, and the build job's `pnpm openapi` with `git diff --exit-code`.
// The client's own test does the same for src/generated.ts.

import { REGISTRY, getHealth } from "@nortfox/contract";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testListAccounts } from "../test/api.ts";
import { renderOpenApi } from "./openapi.ts";
import { OPENAPI_FILE, openApiDrift } from "./openapi-file.ts";
import { readServerVersion } from "./version.ts";

const DRIFT = "packages/client/openapi.json is out of date. Run `pnpm openapi` and commit the result.";

describe("packages/client/openapi.json", () => {
  const committed = readFileSync(OPENAPI_FILE, "utf8");

  it("matches the registry", () => {
    const drift = openApiDrift(committed, renderOpenApi(REGISTRY, readServerVersion()));
    expect(drift, drift).toBeUndefined();
  });

  it("shows a changed registry as drift", () => {
    expect(openApiDrift(committed, renderOpenApi([...REGISTRY, testListAccounts], readServerVersion()))).toBe(DRIFT);
    expect(openApiDrift(committed, renderOpenApi([getHealth], readServerVersion()))).toBe(DRIFT);
    expect(openApiDrift(committed, renderOpenApi(REGISTRY, "0.0.0-other"))).toBe(DRIFT);
  });
});

describe("openApiDrift", () => {
  it("passes the same text, also with Windows line ends", () => {
    expect(openApiDrift('{\n  "a": 1\n}\n', '{\n  "a": 1\n}\n')).toBeUndefined();
    expect(openApiDrift('{\r\n  "a": 1\r\n}\r\n', '{\n  "a": 1\n}\n')).toBeUndefined();
  });

  it("fails on a changed file and names the command that fixes it", () => {
    expect(openApiDrift('{"a":1}\n', '{"a":2}\n')).toBe(DRIFT);
  });
});
