// SPDX-License-Identifier: AGPL-3.0-only

// The work contacts, Användaruppgifter (db/README.md, the schema access): a
// member's work e-mail address and phone number in one company. An
// install-wide table of the company class: the app reads and writes only the
// transaction's company's rows, and the membership pairs with its company in
// the foreign key, so a row never names company A and a membership of
// company B. It keeps no history: the work contacts are profile data, which
// an identity's deletion erases.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { aCompany, asMember, type Company } from "../../../test/memberships.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

const INSERT = "INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email, work_phone) VALUES ($1, $2, $3, $4)";

interface ContactRow {
  readonly contact_company_id: string;
  readonly membership_id: string;
  readonly work_email: string | null;
  readonly work_phone: string | null;
  readonly updated_at: Date;
}

describe("the work contacts", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let alfa: Company;
  let beta: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    beta = await aCompany(app, "Testbolaget Beta AB");
    await asMember(app, alfa.id, alfa.asOwner, INSERT, [alfa.id, alfa.membership, "alfa.ekonomi@example.com", "070-174 06 08"]);
    await asMember(app, beta.id, beta.asOwner, INSERT, [beta.id, beta.membership, "beta.ekonomi@example.com", null]);
  });

  afterAll(async () => {
    await db.close();
  });

  /** The contacts the app reads with `company` set, or none set. */
  async function contacts(company?: string): Promise<ContactRow[]> {
    return inTransaction(app, company === undefined ? {} : { company }, async () =>
      (await app.query<ContactRow>("SELECT * FROM access.membership_contacts ORDER BY work_email")).rows,
    );
  }

  /** The history rows of `company`, as the owner counts them. */
  async function historyCount(company: string): Promise<number> {
    const found = await inTransaction(owner, { company }, () => owner.query<{ count: bigint }>("SELECT count(*) AS count FROM audit.history"));
    return Number(found.rows[0]?.count);
  }

  it("shows the app only the transaction's company's contacts, and none with no company set", async () => {
    expect((await contacts(alfa.id)).map((row) => [row.contact_company_id, row.membership_id, row.work_email, row.work_phone])).toEqual([
      [alfa.id, alfa.membership, "alfa.ekonomi@example.com", "070-174 06 08"],
    ]);
    expect((await contacts(beta.id)).map((row) => row.membership_id)).toEqual([beta.membership]);
    expect(await contacts()).toEqual([]);
  });

  it("refuses a row that names another company's membership, and lets the app change no other company's row", async () => {
    // The membership of B under the company A: the paired foreign key refuses it.
    await expectError(asMember(app, alfa.id, alfa.asOwner, INSERT, [alfa.id, beta.membership, "fel@example.com", null]), FOREIGN_KEY_VIOLATION, /membership_contacts_membership_fkey/);
    // A row of B while A is set: row level security refuses it.
    await expectError(asMember(app, alfa.id, alfa.asOwner, INSERT, [beta.id, beta.membership, "fel@example.com", null]), INSUFFICIENT_PRIVILEGE, /row-level security/);
    const changed = await inTransaction(app, { company: alfa.id, ...alfa.asOwner }, async () => [
      (await app.query("UPDATE access.membership_contacts SET work_phone = '0' WHERE membership_id = $1", [beta.membership])).rowCount,
      (await app.query("DELETE FROM access.membership_contacts WHERE membership_id = $1", [beta.membership])).rowCount,
    ]);
    expect(changed).toEqual([0, 0]);
    expect((await contacts(beta.id)).map((row) => row.work_email)).toEqual(["beta.ekonomi@example.com"]);
  });

  it("writes no history row, and lets the app change and delete its company's row", async () => {
    const before = await historyCount(alfa.id);
    const company = await aCompany(app, "Testbolaget Gamma AB");
    const made = await historyCount(company.id);
    await asMember(app, company.id, company.asOwner, INSERT, [company.id, company.membership, "gamma@example.com", null]);
    await asMember(app, company.id, company.asOwner, "UPDATE access.membership_contacts SET work_phone = '070-174 06 07' WHERE membership_id = $1", [company.membership]);
    await asMember(app, company.id, company.asOwner, "DELETE FROM access.membership_contacts WHERE membership_id = $1", [company.membership]);
    expect(await historyCount(company.id)).toBe(made);
    expect(await historyCount(alfa.id)).toBe(before);
    const admin = await db.admin();
    const rows = await admin.query<{ count: bigint }>("SELECT count(*) AS count FROM audit.history WHERE table_name = 'access.membership_contacts'");
    expect(rows.rows[0]?.count).toBe(0n);
    expect(await contacts(company.id)).toEqual([]);
  });

  it("stamps the time of each change, refuses one that is given, and never moves a row to another membership or company", async () => {
    const company = await aCompany(app, "Testbolaget Delta AB");
    await expectRefusal(
      asMember(app, company.id, company.asOwner, "INSERT INTO access.membership_contacts (contact_company_id, membership_id, updated_at) VALUES ($1, $2, pg_catalog.now())", [
        company.id,
        company.membership,
      ]),
      "immutable_field",
      { field: "updated_at", operation: "create" },
    );
    await asMember(app, company.id, company.asOwner, INSERT, [company.id, company.membership, null, "070-174 06 09"]);
    const [first] = await contacts(company.id);
    await asMember(app, company.id, company.asOwner, "UPDATE access.membership_contacts SET work_email = 'delta.kontor@example.com'");
    const [second] = await contacts(company.id);
    expect(second?.work_email).toBe("delta.kontor@example.com");
    expect(second?.updated_at.getTime()).toBeGreaterThan(first?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
    for (const [set, field] of [
      ["updated_at = pg_catalog.now() - interval '1 day'", "updated_at"],
      [`membership_id = '${alfa.membership}'`, "membership_id"],
      [`contact_company_id = '${alfa.id}'`, "contact_company_id"],
    ] as const) {
      await expectRefusal(asMember(app, company.id, company.asOwner, `UPDATE access.membership_contacts SET ${set}`), "immutable_field", { field, operation: "update" });
    }
  });

  it("takes an e-mail address of 1 to 254 characters and a phone number of 1 to 50", async () => {
    const company = await aCompany(app, "Testbolaget Epsilon AB");
    for (const [email, phone, constraint] of [
      ["", null, /membership_contacts_work_email_length/],
      [`${"a".repeat(243)}@example.com`, null, /membership_contacts_work_email_length/],
      [null, "", /membership_contacts_work_phone_length/],
      [null, "1".repeat(51), /membership_contacts_work_phone_length/],
    ] as const) {
      await expectError(asMember(app, company.id, company.asOwner, INSERT, [company.id, company.membership, email, phone]), CHECK_VIOLATION, constraint);
    }
    await asMember(app, company.id, company.asOwner, INSERT, [company.id, company.membership, `${"a".repeat(242)}@example.com`, "1".repeat(50)]);
  });

  it("gives a reader nothing", async () => {
    const reader = await db.connect("readerA");
    await expectError(reader.query("SELECT * FROM access.membership_contacts"), INSUFFICIENT_PRIVILEGE, /permission denied for table membership_contacts/);
  });
});
