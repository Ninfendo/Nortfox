// SPDX-License-Identifier: AGPL-3.0-only

// M3 (issue 12, Companies 3): changing the organisation number is refused.
// updateCompany does not know the field, so a request that sends it is
// refused as a field the operation does not take, and the database refuses
// the change from every role. updateCompany changes the company's name, its
// postal and visiting addresses and its contact details, the fields of the
// established company resource (Adress, Postnummer, Ort, Land, Besöksadress,
// Telefon, E-post), each checked by the API and by the database; getCompany
// and getMe give them. Only a system administrator changes the company. A
// change is in the behandlingshistorik, as every change of a company row is.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { CHECK_VIOLATION, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

/** A whole set of the company's details. */
const DETAILS = {
  address: "Storgatan 1",
  zipCode: "111 22",
  city: "Stockholm",
  countryCode: "SE",
  visitAddress: "Lilla torget 3",
  visitZipCode: "411 18",
  visitCity: "Göteborg",
  visitCountryCode: "SE",
  phone: "070-174 06 13",
  email: "info@example.com",
};

/** The columns of the details, by the API's name. */
const COLUMNS: Readonly<Record<keyof typeof DETAILS, string>> = {
  address: "address",
  zipCode: "zip_code",
  city: "city",
  countryCode: "country_code",
  visitAddress: "visit_address",
  visitZipCode: "visit_zip_code",
  visitCity: "visit_city",
  visitCountryCode: "visit_country_code",
  phone: "phone",
  email: "email",
};

