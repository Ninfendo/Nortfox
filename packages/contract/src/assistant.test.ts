// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assistantOperations } from "./assistant.ts";
import { defineOperation, type Operation } from "./operation.ts";
import { REGISTRY } from "./registry.ts";

function sample(id: string, assistant?: boolean): Operation {
  return defineOperation({
    id,
    method: "get",
    path: `/v1/${id.toLowerCase()}`,
    tags: ["samples"],
    summary: id,
    description: id,
    output: z.strictObject({ ok: z.boolean() }),
    permission: "test:read",
    tool: `Reads ${id}.`,
    writes: false,
    ...(assistant === undefined ? {} : { assistant }),
  });
}

describe("assistantOperations", () => {
  it("leaves out an entry without the flag, and one that closes itself", () => {
    const open = sample("openSample", true);
    const unsaid = sample("unsaidSample");
    const closed = sample("closedSample", false);
    expect(unsaid["x-nortfox"].assistant).toBe(false);
    expect(assistantOperations([unsaid, open, closed])).toEqual([open]);
  });

  it("opens only getCompany in the real registry", () => {
    expect(assistantOperations(REGISTRY).map((entry) => entry.operationId)).toEqual(["getCompany"]);
  });
});
