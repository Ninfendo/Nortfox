// SPDX-License-Identifier: AGPL-3.0-only

// The program grants and the program administrators (issue 12, "Roles,
// admin levels, programs and permissions"; db/README.md, the schema access).
// Both are company tables, so every change is in the behandlingshistorik
// (rights-history.db.test.ts). The grants' trigger holds each grant to the
// catalogue, for every role:
// - a grant holds only its program's permissions (not_in_program, NF024);
// - an action right needs its group's view right (view_permission_missing,
//   NF023, open point 4); a Rapporter or Register/Övrigt right stands alone;
// - the list is kept once each, in the catalogue's order;
// - is_full says whether the grant holds every right of the program's "Full
//   behörighet", and the trigger sets it;
// - the time of the grant, and for a Revisor grant its end 30 days later
//   (open point 3), are the trigger's, never given and never changed, and
//   neither is the program. A move to another member keeps them.
// A program administrator is a member and a program, once, and never
// changes: it is appointed and removed.

import { PROGRAMS, fullPermissions, programPermissions } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type TestDatabase,
} from "../../../test/database.ts";
import { GRANT_COLUMNS, addGrant, addProgramAdmin, changeGrant, type GrantRow } from "../../../test/grants.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

/** Thirty days, in seconds. */
const THIRTY_DAYS = 30 * 24 * 60 * 60;