describe("updateCompany", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function companyRow(): Promise<Record<string, unknown>> {
    return (await superuser.query<Record<string, unknown>>("SELECT * FROM ledger.companies WHERE company_id = $1", [company.id])).rows[0] ?? {};
  }

  it("updateCompany refuses the organisation number", async () => {
    const before = await companyRow();
    const problem = await jsonOf<ProblemBody>(await calls.updateCompany(server, company.session, { organizationNumber: "599999-0129" }), 400);
    expect(problem.code).toBe("invalid-request");
    expect(problem.errors).toEqual([{ code: "unknown-field", detail: "The field /organizationNumber is not part of this operation.", pointer: "/organizationNumber" }]);
    // With another field beside it, nothing changes either.
    expect((await calls.updateCompany(server, company.session, { name: "Testbolaget Beta AB", organizationNumber: "599999-0129" })).status).toBe(400);
    expect(await companyRow()).toEqual(before);
  });

  it("the database refuses a change of it, from the app and from the owner", async () => {
    for (const client of [app, owner]) {
      await expectRefusal(
        inTransaction(client, { company: company.id, ...company.asOwner, channel: "rest" }, () =>
          client.query("UPDATE ledger.companies SET organization_number = '599999-0129' WHERE company_id = $1", [company.id]),
        ),
        "immutable_field",
        { field: "organization_number", operation: "update" },
      );
    }
    expect((await companyRow())["organization_number"]).toBe("556000-0167");
  });

  it("changes the name and every detail, and getCompany and getMe give them", async () => {
    const changed = await jsonOf(await calls.updateCompany(server, company.session, { name: "Testbolaget Alfa Gamma AB", ...DETAILS }));
    const expected = { id: company.id, name: "Testbolaget Alfa Gamma AB", organizationNumber: "556000-0167", databaseNumber: company.row.database_number, ...DETAILS };
    expect(changed).toEqual(expected);
    expect(await jsonOf(await getAs(server, company.session, "/v1/company"))).toEqual(expected);
    expect((await jsonOf<{ company: unknown }>(await getAs(server, company.session, "/v1/me"))).company).toEqual(expected);
    const row = await companyRow();
    for (const [field, column] of Object.entries(COLUMNS)) {
      expect(row[column], column).toBe(DETAILS[field as keyof typeof DETAILS]);
    }
  });

  it("keeps a field left out, takes a detail away with null, and gives no field that is not set", async () => {
    const changed = await jsonOf(await calls.updateCompany(server, company.session, { phone: null, visitAddress: null, city: "Uppsala" }));
    expect(changed).toEqual({
      id: company.id,
      name: "Testbolaget Alfa Gamma AB",
      organizationNumber: "556000-0167",
      databaseNumber: company.row.database_number,
      ...DETAILS,
      city: "Uppsala",
      phone: undefined,
      visitAddress: undefined,
    });
    expect(Object.keys(changed)).not.toContain("phone");
    expect((await companyRow())["phone"]).toBeNull();
    // An empty change changes nothing.
    expect(await jsonOf(await calls.updateCompany(server, company.session, {}))).toEqual(changed);
  });

  it("refuses null for the name, and each detail that is too long, empty or of another form, by the API", async () => {
    const before = await companyRow();
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ name: null }, "invalid-type"],
      [{ name: "" }, "too-short"],
      [{ name: "x".repeat(201) }, "too-long"],
      [{ name: "Testbolaget\nAlfa AB" }, "invalid-value"],
      [{ name: "Testbolaget\u2028Alfa AB" }, "invalid-value"],
      [{ address: "" }, "too-short"],
      [{ address: "x".repeat(201) }, "too-long"],
      [{ visitAddress: "x".repeat(201) }, "too-long"],
      [{ zipCode: "1".repeat(21) }, "too-long"],
      [{ visitZipCode: "" }, "too-short"],
      [{ city: "x".repeat(101) }, "too-long"],
      [{ visitCity: "" }, "too-short"],
      [{ countryCode: "se" }, "bad-format"],
      [{ countryCode: "SWE" }, "bad-format"],
      [{ visitCountryCode: "S" }, "bad-format"],
      [{ phone: "0".repeat(51) }, "too-long"],
      [{ email: "inte en adress" }, "bad-format"],
      [{ email: `${"a".repeat(60)}@${`${"b".repeat(60)}.`.repeat(3)}example.com` }, "too-long"],
      [{ address: "Storgatan\u0000 1" }, "invalid-value"],
      [{ city: "Stock\uD800holm" }, "invalid-value"],
    ];
    for (const [body, code] of cases) {
      const problem = await jsonOf<ProblemBody>(await calls.updateCompany(server, company.session, body), 400);
      const field = Object.keys(body)[0] ?? "";
      expect(problem.errors?.map((error) => [error.code, error.pointer]), JSON.stringify(body)).toEqual([[code, `/${field}`]]);
    }
    expect(await companyRow()).toEqual(before);
  });

  it("the database refuses each detail that is empty, too long or of another form, and a name on more than one line, as the app", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["name", "Testbolaget\nAlfa AB"],
      ["name", "Testbolaget\r\nAlfa AB"],
      ["name", "Testbolaget\u0085Alfa AB"],
      ["name", "Testbolaget\u202EAlfa AB"],
      ["address", ""],
      ["address", "x".repeat(201)],
      ["zip_code", "1".repeat(21)],
      ["city", ""],
      ["city", "x".repeat(101)],
      ["country_code", "se"],
      ["country_code", "SWE"],
      ["visit_address", ""],
      ["visit_zip_code", ""],
      ["visit_city", "x".repeat(101)],
      ["visit_country_code", "S"],
      ["phone", ""],
      ["phone", "0".repeat(51)],
      ["email", ""],
      ["email", `${"a".repeat(250)}@example.com`],
    ];
    for (const [column, value] of cases) {
      await expectError(
        inTransaction(app, { company: company.id, ...company.asOwner, channel: "rest" }, () =>
          app.query(`UPDATE ledger.companies SET ${column} = $2 WHERE company_id = $1`, [company.id, value]),
        ),
        CHECK_VIOLATION,
        new RegExp(`companies_${column}_`),
      );
    }
    // Each takes its longest value, and none.
    await inTransaction(app, { company: company.id, ...company.asOwner, channel: "rest" }, () =>
      app.query(
        `UPDATE ledger.companies SET address = $2, zip_code = $3, city = $4, country_code = 'NO', visit_address = NULL, visit_zip_code = NULL,
         visit_city = NULL, visit_country_code = NULL, phone = $5, email = $6 WHERE company_id = $1`,
        [company.id, "x".repeat(200), "1".repeat(20), "x".repeat(100), "0".repeat(50), `${"a".repeat(242)}@example.com`],
      ),
    );
    expect((await jsonOf(await getAs(server, company.session, "/v1/company")))["countryCode"]).toBe("NO");
  });

  it("writes the change in the behandlingshistorik, with the actor", async () => {
    await calls.updateCompany(server, company.session, { name: "Testbolaget Alfa Delta AB" });
    const history = await superuser.query<{ actor_id: string; actor_kind: string; channel: string; name: string }>(
      `SELECT actor_id, actor_kind, channel, new_values->>'name' AS name FROM audit.history
       WHERE company_id = $1 AND table_name = 'ledger.companies' AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
      [company.id],
    );
    expect(history.rows).toEqual([{ actor_id: company.creator.id, actor_kind: "user", channel: "rest", name: "Testbolaget Alfa Delta AB" }]);
  });

  it("needs a system administrator: a member gets permission-missing, and the company stays", async () => {
    const before = await companyRow();
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    const problem = await jsonOf<ProblemBody>(await calls.updateCompany(server, session, { name: "Testbolaget Epsilon AB" }), 403);
    expect(problem).toMatchObject({ code: "permission-missing", permission: "company:update" });
    expect(await companyRow()).toEqual(before);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
