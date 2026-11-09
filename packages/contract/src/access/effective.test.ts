// SPDX-License-Identifier: AGPL-3.0-only

// The effective permissions and the six roles (issue 12, "Roles, admin
// levels, programs and permissions", lines 1 to 12, and the done-when lines
// on the six roles and the Revisor). A member's permissions are the
// platform's, by being a member, a system administrator or a program
// administrator, and the rights of the member's grants that still hold. A
// right ends with the latest grant that gives it, and never while a grant
// with no end gives it. The plan's six roles are sets in this model: owner
// and admin are the system administrator's levels, bookkeeper is Bokföring
// with "Full behörighet", approver is Bokföring - Attest & Läs, viewer is
// Läs, and auditor is Revisor. effective.property.test.ts holds the rules
// for any member.

import { describe, expect, it } from "vitest";
import * as contract from "../index.ts";
import { CATALOGUE_PERMISSIONS, fullPermissions, programPermissions, type CataloguePermissionKey, type Program } from "./catalogue.ts";
import { ROLES, ROLE_KEYS, effectivePermissions, grantHolds, grantRights, rolesOf, type GrantAccess, type MemberAccess, type Role } from "./effective.ts";
import { MEMBER_PERMISSIONS, PROGRAM_ADMINISTRATOR_PERMISSIONS, SYSTEM_ADMINISTRATOR_PERMISSIONS } from "./permissions.ts";