describe("the program grants", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: Company;
  let other: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await aCompany(app);
    other = await aCompany(app, "Testbolaget Beta AB");
  });

  afterAll(async () => {
    await db.close();
  });

  /** A new active member of the company, by its membership's id. */
  async function aMember(): Promise<string> {
    return addMembership(app, owner, company);
  }

  /** Grants `program` with `permissions` to a new member of the company. */
  async function grant(program: string, permissions: readonly (string | null)[]): Promise<GrantRow> {
    return addGrant(app, company, await aMember(), program, permissions);
  }

  describe("the program's set", () => {
    it.each([
      ["Läs, an action right", "read", ["vouchers.view", "vouchers.book"], "vouchers.book"],
      ["Bokföring - Attest & Läs, an action right of Bokföring", "approval-read", ["vouchers.view", "vouchers.book"], "vouchers.book"],
      ["Bokföring, a right that only Bokföring - Attest & Läs holds", "bookkeeping", ["vouchers.view", "vouchers.see-all-series"], "vouchers.see-all-series"],
      ["Bokföring, a report that only Bokföring - Attest & Läs holds", "bookkeeping", ["reports.supplier-due-list"], "reports.supplier-due-list"],
      ["Revisor, a Register/Övrigt right it cannot switch on", "auditor", ["vouchers.view", "register.suppliers"], "register.suppliers"],
      ["Läs, a manual-only right", "read", ["register.removed-users"], "register.removed-users"],
      ["a permission that the catalogue does not hold", "bookkeeping", ["vouchers.view", "vouchers.fly"], "vouchers.fly"],
      [
        "the first of several, in the order given",
        "bookkeeping",
        ["vouchers.view", "reports.supplier-invoices", "vouchers.see-all-series"],
        "reports.supplier-invoices",
      ],
    ])("refuses %s, naming the permission and the program (not_in_program)", async (_case, program, permissions, permission) => {
      await expectRefusal(grant(program, permissions), "not_in_program", { permission, program });
    });

    it("refuses a missing permission in the list", async () => {
      await expectRefusal(grant("bookkeeping", ["vouchers.view", null]), "not_in_program", { permission: null, program: "bookkeeping" });
    });

    it("refuses an update that gives the grant a right outside its program", async () => {
      const row = await grant("read", ["vouchers.view"]);
      await expectRefusal(changeGrant(app, company, row.id, "permissions = $2", [["vouchers.view", "vouchers.book"]]), "not_in_program", {
        permission: "vouchers.book",
        program: "read",
      });
    });

    it.each(PROGRAMS)("takes every right of %s, Full behörighet and those by hand", async (program) => {
      expect((await grant(program, programPermissions(program))).permissions).toEqual(programPermissions(program));
    });

    it("refuses a program that the catalogue does not hold", async () => {
      await expectError(grant("payroll", []), FOREIGN_KEY_VIOLATION, /program_grants_program_fkey/);
    });
  });

  describe("the view rule (open point 4)", () => {
    it.each([
      ["Bokför without Verifikationer", ["vouchers.book"], "vouchers.book", "vouchers.view"],
      [
        "Makulera without Leverantörsfakturor, though Verifikationer is on",
        ["vouchers.view", "supplier-invoices.void"],
        "supplier-invoices.void",
        "supplier-invoices.view",
      ],
      [
        "the first of several, in the order given",
        ["vouchers.view", "supplier-invoices.save", "vouchers.book", "supplier-invoices.void"],
        "supplier-invoices.save",
        "supplier-invoices.view",
      ],
    ])("refuses %s, naming the permission and its view right (view_permission_missing)", async (_case, permissions, permission, view) => {
      await expectRefusal(grant("bookkeeping", permissions), "view_permission_missing", { permission, view });
    });

    it("refuses an update that takes the view right off and keeps an action right", async () => {
      const row = await grant("bookkeeping", ["vouchers.view", "vouchers.book"]);
      await expectRefusal(changeGrant(app, company, row.id, "permissions = $2", [["vouchers.book"]]), "view_permission_missing", {
        permission: "vouchers.book",
        view: "vouchers.view",
      });
    });

    it("checks the program's set before the view rule", async () => {
      await expectRefusal(grant("read", ["vouchers.book"]), "not_in_program", { permission: "vouchers.book", program: "read" });
    });

    it("takes a Rapporter or Register/Övrigt right alone, a view right alone, an action right with its view right, and no right at all", async () => {
      for (const permissions of [["reports.vat"], ["register.sie-export"], ["vouchers.view"], ["supplier-invoices.view", "supplier-invoices.void"], []]) {
        expect((await grant("bookkeeping", permissions)).permissions).toEqual(permissions);
      }
    });
  });

  it("keeps the permissions once each, in the catalogue's order", async () => {
    const row = await grant("bookkeeping", ["reports.vat", "vouchers.book", "vouchers.view", "vouchers.book", "register.suppliers", "reports.vat"]);
    expect(row.permissions).toEqual(["vouchers.view", "vouchers.book", "reports.vat", "register.suppliers"]);
    const changed = await changeGrant(app, company, row.id, "permissions = $2", [["register.suppliers", "vouchers.view", "vouchers.view"]]);
    expect(changed?.permissions).toEqual(["vouchers.view", "register.suppliers"]);
  });

  describe("Full behörighet", () => {
    it.each(PROGRAMS)("marks a grant of %s full when it holds every right of Full behörighet, in any order", async (program) => {
      expect((await grant(program, [...fullPermissions(program)].reverse())).is_full).toBe(true);
    });

    it("keeps a grant full with a right by hand beside Full behörighet, and makes it not full when one right of it is off", async () => {
      expect((await grant("bookkeeping", [...fullPermissions("bookkeeping"), "register.anonymise-fiscal-year"])).is_full).toBe(true);
      expect((await grant("auditor", [...fullPermissions("auditor"), "register.export-files"])).is_full).toBe(true);
      expect(
        (
          await grant(
            "bookkeeping",
            fullPermissions("bookkeeping").filter((permission) => permission !== "reports.vat"),
          )
        ).is_full,
      ).toBe(false);
      expect((await grant("read", ["vouchers.view"])).is_full).toBe(false);
    });

    it("sets it again at each change: narrowed, it is not full, and widened back, it is", async () => {
      const row = await grant("read", fullPermissions("read"));
      expect(row.is_full).toBe(true);
      expect((await changeGrant(app, company, row.id, "permissions = $2", [["vouchers.view", "supplier-invoices.view"]]))?.is_full).toBe(false);
      expect((await changeGrant(app, company, row.id, "permissions = $2", [fullPermissions("read")]))?.is_full).toBe(true);
    });

    it("refuses a mark that is given, on a new grant and by an update, from the owner too", async () => {
      const member = await aMember();
      await expectRefusal(
        asMember(
          app,
          company.id,
          company.asOwner,
          "INSERT INTO access.program_grants (company_id, membership_id, program, permissions, is_full) VALUES ($1, $2, 'read', '{}', false)",
          [company.id, member],
        ),
        "immutable_field",
        { field: "is_full", operation: "create" },
      );
      const row = await grant("read", ["vouchers.view"]);
      await expectRefusal(changeGrant(app, company, row.id, "is_full = true"), "immutable_field", { field: "is_full", operation: "update" });
      await expectRefusal(
        inTransaction(owner, { company: company.id, ...company.asOwner }, () =>
          owner.query("UPDATE access.program_grants SET is_full = true WHERE id = $1", [row.id]),
        ),
        "immutable_field",
        { field: "is_full", operation: "update" },
      );
    });
  });

  describe("the time of a grant and the Revisor's end (open point 3)", () => {
    it("stamps the time of every grant by the database's clock, and ends a Revisor grant 30 days later, and no other program's", async () => {
      const before = Date.now();
      for (const program of PROGRAMS) {
        const row = await grant(program, fullPermissions(program));
        const granted = new Date(row.granted_at).getTime();
        expect(granted, program).toBeGreaterThanOrEqual(before - 60_000);
        expect(granted, program).toBeLessThanOrEqual(Date.now() + 60_000);
        if (program === "auditor") {
          expect(new Date(row.expires_at ?? "").getTime() - granted).toBe(THIRTY_DAYS * 1000);
        } else {
          expect(row.expires_at, program).toBeNull();
        }
      }
    });

    it.each([
      ["the time of the grant", "granted_at", "granted_at", "'2030-05-15 08:30:00+00'"],
      ["an end", "expires_at", "expires_at", "'2090-01-01 00:00:00+00'"],
    ])("refuses %s that is given on a new grant", async (_case, column, field, value) => {
      await expectRefusal(
        asMember(
          app,
          company.id,
          company.asOwner,
          `INSERT INTO access.program_grants (company_id, membership_id, program, permissions, ${column}) VALUES ($1, $2, 'auditor', '{}', ${value})`,
          [company.id, await aMember()],
        ),
        "immutable_field",
        { field, operation: "create" },
      );
    });

    it.each([
      ["the end", "expires_at = expires_at + interval '30 days'", "expires_at"],
      ["the end, to none", "expires_at = NULL", "expires_at"],
      ["the time of the grant", "granted_at = granted_at - interval '1 day'", "granted_at"],
      ["the program", "program = 'read'", "program"],
      ["the id", "id = gen_random_uuid()", "id"],
    ])("never changes %s of a grant, from the owner neither", async (_case, set, field) => {
      const row = await grant("auditor", ["vouchers.view"]);
      await expectRefusal(changeGrant(app, company, row.id, set), "immutable_field", { field, operation: "update" });
      await expectRefusal(
        inTransaction(owner, { company: company.id, ...company.asOwner }, () => owner.query(`UPDATE access.program_grants SET ${set} WHERE id = $1`, [row.id])),
        "immutable_field",
        { field, operation: "update" },
      );
    });

    it("keeps a Revisor grant's time and end when the grant moves to another member, narrowed or not", async () => {
      const row = await grant("auditor", fullPermissions("auditor"));
      const target = await aMember();
      const moved = await changeGrant(app, company, row.id, "membership_id = $2, permissions = $3", [target, ["vouchers.view", "reports.vat"]]);
      expect(moved).toEqual({ ...row, membership_id: target, permissions: ["vouchers.view", "reports.vat"], is_full: false });
    });
  });

  it("grants a program once to a member, and the same program to other members, and other programs to the same member", async () => {
    const member = await aMember();
    await addGrant(app, company, member, "read", ["vouchers.view"]);
    await expectError(addGrant(app, company, member, "read", []), UNIQUE_VIOLATION, /program_grants_once/);
    await addGrant(app, company, member, "approval-read", ["vouchers.view"]);
    await addGrant(app, company, await aMember(), "read", ["vouchers.view"]);
  });

  it("holds a grant to a membership of its own company, also when it moves", async () => {
    const theirs = await addMembership(app, owner, other);
    await expectError(addGrant(app, company, theirs, "read", []), FOREIGN_KEY_VIOLATION, /program_grants_membership_fkey/);
    await expectError(addGrant(app, company, randomUUID(), "read", []), FOREIGN_KEY_VIOLATION, /program_grants_membership_fkey/);
    const row = await grant("read", []);
    await expectError(changeGrant(app, company, row.id, "membership_id = $2", [theirs]), FOREIGN_KEY_VIOLATION, /program_grants_membership_fkey/);
  });

  it("lets the app grant, change and withdraw a grant in the transaction's company only, and never move one to another company", async () => {
    const row = await grant("read", ["vouchers.view"]);
    const withdrawn = await asMember(app, company.id, company.asOwner, "DELETE FROM access.program_grants WHERE id = $1 RETURNING id", [row.id]);
    expect(withdrawn).toEqual([{ id: row.id }]);
    const theirs = await addMembership(app, owner, other);
    await expectError(
      asMember(
        app,
        company.id,
        company.asOwner,
        "INSERT INTO access.program_grants (company_id, membership_id, program, permissions) VALUES ($1, $2, 'read', '{}')",
        [other.id, theirs],
      ),
      INSUFFICIENT_PRIVILEGE,
      /row-level security/,
    );
    const kept = await grant("read", []);
    await expectRefusal(changeGrant(app, company, kept.id, "company_id = $2", [other.id]), "immutable_field", { field: "company_id", operation: "update" });
    // Another company's transaction sees none of this company's grants.
    const seen = await asMember(app, other.id, other.asOwner, `SELECT ${GRANT_COLUMNS} FROM access.program_grants`);
    expect(seen).toEqual([]);
  });
});

