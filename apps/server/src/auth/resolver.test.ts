// SPDX-License-Identifier: AGPL-3.0-only

// A session's permissions are its snapshot of when it chose its company:
// each permission with the end of the grant that gives it, or none. The
// resolver drops a permission whose grant has ended, so a time-bound grant
// ends in a session that began before, on the next request. A program
// administrator's programs are in the snapshot too, as keys that name no
// permission.
// sessions.db.test.ts, idle-logout.db.test.ts and session-membership.db.test.ts
// run the resolver on PostgreSQL, and session-permissions.db.test.ts and
// modules/users/auditor.db.test.ts the snapshot.

import { describe, expect, it } from "vitest";
import { CATALOGUE_PERMISSIONS, PERMISSIONS } from "@nortfox/contract";
import { ADMINISTERS, administeredPrograms, livePermissions, permissionSnapshot } from "./resolver.ts";

describe("permissionSnapshot", () => {
  it("keeps each permission with its end as an ISO time, or null for no end", () => {
    const end = new Date("2090-04-14T10:00:00.123Z");
    expect(permissionSnapshot(new Map([["company:read", null], ["vouchers.view", end]]))).toEqual({ "company:read": null, "vouchers.view": "2090-04-14T10:00:00.123Z" });
  });

  it("is what livePermissions reads back: a permission holds until its end", () => {
    const end = new Date("2090-04-14T10:00:00.123Z");
    const snapshot = permissionSnapshot(new Map([["company:read", null], ["vouchers.view", end]]));
    expect(livePermissions(snapshot, new Date(end.getTime() - 1))).toEqual(["company:read", "vouchers.view"]);
    expect(livePermissions(snapshot, end)).toEqual(["company:read"]);
  });

  it("gives an empty snapshot for no permission", () => {
    expect(permissionSnapshot(new Map())).toEqual({});
  });

  it("keeps a program administrator's programs beside the permissions, as keys that name no permission, which livePermissions leaves out", () => {
    const snapshot = permissionSnapshot(new Map([["company:read", null], ["programs:grant", null]]), ["bookkeeping", "auditor"]);
    expect(snapshot).toEqual({ "company:read": null, "programs:grant": null, "administers:bookkeeping": null, "administers:auditor": null });
    expect(livePermissions(snapshot, new Date())).toEqual(["company:read", "programs:grant"]);
    expect(administeredPrograms(snapshot)).toEqual(["bookkeeping", "auditor"]);
    expect(administeredPrograms(permissionSnapshot(new Map([["company:read", null]])))).toEqual([]);
    // No permission's key starts as a program's does.
    expect([...Object.keys(PERMISSIONS), ...CATALOGUE_PERMISSIONS.map((permission) => permission.key)].filter((permission) => permission.startsWith(ADMINISTERS))).toEqual([]);
  });

  it("reads only the programs of the catalogue, in its order, from a snapshot", () => {
    expect(administeredPrograms({ "administers:auditor": null, "administers:read": null, "administers:payroll": null, "company:read": null })).toEqual(["read", "auditor"]);
  });
});

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
