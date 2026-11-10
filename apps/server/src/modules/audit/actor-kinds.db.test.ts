// SPDX-License-Identifier: AGPL-3.0-only

// F8 (issue 12, "Who acts" 1; decision 2): each request runs as the kind of
// actor that decision 2 sets. This is the API token's half: a session runs
// as its user, and a request with an API token as an integration, which the
// period lock's row of integrations, "Externt via integration", locks. So a
// date locked for integrations refuses a booking through the token and lets
// one through the session of the same person. No request runs as the
// internal system user. The booking is a test-only write that needs Bokför.
// Part 5 completes this file with the MCP client. The people and the
// company are made up.

import { defineOperation } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_PERMISSIONS, TEST_REGISTRY, appPool, testHandlers, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addBooksYear, setLock } from "../../../test/ledger.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, writeAs, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";
import { handleData, ok } from "../../api/operation.ts";

/** What the test-only booking answers: the voucher, and the kind of actor that the database recorded as its creator. */
const Booked = z.strictObject({
  id: z.uuid().meta({ description: "The voucher's id." }),
  createdByKind: z.string().meta({ description: "The kind of actor the database recorded as the voucher's creator." }),
});

/** A booking of one voucher on 15 March 2090 in series A, which needs Bokför. Only these tests serve it. */
const testBookAsMember = defineOperation({
  id: "testBookAsMember",
  method: "post",
  path: "/v1/test-member-vouchers",
  tags: ["test"],
  summary: "Book a voucher",
  description: "Books a voucher of 125 kronor on 2090-03-15 in series A, debit 6110 and credit 1930, and needs vouchers.book. Only the tests serve it.",
  output: Booked,
  status: 201,
  permission: "vouchers.book",
  scope: "bookkeeping",
  tool: "Books a voucher in the company you work in. Only the tests serve it.",
  writes: true,
});

const testBookAsMemberHandler = handleData(testBookAsMember, async ({ context: { company }, tx }) => {
  const found = await tx.query<{ id: string; created_by_kind: string }>(
    `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
     SELECT $1, id, 'A', 'Kontorsmaterial', DATE '2090-03-15', 'MANUAL' FROM ledger.fiscal_years RETURNING id, created_by_kind`,
    [company.companyId],
  );
  const [voucher] = found.rows;
  if (voucher === undefined) {
    throw new Error("The company has no fiscal year to book in.");
  }
  await tx.query("INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit) VALUES ($1, $2, 6110, 12500)", [company.companyId, voucher.id]);
  await tx.query("INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, credit) VALUES ($1, $2, 1930, 12500)", [company.companyId, voucher.id]);
  return ok({ id: voucher.id, createdByKind: voucher.created_by_kind });
});

describe("the kind of actor of each request", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  let bookkeeper: TestMember;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, {
      clock: testClock(new Date()),
      options: { registry: [...TEST_REGISTRY, testBookAsMember], handlers: [...testHandlers(), testBookAsMemberHandler], permissions: [...ALL_PERMISSIONS, "vouchers.book"] },
    });
    company = await apiCompany(server, { app, owner });
    await addBooksYear(app, company.id, "2090-01-01", "2090-12-31", company.asOwner);
    bookkeeper = await newMember(server, { app, owner }, company);
    await jsonOf(await calls.assignProgram(server, company.session, bookkeeper.id, "bookkeeping", { full: true }));
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("a session runs as its user and an API token as an integration, and the period lock's integrations row applies only to the token", async () => {
    const session = await sessionIn(server, bookkeeper.person, company.id);
    const { token, id } = await makeApiToken(server, session, { scopes: ["bookkeeping"] });
    expect(await jsonOf(await writeAs(server, session, "POST", "/v1/test-member-vouchers", undefined), 201)).toMatchObject({ createdByKind: "user" });
    expect(await jsonOf(await asToken(server, token, "POST", "/v1/test-member-vouchers"), 201)).toMatchObject({ createdByKind: "integration" });
    // Externt via integration, locked through March.
    await setLock(app, company.id, "integration", "2090-03-31", { who: company.asOwner });
    expect(await jsonOf<ProblemBody>(await asToken(server, token, "POST", "/v1/test-member-vouchers"), 422)).toMatchObject({ code: "period-locked-manual" });
    expect(await jsonOf(await writeAs(server, session, "POST", "/v1/test-member-vouchers", undefined), 201)).toMatchObject({ createdByKind: "user" });
    // The behandlingshistorik names the person both times, and the token as the integration's via.
    const kinds = await superuser.query<{ actor_id: string; actor_kind: string; via_id: string | null }>(
      "SELECT DISTINCT actor_id, actor_kind, via_id FROM audit.history WHERE company_id = $1 AND table_name = 'ledger.vouchers' ORDER BY actor_kind",
      [company.id],
    );
    expect(kinds.rows).toEqual([
      { actor_id: bookkeeper.person.id, actor_kind: "integration", via_id: id },
      { actor_id: bookkeeper.person.id, actor_kind: "user", via_id: null },
    ]);
  });

  it("no request runs as the internal system user", async () => {
    const system = await superuser.query("SELECT table_name FROM audit.history WHERE actor_kind = 'system'");
    expect(system.rows).toEqual([]);
    const written = await superuser.query<{ kinds: string[] }>("SELECT pg_catalog.array_agg(DISTINCT actor_kind ORDER BY actor_kind) AS kinds FROM audit.history");
    expect(written.rows).toEqual([{ kinds: ["integration", "user"] }]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