describe("the program administrators", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: Company;
  let other: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await aCompany(app);
    other = await aCompany(app, "Testbolaget Beta AB");
  });

  afterAll(async () => {
    await db.close();
  });

  it("appoints a member once per program, of any program of the catalogue, and removes one", async () => {
    const member = await addMembership(app, owner, company);
    const bookkeeping = await addProgramAdmin(app, company, member, "bookkeeping");
    await expectError(addProgramAdmin(app, company, member, "bookkeeping"), UNIQUE_VIOLATION, /program_admins_once/);
    await addProgramAdmin(app, company, member, "auditor");
    await expectError(addProgramAdmin(app, company, member, "payroll"), FOREIGN_KEY_VIOLATION, /program_admins_program_fkey/);
    const removed = await asMember(app, company.id, company.asOwner, "DELETE FROM access.program_admins WHERE id = $1 RETURNING id", [bookkeeping]);
    expect(removed).toEqual([{ id: bookkeeping }]);
    await addProgramAdmin(app, company, member, "bookkeeping");
  });

  it("holds an administrator to a membership of its own company, and to the transaction's company", async () => {
    const theirs = await addMembership(app, owner, other);
    await expectError(addProgramAdmin(app, company, theirs, "read"), FOREIGN_KEY_VIOLATION, /program_admins_membership_fkey/);
    await expectError(
      asMember(app, company.id, company.asOwner, "INSERT INTO access.program_admins (company_id, membership_id, program) VALUES ($1, $2, 'read')", [
        other.id,
        theirs,
      ]),
      INSUFFICIENT_PRIVILEGE,
      /row-level security/,
    );
  });

  it("lets the app appoint and remove, never change, and refuses the owner a change of any field", async () => {
    const member = await addMembership(app, owner, company);
    const id = await addProgramAdmin(app, company, member, "read");
    await expectError(
      asMember(app, company.id, company.asOwner, "UPDATE access.program_admins SET program = 'auditor' WHERE id = $1", [id]),
      INSUFFICIENT_PRIVILEGE,
      /permission denied for table program_admins/,
    );
    const another = await addMembership(app, owner, company);
    for (const [set, field] of [
      ["program = 'auditor'", "program"],
      [`membership_id = '${another}'`, "membership_id"],
      ["id = gen_random_uuid()", "id"],
      [`company_id = '${other.id}'`, "company_id"],
    ] as const) {
      await expectRefusal(
        inTransaction(owner, { company: company.id, ...company.asOwner }, () => owner.query(`UPDATE access.program_admins SET ${set} WHERE id = $1`, [id])),
        "immutable_field",
        { field, operation: "update" },
      );
    }
  });
});
