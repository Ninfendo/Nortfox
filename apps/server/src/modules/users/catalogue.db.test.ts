// SPDX-License-Identifier: AGPL-3.0-only

// The permission catalogue as the database holds it (db/README.md, the
// schema access). Migration 0009 seeds the programs, the groups, the
// permissions and each program's set, and they are the contract's, row by
// row and in order (packages/contract/src/access/catalogue.ts). They are
// public install-wide tables: the app reads every row, with or without a
// person or a company set, and writes none; a reader reads none.

import { CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS, CATALOGUE_PROGRAMS, PROGRAM_PERMISSIONS } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, freshDatabase, inTransaction, type Settings, type TestDatabase } from "../../../test/database.ts";
import { aCompany, type Company } from "../../../test/memberships.ts";

/** The four tables of the catalogue. */
const TABLES = ["access.catalogue_programs", "access.catalogue_groups", "access.catalogue_permissions", "access.catalogue_program_permissions"] as const;

describe("the permission catalogue in the database", () => {
  let db: TestDatabase;
  let app: Client;
  let company: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await aCompany(app);
  });

  afterAll(async () => {
    await db.close();
  });

  /** The rows of `sql`, read as the app with `settings`. */
  async function rows<T extends object>(sql: string, settings: Settings = {}): Promise<T[]> {
    return inTransaction(app, settings, async () => (await app.query<T>(sql)).rows);
  }

  it("holds the contract's programs, in order, with their screen words and the days after which a grant ends by itself", async () => {
    expect(
      await rows<{ key: string; label: string; lifetimeDays: number | null }>(
        'SELECT program AS key, label, lifetime_days AS "lifetimeDays" FROM access.catalogue_programs ORDER BY position',
      ),
    ).toEqual(CATALOGUE_PROGRAMS);
  });

  it("holds the contract's groups, in order, with their kinds and screen words", async () => {
    expect(await rows("SELECT group_key AS key, kind, label FROM access.catalogue_groups ORDER BY position")).toEqual(CATALOGUE_GROUPS);
  });

  it("holds the contract's permissions, in order, with their groups, screen words, view marks and manual-only marks", async () => {
    expect(
      await rows(
        `SELECT permission AS key, group_key AS "group", label, is_view AS view, manual_only AS "manualOnly" FROM access.catalogue_permissions ORDER BY position`,
      ),
    ).toEqual(CATALOGUE_PERMISSIONS);
  });

  it("holds the contract's program sets, program by program in the catalogue's order, each with whether Full behörighet holds it", async () => {
    expect(
      await rows(`
        SELECT s.program, s.permission, s.in_full AS "inFull"
        FROM access.catalogue_program_permissions AS s
        JOIN access.catalogue_programs AS g ON g.program = s.program
        JOIN access.catalogue_permissions AS p ON p.permission = s.permission
        ORDER BY g.position, p.position`),
    ).toEqual(PROGRAM_PERMISSIONS);
  });

  it("numbers each table's positions from 1 without a gap", async () => {
    for (const table of TABLES.slice(0, 3)) {
      const found = await rows<{ positions: number[] }>(`SELECT array_agg(position ORDER BY position) AS positions FROM ${table}`);
      const positions = found[0]?.positions ?? [];
      expect(positions, table).toEqual(positions.map((_position, index) => index + 1));
    }
  });

  it("lets the app read every row with no setting, with a person, and in a company, and a reader nothing", async () => {
    const counts = async (settings: Settings): Promise<number[]> => {
      const found: number[] = [];
      for (const table of TABLES) {
        found.push(Number((await rows<{ count: bigint }>(`SELECT count(*) AS count FROM ${table}`, settings))[0]?.count));
      }
      return found;
    };
    const all = [CATALOGUE_PROGRAMS.length, CATALOGUE_GROUPS.length, CATALOGUE_PERMISSIONS.length, PROGRAM_PERMISSIONS.length];
    expect(await counts({})).toEqual(all);
    expect(await counts({ actor: company.owner, kind: "user" })).toEqual(all);
    expect(await counts({ company: company.id, actor: company.owner, kind: "user", channel: "rest" })).toEqual(all);
    const reader = await db.connect("readerA");
    for (const table of TABLES) {
      await expectError(reader.query(`SELECT * FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table catalogue_/);
    }
  });

  it.each([
    ["add a program", "INSERT INTO access.catalogue_programs (program, position, label) VALUES ('payroll', 5, 'Lön')"],
    ["rename a program", "UPDATE access.catalogue_programs SET label = 'Bokföring Plus'"],
    ["delete a group", "DELETE FROM access.catalogue_groups"],
    [
      "add a permission",
      "INSERT INTO access.catalogue_permissions (permission, position, group_key, label, is_view, manual_only) VALUES ('vouchers.fly', 99, 'vouchers', 'Flyg', false, false)",
    ],
    ["take a manual-only mark off", "UPDATE access.catalogue_permissions SET manual_only = false"],
    ["put a right in Full behörighet", "UPDATE access.catalogue_program_permissions SET in_full = true"],
    ["give a program a right", "INSERT INTO access.catalogue_program_permissions (program, permission, in_full) VALUES ('read', 'vouchers.book', true)"],
    ["empty a program set", "TRUNCATE access.catalogue_program_permissions"],
  ])("refuses the app to %s", async (_case, sql) => {
    await expectError(
      inTransaction(app, { company: company.id, ...company.asOwner, channel: "rest" }, () => app.query(sql)),
      INSUFFICIENT_PRIVILEGE,
      /permission denied for table catalogue_/,
    );
  });
});
