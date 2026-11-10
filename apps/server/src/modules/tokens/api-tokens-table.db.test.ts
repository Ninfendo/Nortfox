// SPDX-License-Identifier: AGPL-3.0-only

// The table of the API tokens (issue 12, API tokens; plan 2.6, 2.7 and
// 2.11). A token is kept only as the SHA-256 of the whole token, never in
// clear. It belongs to one company and to the membership of its person
// there, paired with the company, so a token can never name company A and a
// membership of company B. It is an install-wide table of the company class:
// the app reads and writes only the tokens of the transaction's company, so
// a request in company A never sees or makes a token of the person's other
// company. The resolver finds a token by its hash, before it knows any
// company, through one lookup function.
//
// The database stamps the token's person, the transaction's actor, and when
// it was made. A token is revoked once, and the database stamps who revoked
// it. Nothing else of a token ever changes, and no token is deleted. Its
// trigger writes the token's entries in the behandlingshistorik itself, in
// the token's company: one when it is made, and one when it is revoked.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type Settings,
  type TestDatabase,
} from "../../../test/database.ts";
import { addIdentity, anonymously, tokenHash } from "../../../test/identities.ts";
import { someIntegration, type Actor } from "../../../test/ledger.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";
import { API_TOKEN_COLUMNS, INSERT_API_TOKEN, addApiToken, type ApiTokenRow } from "../../../test/tokens.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

