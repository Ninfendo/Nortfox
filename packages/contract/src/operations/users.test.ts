// SPDX-License-Identifier: AGPL-3.0-only

// updateUserRights sets the Rapporter and Register/Övrigt rights (issue 12,
// "Roles, admin levels, programs and permissions"): its schema takes those
// rights alone, as the catalogue's keys, so the API's description, the tool's
// schema and the client say what the server takes. A right of a program's own
// is refused with invalid-value at its pointer, and the allowed rights with
// it.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS } from "../access/catalogue.ts";
import { bodySchema } from "../operation.ts";
import { fieldIssues } from "../problem.ts";
import { RightKey, updateUserRights } from "./users.ts";

/** The Rapporter and Register/Övrigt rights, in the catalogue's order. */
const RIGHTS = CATALOGUE_PERMISSIONS.filter((permission) => CATALOGUE_GROUPS.find((group) => group.key === permission.group)?.kind !== "program").map((permission) => permission.key);

describe("updateUserRights' rights", () => {
  it("are the catalogue's Rapporter and Register/Övrigt rights, in its order", () => {
    expect(RightKey.options).toEqual(RIGHTS);
    expect(RIGHTS).toHaveLength(32);
  });

  it("refuse a right of a program's own at its pointer, with the rights that the field takes", () => {
    const parsed = (bodySchema(updateUserRights) ?? z.never()).safeParse({ permissions: ["reports.vat", "vouchers.view"] }, { reportInput: true });
    expect(parsed.success).toBe(false);
    const problems = parsed.success ? [] : fieldIssues(parsed.error.issues);
    expect(problems).toEqual([expect.objectContaining({ code: "invalid-value", pointer: "/permissions/1", data: expect.objectContaining({ allowed: RIGHTS }) as unknown })]);
  });

  it("take every Rapporter and Register/Övrigt right", () => {
    expect((bodySchema(updateUserRights) ?? z.never()).safeParse({ permissions: RIGHTS }).success).toBe(true);
  });
});
