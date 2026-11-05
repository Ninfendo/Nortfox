// SPDX-License-Identifier: AGPL-3.0-only

// A session's permissions are its snapshot of when it chose its company:
// each permission with the end of the grant that gives it, or none. The
// resolver drops a permission whose grant has ended, so a time-bound grant
// ends in a session that began before, on the next request.
// sessions.db.test.ts, idle-logout.db.test.ts and session-membership.db.test.ts
// run the resolver on PostgreSQL.

import { describe, expect, it } from "vitest";
import { livePermissions } from "./resolver.ts";

describe("livePermissions", () => {
  const AT = new Date("2090-03-15T10:00:00.000Z");

  it("keeps a permission with no end, and one whose end is still to come", () => {
    expect(livePermissions({ "company:read": null, "vouchers.view": "2090-03-15T10:00:00.001Z" }, AT)).toEqual(["company:read", "vouchers.view"]);
  });

  it("drops a permission whose grant ended, at its end too", () => {
    expect(livePermissions({ "company:read": null, "vouchers.view": "2090-03-15T10:00:00.000Z", "reports.balance-sheet": "2090-03-14T00:00:00.000Z" }, AT)).toEqual([
      "company:read",
    ]);
  });

  it("gives nothing for an empty snapshot", () => {
    expect(livePermissions({}, AT)).toEqual([]);
  });
});
