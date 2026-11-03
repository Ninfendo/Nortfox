// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as contract from "./index.ts";
import { PERMISSIONS } from "./operation.ts";
import { REGISTRY } from "./registry.ts";
import { registryProblems } from "./registry-guard.ts";

describe("REGISTRY", () => {
  it("passes the registry guard", () => {
    expect(registryProblems(REGISTRY, Object.keys(PERMISSIONS))).toEqual([]);
  });

  it("holds getHealth and getCompany", () => {
    expect(REGISTRY.map((entry) => [entry.operationId, entry.method, entry.path, entry["x-nortfox"]])).toEqual([
      [
        "getHealth",
        "get",
        "/v1/health",
        {
          permission: "public",
          tool: "Checks that the NortFox server is up, and gives its version. It reads no data.",
          assistant: false,
          writes: false,
          list: false,
        },
      ],
      [
        "getCompany",
        "get",
        "/v1/company",
        {
          permission: "company:read",
          tool: "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
          assistant: true,
          writes: false,
          list: false,
        },
      ],
    ]);
  });

  it("uses every permission on the list, so none is dead", () => {
    const used = new Set(REGISTRY.map((entry) => entry["x-nortfox"].permission));
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(used).toContain(permission);
    }
  });

  it("describes each permission in a sentence", () => {
    expect(PERMISSIONS).toEqual({
      "company:read": "Read the company: its id, name, organisation number and tenant id.",
    });
  });

  it("is what the package exports", () => {
    expect(contract.REGISTRY).toBe(REGISTRY);
  });
});
