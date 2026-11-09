// SPDX-License-Identifier: AGPL-3.0-only

// The history of rights (issue 12, done-when R14; "What the law requires":
// who granted what to whom, when, and when it ended, kept and never changed).
// Every grant, change, move and withdrawal of a program, every appointment
// and removal of a program administrator, and every change of a system
// administrator's level leaves a row in the behandlingshistorik, through
// 2a's history trigger: the operation, the old and the new row, the actor
// and its kind. The app cannot change or delete such a row, and the owner
// neither.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addGrant, addProgramAdmin, changeGrant } from "../../../test/grants.ts";
import type { Actor } from "../../../test/ledger.ts";
import { aCompany, addMembership, asMember, changeMembership, type Company } from "../../../test/memberships.ts";

/** A history row of the rights, as the app reads it. */
interface RightsRow {
  readonly id: string;
  readonly table_name: string;
  readonly row_id: string;
  readonly operation: string;
  readonly old_values: Record<string, unknown> | null;
  readonly new_values: Record<string, unknown> | null;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly channel: string | null;
}

describe("the history of rights", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: Company;
  let member: string;
  let target: string;
  let admin: Actor;
  let grant: string;
  let programAdmin: string;
  let systemAdmin: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await aCompany(app);
    member = await addMembership(app, owner, company);
    target = await addMembership(app, owner, company);
    // A second system administrator, made one by the owner, who then acts too.
    systemAdmin = await addMembership(app, owner, company);
    await changeMembership(app, company, systemAdmin, "admin_level = 'admin'");
    const [row] = await asMember<{ user_id: string }>(app, company.id, company.asOwner, "SELECT user_id FROM access.memberships WHERE id = $1", [systemAdmin]);
    admin = { actor: row?.user_id ?? "", kind: "user" };
    // A grant to the member, narrowed, moved to the target, and withdrawn.
    grant = (await addGrant(app, company, member, "bookkeeping", ["vouchers.view", "vouchers.book", "reports.vat"])).id;
    await changeGrant(app, company, grant, "permissions = $2", [["vouchers.view", "reports.vat"]], admin);
    await changeGrant(app, company, grant, "membership_id = $2", [target]);
    await asMember(app, company.id, admin, "DELETE FROM access.program_grants WHERE id = $1", [grant]);
    // The member is made the administrator of Bokföring, and then no more.
    programAdmin = await addProgramAdmin(app, company, member, "bookkeeping");
    await asMember(app, company.id, admin, "DELETE FROM access.program_admins WHERE id = $1", [programAdmin]);
    // The second system administrator is one no more.
    await changeMembership(app, company, systemAdmin, "admin_level = NULL", [], admin);
  });

  afterAll(async () => {
    await db.close();
  });

  /** The history rows of one row of a table, in the order they were written, as the app reads them in the company. */
  async function historyOf(table: string, id: string): Promise<RightsRow[]> {
    return asMember<RightsRow>(
      app,
      company.id,
      company.asOwner,
      "SELECT id, table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, channel FROM audit.history WHERE table_name = $1 AND row_id = $2 ORDER BY id",
      [table, id],
    );
  }

  it("keeps each grant, its narrowing, its move and its withdrawal, with the old and new row, who did it and how", async () => {
    const rows = await historyOf("access.program_grants", grant);
    expect(rows.map((row) => [row.operation, row.actor_id, row.actor_kind, row.channel])).toEqual([
      ["INSERT", company.owner, "user", "rest"],
      ["UPDATE", admin.actor, "user", "rest"],
      ["UPDATE", company.owner, "user", "rest"],
      ["DELETE", admin.actor, "user", "rest"],
    ]);
    const [granted, narrowed, moved, withdrawn] = rows;
    expect(granted?.old_values).toBeNull();
    expect(granted?.new_values).toMatchObject({
      membership_id: member,
      program: "bookkeeping",
      permissions: ["vouchers.view", "vouchers.book", "reports.vat"],
      is_full: false,
    });
    expect(narrowed?.old_values).toMatchObject({ permissions: ["vouchers.view", "vouchers.book", "reports.vat"] });
    expect(narrowed?.new_values).toMatchObject({ membership_id: member, permissions: ["vouchers.view", "reports.vat"] });
    expect(moved?.old_values).toMatchObject({ membership_id: member });
    expect(moved?.new_values).toMatchObject({ membership_id: target, permissions: ["vouchers.view", "reports.vat"] });
    expect(withdrawn?.old_values).toMatchObject({ membership_id: target, program: "bookkeeping" });
    expect(withdrawn?.new_values).toBeNull();
    // The time of the grant is in every row, so the history says when it was granted and when it ended.
    for (const row of rows) {
      expect(row.old_values?.["granted_at"] ?? row.new_values?.["granted_at"]).toBe(granted?.new_values?.["granted_at"]);
    }
  });

  it("keeps each appointment and removal of a program administrator", async () => {
    const rows = await historyOf("access.program_admins", programAdmin);
    expect(rows.map((row) => [row.operation, row.actor_id, row.old_values, row.new_values])).toEqual([
      ["INSERT", company.owner, null, { id: programAdmin, company_id: company.id, membership_id: member, program: "bookkeeping" }],
      ["DELETE", admin.actor, { id: programAdmin, company_id: company.id, membership_id: member, program: "bookkeeping" }, null],
    ]);
  });

  it("keeps each change of a system administrator's level", async () => {
    const rows = (await historyOf("access.memberships", systemAdmin)).filter((row) => row.operation === "UPDATE");
    expect(rows.map((row) => [row.actor_id, row.old_values?.["admin_level"], row.new_values?.["admin_level"]])).toEqual([
      [company.owner, null, "admin"],
      [admin.actor, "admin", null],
    ]);
  });

  it("lets the app neither change nor delete one of these rows, and refuses the owner both", async () => {
    const rows = [
      ...(await historyOf("access.program_grants", grant)),
      ...(await historyOf("access.program_admins", programAdmin)),
      ...(await historyOf("access.memberships", systemAdmin)),
    ];
    // The grant's four, the administrator's two, and the membership's insert and two changes.
    expect(rows.length).toBe(9);
    const ids = rows.map((row) => row.id);
    for (const sql of ["UPDATE audit.history SET new_values = '{}' WHERE id = ANY ($1)", "DELETE FROM audit.history WHERE id = ANY ($1)"]) {
      await expectError(asMember(app, company.id, company.asOwner, sql, [ids]), INSUFFICIENT_PRIVILEGE, /permission denied for table history/);
    }
    for (const [sql, operation] of [
      ["UPDATE audit.history SET new_values = '{}' WHERE id = ANY ($1)", "UPDATE"],
      ["DELETE FROM audit.history WHERE id = ANY ($1)", "DELETE"],
    ] as const) {
      await expectRefusal(
        inTransaction(owner, { company: company.id, ...company.asOwner }, () => owner.query(sql, [ids])),
        "append_only",
        { table: "audit.history", operation },
      );
    }
    expect([
      ...(await historyOf("access.program_grants", grant)),
      ...(await historyOf("access.program_admins", programAdmin)),
      ...(await historyOf("access.memberships", systemAdmin)),
    ]).toEqual(rows);
  });
});
