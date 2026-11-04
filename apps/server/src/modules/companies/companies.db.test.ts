// SPDX-License-Identifier: AGPL-3.0-only

// A company and its tenant id (rule 4 of the slice): the database gives each
// company the next tenant id, refuses one that is given, and never lets it
// change. Nor does the organisation number change (issue 12). Each company
// here comes, as createCompany makes it, with its owner in the same
// transaction.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addCompanyWithOwner, someUser, type CompanyRow, type CompanyValues } from "../../../test/ledger.ts";

describe("companies", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const who = someUser();
  const first = randomUUID();
  const second = randomUUID();

  /** Adds a company as the app, with its owner, in its own transaction, and gives its row. */
  async function addCompany(company: string, values: CompanyValues = {}): Promise<CompanyRow> {
    return (await addCompanyWithOwner(app, who, { ...values, id: company })).row;
  }

  /** Runs one statement as the app in `company`, as the company's maker. */
  function asMaker(company: string, sql: string, params: readonly unknown[] = []): Promise<unknown> {
    return inTransaction(app, { company, ...who }, () => app.query(sql, [...params]));
  }

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  it("gives each new company the next tenant id, an integer, from 1", async () => {
    expect(await addCompany(first)).toEqual({
      company_id: first,
      name: "Testbolaget Alfa AB",
      organization_number: "556000-0167",
      database_number: 1,
    });
    expect((await addCompany(second)).database_number).toBe(2);
  });

  it("refuses a tenant id given on insert, such as another company's", async () => {
    for (const value of [1, 3]) {
      await expectRefusal(addCompany(randomUUID(), { databaseNumber: value }), "immutable_field", {
        field: "database_number",
        operation: "create",
      });
    }
  });

  it("never lets a company's tenant id or company id change", async () => {
    await expectRefusal(asMaker(first, "UPDATE ledger.companies SET database_number = 2 WHERE company_id = $1", [first]), "immutable_field", {
      field: "database_number",
      operation: "update",
    });
    await expectRefusal(asMaker(first, "UPDATE ledger.companies SET company_id = $2 WHERE company_id = $1", [first, randomUUID()]), "immutable_field", {
      field: "company_id",
      operation: "update",
    });
  });

  it("refuses a second company with the tenant id of another, even if the sequence were set back", async () => {
    await owner.query("SELECT pg_catalog.setval('ledger.database_number_seq', 1, false)");
    try {
      await expectError(addCompany(randomUUID()), "23505", /companies_database_number_key/);
    } finally {
      // Back to where it was: two companies, so the next tenant id is 3.
      await owner.query("SELECT pg_catalog.setval('ledger.database_number_seq', 2)");
    }
  });

  it("never lets the organisation number change, for the owner neither, and lets the app change a company's name", async () => {
    for (const number of ["599999-0129", "556000-0167 ", ""]) {
      await expectRefusal(asMaker(first, "UPDATE ledger.companies SET organization_number = $2 WHERE company_id = $1", [first, number]), "immutable_field", {
        field: "organization_number",
        operation: "update",
      });
    }
    await expectRefusal(
      inTransaction(owner, { company: first, ...who }, () => owner.query("UPDATE ledger.companies SET organization_number = '599999-0129' WHERE company_id = $1", [first])),
      "immutable_field",
      { field: "organization_number", operation: "update" },
    );
    const changed = await inTransaction(app, { company: first, ...who }, async () => {
      const found = await app.query<{ name: string; organization_number: string; database_number: number }>(
        "UPDATE ledger.companies SET name = 'Testbolaget Alfa Konsult AB', organization_number = organization_number WHERE company_id = $1 RETURNING name, organization_number, database_number",
        [first],
      );
      return found.rows;
    });
    expect(changed).toEqual([{ name: "Testbolaget Alfa Konsult AB", organization_number: "556000-0167", database_number: 1 }]);
  });
});
