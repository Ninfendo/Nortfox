// SPDX-License-Identifier: AGPL-3.0-only

// A write whose answer holds a secret (plan 2.2, "Answers that hold a
// secret"): the runner keeps its key with the fingerprint, the status and
// the answer less each secret field, and never the secret. A repeat of the
// same request with the key gets 409 answer-shown-once, with the answer it
// kept as the problem's answer, so a client can end what the first call made
// and try again with a new key. The same key with another request gets 422,
// as for any write. These run through /v1 and /mcp as nortfox_app, with
// createApiToken: a token shown once, which the database keeps only as its
// hash. The scan of the database at the end finds no token anywhere, the
// stored answers and the behandlingshistorik included.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appPool, callTool, mcpClient, type AppPool, type ProblemBody } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { expectNoTokens, tokensIn } from "../../test/secrets.ts";
import {
  TEST_ORIGIN,
  addSignInIdentity,
  chooseCompany,
  cookieHeader,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  signIn,
  signInApp,
  writeAs,
  type SignInApp,
} from "../../test/sign-in.ts";
import { tokenHash } from "../auth/tokens.ts";

/** What createApiToken answers: the token's facts, and the token, shown once. */
const MadeToken = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  userId: z.uuid(),
  createdAt: z.string(),
  token: z.string(),
});

/** The answer that createApiToken keeps with its key: the same, without the token. */
function keptOf(made: z.infer<typeof MadeToken>): Record<string, unknown> {
  return { id: made.id, name: made.name, scopes: made.scopes, userId: made.userId, createdAt: made.createdAt };
}

describe("a write whose answer holds a secret", () => {
  let db: TestDatabase;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let session: string;
  let companyId: string;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { mcpSessions: "on" });
    const person = await addSignInIdentity(owner);
    session = (await signIn(server, person)).session;
    companyId = (await jsonOf<{ id: string }>(await writeAs(server, session, "POST", "/v1/companies", { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" }), 201)).id;
    await jsonOf(await chooseCompany(server, session, companyId));
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The first call, past the sign-in app's record of answers: its answer holds the token, as it must, so the scan of the other answers stays strict. */
  async function firstCall(key: string, name: string): Promise<Response> {
    return server.app.hono.request("/v1/api-tokens", {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", "idempotency-key": key, ...cookieHeader({ session }) },
      body: JSON.stringify({ name, scopes: ["bookkeeping"] }),
    });
  }

  async function keptAnswers(key: string): Promise<unknown[]> {
    return (await superuser.query<{ response_body: unknown }>("SELECT response_body FROM ledger.idempotency_keys WHERE idempotency_key = $1", [key])).rows.map(
      (row) => row.response_body,
    );
  }

  async function tokensNamed(name: string): Promise<{ id: string; token_hash: Buffer }[]> {
    return (await superuser.query<{ id: string; token_hash: Buffer }>("SELECT id, token_hash FROM access.api_tokens WHERE name = $1", [name])).rows;
  }

  it("answers the token once, and keeps the answer of its key without it", async () => {
    const made = MadeToken.parse(await jsonOf(await firstCall("make-export", "Bokföringsexport"), 201));
    expect(made).toMatchObject({ name: "Bokföringsexport", scopes: ["bookkeeping"] });
    expect(made.token).toMatch(/^nft_[A-Za-z0-9_-]{43}$/);
    expect(await tokensNamed("Bokföringsexport")).toEqual([{ id: made.id, token_hash: tokenHash(made.token) }]);
    expect(await keptAnswers("make-export")).toEqual([keptOf(made)]);
  });

  it("refuses a repeat of the same request with 409 answer-shown-once and the token's id, by REST and by MCP, and makes no second token", async () => {
    const made = MadeToken.parse(await jsonOf(await firstCall("make-import", "Bankimport"), 201));
    const kept = keptOf(made);
    const shownOnce: ProblemBody & { readonly answer: unknown } = {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail:
        "The first answer to this idempotency key held a secret, which is shown only once. answer gives the rest of it, such as the id of what it made. " +
        "If the secret is lost, end what it made and send the request again with a new key.",
      code: "answer-shown-once",
      answer: kept,
    };
    const again = await writeAs(server, session, "POST", "/v1/api-tokens", { name: "Bankimport", scopes: ["bookkeeping"] }, { key: "make-import" });
    expect(again.headers.get("content-type")).toBe("application/problem+json");
    expect(await jsonOf(again, 409)).toEqual(shownOnce);
    const client = await mcpClient(server.app, { token: session });
    expect(await callTool(client, "createApiToken", { name: "Bankimport", scopes: ["bookkeeping"], idempotencyKey: "make-import" })).toEqual({ isError: true, structured: shownOnce });
    await client.close();
    expect((await tokensNamed("Bankimport")).map((row) => row.id)).toEqual([made.id]);
  });

  it("refuses the same key with another request with 422 idempotency-key-reused, and makes no token", async () => {
    await jsonOf(await firstCall("make-payroll", "Lönefil"), 201);
    const other = await writeAs(server, session, "POST", "/v1/api-tokens", { name: "Lönefil två", scopes: ["bookkeeping"] }, { key: "make-payroll" });
    expect((await jsonOf<ProblemBody>(other, 422)).code).toBe("idempotency-key-reused");
    expect(await tokensNamed("Lönefil två")).toEqual([]);
  });

  it("leaves no token in any answer but the first, nor in the database: the kept answers and the behandlingshistorik hold none", async () => {
    const histories = (await superuser.query<{ row: string }>("SELECT pg_catalog.to_jsonb(h)::text AS row FROM audit.history AS h WHERE company_id = $1", [companyId])).rows;
    expect(histories.length).toBeGreaterThan(0);
    expectNoTokens(histories.map((history) => history.row));
    expect(tokensIn(await keptAnswers("make-export"))).toEqual([]);
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
