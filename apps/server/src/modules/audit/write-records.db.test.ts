// SPDX-License-Identifier: AGPL-3.0-only

// T8 (issue 12, "Who acts" 2; What the law requires: every write has a known
// actor and a time). This is the API token's half: a write through a
// session records the person with the kind user and no via; a write through
// an API token records the kind integration, the person and the token, as
// the via. The behandlingshistorik holds both, with the channel. Part 5
// completes this file with the MCP token, which records the MCP client. The
// people and the company are made up.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, type ApiCompany } from "../../../test/users.ts";

/** Who a change of the company's row records in the behandlingshistorik. */
interface Recorded {
  readonly city: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly via_kind: string | null;
  readonly via_id: string | null;
  readonly channel: string;
}

describe("who a write records", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the checks. */
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

  /** The latest change of the company's row, as the behandlingshistorik holds it. */
  async function latestChange(): Promise<Recorded | undefined> {
    const found = await superuser.query<Recorded>(
      `SELECT new_values ->> 'city' AS city, actor_id, actor_kind, via_kind, via_id, channel FROM audit.history
       WHERE company_id = $1 AND table_name = 'ledger.companies' AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
      [company.id],
    );
    return found.rows[0];
  }

  it("a session's write records the person as user", async () => {
    await jsonOf(await calls.updateCompany(server, company.session, { city: "Lund" }));
    expect(await latestChange()).toEqual({ city: "Lund", actor_id: company.creator.id, actor_kind: "user", via_kind: null, via_id: null, channel: "rest" });
  });

  it("a token's write records integration, the person and the token", async () => {
    const made = await makeApiToken(server, company.session, { scopes: ["companies"] });
    await jsonOf(await asToken(server, made.token, "PATCH", "/v1/company", { body: { city: "Malmö" } }));
    expect(await latestChange()).toEqual({ city: "Malmö", actor_id: company.creator.id, actor_kind: "integration", via_kind: "api-token", via_id: made.id, channel: "rest" });
    // Every row the write left in the behandlingshistorik, its idempotency key's too, records the same.
    const rows = await superuser.query<{ actor_kind: string; via_id: string }>(
      "SELECT DISTINCT actor_kind, via_id FROM audit.history WHERE company_id = $1 AND via_id IS NOT NULL",
      [company.id],
    );
    expect(rows.rows).toEqual([{ actor_kind: "integration", via_id: made.id }]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
