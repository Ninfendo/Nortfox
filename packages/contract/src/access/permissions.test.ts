// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a membership holds by being one, and by its admin level
// (issue 12, "Roles, admin levels, programs and permissions"): every active
// member reads the company, and the owner and the admin hold the same (open
// point 1), with none of the catalogue's work rights. Each permission is on
// the contract's list. The admin levels are the database's.

import { describe, expect, it } from "vitest";
import * as contract from "../index.ts";
import { PERMISSIONS } from "../operation.ts";
import { ADMIN_LEVELS, MEMBER_PERMISSIONS, SYSTEM_ADMINISTRATOR_PERMISSIONS, platformPermissions } from "./permissions.ts";

describe("the platform permissions", () => {
  it("gives a member with no admin level exactly the member's own: reading the company", () => {
    expect([...platformPermissions(null)]).toEqual(["company:read"]);
    expect(MEMBER_PERMISSIONS).toEqual(["company:read"]);
  });

  it.each(ADMIN_LEVELS)("gives the %s the member's own and a system administrator's", (level) => {
    expect([...platformPermissions(level)]).toEqual([...MEMBER_PERMISSIONS, ...SYSTEM_ADMINISTRATOR_PERMISSIONS]);
    for (const permission of MEMBER_PERMISSIONS) {
      expect(platformPermissions(level).has(permission)).toBe(true);
    }
  });

  it("gives the owner and the admin the same (open point 1)", () => {
    expect(platformPermissions("owner")).toEqual(platformPermissions("admin"));
  });

  it("gives a system administrator nothing beyond the member's own until its operations come", () => {
    // updateCompany, the user administration and the program grants bring
    // their permissions later in slice 2c, and this list with them.
    expect(SYSTEM_ADMINISTRATOR_PERMISSIONS).toEqual([]);
  });

  it("names only permissions on the contract's list, each once, in one list only", () => {
    const named = [...MEMBER_PERMISSIONS, ...SYSTEM_ADMINISTRATOR_PERMISSIONS];
    expect(new Set(named).size).toBe(named.length);
    for (const permission of named) {
      expect(Object.keys(PERMISSIONS)).toContain(permission);
    }
  });

  it("gives a new set each time, so no caller changes another's", () => {
    expect(platformPermissions(null)).not.toBe(platformPermissions(null));
  });

  it("knows the admin levels that the database takes, owner and admin", () => {
    expect(ADMIN_LEVELS).toEqual(["owner", "admin"]);
  });

  it("is what the package exports", () => {
    expect(contract.ADMIN_LEVELS).toBe(ADMIN_LEVELS);
    expect(contract.MEMBER_PERMISSIONS).toBe(MEMBER_PERMISSIONS);
    expect(contract.SYSTEM_ADMINISTRATOR_PERMISSIONS).toBe(SYSTEM_ADMINISTRATOR_PERMISSIONS);
    expect(contract.platformPermissions).toBe(platformPermissions);
  });
});