const NOW = new Date("2090-03-15T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A plain member, with no admin level, no grant and no program to administer. */
const PLAIN: MemberAccess = { adminLevel: null, grants: [], programsAdministered: [] };

/** A grant of `program` with "Full behörighet", as "Tilldela program" preselects it, with no end. */
function full(program: Program, expiresAt: Date | null = null): GrantAccess {
  return { program, permissions: fullPermissions(program), expiresAt };
}

/** The keys of a member's effective permissions at NOW, in their order. */
function keysOf(access: MemberAccess, now = NOW): string[] {
  return [...effectivePermissions(access, now).keys()];
}

/** The catalogue's keys of a group, in its order. */
function groupOf(group: string): CataloguePermissionKey[] {
  return CATALOGUE_PERMISSIONS.filter((permission) => permission.group === group).map((permission) => permission.key);
}

/** The six that only Bokföring - Attest & Läs holds (issue 12, catalogue item 9). */
const APPROVAL_READ_ONLY = [
  "vouchers.approve-own-series",
  "vouchers.see-all-series",
  "reports.supplier-invoices",
  "reports.supplier-statistics",
  "reports.supplier-ledger",
  "reports.supplier-due-list",
];

/** The manual-only rights this slice builds. */
const MANUAL_ONLY = CATALOGUE_PERMISSIONS.filter((permission) => permission.manualOnly).map((permission) => permission.key);

/** The member of each role, as its definition makes one: the creator or an admin for the two levels, and a grant with "Full behörighet" for each program. */
const MEMBER_OF: Readonly<Record<Role, MemberAccess>> = {
  owner: { ...PLAIN, adminLevel: "owner" },
  admin: { ...PLAIN, adminLevel: "admin" },
  bookkeeper: { ...PLAIN, grants: [full("bookkeeping")] },
  approver: { ...PLAIN, grants: [full("approval-read")] },
  viewer: { ...PLAIN, grants: [full("read")] },
  auditor: { ...PLAIN, grants: [full("auditor", new Date(NOW.getTime() + 30 * DAY_MS))] },
};

describe("the six roles", () => {
  it("are the plan's six, each as an admin level or a program (open points 1 and 2)", () => {
    expect(ROLE_KEYS).toEqual(["owner", "admin", "bookkeeper", "approver", "viewer", "auditor"]);
    expect(ROLES).toEqual([
      { key: "owner", adminLevel: "owner" },
      { key: "admin", adminLevel: "admin" },
      { key: "bookkeeper", program: "bookkeeping", full: true },
      { key: "approver", program: "approval-read", full: false },
      { key: "viewer", program: "read", full: false },
      { key: "auditor", program: "auditor", full: false },
    ]);
    expect(Object.isFrozen(ROLES)).toBe(true);
    for (const role of ROLES) {
      expect(Object.isFrozen(role)).toBe(true);
    }
  });

  it.each(ROLE_KEYS)("a member made the %s holds that role and no other", (role) => {
    expect(rolesOf(MEMBER_OF[role], NOW)).toEqual([role]);
  });

  it("gives the owner and the admin a member's own permissions and a system administrator's, and none of Bokföring's", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(keysOf(MEMBER_OF[role])).toEqual([...MEMBER_PERMISSIONS, ...SYSTEM_ADMINISTRATOR_PERMISSIONS]);
      expect(keysOf(MEMBER_OF[role]).filter((key) => CATALOGUE_PERMISSIONS.some((permission) => permission.key === key))).toEqual([]);
    }
  });

  it("gives the owner and the admin the same permissions (open point 1)", () => {
    expect(effectivePermissions(MEMBER_OF.owner, NOW)).toEqual(effectivePermissions(MEMBER_OF.admin, NOW));
  });

  it("gives the bookkeeper every right of Bokföring and its Rapporter and Register/Övrigt rights, but none of the six of Bokföring - Attest & Läs and no manual-only right", () => {
    const keys = keysOf(MEMBER_OF.bookkeeper);
    const wanted = [
      ...groupOf("vouchers"),
      ...groupOf("supplier-invoices"),
      ...groupOf("reports"),
      ...groupOf("register"),
    ].filter((key) => !APPROVAL_READ_ONLY.includes(key) && !MANUAL_ONLY.includes(key));
    expect(keys).toEqual(["company:read", ...wanted]);
    expect(wanted).toHaveLength(17 + 13 + 18 + 7);
    for (const key of [...APPROVAL_READ_ONLY, ...MANUAL_ONLY]) {
      expect(keys).not.toContain(key);
    }
  });

  it.each(["approver", "viewer", "auditor"] as const)("gives the %s only its program's set", (role) => {
    const program = { approver: "approval-read", viewer: "read", auditor: "auditor" } as const;
    expect(keysOf(MEMBER_OF[role])).toEqual(["company:read", ...fullPermissions(program[role])]);
  });

  it("gives the viewer the view rights and the reports of Bokföring, and no action right", () => {
    expect(keysOf(MEMBER_OF.viewer)).toEqual(["company:read", "vouchers.view", "supplier-invoices.view", ...groupOf("reports").filter((key) => !APPROVAL_READ_ONLY.includes(key))]);
  });

  it("gives the auditor Exportera filer and Sie-export only once they are switched on, and the auditor stays the auditor", () => {
    expect(keysOf(MEMBER_OF.auditor)).not.toContain("register.export-files");
    expect(keysOf(MEMBER_OF.auditor)).not.toContain("register.sie-export");
    const end = new Date(NOW.getTime() + DAY_MS);
    const switchedOn: MemberAccess = { ...PLAIN, grants: [{ program: "auditor", permissions: [...fullPermissions("auditor"), "register.sie-export", "register.export-files"], expiresAt: end }] };
    expect(keysOf(switchedOn)).toContain("register.export-files");
    expect(keysOf(switchedOn)).toContain("register.sie-export");
    expect(rolesOf(switchedOn, NOW)).toEqual(["auditor"]);
  });

  it("makes a narrowed Bokföring no bookkeeper, while a narrowed program of the other three keeps its role", () => {
    const narrowed = (program: Program): MemberAccess => ({ ...PLAIN, grants: [{ program, permissions: ["vouchers.view"], expiresAt: null }] });
    expect(rolesOf(narrowed("bookkeeping"), NOW)).toEqual([]);
    expect(rolesOf(narrowed("approval-read"), NOW)).toEqual(["approver"]);
    expect(rolesOf(narrowed("read"), NOW)).toEqual(["viewer"]);
    expect(rolesOf({ ...narrowed("auditor"), grants: [{ program: "auditor", permissions: ["vouchers.view"], expiresAt: new Date(NOW.getTime() + DAY_MS) }] }, NOW)).toEqual(["auditor"]);
    // Bokföring with every right of "Full behörighet" and a manual-only one beside them is still the bookkeeper.
    expect(rolesOf({ ...PLAIN, grants: [{ program: "bookkeeping", permissions: programPermissions("bookkeeping"), expiresAt: null }] }, NOW)).toEqual(["bookkeeper"]);
  });

  it("gives a member several roles at once, in the roles' order", () => {
    const many: MemberAccess = {
      adminLevel: "owner",
      grants: [full("auditor", new Date(NOW.getTime() + DAY_MS)), full("bookkeeping"), full("read"), full("approval-read")],
      programsAdministered: ["bookkeeping"],
    };
    expect(rolesOf(many, NOW)).toEqual(["owner", "bookkeeper", "approver", "viewer", "auditor"]);
    expect(rolesOf({ ...many, adminLevel: "admin" }, NOW)).toEqual(["admin", "bookkeeper", "approver", "viewer", "auditor"]);
  });

  it("gives no role to a plain member, nor to a program administrator by being one", () => {
    expect(rolesOf(PLAIN, NOW)).toEqual([]);
    expect(rolesOf({ ...PLAIN, programsAdministered: ["bookkeeping", "auditor"] }, NOW)).toEqual([]);
  });
});

