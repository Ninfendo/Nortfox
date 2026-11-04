// SPDX-License-Identifier: AGPL-3.0-only

// The safe report of errors that PostgreSQL raises: a check violation, whose
// detail can hold the failing row, and a unique violation on a personnummer,
// whose detail can hold the personnummer. The report names the SQLSTATE, the
// constraint, the schema and the table, and holds nothing of the row.
//
// As nortfox_app, PostgreSQL itself leaves the row out: row level security
// applies to the app on every table, and PostgreSQL then gives no "Failing
// row" and no "Key (...)=(...)". A role that row level security does not
// bind, such as the superuser, gets the row in the detail. The report holds
// it in neither case.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS, addIdentity } from "../../test/identities.ts";
import { errorReport } from "./report.ts";

const NAME = "Malin Ekdahl";
const [TAKEN] = PERSONAL_IDENTITY_NUMBERS;
const BAD_FORM = "1990-01-01-23";

describe("the report of a database error", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let admin: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    admin = await db.admin();
    await addIdentity(owner, { personalIdentityNumber: TAKEN });
  });

  afterAll(async () => {
    await db.close();
  });

  /** The error of a statement as the app, with the person set as the actor. */
  function asApp(person: string, sql: string, params: readonly unknown[]): Promise<unknown> {
    return failureOf(inTransaction(app, { actor: person, kind: "user", channel: "rest" }, () => app.query(sql, [...params])));
  }

  /** The error of a statement as the superuser, whom row level security does not bind. */
  function asSuperuser(sql: string, params: readonly unknown[]): Promise<unknown> {
    return failureOf(inTransaction(admin, {}, () => admin.query(sql, [...params])));
  }

  const SET_NUMBER = "UPDATE access.identities SET personal_identity_number = $1 WHERE id = $2";

  function expectSafe(report: string, left: readonly string[]): void {
    for (const text of [...left, "Failing row", "already exists", "Key ("]) {
      expect(report).not.toContain(text);
    }
  }

  it("of a check violation names the constraint and the table, and nothing of the failing row", async () => {
    const email = "malin.ekdahl@example.com";
    const person = await addIdentity(owner, { name: NAME, email });

    const ofApp = await asApp(person, SET_NUMBER, [BAD_FORM, person]);
    expect(ofApp).toMatchObject({ code: "23514", constraint: "identities_personal_identity_number_form" });
    expect((ofApp as { detail?: unknown }).detail).toBeUndefined();

    const ofSuperuser = await asSuperuser(SET_NUMBER, [BAD_FORM, person]);
    expect(ofSuperuser).toMatchObject({ code: "23514", constraint: "identities_personal_identity_number_form" });
    expect(String((ofSuperuser as { detail?: unknown }).detail)).toContain(email);

    for (const error of [ofApp, ofSuperuser]) {
      const report = errorReport(error);
      expect(report).toContain("code 23514, constraint identities_personal_identity_number_form, schema access, table identities");
      expectSafe(report, [NAME, email, "malin.ekdahl", BAD_FORM, person]);
    }
  });

  it("of a unique violation on a personnummer holds no personnummer", async () => {
    const person = await addIdentity(owner, { name: NAME, email: "malin.e@example.com" });

    const ofApp = await asApp(person, SET_NUMBER, [TAKEN, person]);
    expect(ofApp).toMatchObject({ code: "23505", constraint: "identities_personal_identity_number_key" });
    expect((ofApp as { detail?: unknown }).detail).toBeUndefined();

    const ofSuperuser = await asSuperuser(SET_NUMBER, [TAKEN, person]);
    expect(ofSuperuser).toMatchObject({ code: "23505", constraint: "identities_personal_identity_number_key" });
    expect(String((ofSuperuser as { detail?: unknown }).detail)).toContain(TAKEN);

    for (const error of [ofApp, ofSuperuser]) {
      const report = errorReport(error);
      expect(report).toContain("code 23505, constraint identities_personal_identity_number_key, schema access, table identities");
      expectSafe(report, [TAKEN, TAKEN.replace("-", ""), NAME, person]);
    }
  });
});