describe("the API tokens' table", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let alfa: Company;
  let beta: Company;
  /** Alva: Alfa's owner, and an active member of Beta. */
  let alva: Actor;
  /** Alva's membership in Beta. */
  let alvaInBeta: string;
  /** Gunnar: an active member of Alfa. */
  let gunnar: Actor;
  let gunnarInAlfa: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    beta = await aCompany(app, "Testbolaget Beta AB");
    alva = alfa.asOwner;
    alvaInBeta = await addMembership(app, owner, beta, { user: alva.actor });
    const gunnarId = await addIdentity(owner, { name: "Gunnar Holm" });
    gunnar = { actor: gunnarId, kind: "user" };
    gunnarInAlfa = await addMembership(app, owner, alfa, { user: gunnarId });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs `sql` as the app in `company` as `who`, through REST, and gives its rows. */
  function inCompany<T extends object = Record<string, unknown>>(company: string, who: Actor, sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return asMember<T>(app, company, who, sql, params);
  }

  /** The tokens the app reads with `settings`, by id. */
  async function seen(settings: Settings): Promise<string[]> {
    return inTransaction(app, settings, async () => (await app.query<{ id: string }>("SELECT id FROM access.api_tokens ORDER BY id")).rows.map((row) => row.id));
  }

  /** A token of Alva in Alfa. */
  function alvasToken(name = "Bokföringsexport", scopes: readonly string[] = ["bookkeeping"]): Promise<{ row: ApiTokenRow; hash: Buffer }> {
    return addApiToken(app, alfa.id, alfa.membership, alva, { name, scopes });
  }

  describe("the hash", () => {
    it("keeps a token only as its hash: its columns hold no token in clear", async () => {
      const found = await owner.query<{ name: string; type: string; nullable: boolean }>(
        `SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
         FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = 'access.api_tokens'::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      );
      expect(found.rows).toEqual([
        { name: "id", type: "uuid", nullable: false },
        { name: "token_hash", type: "bytea", nullable: false },
        { name: "token_company_id", type: "uuid", nullable: false },
        { name: "membership_id", type: "uuid", nullable: false },
        { name: "identity_id", type: "uuid", nullable: false },
        { name: "name", type: "text", nullable: false },
        { name: "scopes", type: "text[]", nullable: false },
        { name: "created_at", type: "timestamp with time zone", nullable: false },
        { name: "revoked_at", type: "timestamp with time zone", nullable: true },
        { name: "revoked_by", type: "uuid", nullable: true },
      ]);
    });

    it("takes a hash of exactly 32 bytes, once in the install", async () => {
      for (const hash of [Buffer.alloc(0), Buffer.alloc(31, 7), Buffer.alloc(33, 7), Buffer.from("nft_token", "utf8")]) {
        await expectError(addApiToken(app, alfa.id, alfa.membership, alva, { hash }), CHECK_VIOLATION, /api_tokens_token_hash_form/);
      }
      const { hash } = await alvasToken();
      // Also in another company of the person.
      await expectError(addApiToken(app, beta.id, alvaInBeta, alva, { hash }), UNIQUE_VIOLATION, /api_tokens_token_hash_key/);
    });

    it("finds a live token by its hash, before any company is set, with its person, the identity's status, its company, its membership and its scopes", async () => {
      const { row, hash } = await alvasToken("Lönesystemet", ["bookkeeping", "companyinformation"]);
      const LOOKUP = "SELECT token_id, identity_id, status, token_company_id, membership_id, scopes FROM access.api_token_by_token($1)";
      expect(await anonymously(app, LOOKUP, [hash])).toEqual([
        { token_id: row.id, identity_id: alva.actor, status: "active", token_company_id: alfa.id, membership_id: alfa.membership, scopes: ["bookkeeping", "companyinformation"] },
      ]);
      // A wrong hash, or one of another length, finds nothing.
      expect(await anonymously(app, LOOKUP, [tokenHash()])).toEqual([]);
      expect(await anonymously(app, LOOKUP, [hash.subarray(0, 31)])).toEqual([]);
      // A revoked token is found no more.
      await inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [row.id]);
      expect(await anonymously(app, LOOKUP, [hash])).toEqual([]);
    });
  });

  describe("the app's policy by company", () => {
    it("shows the app only the tokens of the transaction's company: none of the person's other company, and none with no company set", async () => {
      const inAlfa = (await alvasToken()).row.id;
      const inBeta = (await addApiToken(app, beta.id, alvaInBeta, alva)).row.id;
      const alfaTokens = await seen({ company: alfa.id, ...alva });
      expect(alfaTokens).toContain(inAlfa);
      expect(alfaTokens).not.toContain(inBeta);
      const betaTokens = await seen({ company: beta.id, ...alva });
      expect(betaTokens).toContain(inBeta);
      expect(betaTokens).not.toContain(inAlfa);
      expect(await seen({ ...alva })).toEqual([]);
      expect(await seen({})).toEqual([]);
      // Nor can a request in Alfa revoke the person's token in Beta.
      const revoked = await inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1 RETURNING id", [inBeta]);
      expect(revoked).toEqual([]);
      expect((await inCompany<ApiTokenRow>(beta.id, alva, `SELECT ${API_TOKEN_COLUMNS} FROM access.api_tokens WHERE id = $1`, [inBeta]))[0]?.revoked_at).toBeNull();
    });

    it("lets the app make no token for another company than the transaction's, nor with no company set", async () => {
      const make = (settings: Settings): Promise<unknown> =>
        inTransaction(app, { ...settings, channel: "rest" }, () => app.query(INSERT_API_TOKEN, [tokenHash(), beta.id, alvaInBeta, "Bokföringsexport", ["bookkeeping"]]));
      await expectError(make({ company: alfa.id, ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security/);
      await expectError(make({ ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security/);
    });

    it("refuses the owner a token whose company is not the transaction's, since its entry goes to the token's company", async () => {
      const make = (settings: Settings): Promise<unknown> =>
        inTransaction(owner, { ...settings, channel: "rest" }, () => owner.query(INSERT_API_TOKEN, [tokenHash(), beta.id, alvaInBeta, "Bokföringsexport", ["bookkeeping"]]));
      await expectError(make({ company: alfa.id, ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security policy for table "events"/);
      await expectError(make({ ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security policy for table "events"/);
      // And a revoke of Beta's token in Alfa.
      const inBeta = (await addApiToken(app, beta.id, alvaInBeta, alva)).row.id;
      await expectError(
        inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("UPDATE access.api_tokens SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [inBeta])),
        INSUFFICIENT_PRIVILEGE,
        /row-level security policy for table "events"/,
      );
    });
  });

  describe("the paired membership key", () => {
    it("refuses a token whose membership is of another company than the token, also the same person's", async () => {
      // Alva's membership in Beta, named with Alfa.
      await expectError(addApiToken(app, alfa.id, alvaInBeta, alva), FOREIGN_KEY_VIOLATION, /api_tokens_membership_fkey/);
      // And as the owner, whose policy reads every row.
      await expectError(
        inTransaction(owner, { company: alfa.id, ...alva, channel: "rest" }, () => owner.query(INSERT_API_TOKEN, [tokenHash(), alfa.id, alvaInBeta, "Bokföringsexport", ["bookkeeping"]])),
        FOREIGN_KEY_VIOLATION,
        /api_tokens_membership_fkey/,
      );
      // A membership that is no one's.
      await expectError(addApiToken(app, alfa.id, randomUUID(), alva), FOREIGN_KEY_VIOLATION, /api_tokens_membership_fkey/);
    });
  });

  describe("what the database stamps and checks", () => {
    it("stamps the token's person, the transaction's actor, and when it was made, to the millisecond, and nothing of a revoke", async () => {
      const before = new Date(Date.now() - 1000);
      const { row } = await addApiToken(app, alfa.id, gunnarInAlfa, gunnar, { name: "Kassaregistret", scopes: ["bookkeeping", "costcenter"] });
      expect(row).toMatchObject({
        token_company_id: alfa.id,
        membership_id: gunnarInAlfa,
        identity_id: gunnar.actor,
        name: "Kassaregistret",
        scopes: ["bookkeeping", "costcenter"],
        revoked_at: null,
        revoked_by: null,
      });
      expect(new Date(row.created_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
      const whole = await owner.query<{ whole: boolean }>("SELECT $1::timestamptz = pg_catalog.date_trunc('milliseconds', $1::timestamptz) AS whole", [row.created_at]);
      expect(whole.rows[0]?.whole).toBe(true);
    });

    it.each([
      ["identity_id", (): string => alva.actor],
      ["created_at", (): string => "2090-03-15T10:00:00.000Z"],
      ["revoked_at", (): string => "2090-03-15T10:00:00.000Z"],
      ["revoked_by", (): string => alva.actor],
    ] as const)("refuses a %s that is given with a new token", async (column, value) => {
      await expectRefusal(
        inCompany(alfa.id, alva, `INSERT INTO access.api_tokens (token_hash, token_company_id, membership_id, name, scopes, ${column}) VALUES ($1, $2, $3, $4, $5, $6)`, [
          tokenHash(),
          alfa.id,
          alfa.membership,
          "Bokföringsexport",
          ["bookkeeping"],
          value(),
        ]),
        "immutable_field",
        { field: column, operation: "create" },
      );
    });

    it("takes a name of 1 to 100 characters on one line", async () => {
      expect((await alvasToken("x")).row.name).toBe("x");
      expect((await alvasToken("Å".repeat(100))).row.name).toBe("Å".repeat(100));
      await expectError(alvasToken(""), CHECK_VIOLATION, /api_tokens_name_length/);
      await expectError(alvasToken("Å".repeat(101)), CHECK_VIOLATION, /api_tokens_name_length/);
      for (const name of ["Två\nrader", "Tab\tbort", "Retur\r", "Ljud\u{7}", "Rad\u{2028}skift", "Stycke\u{2029}", "Riktning\u{202E}", "Isolat\u{2066}", "Märke\u{200F}"]) {
        await expectError(alvasToken(name), CHECK_VIOLATION, /api_tokens_name_one_line/);
      }
    });

    it("takes one or more scopes, each a word of small letters, in a list of one dimension", async () => {
      expect((await alvasToken("Alla", ["companyinformation", "profile", "companies", "users", "tokens"])).row.scopes).toHaveLength(5);
      for (const scopes of [[], ["Bookkeeping"], ["book keeping"], ["bookkeeping,profile"], ["bookkeeping", ""], ["companyinformation", "bookkeeping-2"], ["åäö"], ["null"]]) {
        await expectError(alvasToken("Fel", scopes), CHECK_VIOLATION, /api_tokens_scopes_form/);
      }
      await expectError(
        inCompany(alfa.id, alva, INSERT_API_TOKEN, [tokenHash(), alfa.id, alfa.membership, "Fel", ["bookkeeping", null]]),
        CHECK_VIOLATION,
        /api_tokens_scopes_form/,
      );
      // Two dimensions, and a list that does not start at 1.
      for (const literal of ["{{bookkeeping},{profile}}", "[2:2]={bookkeeping}"]) {
        await expectError(
          inCompany(alfa.id, alva, "INSERT INTO access.api_tokens (token_hash, token_company_id, membership_id, name, scopes) VALUES ($1, $2, $3, 'Fel', $4::text[])", [
            tokenHash(),
            alfa.id,
            alfa.membership,
            literal,
          ]),
          CHECK_VIOLATION,
          /api_tokens_scopes_form/,
        );
      }
    });

    it("refuses a token with no actor", async () => {
      await expectRefusal(
        inTransaction(app, { company: alfa.id }, () => app.query(INSERT_API_TOKEN, [tokenHash(), alfa.id, alfa.membership, "Bokföringsexport", ["bookkeeping"]])),
        "actor_missing",
        { setting: "nortfox.actor_id" },
      );
    });
  });

  describe("a revoke", () => {
    const REVOKE = `UPDATE access.api_tokens SET revoked_at = $2 WHERE id = $1 RETURNING ${API_TOKEN_COLUMNS}`;

    it("stamps who revoked the token: the transaction's actor, here a system administrator who revokes a member's token", async () => {
      const { row } = await addApiToken(app, alfa.id, gunnarInAlfa, gunnar);
      const [revoked] = await inCompany<ApiTokenRow>(alfa.id, alva, REVOKE, [row.id, "2090-03-15T10:00:00.123Z"]);
      expect(revoked).toEqual({ ...row, revoked_at: "2090-03-15 10:00:00.123+00", revoked_by: alva.actor });
    });

    it("refuses a second revoke, and one taken back", async () => {
      const { row } = await alvasToken();
      await inCompany(alfa.id, alva, REVOKE, [row.id, "2090-03-15T10:00:00.000Z"]);
      await expectRefusal(inCompany(alfa.id, alva, REVOKE, [row.id, "2090-03-15T11:00:00.000Z"]), "immutable_field", { field: "revoked_at", operation: "update" });
      await expectRefusal(inCompany(alfa.id, gunnar, REVOKE, [row.id, "2090-03-15T11:00:00.000Z"]), "immutable_field", { field: "revoked_at", operation: "update" });
      await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_at = NULL, revoked_by = NULL WHERE id = $1", [row.id]), "immutable_field", {
        field: "revoked_at",
        operation: "update",
      });
      await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_by = $2 WHERE id = $1", [row.id, gunnar.actor]), "immutable_field", {
        field: "revoked_by",
        operation: "update",
      });
      const [kept] = await inCompany<ApiTokenRow>(alfa.id, alva, `SELECT ${API_TOKEN_COLUMNS} FROM access.api_tokens WHERE id = $1`, [row.id]);
      expect(kept).toEqual({ ...row, revoked_at: "2090-03-15 10:00:00+00", revoked_by: alva.actor });
    });

    it("refuses a revoke that gives who revoked, and who revoked without a revoke", async () => {
      const { row } = await alvasToken();
      await expectRefusal(
        inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_at = pg_catalog.clock_timestamp(), revoked_by = $2 WHERE id = $1", [row.id, gunnar.actor]),
        "immutable_field",
        { field: "revoked_by", operation: "update" },
      );
      await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_by = $2 WHERE id = $1", [row.id, gunnar.actor]), "immutable_field", {
        field: "revoked_by",
        operation: "update",
      });
    });

    it.each([
      ["id", "id = $2::uuid", (): unknown => randomUUID()],
      ["token_hash", "token_hash = $2::bytea", (): unknown => tokenHash()],
      ["token_company_id", "token_company_id = $2::uuid", (): unknown => randomUUID()],
      ["membership_id", "membership_id = $2::uuid", (): unknown => randomUUID()],
      ["identity_id", "identity_id = $2::uuid", (): unknown => randomUUID()],
      ["name", "name = $2::text", (): unknown => "Ett annat namn"],
      ["scopes", "scopes = $2::text[]", (): unknown => ["bookkeeping", "profile"]],
      ["created_at", "created_at = $2::timestamptz", (): unknown => "2090-01-01T00:00:00Z"],
    ] as const)("refuses a change of the token's %s, also with its revoke", async (field, set, value) => {
      const { row } = await alvasToken();
      await expectRefusal(inCompany(alfa.id, alva, `UPDATE access.api_tokens SET ${set} WHERE id = $1`, [row.id, value()]), "immutable_field", { field, operation: "update" });
      await expectRefusal(
        inCompany(alfa.id, alva, `UPDATE access.api_tokens SET ${set}, revoked_at = pg_catalog.clock_timestamp() WHERE id = $1`, [row.id, value()]),
        "immutable_field",
        { field, operation: "update" },
      );
    });

    it("refuses the app a deletion, and every role one through the trigger", async () => {
      const { row } = await alvasToken();
      await expectError(inCompany(alfa.id, alva, "DELETE FROM access.api_tokens WHERE id = $1", [row.id]), INSUFFICIENT_PRIVILEGE, /permission denied for table api_tokens/);
      await expectRefusal(
        inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("DELETE FROM access.api_tokens WHERE id = $1", [row.id])),
        "append_only",
        { table: "access.api_tokens", operation: "DELETE" },
      );
      await expectRefusal(inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("TRUNCATE access.api_tokens")), "append_only", {
        table: "access.api_tokens",
        operation: "TRUNCATE",
      });
    });
  });

  describe("the entries in the behandlingshistorik", () => {
    /** An entry of access.events, with its history row's actor, as the app reads them in `company`. */
    interface Entry {
      readonly program: string;
      readonly heading: string;
      readonly subject_id: string;
      readonly details: Record<string, unknown>;
      readonly at: string;
      readonly actor_id: string;
      readonly actor_kind: string;
      readonly via_kind: string | null;
      readonly via_id: string | null;
      readonly channel: string | null;
    }

    async function entriesOf(company: string, token: string): Promise<Entry[]> {
      return inTransaction(app, { company }, async () =>
        (
          await app.query<Entry>(
            `SELECT e.program, e.heading, e.subject_id, e.details, e.at::text AS at, h.actor_id, h.actor_kind, h.via_kind, h.via_id::text AS via_id, h.channel
             FROM access.events AS e JOIN audit.history AS h ON h.table_name = 'access.events' AND h.row_id = e.id
             WHERE e.details ->> 'tokenId' = $1 ORDER BY e.at, h.id`,
            [token],
          )
        ).rows,
      );
    }

    it("writes the entry of a token made, in the token's company, with its maker as the actor", async () => {
      const { row } = await addApiToken(app, beta.id, alvaInBeta, alva, { name: "Lönesystemet", scopes: ["bookkeeping", "profile"] });
      expect(await entriesOf(beta.id, row.id)).toEqual([
        {
          program: "users",
          heading: "api-token-created",
          subject_id: alva.actor,
          details: { tokenId: row.id, name: "Lönesystemet", scopes: ["bookkeeping", "profile"] },
          at: row.created_at,
          actor_id: alva.actor,
          actor_kind: "user",
          via_kind: null,
          via_id: null,
          channel: "rest",
        },
      ]);
      // None in the person's other company.
      expect(await entriesOf(alfa.id, row.id)).toEqual([]);
    });

    it("writes the entry of a token revoked, with the time of the revoke and who revoked it, also through the token itself", async () => {
      const { row } = await addApiToken(app, alfa.id, gunnarInAlfa, gunnar, { name: "Kassaregistret", scopes: ["bookkeeping"] });
      // The token revokes itself: Gunnar as an integration through it.
      const through: Actor = { ...someIntegration(gunnar.actor), viaId: row.id };
      const [revoked] = await inCompany<ApiTokenRow>(alfa.id, through, `UPDATE access.api_tokens SET revoked_at = $2 WHERE id = $1 RETURNING ${API_TOKEN_COLUMNS}`, [
        row.id,
        "2090-03-15T10:00:00.000Z",
      ]);
      expect(revoked?.revoked_by).toBe(gunnar.actor);
      const details = { tokenId: row.id, name: "Kassaregistret", scopes: ["bookkeeping"] };
      expect(await entriesOf(alfa.id, row.id)).toEqual([
        {
          program: "users",
          heading: "api-token-created",
          subject_id: gunnar.actor,
          details,
          at: row.created_at,
          actor_id: gunnar.actor,
          actor_kind: "user",
          via_kind: null,
          via_id: null,
          channel: "rest",
        },
        {
          program: "users",
          heading: "api-token-revoked",
          subject_id: gunnar.actor,
          details,
          at: "2090-03-15 10:00:00+00",
          actor_id: gunnar.actor,
          actor_kind: "integration",
          via_kind: "api-token",
          via_id: row.id,
          channel: "rest",
        },
      ]);
    });

    it("writes no entry for a statement that changes no token, and none for a refused change", async () => {
      const { row } = await alvasToken();
      const before = await entriesOf(alfa.id, row.id);
      await inCompany(alfa.id, alva, "UPDATE access.api_tokens SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1 AND false", [row.id]);
      await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.api_tokens SET name = 'Nytt' WHERE id = $1", [row.id]), "immutable_field");
      expect(await entriesOf(alfa.id, row.id)).toEqual(before);
    });
  });
});