describe("the effective permissions", () => {
  it("gives a plain member reading the company, with no end", () => {
    expect(effectivePermissions(PLAIN, NOW)).toEqual(new Map([["company:read", null]]));
  });

  it("gives a program administrator a program administrator's permissions and none of the programs' rights", () => {
    const administrator: MemberAccess = { ...PLAIN, programsAdministered: ["bookkeeping"] };
    expect(keysOf(administrator)).toEqual([...MEMBER_PERMISSIONS, ...PROGRAM_ADMINISTRATOR_PERMISSIONS]);
  });

  it("ends a Revisor grant's rights at its end, also at the very millisecond, and gives the end with each one", () => {
    const end = new Date(NOW.getTime() + 30 * DAY_MS);
    const auditor: MemberAccess = { ...PLAIN, grants: [full("auditor", end)] };
    const before = effectivePermissions(auditor, new Date(end.getTime() - 1));
    expect([...before.keys()]).toEqual(["company:read", ...fullPermissions("auditor")]);
    expect(before.get("company:read")).toBeNull();
    for (const permission of fullPermissions("auditor")) {
      expect(before.get(permission)).toEqual(end);
    }
    expect([...effectivePermissions(auditor, end).keys()]).toEqual(["company:read"]);
    expect([...effectivePermissions(auditor, new Date(end.getTime() + DAY_MS)).keys()]).toEqual(["company:read"]);
    expect(grantHolds({ expiresAt: end }, new Date(end.getTime() - 1))).toBe(true);
    expect(grantHolds({ expiresAt: end }, end)).toBe(false);
    expect(grantHolds({ expiresAt: null }, new Date("2999-12-31T00:00:00.000Z"))).toBe(true);
  });

  it("gives a right with no end while a grant with no end gives it, and otherwise with the latest end of the grants that give it", () => {
    const soon = new Date(NOW.getTime() + DAY_MS);
    const later = new Date(NOW.getTime() + 20 * DAY_MS);
    const both: MemberAccess = { ...PLAIN, grants: [full("auditor", soon), full("read")] };
    const given = effectivePermissions(both, NOW);
    // Läs gives the view rights and the reports with no end; only the auditor gives the two "Se skapad av".
    expect(given.get("vouchers.view")).toBeNull();
    expect(given.get("reports.processing-history")).toBeNull();
    expect(given.get("vouchers.created-by")).toEqual(soon);
    expect(given.get("supplier-invoices.created-by")).toEqual(soon);
    const twoEnds: MemberAccess = {
      ...PLAIN,
      grants: [
        { program: "auditor", permissions: ["vouchers.view", "vouchers.created-by"], expiresAt: soon },
        { program: "auditor", permissions: ["vouchers.view"], expiresAt: later },
      ],
    };
    expect(effectivePermissions(twoEnds, NOW).get("vouchers.view")).toEqual(later);
    expect(effectivePermissions(twoEnds, NOW).get("vouchers.created-by")).toEqual(soon);
    // Once the first has ended, only the second gives anything.
    expect([...effectivePermissions(twoEnds, soon).keys()]).toEqual(["company:read", "vouchers.view"]);
  });

  it("gives the union of the grants' rights, in the catalogue's order, each once", () => {
    const two: MemberAccess = {
      ...PLAIN,
      grants: [
        { program: "read", permissions: ["reports.vat", "vouchers.view"], expiresAt: null },
        { program: "approval-read", permissions: ["vouchers.see-all-series", "vouchers.view", "reports.vat"], expiresAt: null },
      ],
    };
    expect(keysOf(two)).toEqual(["company:read", "vouchers.view", "vouchers.see-all-series", "reports.vat"]);
  });

  it("gives only the rights of a grant that its program's set holds, and an action right only beside its group's view right in the same grant", () => {
    // The database refuses such grants. A grant made before a change of the catalogue gives no more than the catalogue now allows.
    const odd: MemberAccess = {
      ...PLAIN,
      grants: [
        { program: "read", permissions: ["vouchers.view", "vouchers.book", "register.anonymise-fiscal-year", "company:read", "made-up.right", ""], expiresAt: null },
        { program: "bookkeeping", permissions: ["supplier-invoices.save", "reports.supplier-invoices", "register.removed-users"], expiresAt: null },
      ],
    };
    expect(keysOf(odd)).toEqual(["company:read", "vouchers.view", "register.removed-users"]);
    expect(grantRights({ program: "read", permissions: ["vouchers.book", "vouchers.view", "vouchers.view"] })).toEqual(["vouchers.view"]);
    expect(grantRights({ program: "bookkeeping", permissions: ["vouchers.book", "vouchers.view"] })).toEqual(["vouchers.view", "vouchers.book"]);
    expect(grantRights({ program: "bookkeeping", permissions: ["vouchers.book"] })).toEqual([]);
    expect(grantRights({ program: "bookkeeping", permissions: ["register.projects"] })).toEqual(["register.projects"]);
  });

  it("gives a grant's rights however far in the past it was granted, until its end", () => {
    const longAgo: MemberAccess = { ...PLAIN, grants: [{ program: "read", permissions: ["vouchers.view"], expiresAt: null }] };
    expect(keysOf(longAgo, new Date("2999-12-31T00:00:00.000Z"))).toEqual(["company:read", "vouchers.view"]);
  });

  it("gives a new map each call, and leaves the member as it was", () => {
    const access: MemberAccess = Object.freeze({ ...PLAIN, grants: Object.freeze([Object.freeze(full("bookkeeping"))]) });
    const first = effectivePermissions(access, NOW);
    first.delete("vouchers.view");
    expect(effectivePermissions(access, NOW).has("vouchers.view")).toBe(true);
    expect(access.grants[0]?.permissions).toEqual(fullPermissions("bookkeeping"));
  });

  it("is what the package exports", () => {
    expect(contract.ROLES).toBe(ROLES);
    expect(contract.ROLE_KEYS).toBe(ROLE_KEYS);
    expect(contract.effectivePermissions).toBe(effectivePermissions);
    expect(contract.grantHolds).toBe(grantHolds);
    expect(contract.grantRights).toBe(grantRights);
    expect(contract.rolesOf).toBe(rolesOf);
    expect(contract.PROGRAM_ADMINISTRATOR_PERMISSIONS).toBe(PROGRAM_ADMINISTRATOR_PERMISSIONS);
  });
});
