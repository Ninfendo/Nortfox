// SPDX-License-Identifier: AGPL-3.0-only

// The purge of the install-wide rows (db/README.md, the schema access). The
// server calls access.purge_expired with its own clock every ten minutes.
// It deletes what has passed: login challenges and unused setup links past
// their end (a used link stays: it names the identity it made), sessions
// that ended more than 30 days ago or began more than 30 days and 12 hours
// ago, attempt counters whose hour has passed and whose lock has ended, a
// person's idempotency keys 24 hours after they were stored, and the account
// events past the 100 latest of each identity, but for the failed sign-ins
// of the last hour, which the behandlingshistorik counts. Of the MCP login
// (migration 0011), it deletes the authorization requests, the codes and the
// access tokens at their end, a grant family's refresh tokens once every one
// of them has passed its end (a used one stays until then, so its reuse is
// still found), and a client that has no consent 24 hours after its
// registration. It deletes no identity and no consent. The tests move the
// server's clock forwards only.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, backendPid, begin, expectError, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, anonymously, asPerson, later, tokenHash } from "../../../test/identities.ts";
import { aCompany } from "../../../test/memberships.ts";
import { INSERT_CONSENT, logIn, openRequest, redeemRefreshToken, registerClient, type Approver } from "../../../test/oauth.ts";
import { expectNoSecretsAtRest } from "../../../test/secrets.ts";

/** The server's clock when the rows are made. */
const T0 = new Date("2090-03-15T10:00:00.000Z");

const DAY = 24 * 60;

