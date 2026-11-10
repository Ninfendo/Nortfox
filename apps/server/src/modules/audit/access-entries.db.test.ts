// SPDX-License-Identifier: AGPL-3.0-only

// F7 (issue 12, Behandlingshistorik 2): created and revoked tokens are in
// the behandlingshistorik. This is the API token's half: an API token made
// with createApiToken and revoked with revokeApiToken each leave one entry
// in the token's company, Program "Användare" (users) with the heading
// api-token-created or api-token-revoked, about the token's person, with
// the token's id, name and scopes, at the token's own time. The tokens'
// trigger in the database writes it (db/README.md, the API tokens), and its
// history row carries the request's actor, kind, via and channel: a
// session's person as a user, or a token's person as an integration through
// that token. Part 5 completes this file with the sign-ins, the consents and
// the MCP clients' revocations. The people and the company are made up.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, signInApp, testClock, writeAs, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, type ApiCompany } from "../../../test/users.ts";
import { ENTRY_WORDS } from "./entries.ts";

/** An entry of access.events with its history row's actor, kind, via and channel. */
interface Entry {
  readonly program: string;
  readonly heading: string;
  readonly subject_id: string;
  readonly details: Record<string, unknown>;
  readonly at_matches: boolean;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly via_kind: string | null;
  readonly via_id: string | null;
  readonly channel: string;
}

describe("the entries of an API token", () => {
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

  /** The entries of `tokenId` in the company, in order, each with its history row and whether its time is the token's own `column`. */
  async function entriesOf(tokenId: string): Promise<Entry[]> {
    const found = await superuser.query<Entry>(
      `SELECT e.program, e.heading, e.subject_id, e.details,
         e.at = CASE e.heading WHEN 'api-token-created' THEN t.created_at ELSE t.revoked_at END AS at_matches,
         h.actor_id, h.actor_kind, h.via_kind, h.via_id, h.channel
       FROM access.events AS e
       JOIN audit.history AS h ON h.table_name = 'access.events' AND h.row_id = e.id AND h.operation = 'INSERT'
       JOIN access.api_tokens AS t ON t.id::text = e.details ->> 'tokenId'
       WHERE e.company_id = $1 AND e.details ->> 'tokenId' = $2
       ORDER BY e.at, e.id`,
      [company.id, tokenId],
    );
    return found.rows;
  }

  it("an API token made and revoked each leave an entry, written by the trigger, with the request's actor", async () => {
    // Made by the owner's session, and revoked by the token itself.
    const made = await makeApiToken(server, company.session, { name: "Bokföringsexport", scopes: ["companyinformation", "tokens"] });
    const details = { tokenId: made.id, name: "Bokföringsexport", scopes: ["companyinformation", "tokens"] };
    const asUser = { actor_id: company.creator.id, actor_kind: "user", via_kind: null, via_id: null, channel: "rest" };
    const entry = { program: "users", subject_id: company.creator.id, details, at_matches: true };
    expect(await entriesOf(made.id)).toEqual([{ ...entry, heading: "api-token-created", ...asUser }]);
    expect((await asToken(server, made.token, "DELETE", `/v1/api-tokens/${made.id}`)).status).toBe(204);
    expect(await entriesOf(made.id)).toEqual([
      { ...entry, heading: "api-token-created", ...asUser },
      { ...entry, heading: "api-token-revoked", actor_id: company.creator.id, actor_kind: "integration", via_kind: "api-token", via_id: made.id, channel: "rest" },
    ]);
    // Revoked by the session, the entry names the person as a user.
    const second = await makeApiToken(server, company.session, { name: "Bankimport", scopes: ["bookkeeping"] });
    expect((await writeAs(server, company.session, "DELETE", `/v1/api-tokens/${second.id}`, undefined)).status).toBe(204);
    expect((await entriesOf(second.id)).map((each) => [each.heading, each.actor_kind, each.via_kind])).toEqual([
      ["api-token-created", "user", null],
      ["api-token-revoked", "user", null],
    ]);
    // A second revoke of a revoked token changes nothing, and writes no entry.
    expect((await writeAs(server, company.session, "DELETE", `/v1/api-tokens/${second.id}`, undefined)).status).toBe(422);
    expect(await entriesOf(second.id)).toHaveLength(2);
  });

  it("has the screen's words for the token's headings", () => {
    expect(ENTRY_WORDS.programs.users).toBe("Användare");
    expect(ENTRY_WORDS.headings["api-token-created"]).toBe("API-token skapad");
    expect(ENTRY_WORDS.headings["api-token-revoked"]).toBe("API-token återkallad");
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
