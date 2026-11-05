// SPDX-License-Identifier: AGPL-3.0-only

// The behandlingshistorik entries that change no company row, such as a
// sign-in (db/README.md, the schema access). Each is a row of access.events
// in its company, and its insert's history row is the entry, with the actor,
// its kind and the channel. The app may only add one; no role changes or
// deletes one.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { aCompany, asMember, type Company } from "../../../test/memberships.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row, and for a column that may not be null. */
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";

const INSERT = "INSERT INTO access.events (company_id, program, heading, subject_id, details, at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id";

describe("the entries that change no company row", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await aCompany(app);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Adds an entry as the app, as the company's owner through REST, and gives its id. */
  async function addEvent(details: unknown = { method: "password-email", outcome: "signed-in" }, heading = "sign-in", program = "users"): Promise<string> {
    const [row] = await asMember<{ id: string }>(app, company.id, company.asOwner, INSERT, [
      company.id,
      program,
      heading,
      company.owner,
      details,
      "2030-05-15T08:30:00Z",
    ]);
    if (row === undefined) {
      throw new Error("The entry was not added.");
    }
    return row.id;
  }

  it("writes the entry's history row with the event, the actor, its kind and the channel", async () => {
    const id = await addEvent({ method: "password-email", secondStep: "totp", application: "web", outcome: "signed-in" });
    const found = await inTransaction(app, { company: company.id }, () =>
      app.query<{ operation: string; values: Record<string, unknown>; actor_id: string; actor_kind: string; channel: string }>(
        "SELECT operation, new_values AS values, actor_id, actor_kind, channel FROM audit.history WHERE table_name = 'access.events' AND row_id = $1",
        [id],
      ),
    );
    expect(found.rows).toEqual([
      {
        operation: "INSERT",
        values: {
          id,
          company_id: company.id,
          program: "users",
          heading: "sign-in",
          subject_id: company.owner,
          details: { method: "password-email", secondStep: "totp", application: "web", outcome: "signed-in" },
          at: "2030-05-15T08:30:00+00:00",
        },
        actor_id: company.owner,
        actor_kind: "user",
        channel: "rest",
      },
    ]);
  });

  it("lets the app only add an entry, and refuses a change or a deletion from the owner too", async () => {
    const id = await addEvent();
    for (const sql of ["UPDATE access.events SET heading = 'sign-out' WHERE id = $1", "DELETE FROM access.events WHERE id = $1"]) {
      await expectError(asMember(app, company.id, company.asOwner, sql, [id]), INSUFFICIENT_PRIVILEGE, /permission denied for table events/);
    }
    for (const [sql, operation] of [
      ["UPDATE access.events SET heading = 'sign-out' WHERE id = $1", "UPDATE"],
      ["DELETE FROM access.events WHERE id = $1", "DELETE"],
    ] as const) {
      await expectRefusal(
        inTransaction(owner, { company: company.id, ...company.asOwner }, () => owner.query(sql, [id])),
        "append_only",
        { table: "access.events", operation },
      );
    }
  });

  it("takes a program and a heading in kebab-case, details as an object, a known person and the time the server gives", async () => {
    await expectError(addEvent({}, "Inloggning"), CHECK_VIOLATION, /events_heading_form/);
    await expectError(addEvent({}, "sign-in", "Användare"), CHECK_VIOLATION, /events_program_form/);
    await expectError(addEvent(JSON.stringify(["password-email"])), CHECK_VIOLATION, /events_details_object/);
    await expectError(
      asMember(app, company.id, company.asOwner, INSERT, [company.id, "users", "sign-in", randomUUID(), {}, "2030-05-15T08:30:00Z"]),
      FOREIGN_KEY_VIOLATION,
      /events_subject_id_fkey/,
    );
    await expectError(asMember(app, company.id, company.asOwner, INSERT, [company.id, "users", "sign-in", null, {}, null]), NOT_NULL_VIOLATION, /"at"/);
    // An entry about no one person, such as a client's own, is taken.
    await asMember(app, company.id, company.asOwner, INSERT, [company.id, "users", "sign-in", null, {}, "2030-05-15T08:30:00Z"]);
  });

  it("refuses an entry in another company than the transaction's", async () => {
    const other = await aCompany(app, "Testbolaget Beta AB");
    await expectError(
      asMember(app, company.id, company.asOwner, INSERT, [other.id, "users", "sign-in", null, {}, "2030-05-15T08:30:00Z"]),
      INSUFFICIENT_PRIVILEGE,
      /row-level security/,
    );
  });
});