describe("the purge of expired login rows", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs the purge as the server does: as the app, in a transaction with only the channel, with its clock. */
  async function purge(at: Date): Promise<void> {
    await inTransaction(app, { channel: "rest" }, () => app.query("SELECT access.purge_expired($1)", [at]));
  }

  /** The ids left in `table`, sorted. */
  async function left(table: string, column = "id"): Promise<string[]> {
    return (await owner.query<{ id: string }>(`SELECT ${column}::text AS id FROM ${table} ORDER BY 1`)).rows.map((row) => row.id);
  }

  async function insert(sql: string, params: readonly unknown[]): Promise<string> {
    return (await owner.query<{ id: string }>(`${sql} RETURNING id::text`, [...params])).rows[0]?.id ?? "";
  }

  it("deletes a login challenge and a setup link at their end, and keeps them until then", async () => {
    const person = await addIdentity(owner);
    const challenge = (end: Date, used: Date | null = null): Promise<string> =>
      insert("INSERT INTO access.login_challenges (token_hash, identity_id, method, created_at, expires_at, used_at) VALUES ($1, $2, 'password-email', $3, $4, $5)", [
        tokenHash(),
        person,
        T0,
        end,
        used,
      ]);
    const link = (end: Date): Promise<string> => insert("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at) VALUES ($1, $2, $3)", [tokenHash(), T0, end]);
    const soon = await challenge(later(T0, 20));
    const used = await challenge(later(T0, 20), later(T0, 1));
    const after = await challenge(later(T0, 40));
    const shortLink = await link(later(T0, 20));
    const longLink = await link(later(T0, 28 * DAY));
    await purge(later(T0, 19));
    expect(await left("access.login_challenges")).toEqual([soon, used, after].sort());
    await purge(later(T0, 20));
    expect(await left("access.login_challenges")).toEqual([after]);
    expect(await left("access.setup_tokens")).toEqual([longLink]);
    expect(shortLink).not.toBe(longLink);
    await purge(later(T0, 28 * DAY));
    expect(await left("access.login_challenges")).toEqual([]);
    expect(await left("access.setup_tokens")).toEqual([]);
  });

  it("keeps a used setup link past its end, since it names the identity it made, and the one it replaced", async () => {
    const [made, replaced] = [await addIdentity(owner), await addIdentity(owner)];
    const used = await insert("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, used_at, identity_id, replaces_identity_id) VALUES ($1, $2, $3, $2, $4, $5)", [
      tokenHash(),
      T0,
      later(T0, 20),
      made,
      replaced,
    ]);
    const stopped = await insert("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, superseded_at, replaces_identity_id) VALUES ($1, $2, $3, $2, $4)", [
      tokenHash(),
      T0,
      later(T0, 20),
      replaced,
    ]);
    await purge(later(T0, 19));
    expect(await left("access.setup_tokens")).toEqual([used, stopped].sort());
    await purge(later(T0, 365 * DAY));
    expect(await left("access.setup_tokens")).toEqual([used]);
    await expectNoSecretsAtRest(db);
  });

  it("deletes a session 30 days after it ended, and one that never ended 30 days after its 12 hours", async () => {
    const person = await addIdentity(owner);
    const session = (ended: Date | null): Promise<string> =>
      insert("INSERT INTO access.sessions (token_hash, identity_id, method, second_step, started_at, last_seen_at, ended_at, end_reason) VALUES ($1, $2, 'password-email', 'totp', $3, $3, $4, $5)", [
        tokenHash(),
        person,
        T0,
        ended,
        ended === null ? null : "logout",
      ]);
    const ended = await session(later(T0, 60));
    const open = await session(null);
    await purge(later(T0, 30 * DAY + 59));
    expect(await left("access.sessions")).toEqual([ended, open].sort());
    await purge(later(T0, 30 * DAY + 60));
    expect(await left("access.sessions")).toEqual([open]);
    await purge(later(T0, 30 * DAY + 12 * 60 - 1));
    expect(await left("access.sessions")).toEqual([open]);
    await purge(later(T0, 30 * DAY + 12 * 60));
    expect(await left("access.sessions")).toEqual([]);
  });

  it("deletes an attempt counter once its hour has passed and its lock has ended", async () => {
    const counter = (subject: string, locked: Date | null): Promise<unknown> =>
      owner.query(
        "INSERT INTO access.attempt_counters (subject, kind, window_started_at, failures, last_failure_at, locked_until) VALUES ($1, 'password', $2, 3, $2, $3)",
        [subject, T0, locked],
      );
    const plain = randomUUID();
    const locked = randomUUID();
    await counter(plain, null);
    await counter(locked, later(T0, 90));
    await purge(later(T0, 59));
    expect(await left("access.attempt_counters", "subject")).toEqual([plain, locked].sort());
    await purge(later(T0, 60));
    expect(await left("access.attempt_counters", "subject")).toEqual([locked]);
    await purge(later(T0, 89));
    expect(await left("access.attempt_counters", "subject")).toEqual([locked]);
    await purge(later(T0, 90));
    expect(await left("access.attempt_counters", "subject")).toEqual([]);
  });

  it("keeps each identity's 100 latest account events, and deletes no identity", async () => {
    const busy = await addIdentity(owner);
    const quiet = await addIdentity(owner);
    for (let count = 0; count < 103; count += 1) {
      await asPerson(app, busy, () => app.query("INSERT INTO access.account_events (identity_id, kind, details) VALUES ($1, 'sign-in', $2)", [busy, { count }]));
    }
    await asPerson(app, quiet, () => app.query("INSERT INTO access.account_events (identity_id, kind) VALUES ($1, 'logout')", [quiet]));
    await purge(T0);
    const kept = await owner.query<{ count: number }>("SELECT (details ->> 'count')::integer AS count FROM access.account_events WHERE identity_id = $1 ORDER BY at", [busy]);
    expect(kept.rows.map((row) => row.count)).toEqual(Array.from({ length: 100 }, (_unused, index) => index + 3));
    expect(await left("access.account_events", "identity_id")).toEqual([...Array.from({ length: 100 }, () => busy), quiet].sort());
    // A purge far in the future still deletes no identity.
    await purge(later(T0, 365 * DAY));
    const identities = await owner.query("SELECT id FROM access.identities WHERE id = ANY ($1::uuid[])", [[busy, quiet]]);
    expect(identities.rows).toHaveLength(2);
  });

  it("keeps an identity's failed sign-ins of the last hour past the 100, which the behandlingshistorik counts, by the database's clock", async () => {
    const busy = await addIdentity(owner);
    // Three failed sign-ins two hours ago, stamped as the database would have; the trigger that stamps the time is off for the insert.
    const superuser = await db.admin();
    await superuser.query("BEGIN");
    await superuser.query("SET LOCAL session_replication_role = replica");
    await superuser.query(
      "INSERT INTO access.account_events (identity_id, kind, details, at) SELECT $1, 'sign-in', '{\"outcome\": \"failed\", \"old\": true}', pg_catalog.clock_timestamp() - interval '2 hours' FROM generate_series(1, 3)",
      [busy],
    );
    await superuser.query("COMMIT");
    // Two logouts, then 101 failed sign-ins, now.
    for (let count = 0; count < 2; count += 1) {
      await asPerson(app, busy, () => app.query("INSERT INTO access.account_events (identity_id, kind) VALUES ($1, 'logout')", [busy]));
    }
    for (let count = 0; count < 101; count += 1) {
      await asPerson(app, busy, () => app.query("INSERT INTO access.account_events (identity_id, kind, details) VALUES ($1, 'sign-in', $2)", [busy, { outcome: "failed", count }]));
    }
    await purge(T0);
    const kept = await owner.query<{ kind: string; count: number | null }>(
      "SELECT kind, (details ->> 'count')::integer AS count FROM access.account_events WHERE identity_id = $1 ORDER BY at, id",
      [busy],
    );
    expect(kept.rows.map((row) => row.count)).toEqual(Array.from({ length: 101 }, (_unused, index) => index));
  });

  it("is the app's to run, and a reader's not", async () => {
    const reader = await db.connect("readerA");
    await expectError(reader.query("SELECT access.purge_expired($1)", [T0]), INSUFFICIENT_PRIVILEGE);
  });

  describe("the rows of the MCP login", () => {
    /** The company's owner, approving in it. */
    let approver: Approver;

    beforeAll(async () => {
      const company = await aCompany(app, "Testbolaget Alfa AB");
      approver = { company: company.id, membership: company.membership, who: company.asOwner };
    });

    /** The ids of `table`'s rows among `ids`, sorted. */
    async function kept(table: string, ids: readonly (string | null)[]): Promise<string[]> {
      return (await owner.query<{ id: string }>(`SELECT id::text AS id FROM ${table} WHERE id = ANY ($1::uuid[]) ORDER BY 1`, [ids])).rows.map((row) => row.id);
    }

    it("deletes an authorization request, a code and an access token at their end, used and revoked ones too, and keeps them until then", async () => {
      const client = await registerClient(app, { at: T0 });
      // A request that is never used ends at 10 minutes. A login's request is used at 1 minute, its code
      // issued then and used at 2, ending at 11, and its access token issued at 2, ending at 62.
      const open = await openRequest(app, client.id, { at: T0 });
      const login = await logIn(app, approver, { client });
      const revoked = await logIn(app, approver, { client });
      await anonymously(app, "SELECT * FROM access.revoke_oauth_token($1, $2, $3)", [revoked.tokens.accessHash, client.clientId, later(T0, 3)]);
      const requests = [open.id, login.request.id, revoked.request.id];
      const codes = [login.approval.codeId, revoked.approval.codeId];
      const accessTokens = [login.tokens.accessTokenId, revoked.tokens.accessTokenId];
      await purge(later(T0, 9));
      expect(await kept("access.oauth_requests", requests)).toEqual([...requests].sort());
      await purge(later(T0, 10));
      expect(await kept("access.oauth_requests", requests)).toEqual([]);
      expect(await kept("access.oauth_codes", codes)).toEqual([...codes].sort());
      await purge(later(T0, 11));
      expect(await kept("access.oauth_codes", codes)).toEqual([]);
      await purge(later(T0, 61));
      expect(await kept("access.oauth_access_tokens", accessTokens)).toEqual([...accessTokens].sort());
      await purge(later(T0, 62));
      expect(await kept("access.oauth_access_tokens", accessTokens)).toEqual([]);
      await expectNoSecretsAtRest(db);
    });

    it("keeps a family's refresh tokens, used and revoked ones too, until every one of them has passed its end, so a reuse is still found", async () => {
      // The first refresh token is issued at 2 minutes and used at 30; the one it gave ends 45 days after 30 minutes.
      const login = await logIn(app, approver);
      const refreshed = await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId, at: later(T0, 30) });
      // A family that the client revoked, which ends 45 days after 2 minutes.
      const other = await logIn(app, approver, { client: login.client });
      await anonymously(app, "SELECT * FROM access.revoke_oauth_token($1, $2, $3)", [other.tokens.refreshHash, login.client.clientId, later(T0, 3)]);
      const family = [login.tokens.refreshTokenId, refreshed.refreshTokenId];
      const revoked = [other.tokens.refreshTokenId];
      await purge(later(T0, 2 + 45 * DAY - 1));
      expect(await kept("access.oauth_refresh_tokens", [...family, ...revoked])).toEqual([...family, ...revoked].sort());
      await purge(later(T0, 2 + 45 * DAY));
      expect(await kept("access.oauth_refresh_tokens", [...family, ...revoked])).toEqual([...family].sort());
      // The used one is still found when it comes back, and its family is revoked.
      expect((await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId, at: later(T0, 2 + 45 * DAY) })).outcome).toBe("reused");
      await purge(later(T0, 30 + 45 * DAY - 1));
      expect(await kept("access.oauth_refresh_tokens", family)).toEqual([...family].sort());
      await purge(later(T0, 30 + 45 * DAY));
      expect(await kept("access.oauth_refresh_tokens", family)).toEqual([]);
    });

    it("deletes a client that has no consent 24 hours after its registration, keeps one with a consent, and deletes no consent", async () => {
      const lonely = await registerClient(app, { at: T0 });
      const consented = await registerClient(app, { at: T0 });
      const login = await logIn(app, approver, { client: consented });
      // A request of the lonely client, still live when the client goes.
      const request = await openRequest(app, lonely.id, { at: later(T0, DAY - 5) });
      await purge(later(T0, DAY - 1));
      expect(await kept("access.oauth_clients", [lonely.id, consented.id])).toEqual([lonely.id, consented.id].sort());
      await purge(later(T0, DAY));
      expect(await kept("access.oauth_clients", [lonely.id, consented.id])).toEqual([consented.id]);
      // The request stays until its end, and finds nothing without its client.
      expect(await kept("access.oauth_requests", [request.id])).toEqual([request.id]);
      expect(await anonymously(app, "SELECT * FROM access.oauth_request_by_token($1, $2, $3)", [request.hash, request.binding, later(T0, DAY)])).toEqual([]);
      await purge(later(T0, 365 * DAY));
      expect(await kept("access.oauth_clients", [consented.id])).toEqual([consented.id]);
      expect(await kept("access.consents", [login.approval.consent.id])).toEqual([login.approval.consent.id]);
    });

    it("waits for an approval that holds the client: keeps the client when the approval gives its first consent, and deletes it when the approval ends without one", async () => {
      const holder = await db.connect("app");
      const purger = await db.connect("app");
      const pid = await backendPid(purger);
      for (const ending of ["consent", "rollback"] as const) {
        const client = await registerClient(app, { at: T0 });
        const at = later(T0, DAY - 1);
        const request = await openRequest(app, client.id, { at });
        await begin(holder, { company: approver.company, ...approver.who, channel: "rest" });
        try {
          expect((await holder.query("SELECT * FROM access.use_oauth_request($1, $2, $3)", [request.hash, request.binding, at])).rows).toHaveLength(1);
          const purging = inTransaction(purger, { channel: "rest" }, () => purger.query("SELECT access.purge_expired($1)", [later(T0, DAY)]));
          await untilWaitingForLock(app, pid);
          if (ending === "consent") {
            await holder.query(INSERT_CONSENT, [approver.company, approver.membership, client.id, ["profile"]]);
            await holder.query("COMMIT");
          } else {
            await holder.query("ROLLBACK");
          }
          await purging;
        } catch (error) {
          await holder.query("ROLLBACK");
          throw error;
        }
        expect(await kept("access.oauth_clients", [client.id]), ending).toEqual(ending === "consent" ? [client.id] : []);
      }
    });
  });
});
