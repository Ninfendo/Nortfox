// SPDX-License-Identifier: AGPL-3.0-only

// The tables of the MCP login (issue 12, OAuth for MCP clients; plan 2.6,
// 2.7 and 2.12). An MCP client registers itself and is public: the app
// reads every client and writes none, and only the registration function
// adds one. A person's approval at the authorization step is a consent: the
// client, the company, the scopes, who approved them and when. A consent is
// of the company class, as an API token is: the app reads, gives and
// revokes only the transaction's company's, its membership pairs with its
// company, the database stamps who gave it and when, and its trigger writes
// its entries in the behandlingshistorik. A new consent replaces the
// person's live one for the same client in the same company. The
// authorization requests, the codes and the access and refresh tokens are
// secret: each is kept only as its hash, and the app reaches them only
// through the database's functions. A request, a code and a refresh token
// each work once, also for two parallel calls; a code or a refresh token
// that comes back after its use revokes every live token of its grant
// family. The tests move the server's clock forwards only.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type Settings,
  type TestDatabase,
} from "../../../test/database.ts";
import { addIdentity, anonymously, deleteIdentity, later, tokenHash } from "../../../test/identities.ts";
import { someIntegration, type Actor } from "../../../test/ledger.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";
import {
  CONSENT_COLUMNS,
  INSERT_CONSENT,
  LIFETIMES,
  REDIRECT_URI,
  addConsent,
  approve,
  challengeOf,
  logIn,
  openRequest,
  redeemCode,
  redeemRefreshToken,
  registerClient,
  someClientId,
  someVerifier,
  type Approver,
  type ConsentRow,
  type RegisteredClient,
} from "../../../test/oauth.ts";
import { expectNoSecretsAtRest } from "../../../test/secrets.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

/** The server's clock when the rows are made. */
const T0 = new Date("2090-03-15T10:00:00.000Z");

/** The secret tables of the login, which the app reaches only through the functions. */
const SECRET_TABLES = ["access.oauth_requests", "access.oauth_codes", "access.oauth_access_tokens", "access.oauth_refresh_tokens"] as const;

/** A row of access.use_oauth_request and access.oauth_request_by_token. */
interface RequestRow {
  readonly request_id: string;
  readonly oauth_client_id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uri: string;
  readonly scopes: string[];
  readonly state: string | null;
}

/** A row of access.oauth_access_token_by_token. */
interface AccessTokenRow {
  readonly token_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly consent_id: string;
  readonly consent_company_id: string;
  readonly membership_id: string;
  readonly oauth_client_id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly scopes: string[];
}

/** A row of access.revoke_oauth_token. */
interface RevokeRow {
  readonly kind: string;
  readonly revoked: number;
  readonly consent_id: string;
  readonly identity_id: string;
  readonly consent_company_id: string;
  readonly membership_id: string;
  readonly oauth_client_id: string;
  readonly client_name: string;
}

describe("the tables of the MCP login", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Connections of their own as the app, for the parallel calls. */
  const parallel: Client[] = [];
  let alfa: Company;
  let beta: Company;
  /** Alva: Alfa's owner, and an active member of Beta. */
  let alva: Actor;
  let alvaInBeta: string;
  /** Gunnar: an active member of Alfa. */
  let gunnar: Actor;
  let gunnarInAlfa: string;
  /** Alva approving in Alfa, in Beta, and Gunnar in Alfa. */
  let alvaAlfa: Approver;
  let alvaBeta: Approver;
  let gunnarAlfa: Approver;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    for (let count = 0; count < 2; count += 1) {
      parallel.push(await db.connect("app"));
    }
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    beta = await aCompany(app, "Testbolaget Beta AB");
    alva = alfa.asOwner;
    alvaInBeta = await addMembership(app, owner, beta, { user: alva.actor });
    const gunnarId = await addIdentity(owner, { name: "Gunnar Holm" });
    gunnar = { actor: gunnarId, kind: "user" };
    gunnarInAlfa = await addMembership(app, owner, alfa, { user: gunnarId });
    alvaAlfa = { company: alfa.id, membership: alfa.membership, who: alva };
    alvaBeta = { company: beta.id, membership: alvaInBeta, who: alva };
    gunnarAlfa = { company: alfa.id, membership: gunnarInAlfa, who: gunnar };
  });

  afterAll(async () => {
    await expectNoSecretsAtRest(db);
    await db.close();
  });

  /** The columns of `table`, with their types and whether they may be NULL. */
  async function columnsOf(table: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
    const found = await owner.query<{ name: string; type: string; nullable: boolean }>(
      `SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
       FROM pg_catalog.pg_attribute AS a
       WHERE a.attrelid = $1::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [table],
    );
    return found.rows;
  }

  describe("the columns", () => {
    it("keeps every request, code and token only as its hash: no column holds one in clear", async () => {
      const column = (name: string, type: string, nullable = false): { name: string; type: string; nullable: boolean } => ({ name, type, nullable });
      const uuid = "uuid";
      const time = "timestamp with time zone";
      expect(await columnsOf("access.oauth_clients")).toEqual([
        column("id", uuid),
        column("client_id", "text"),
        column("client_name", "text"),
        column("redirect_uris", "text[]"),
        column("grant_types", "text[]"),
        column("created_at", time),
        column("first_consent_at", time, true),
      ]);
      expect(await columnsOf("access.oauth_requests")).toEqual([
        column("id", uuid),
        column("token_hash", "bytea"),
        column("oauth_client_id", uuid),
        column("redirect_uri", "text"),
        column("scopes", "text[]"),
        column("code_challenge", "text"),
        column("state", "text", true),
        column("resource", "text", true),
        column("binding_hash", "bytea"),
        column("created_at", time),
        column("expires_at", time),
        column("used_at", time, true),
      ]);
      expect(await columnsOf("access.consents")).toEqual([
        column("id", uuid),
        column("consent_company_id", uuid),
        column("membership_id", uuid),
        column("oauth_client_id", uuid),
        column("identity_id", uuid),
        column("scopes", "text[]"),
        column("approved_at", time),
        column("revoked_at", time, true),
        column("revoked_by", uuid, true),
      ]);
      expect(await columnsOf("access.oauth_codes")).toEqual([
        column("id", uuid),
        column("token_hash", "bytea"),
        column("request_id", uuid),
        column("consent_id", uuid),
        column("redirect_uri", "text"),
        column("code_challenge", "text"),
        column("created_at", time),
        column("expires_at", time),
        column("used_at", time, true),
      ]);
      for (const table of ["access.oauth_access_tokens", "access.oauth_refresh_tokens"]) {
        expect(await columnsOf(table), table).toEqual([
          column("id", uuid),
          column("token_hash", "bytea"),
          column("consent_id", uuid),
          column("family_id", uuid),
          column("scopes", "text[]"),
          column("created_at", time),
          column("expires_at", time),
          ...(table === "access.oauth_refresh_tokens" ? [column("used_at", time, true)] : []),
          column("revoked_at", time, true),
        ]);
      }
    });

    it("lets the app read and write no secret table of the login directly, and a reader no table or function of it", async () => {
      for (const table of SECRET_TABLES) {
        await expectError(app.query(`SELECT * FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
        await expectError(app.query(`INSERT INTO ${table} DEFAULT VALUES`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
        await expectError(app.query(`UPDATE ${table} SET id = id`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
        await expectError(app.query(`DELETE FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
      }
      const reader = await db.connect("readerA");
      for (const table of [...SECRET_TABLES, "access.oauth_clients", "access.consents"]) {
        await expectError(reader.query(`SELECT * FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
      }
      await expectError(reader.query("SELECT * FROM access.oauth_access_token_by_token($1, $2)", [tokenHash(), T0]), INSUFFICIENT_PRIVILEGE, /permission denied for function/);
    });
  });

  describe("the clients", () => {
    /** The clients the app reads with `settings`, by row id. */
    async function seen(settings: Settings): Promise<string[]> {
      return inTransaction(app, settings, async () => (await app.query<{ id: string }>("SELECT id FROM access.oauth_clients ORDER BY id")).rows.map((row) => row.id));
    }

    it("registers a client at the server's time, and lets the app read every client, with or without a person or a company, and write none", async () => {
      const at = later(T0, 5);
      const client = await registerClient(app, { name: "Kodassistenten", redirectUris: [REDIRECT_URI, "https://klient.example/oauth/callback"], at });
      const found = await owner.query("SELECT client_id, client_name, redirect_uris, grant_types, created_at, first_consent_at FROM access.oauth_clients WHERE id = $1", [
        client.id,
      ]);
      expect(found.rows).toEqual([
        {
          client_id: client.clientId,
          client_name: "Kodassistenten",
          redirect_uris: [REDIRECT_URI, "https://klient.example/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          created_at: at,
          first_consent_at: null,
        },
      ]);
      for (const settings of [{}, { channel: "rest" }, { ...alva }, { company: alfa.id, ...alva }, { company: beta.id, ...gunnar }] as Settings[]) {
        expect(await seen(settings)).toContain(client.id);
      }
      for (const sql of [
        `INSERT INTO access.oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at) VALUES ('${someClientId()}', 'X', '{${REDIRECT_URI}}', '{authorization_code}', pg_catalog.now())`,
        "UPDATE access.oauth_clients SET client_name = 'Annat namn'",
        "DELETE FROM access.oauth_clients",
        "TRUNCATE access.oauth_clients",
      ]) {
        await expectError(asMember(app, alfa.id, alva, sql), INSUFFICIENT_PRIVILEGE, /permission denied for table oauth_clients/);
      }
    });

    it("takes a client id of nfk_ and 22 characters of base64url, once in the install", async () => {
      const { clientId } = await registerClient(app);
      await expectError(registerClient(app, { clientId }), UNIQUE_VIOLATION, /oauth_clients_client_id_key/);
      for (const wrong of ["", "nfk_", `nfk_${"a".repeat(21)}`, `nfk_${"a".repeat(23)}`, `nft_${"a".repeat(22)}`, `NFK_${"a".repeat(22)}`, `nfk_${"a".repeat(21)}=`, `nfk_${"å".repeat(22)}`]) {
        await expectError(registerClient(app, { clientId: wrong }), CHECK_VIOLATION, /oauth_clients_client_id_form/);
      }
    });

    it("takes a name of 1 to 100 characters on one line", async () => {
      await registerClient(app, { name: "x" });
      await registerClient(app, { name: "Å".repeat(100) });
      await expectError(registerClient(app, { name: "" }), CHECK_VIOLATION, /oauth_clients_client_name_length/);
      await expectError(registerClient(app, { name: "Å".repeat(101) }), CHECK_VIOLATION, /oauth_clients_client_name_length/);
      for (const name of ["Två\nrader", "Tab\tbort", "Retur\r", "Ljud\u{7}", "Rad\u{2028}skift", "Stycke\u{2029}", "Riktning\u{202E}", "Isolat\u{2066}", "Märke\u{200F}"]) {
        await expectError(registerClient(app, { name }), CHECK_VIOLATION, /oauth_clients_client_name_one_line/);
      }
    });

    it.each([
      ["https to a host", "https://klient.example/callback"],
      ["https with a port, a path and a query", "https://klient.example:8443/oauth/callback?from=mcp&x=1"],
      ["https to a host with no path", "https://klient.example"],
      ["https to an address", "https://192.0.2.10/cb"],
      ["https to an IPv6 address", "https://[2001:db8::1]/cb"],
      ["http to 127.0.0.1", "http://127.0.0.1/callback"],
      ["http to 127.0.0.1 with a port", "http://127.0.0.1:33418/callback"],
      ["http to [::1] with a port", "http://[::1]:33418/callback"],
      ["http to localhost with a port", "http://localhost:8090/callback"],
    ])("takes a redirect URI of %s", async (_case, uri) => {
      const client = await registerClient(app, { redirectUris: [uri] });
      const found = await owner.query<{ uris: string[] }>("SELECT redirect_uris AS uris FROM access.oauth_clients WHERE id = $1", [client.id]);
      expect(found.rows[0]?.uris).toEqual([uri]);
    });

    it.each([
      ["no scheme", "klient.example/callback"],
      ["http to another host", "http://klient.example/callback"],
      ["http to another loopback address", "http://127.0.0.2/callback"],
      ["http to a host that starts like localhost", "http://localhost.example/callback"],
      ["a custom scheme", "com.example.klient:/callback"],
      ["a scheme in capitals", "HTTPS://klient.example/callback"],
      ["a fragment", "https://klient.example/callback#here"],
      ["a user", "https://namn@klient.example/callback"],
      ["a space", "https://klient.example/call back"],
      ["a quote", 'https://klient.example/"callback"'],
      ["a line break", "https://klient.example/callback\n"],
      ["a letter outside ASCII", "https://klient.example/återkomst"],
      ["a host outside ASCII", "https://klïent.example/callback"],
      ["no host", "https:///callback"],
      ["a host that ends in a dot", "https://klient./callback"],
      ["a port of six digits", "https://klient.example:844300/callback"],
      ["an empty text", ""],
      ["2001 characters", `https://klient.example/${"a".repeat(2001 - 23)}`],
    ])("refuses a redirect URI with %s", async (_case, uri) => {
      await expectError(registerClient(app, { redirectUris: [uri] }), CHECK_VIOLATION, /oauth_clients_redirect_uris_form/);
    });

    it("takes 1 to 5 redirect URIs of up to 2000 characters, in a list of one dimension with no NULL", async () => {
      const long = `https://klient.example/${"a".repeat(2000 - 23)}`;
      expect(long).toHaveLength(2000);
      await registerClient(app, { redirectUris: [long] });
      await registerClient(app, { redirectUris: Array.from({ length: 5 }, (_unused, index) => `http://127.0.0.1:${String(40000 + index)}/cb`) });
      await expectError(registerClient(app, { redirectUris: [] }), CHECK_VIOLATION, /oauth_clients_redirect_uris_form/);
      await expectError(
        registerClient(app, { redirectUris: Array.from({ length: 6 }, (_unused, index) => `http://127.0.0.1:${String(40000 + index)}/cb`) }),
        CHECK_VIOLATION,
        /oauth_clients_redirect_uris_form/,
      );
      const register = (uris: string): Promise<unknown> =>
        anonymously(app, "SELECT access.register_oauth_client($1, 'Fel', $2::text[], '{authorization_code}', $3)", [someClientId(), uris, T0]);
      for (const literal of [`{${REDIRECT_URI},NULL}`, `{{${REDIRECT_URI}},{${REDIRECT_URI}}}`, `[2:2]={${REDIRECT_URI}}`]) {
        await expectError(register(literal), CHECK_VIOLATION, /oauth_clients_redirect_uris_form/);
      }
    });

    it("takes the grant types authorization_code, alone or with refresh_token after it, and nothing else", async () => {
      await registerClient(app, { grantTypes: ["authorization_code"] });
      await registerClient(app, { grantTypes: ["authorization_code", "refresh_token"] });
      for (const grantTypes of [[], ["refresh_token"], ["refresh_token", "authorization_code"], ["authorization_code", "authorization_code"], ["implicit"], ["client_credentials"], ["Authorization_code"]]) {
        await expectError(registerClient(app, { grantTypes }), CHECK_VIOLATION, /oauth_clients_grant_types_known/);
      }
    });

    it("refuses a first consent's time given with a client, and every change of a client but its first consent's time, which is set once", async () => {
      await expectRefusal(
        owner.query("INSERT INTO access.oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at, first_consent_at) VALUES ($1, 'X', $2, '{authorization_code}', $3, $3)", [
          someClientId(),
          [REDIRECT_URI],
          T0,
        ]),
        "immutable_field",
        { field: "first_consent_at", operation: "create" },
      );
      const client = await registerClient(app);
      for (const [field, set, value] of [
        ["id", "id = $2::uuid", randomUUID()],
        ["client_id", "client_id = $2", someClientId()],
        ["client_name", "client_name = $2", "Ett annat namn"],
        ["redirect_uris", "redirect_uris = $2::text[]", ["http://127.0.0.1:1/cb"]],
        ["grant_types", "grant_types = $2::text[]", ["authorization_code"]],
        ["created_at", "created_at = $2::timestamptz", later(T0, 1)],
      ] as const) {
        await expectRefusal(owner.query(`UPDATE access.oauth_clients SET ${set} WHERE id = $1`, [client.id, value]), "immutable_field", { field, operation: "update" });
      }
      await owner.query("UPDATE access.oauth_clients SET first_consent_at = $2 WHERE id = $1", [client.id, T0]);
      for (const value of [later(T0, 1), null]) {
        await expectRefusal(owner.query("UPDATE access.oauth_clients SET first_consent_at = $2 WHERE id = $1", [client.id, value]), "immutable_field", {
          field: "first_consent_at",
          operation: "update",
        });
      }
    });
  });

  describe("the authorization requests", () => {
    function requestOf(hash: Buffer, binding: Buffer, at = T0): Promise<RequestRow[]> {
      return anonymously<RequestRow>(app, "SELECT * FROM access.oauth_request_by_token($1, $2, $3)", [hash, binding, at]);
    }

    function use(client: Client, hash: Buffer, binding: Buffer, at = T0): Promise<RequestRow[]> {
      return client.query<RequestRow>("SELECT * FROM access.use_oauth_request($1, $2, $3)", [hash, binding, at]).then((found) => found.rows);
    }

    it("opens a request only for a client and one of its redirect URIs, and finds a live one by its hash and its binding, with its client", async () => {
      const client = await registerClient(app, { name: "Kodassistenten", redirectUris: [REDIRECT_URI, "https://klient.example/cb"] });
      const request = await openRequest(app, client.id, { redirectUri: "https://klient.example/cb", scopes: ["profile"], state: "abc 123" });
      expect(request.id).toEqual(expect.any(String));
      const live: RequestRow = {
        request_id: request.id ?? "",
        oauth_client_id: client.id,
        client_id: client.clientId,
        client_name: "Kodassistenten",
        redirect_uri: "https://klient.example/cb",
        scopes: ["profile"],
        state: "abc 123",
      };
      expect(await requestOf(request.hash, request.binding)).toEqual([live]);
      const kept = await owner.query("SELECT code_challenge, resource, created_at, expires_at, used_at FROM access.oauth_requests WHERE id = $1", [request.id]);
      expect(kept.rows).toEqual([{ code_challenge: request.challenge, resource: "https://nortfox.example/mcp", created_at: T0, expires_at: later(T0, 10), used_at: null }]);
      // Nothing with another binding, by another hash, or from its end on.
      expect(await requestOf(request.hash, tokenHash())).toEqual([]);
      expect(await requestOf(tokenHash(), request.binding)).toEqual([]);
      expect(await requestOf(request.hash, request.binding, later(T0, 10))).toEqual([]);
      expect(await requestOf(request.hash, request.binding, later(T0, 9))).toEqual([live]);
      // A state and a resource may be left out.
      const bare = await openRequest(app, client.id, { state: null, resource: null });
      expect((await requestOf(bare.hash, bare.binding))[0]?.state).toBeNull();
      // No request for a redirect URI that is not the client's, nor for a client that does not exist.
      expect((await openRequest(app, client.id, { redirectUri: "https://annan.example/cb" })).id).toBeNull();
      expect((await openRequest(app, client.id, { redirectUri: "https://klient.example/cb/" })).id).toBeNull();
      expect((await openRequest(app, randomUUID())).id).toBeNull();
    });

    it("takes hashes of 32 bytes, each once, a challenge of 43 base64url characters, scopes, a state of visible ASCII and a resource URI", async () => {
      const client = await registerClient(app);
      for (const hash of [Buffer.alloc(0), Buffer.alloc(31, 7), Buffer.alloc(33, 7)]) {
        await expectError(openRequest(app, client.id, { hash }), CHECK_VIOLATION, /oauth_requests_token_hash_form/);
        await expectError(openRequest(app, client.id, { binding: hash }), CHECK_VIOLATION, /oauth_requests_binding_hash_form/);
      }
      const made = await openRequest(app, client.id);
      await expectError(openRequest(app, client.id, { hash: made.hash }), UNIQUE_VIOLATION, /oauth_requests_token_hash_key/);
      await expectError(openRequest(app, client.id, { binding: made.binding }), UNIQUE_VIOLATION, /oauth_requests_binding_hash_key/);
      for (const challenge of ["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, `${"a".repeat(42)}/`, `${"a".repeat(42)} `]) {
        await expectError(openRequest(app, client.id, { challenge }), CHECK_VIOLATION, /oauth_requests_code_challenge_form/);
      }
      for (const scopes of [[], ["Profile"], ["book keeping"], ["profile", ""], ["åäö"]]) {
        await expectError(openRequest(app, client.id, { scopes }), CHECK_VIOLATION, /oauth_requests_scopes_form/);
      }
      expect((await openRequest(app, client.id, { state: "x".repeat(1000) })).id).toEqual(expect.any(String));
      expect((await openRequest(app, client.id, { state: " !~" })).id).toEqual(expect.any(String));
      for (const state of ["", "x".repeat(1001), "rad\nbrytning", "tab\t", "åäö", "\u{7f}"]) {
        await expectError(openRequest(app, client.id, { state }), CHECK_VIOLATION, /oauth_requests_state_form/);
      }
      expect((await openRequest(app, client.id, { resource: "http://127.0.0.1:4100/mcp" })).id).toEqual(expect.any(String));
      for (const resource of ["", "mcp", "https://nortfox.example/mcp#x", "https://nortfox.example/m cp", "ftp://nortfox.example/mcp", `https://nortfox.example/${"a".repeat(2000)}`]) {
        await expectError(openRequest(app, client.id, { resource }), CHECK_VIOLATION, /oauth_requests_resource_form/);
      }
      // A redirect URI of another form never comes from a client, so only a write past the function shows its check.
      await expectError(
        owner.query(
          `INSERT INTO access.oauth_requests (token_hash, oauth_client_id, redirect_uri, scopes, code_challenge, binding_hash, created_at, expires_at)
           VALUES ($1, $2, 'https://klient.example/cb#x', '{profile}', $3, $4, $5, $5)`,
          [tokenHash(), client.id, made.challenge, tokenHash(), T0],
        ),
        CHECK_VIOLATION,
        /oauth_requests_redirect_uri_form/,
      );
    });

    it("uses a request once, also from two parallel calls, only with its binding and before its end", async () => {
      const client = await registerClient(app, { name: "Kodassistenten" });
      const request = await openRequest(app, client.id);
      expect(await use(app, request.hash, tokenHash())).toEqual([]);
      expect(await use(app, tokenHash(), request.binding)).toEqual([]);
      const used = await Promise.all(parallel.map((connection) => use(connection, request.hash, request.binding, later(T0, 1))));
      expect(used.map((rows) => rows.length).sort()).toEqual([0, 1]);
      expect(used.flat()).toEqual([
        {
          request_id: request.id,
          oauth_client_id: client.id,
          client_id: client.clientId,
          client_name: "Kodassistenten",
          redirect_uri: REDIRECT_URI,
          scopes: ["companyinformation", "profile"],
          state: "made-up-state",
        },
      ]);
      const kept = await owner.query<{ used_at: Date }>("SELECT used_at FROM access.oauth_requests WHERE id = $1", [request.id]);
      expect(kept.rows).toEqual([{ used_at: later(T0, 1) }]);
      expect(await use(app, request.hash, request.binding, later(T0, 2))).toEqual([]);
      expect(await requestOf(request.hash, request.binding, later(T0, 2))).toEqual([]);
      // Past its end, a request is not used.
      const ended = await openRequest(app, client.id);
      expect(await use(app, ended.hash, ended.binding, later(T0, 10))).toEqual([]);
      expect(await use(app, ended.hash, ended.binding, later(T0, 9))).toHaveLength(1);
    });

    it("keeps the time a request was used once it is set, for every role", async () => {
      const client = await registerClient(app);
      const request = await openRequest(app, client.id);
      await use(app, request.hash, request.binding, later(T0, 1));
      for (const value of [later(T0, 2), null]) {
        await expectRefusal(owner.query("UPDATE access.oauth_requests SET used_at = $2 WHERE id = $1", [request.id, value]), "immutable_field", {
          field: "used_at",
          operation: "update",
        });
      }
    });

    it("gives nothing for a request whose client is gone", async () => {
      const client = await registerClient(app);
      const request = await openRequest(app, client.id);
      await owner.query("DELETE FROM access.oauth_clients WHERE id = $1", [client.id]);
      expect(await requestOf(request.hash, request.binding)).toEqual([]);
      expect(await use(app, request.hash, request.binding)).toEqual([]);
    });
  });

  describe("the consents", () => {
    let client: RegisteredClient;

    beforeAll(async () => {
      client = await registerClient(app, { name: "Kodassistenten" });
    });

    /** Runs `sql` as the app in `company` as `who`, through REST, and gives its rows. */
    function inCompany<T extends object = Record<string, unknown>>(company: string, who: Actor, sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return asMember<T>(app, company, who, sql, params);
    }

    /** The consents the app reads with `settings`, by id. */
    async function seen(settings: Settings): Promise<string[]> {
      return inTransaction(app, settings, async () => (await app.query<{ id: string }>("SELECT id FROM access.consents ORDER BY id")).rows.map((row) => row.id));
    }

    /** A consent of Alva in Alfa, for a client of its own unless one is given. */
    async function alvasConsent(scopes: readonly string[] = ["companyinformation"], of?: RegisteredClient): Promise<ConsentRow> {
      return addConsent(app, alfa.id, alfa.membership, alva, (of ?? (await registerClient(app))).id, scopes);
    }

    async function liveOf(company: string, person: string, oauthClient: string): Promise<string[]> {
      return (
        await owner.query<{ id: string }>("SELECT id FROM access.consents WHERE consent_company_id = $1 AND identity_id = $2 AND oauth_client_id = $3 AND revoked_at IS NULL", [
          company,
          person,
          oauthClient,
        ])
      ).rows.map((row) => row.id);
    }

    describe("what the database stamps and checks", () => {
      it("stamps the consent's person, the transaction's actor, and when it was given, to the millisecond, and the client's first consent", async () => {
        const fresh = await registerClient(app);
        const before = new Date(Date.now() - 1000);
        const row = await addConsent(app, alfa.id, gunnarInAlfa, gunnar, fresh.id, ["companyinformation", "profile"]);
        expect(row).toMatchObject({
          consent_company_id: alfa.id,
          membership_id: gunnarInAlfa,
          oauth_client_id: fresh.id,
          identity_id: gunnar.actor,
          scopes: ["companyinformation", "profile"],
          revoked_at: null,
          revoked_by: null,
        });
        expect(new Date(row.approved_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
        const whole = await owner.query<{ whole: boolean }>("SELECT $1::timestamptz = pg_catalog.date_trunc('milliseconds', $1::timestamptz) AS whole", [row.approved_at]);
        expect(whole.rows[0]?.whole).toBe(true);
        const first = async (): Promise<string | undefined> =>
          (await owner.query<{ at: string }>("SELECT first_consent_at::text AS at FROM access.oauth_clients WHERE id = $1", [fresh.id])).rows[0]?.at;
        expect(await first()).toBe(row.approved_at);
        // A later consent of the client keeps its first consent's time.
        await addConsent(app, beta.id, alvaInBeta, alva, fresh.id);
        expect(await first()).toBe(row.approved_at);
      });

      it.each([
        ["identity_id", (): string => alva.actor],
        ["approved_at", (): string => "2090-03-15T10:00:00.000Z"],
        ["revoked_at", (): string => "2090-03-15T10:00:00.000Z"],
        ["revoked_by", (): string => alva.actor],
      ] as const)("refuses a %s that is given with a new consent", async (column, value) => {
        await expectRefusal(
          inCompany(alfa.id, alva, `INSERT INTO access.consents (consent_company_id, membership_id, oauth_client_id, scopes, ${column}) VALUES ($1, $2, $3, $4, $5)`, [
            alfa.id,
            alfa.membership,
            client.id,
            ["profile"],
            value(),
          ]),
          "immutable_field",
          { field: column, operation: "create" },
        );
      });

      it("takes one or more scopes, each a word of small letters, in a list of one dimension", async () => {
        expect((await alvasConsent(["companyinformation", "profile", "companies", "users", "tokens"])).scopes).toHaveLength(5);
        for (const scopes of [[], ["Bookkeeping"], ["book keeping"], ["bookkeeping,profile"], ["bookkeeping", ""], ["companyinformation", "bookkeeping-2"], ["åäö"], ["null"]]) {
          await expectError(alvasConsent(scopes), CHECK_VIOLATION, /consents_scopes_form/);
        }
        for (const literal of ["{bookkeeping,NULL}", "{{bookkeeping},{profile}}", "[2:2]={bookkeeping}"]) {
          await expectError(
            inCompany(alfa.id, alva, "INSERT INTO access.consents (consent_company_id, membership_id, oauth_client_id, scopes) VALUES ($1, $2, $3, $4::text[])", [
              alfa.id,
              alfa.membership,
              client.id,
              literal,
            ]),
            CHECK_VIOLATION,
            /consents_scopes_form/,
          );
        }
      });

      it("refuses a consent with no actor, and one for a client that does not exist", async () => {
        await expectRefusal(
          inTransaction(app, { company: alfa.id }, () => app.query(INSERT_CONSENT, [alfa.id, alfa.membership, client.id, ["profile"]])),
          "actor_missing",
          { setting: "nortfox.actor_id" },
        );
        await expectError(addConsent(app, alfa.id, alfa.membership, alva, randomUUID()), FOREIGN_KEY_VIOLATION, /consents_oauth_client_id_fkey/);
      });
    });

    describe("the app's policy by company", () => {
      it("shows the app only the consents of the transaction's company: none of the person's other company, and none with no company set", async () => {
        const inAlfa = (await alvasConsent()).id;
        const inBeta = (await addConsent(app, beta.id, alvaInBeta, alva, client.id)).id;
        const alfaConsents = await seen({ company: alfa.id, ...alva });
        expect(alfaConsents).toContain(inAlfa);
        expect(alfaConsents).not.toContain(inBeta);
        const betaConsents = await seen({ company: beta.id, ...alva });
        expect(betaConsents).toContain(inBeta);
        expect(betaConsents).not.toContain(inAlfa);
        expect(await seen({ ...alva })).toEqual([]);
        expect(await seen({})).toEqual([]);
        const revoked = await inCompany(alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1 RETURNING id", [inBeta]);
        expect(revoked).toEqual([]);
        expect((await inCompany<ConsentRow>(beta.id, alva, `SELECT ${CONSENT_COLUMNS} FROM access.consents WHERE id = $1`, [inBeta]))[0]?.revoked_at).toBeNull();
      });

      it("lets the app give no consent for another company than the transaction's, nor with no company set", async () => {
        const give = (settings: Settings): Promise<unknown> =>
          inTransaction(app, { ...settings, channel: "rest" }, () => app.query(INSERT_CONSENT, [beta.id, alvaInBeta, client.id, ["profile"]]));
        await expectError(give({ company: alfa.id, ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security/);
        await expectError(give({ ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security/);
      });

      it("refuses the owner a consent whose company is not the transaction's, since its entry goes to the consent's company", async () => {
        const other = await registerClient(app);
        const give = (settings: Settings): Promise<unknown> =>
          inTransaction(owner, { ...settings, channel: "rest" }, () => owner.query(INSERT_CONSENT, [beta.id, alvaInBeta, other.id, ["profile"]]));
        await expectError(give({ company: alfa.id, ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security policy for table "events"/);
        await expectError(give({ ...alva }), INSUFFICIENT_PRIVILEGE, /row-level security policy for table "events"/);
        const inBeta = (await addConsent(app, beta.id, alvaInBeta, alva, (await registerClient(app)).id)).id;
        await expectError(
          inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [inBeta])),
          INSUFFICIENT_PRIVILEGE,
          /row-level security policy for table "events"/,
        );
      });
    });

    describe("the paired membership key", () => {
      it("refuses a consent whose membership is of another company than the consent, also the same person's", async () => {
        await expectError(addConsent(app, alfa.id, alvaInBeta, alva, client.id), FOREIGN_KEY_VIOLATION, /consents_membership_fkey/);
        await expectError(
          inTransaction(owner, { company: alfa.id, ...alva, channel: "rest" }, () => owner.query(INSERT_CONSENT, [alfa.id, alvaInBeta, client.id, ["profile"]])),
          FOREIGN_KEY_VIOLATION,
          /consents_membership_fkey/,
        );
        await expectError(addConsent(app, alfa.id, randomUUID(), alva, client.id), FOREIGN_KEY_VIOLATION, /consents_membership_fkey/);
      });
    });

    describe("a revoke", () => {
      const REVOKE = `UPDATE access.consents SET revoked_at = $2 WHERE id = $1 RETURNING ${CONSENT_COLUMNS}`;

      it("stamps who revoked the consent: the transaction's actor, here a system administrator who revokes a member's consent", async () => {
        const row = await addConsent(app, alfa.id, gunnarInAlfa, gunnar, client.id);
        const [revoked] = await inCompany<ConsentRow>(alfa.id, alva, REVOKE, [row.id, "2090-03-15T10:00:00.123Z"]);
        expect(revoked).toEqual({ ...row, revoked_at: "2090-03-15 10:00:00.123+00", revoked_by: alva.actor });
      });

      it("refuses a second revoke, one taken back, and who revoked when it is given", async () => {
        const row = await alvasConsent();
        await expectRefusal(
          inCompany(alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp(), revoked_by = $2 WHERE id = $1", [row.id, gunnar.actor]),
          "immutable_field",
          { field: "revoked_by", operation: "update" },
        );
        await inCompany(alfa.id, alva, REVOKE, [row.id, "2090-03-15T10:00:00.000Z"]);
        await expectRefusal(inCompany(alfa.id, alva, REVOKE, [row.id, "2090-03-15T11:00:00.000Z"]), "immutable_field", { field: "revoked_at", operation: "update" });
        await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.consents SET revoked_at = NULL, revoked_by = NULL WHERE id = $1", [row.id]), "immutable_field", {
          field: "revoked_at",
          operation: "update",
        });
        await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.consents SET revoked_by = $2 WHERE id = $1", [row.id, gunnar.actor]), "immutable_field", {
          field: "revoked_by",
          operation: "update",
        });
        const [kept] = await inCompany<ConsentRow>(alfa.id, alva, `SELECT ${CONSENT_COLUMNS} FROM access.consents WHERE id = $1`, [row.id]);
        expect(kept).toEqual({ ...row, revoked_at: "2090-03-15 10:00:00+00", revoked_by: alva.actor });
      });

      it.each([
        ["id", "id = $2::uuid", (): unknown => randomUUID()],
        ["consent_company_id", "consent_company_id = $2::uuid", (): unknown => randomUUID()],
        ["membership_id", "membership_id = $2::uuid", (): unknown => randomUUID()],
        ["oauth_client_id", "oauth_client_id = $2::uuid", (): unknown => randomUUID()],
        ["identity_id", "identity_id = $2::uuid", (): unknown => randomUUID()],
        ["scopes", "scopes = $2::text[]", (): unknown => ["bookkeeping", "profile"]],
        ["approved_at", "approved_at = $2::timestamptz", (): unknown => "2090-01-01T00:00:00Z"],
      ] as const)("refuses a change of the consent's %s, also with its revoke", async (field, set, value) => {
        const row = await alvasConsent();
        await expectRefusal(inCompany(alfa.id, alva, `UPDATE access.consents SET ${set} WHERE id = $1`, [row.id, value()]), "immutable_field", { field, operation: "update" });
        await expectRefusal(
          inCompany(alfa.id, alva, `UPDATE access.consents SET ${set}, revoked_at = pg_catalog.clock_timestamp() WHERE id = $1`, [row.id, value()]),
          "immutable_field",
          { field, operation: "update" },
        );
      });

      it("refuses the app a deletion, and every role one through the trigger", async () => {
        const row = await alvasConsent();
        await expectError(inCompany(alfa.id, alva, "DELETE FROM access.consents WHERE id = $1", [row.id]), INSUFFICIENT_PRIVILEGE, /permission denied for table consents/);
        await expectRefusal(
          inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("DELETE FROM access.consents WHERE id = $1", [row.id])),
          "append_only",
          { table: "access.consents", operation: "DELETE" },
        );
        // The codes and the tokens name their consent, so PostgreSQL refuses to empty the consents alone, and the trigger with them.
        await expectError(inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("TRUNCATE access.consents")), "0A000", /referenced in a foreign key constraint/);
        await expectRefusal(inTransaction(owner, { company: alfa.id, ...alva }, () => owner.query("TRUNCATE access.consents CASCADE")), "append_only", {
          table: "access.consents",
          operation: "TRUNCATE",
        });
      });
    });

    describe("one live consent of a person for a client in a company", () => {
      it("revokes the person's live consent for the same client in the same company when a new one is given, at the new one's time, by the same actor", async () => {
        const own = await registerClient(app);
        const old = await alvasConsent(["profile"], own);
        // Others that stay live: another client's, another company's, and another person's.
        const otherClient = await alvasConsent(["profile"]);
        const otherCompany = await addConsent(app, beta.id, alvaInBeta, alva, own.id);
        const otherPerson = await addConsent(app, alfa.id, gunnarInAlfa, gunnar, own.id);
        const fresh = await alvasConsent(["companyinformation", "profile"], own);
        const found = await owner.query<ConsentRow>(`SELECT ${CONSENT_COLUMNS} FROM access.consents WHERE id = ANY ($1::uuid[]) ORDER BY approved_at, id`, [
          [old.id, fresh.id, otherClient.id, otherCompany.id, otherPerson.id],
        ]);
        const byId = new Map(found.rows.map((row) => [row.id, row]));
        expect(byId.get(old.id)).toEqual({ ...old, revoked_at: fresh.approved_at, revoked_by: alva.actor });
        for (const kept of [fresh, otherClient, otherCompany, otherPerson]) {
          expect(byId.get(kept.id)?.revoked_at, kept.id).toBeNull();
        }
        expect(await liveOf(alfa.id, alva.actor, own.id)).toEqual([fresh.id]);
      });

      it("gives two new consents of one person for one client one after the other, also in parallel, so exactly one stays live", async () => {
        const own = await registerClient(app);
        const [first, second] = parallel as [Client, Client];
        const secondPid = await backendPid(second);
        await begin(first, { company: alfa.id, ...alva, channel: "rest" });
        try {
          await first.query(INSERT_CONSENT, [alfa.id, alfa.membership, own.id, ["profile"]]);
          const waiting = addConsent(second, alfa.id, alfa.membership, alva, own.id, ["companyinformation"]);
          await untilWaitingForLock(app, secondPid);
          await first.query("COMMIT");
          const waited = await waiting;
          expect(await liveOf(alfa.id, alva.actor, own.id)).toEqual([waited.id]);
        } catch (error) {
          await first.query("ROLLBACK");
          throw error;
        }
        const all = await owner.query("SELECT FROM access.consents WHERE oauth_client_id = $1", [own.id]);
        expect(all.rows).toHaveLength(2);
      });

      it("refuses a second live consent of a person for a client in a company that a write past the trigger would make", async () => {
        const own = await registerClient(app);
        const row = await alvasConsent(["profile"], own);
        const superuser = await db.admin();
        await superuser.query("BEGIN");
        try {
          await superuser.query("SET LOCAL session_replication_role = replica");
          await expectError(
            superuser.query("INSERT INTO access.consents SELECT * FROM pg_catalog.jsonb_populate_record(NULL::access.consents, $1)", [{ ...row, id: randomUUID() }]),
            UNIQUE_VIOLATION,
            /consents_one_live/,
          );
        } finally {
          await superuser.query("ROLLBACK");
        }
      });
    });

    describe("the entries in the behandlingshistorik", () => {
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

      async function entriesOf(company: string, consent: string): Promise<Entry[]> {
        return inTransaction(app, { company }, async () =>
          (
            await app.query<Entry>(
              `SELECT e.program, e.heading, e.subject_id, e.details, e.at::text AS at, h.actor_id, h.actor_kind, h.via_kind, h.via_id::text AS via_id, h.channel
               FROM access.events AS e JOIN audit.history AS h ON h.table_name = 'access.events' AND h.row_id = e.id
               WHERE e.details ->> 'consentId' = $1 ORDER BY h.id`,
              [consent],
            )
          ).rows,
        );
      }

      it("writes the entry of a consent given, in the consent's company, with the client and the scopes, and its giver as the actor", async () => {
        const own = await registerClient(app, { name: "Kalenderklienten" });
        const row = await addConsent(app, beta.id, alvaInBeta, alva, own.id, ["companyinformation", "profile"]);
        expect(await entriesOf(beta.id, row.id)).toEqual([
          {
            program: "users",
            heading: "consent-given",
            subject_id: alva.actor,
            details: { consentId: row.id, clientId: own.clientId, clientName: "Kalenderklienten", scopes: ["companyinformation", "profile"] },
            at: row.approved_at,
            actor_id: alva.actor,
            actor_kind: "user",
            via_kind: null,
            via_id: null,
            channel: "rest",
          },
        ]);
        expect(await entriesOf(alfa.id, row.id)).toEqual([]);
      });

      it("writes the entry of a consent revoked, with the time of the revoke and who revoked it, also through the client itself", async () => {
        const own = await registerClient(app, { name: "Kalenderklienten" });
        const row = await addConsent(app, alfa.id, gunnarInAlfa, gunnar, own.id, ["companyinformation"]);
        const through: Actor = { ...someIntegration(gunnar.actor, "mcp-client"), viaId: own.id };
        await inCompany(alfa.id, through, "UPDATE access.consents SET revoked_at = $2 WHERE id = $1", [row.id, "2090-03-15T10:00:00.000Z"]);
        const details = { consentId: row.id, clientId: own.clientId, clientName: "Kalenderklienten", scopes: ["companyinformation"] };
        expect(await entriesOf(alfa.id, row.id)).toEqual([
          { program: "users", heading: "consent-given", subject_id: gunnar.actor, details, at: row.approved_at, actor_id: gunnar.actor, actor_kind: "user", via_kind: null, via_id: null, channel: "rest" },
          {
            program: "users",
            heading: "consent-revoked",
            subject_id: gunnar.actor,
            details,
            at: "2090-03-15 10:00:00+00",
            actor_id: gunnar.actor,
            actor_kind: "integration",
            via_kind: "mcp-client",
            via_id: own.id,
            channel: "rest",
          },
        ]);
      });

      it("writes the revoke of the replaced consent before the new one's entry, at the same time", async () => {
        const own = await registerClient(app, { name: "Kalenderklienten" });
        const old = await alvasConsent(["profile"], own);
        const fresh = await alvasConsent(["companyinformation"], own);
        expect((await entriesOf(alfa.id, old.id))[1]).toMatchObject({ heading: "consent-revoked", at: fresh.approved_at, actor_id: alva.actor });
        expect(await entriesOf(alfa.id, fresh.id)).toMatchObject([{ heading: "consent-given", at: fresh.approved_at }]);
        const order = await inTransaction(app, { company: alfa.id }, async () =>
          (
            await app.query<{ id: string; heading: string }>(
              `SELECT e.details ->> 'consentId' AS id, e.heading FROM access.events AS e JOIN audit.history AS h ON h.table_name = 'access.events' AND h.row_id = e.id
               WHERE e.details ->> 'consentId' = ANY ($1::text[]) ORDER BY h.id`,
              [[old.id, fresh.id]],
            )
          ).rows,
        );
        expect(order).toEqual([
          { id: old.id, heading: "consent-given" },
          { id: old.id, heading: "consent-revoked" },
          { id: fresh.id, heading: "consent-given" },
        ]);
      });

      it("writes no entry for a statement that changes no consent, and none for a refused change", async () => {
        const row = await alvasConsent();
        const before = await entriesOf(alfa.id, row.id);
        await inCompany(alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1 AND false", [row.id]);
        await expectRefusal(inCompany(alfa.id, alva, "UPDATE access.consents SET scopes = '{profile}' WHERE id = $1", [row.id]), "immutable_field");
        expect(await entriesOf(alfa.id, row.id)).toEqual(before);
      });
    });
  });

  describe("the codes", () => {
    /** Issues a code as `approver` in its company for `request` and `consent`. */
    function issue(approver: Approver, request: string | null, consent: string, code = tokenHash(), at = later(T0, 1)): Promise<string | null> {
      return inTransaction(app, { company: approver.company, ...approver.who, channel: "rest" }, async () =>
        (await app.query<{ id: string | null }>("SELECT access.issue_oauth_code($1, $2, $3, $4, $5) AS id", [code, request, consent, at, later(at, LIFETIMES.code)])).rows[0]?.id ?? null,
      );
    }

    async function usedRequest(client: RegisteredClient): Promise<string | null> {
      const request = await openRequest(app, client.id);
      await anonymously(app, "SELECT * FROM access.use_oauth_request($1, $2, $3)", [request.hash, request.binding, later(T0, 1)]);
      return request.id;
    }

    it("issues a code for a used request and a live consent of the transaction's person in its company, for the request's client, with the request's redirect URI and challenge, once per request", async () => {
      const client = await registerClient(app);
      const request = await openRequest(app, client.id, { redirectUri: REDIRECT_URI });
      const approval = await approve(app, alvaAlfa, request);
      expect(approval.codeId).toEqual(expect.any(String));
      const kept = await owner.query("SELECT request_id, consent_id, redirect_uri, code_challenge, created_at, expires_at, used_at FROM access.oauth_codes WHERE id = $1", [
        approval.codeId,
      ]);
      expect(kept.rows).toEqual([
        { request_id: request.id, consent_id: approval.consent.id, redirect_uri: REDIRECT_URI, code_challenge: request.challenge, created_at: later(T0, 1), expires_at: later(T0, 11), used_at: null },
      ]);
      // A second code for the same request is not issued.
      expect(await issue(alvaAlfa, request.id, approval.consent.id)).toBeNull();
    });

    it("issues no code for a request that is not used, nor for a consent of another client, a revoked one, another company's or another person's", async () => {
      const client = await registerClient(app);
      const consent = await addConsent(app, alfa.id, alfa.membership, alva, client.id);
      const unused = await openRequest(app, client.id);
      expect(await issue(alvaAlfa, unused.id, consent.id)).toBeNull();
      expect(await issue(alvaAlfa, randomUUID(), consent.id)).toBeNull();
      const otherClient = await addConsent(app, alfa.id, alfa.membership, alva, (await registerClient(app)).id);
      expect(await issue(alvaAlfa, await usedRequest(client), otherClient.id)).toBeNull();
      // Gunnar's consent in Alfa, issued as Alva; and Alva's in Alfa, issued in Beta.
      const gunnars = await addConsent(app, alfa.id, gunnarInAlfa, gunnar, client.id);
      expect(await issue(alvaAlfa, await usedRequest(client), gunnars.id)).toBeNull();
      expect(await issue(alvaBeta, await usedRequest(client), consent.id)).toBeNull();
      expect(await issue({ ...alvaAlfa, company: "" }, await usedRequest(client), consent.id)).toBeNull();
      await asMember(app, alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [consent.id]);
      expect(await issue(alvaAlfa, await usedRequest(client), consent.id)).toBeNull();
      // The same calls with a live consent issue a code.
      const live = await addConsent(app, alfa.id, alfa.membership, alva, client.id);
      expect(await issue(alvaAlfa, await usedRequest(client), live.id)).toEqual(expect.any(String));
    });

    it("takes a code's hash of 32 bytes, once in the install", async () => {
      const client = await registerClient(app);
      const consent = await addConsent(app, alfa.id, alfa.membership, alva, client.id);
      for (const hash of [Buffer.alloc(0), Buffer.alloc(31, 7), Buffer.alloc(33, 7)]) {
        await expectError(issue(alvaAlfa, await usedRequest(client), consent.id, hash), CHECK_VIOLATION, /oauth_codes_token_hash_form/);
      }
      const hash = tokenHash();
      await issue(alvaAlfa, await usedRequest(client), consent.id, hash);
      await expectError(issue(alvaAlfa, await usedRequest(client), consent.id, hash), UNIQUE_VIOLATION, /oauth_codes_token_hash_key/);
    });

    it("gives an access token and a refresh token once for a code, with its consent's scopes, and the person", async () => {
      const login = await logIn(app, gunnarAlfa, { scopes: ["companyinformation", "profile"] });
      expect(login.tokens).toMatchObject({ outcome: "issued", identityId: gunnar.actor, scopes: ["companyinformation", "profile"] });
      const access = await owner.query("SELECT consent_id, family_id, scopes, created_at, expires_at, revoked_at FROM access.oauth_access_tokens WHERE id = $1", [login.tokens.accessTokenId]);
      expect(access.rows).toEqual([
        { consent_id: login.approval.consent.id, family_id: login.approval.codeId, scopes: ["companyinformation", "profile"], created_at: later(T0, 2), expires_at: later(T0, 62), revoked_at: null },
      ]);
      const refresh = await owner.query("SELECT consent_id, family_id, scopes, created_at, expires_at, used_at, revoked_at FROM access.oauth_refresh_tokens WHERE id = $1", [
        login.tokens.refreshTokenId,
      ]);
      expect(refresh.rows).toEqual([
        {
          consent_id: login.approval.consent.id,
          family_id: login.approval.codeId,
          scopes: ["companyinformation", "profile"],
          created_at: later(T0, 2),
          expires_at: later(T0, 2 + 45 * 24 * 60),
          used_at: null,
          revoked_at: null,
        },
      ]);
      const used = await owner.query<{ used_at: Date }>("SELECT used_at FROM access.oauth_codes WHERE id = $1", [login.approval.codeId]);
      expect(used.rows).toEqual([{ used_at: later(T0, 2) }]);
    });

    it("gives no refresh token to a client that did not register the refresh grant", async () => {
      const client = await registerClient(app, { grantTypes: ["authorization_code"] });
      const login = await logIn(app, alvaAlfa, { client });
      expect(login.tokens).toMatchObject({ outcome: "issued", refreshTokenId: null });
      expect(login.tokens.accessTokenId).toEqual(expect.any(String));
    });

    it("gives nothing and keeps the code for another client, another redirect URI or another verifier, and nothing from its end on or once its consent is revoked", async () => {
      const client = await registerClient(app, { redirectUris: [REDIRECT_URI, "https://klient.example/cb"] });
      const request = await openRequest(app, client.id);
      const { code, consent } = await approve(app, alvaAlfa, request);
      const other = await registerClient(app);
      for (const grant of [
        { clientId: other.clientId, challenge: request.challenge },
        { clientId: client.clientId, challenge: request.challenge, redirectUri: "https://klient.example/cb" },
        { clientId: client.clientId, challenge: challengeOf(someVerifier()) },
      ]) {
        expect((await redeemCode(app, code, grant)).outcome).toBeNull();
      }
      expect((await redeemCode(app, tokenHash(), { clientId: client.clientId, challenge: request.challenge })).outcome).toBeNull();
      // Its end: nothing at 10 minutes after it was issued.
      expect((await redeemCode(app, code, { clientId: client.clientId, challenge: request.challenge, at: later(T0, 11) })).outcome).toBeNull();
      // A revoked consent's code gives nothing.
      await asMember(app, alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [consent.id]);
      expect((await redeemCode(app, code, { clientId: client.clientId, challenge: request.challenge })).outcome).toBeNull();
      const kept = await owner.query("SELECT used_at FROM access.oauth_codes WHERE token_hash = $1", [code]);
      expect(kept.rows).toEqual([{ used_at: null }]);
      // Another approval: its code still works before its end, after the faults.
      const fresh = await openRequest(app, client.id);
      const approval = await approve(app, alvaAlfa, fresh);
      expect((await redeemCode(app, approval.code, { clientId: other.clientId, challenge: fresh.challenge })).outcome).toBeNull();
      expect((await redeemCode(app, approval.code, { clientId: client.clientId, challenge: fresh.challenge, at: later(T0, 10) })).outcome).toBe("issued");
    });

    it("revokes every live token of its grant family when a used code comes back with its client, redirect URI and verifier, and not for another verifier", async () => {
      const login = await logIn(app, alvaAlfa);
      // A refresh first, so the family has two of each.
      const refreshed = await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId });
      expect(refreshed.outcome).toBe("issued");
      const grant = { clientId: login.client.clientId, challenge: login.request.challenge, at: later(T0, 31) };
      expect((await redeemCode(app, login.approval.code, { ...grant, challenge: challengeOf(someVerifier()) })).outcome).toBeNull();
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 2, refresh: 1 });
      expect(await redeemCode(app, login.approval.code, grant)).toMatchObject({ outcome: "reused", identityId: alva.actor, accessTokenId: null, refreshTokenId: null });
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 0, refresh: 0 });
      const revoked = await owner.query<{ at: Date }>(
        "SELECT revoked_at AS at FROM access.oauth_access_tokens WHERE family_id = $1 UNION ALL SELECT revoked_at FROM access.oauth_refresh_tokens WHERE family_id = $1 AND used_at IS NULL",
        [login.approval.codeId],
      );
      expect(revoked.rows).toEqual([{ at: later(T0, 31) }, { at: later(T0, 31) }, { at: later(T0, 31) }]);
    });

    it("gives tokens for a code once, from two parallel calls too: the second waits, finds it used, and revokes what the first got", async () => {
      const client = await registerClient(app);
      const request = await openRequest(app, client.id);
      const { code, codeId } = await approve(app, alvaAlfa, request);
      const [first, second] = parallel as [Client, Client];
        const secondPid = await backendPid(second);
      const grant = { clientId: client.clientId, challenge: request.challenge };
      await first.query("BEGIN");
      try {
        const won = await redeemCode(first, code, grant);
        expect(won.outcome).toBe("issued");
        const waiting = redeemCode(second, code, grant);
        await untilWaitingForLock(app, secondPid);
        await first.query("COMMIT");
        expect(await waiting).toMatchObject({ outcome: "reused", accessTokenId: null });
      } catch (error) {
        await first.query("ROLLBACK");
        throw error;
      }
      expect(await liveTokens(codeId)).toEqual({ access: 0, refresh: 0 });
      const all = await owner.query("SELECT FROM access.oauth_access_tokens WHERE family_id = $1", [codeId]);
      expect(all.rows).toHaveLength(1);
      // And the plain case of two calls at once: one gets the tokens.
      const again = await openRequest(app, client.id);
      const approval = await approve(app, alvaAlfa, again);
      const both = await Promise.all(parallel.map((connection) => redeemCode(connection, approval.code, { clientId: client.clientId, challenge: again.challenge })));
      expect(both.map((redemption) => redemption.outcome).sort()).toEqual(["issued", "reused"]);
    });

    it.each(["repeatable read", "serializable"] as const)("refuses to redeem a code or a refresh token at %s, where a reuse would not see what a parallel use gave", async (isolation) => {
      const login = await logIn(app, alvaAlfa);
      for (const redeem of [
        () => redeemCode(app, login.approval.code, { clientId: login.client.clientId, challenge: login.request.challenge }),
        () => redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId }),
      ]) {
        await expectRefusal(inTransaction(app, { channel: "rest", isolation }, redeem), "read_committed_only", { isolation });
      }
    });

    it("keeps the time a code was used once it is set, for every role", async () => {
      const login = await logIn(app, alvaAlfa);
      for (const value of [later(T0, 3), null]) {
        await expectRefusal(owner.query("UPDATE access.oauth_codes SET used_at = $2 WHERE id = $1", [login.approval.codeId, value]), "immutable_field", {
          field: "used_at",
          operation: "update",
        });
      }
    });
  });

  /** How many live access and refresh tokens a grant family has: not revoked, and for a refresh token not used. */
  async function liveTokens(family: string | null): Promise<{ access: number; refresh: number }> {
    const found = await owner.query<{ access: number; refresh: number }>(
      `SELECT (SELECT count(*)::integer FROM access.oauth_access_tokens WHERE family_id = $1 AND revoked_at IS NULL) AS access,
              (SELECT count(*)::integer FROM access.oauth_refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND used_at IS NULL) AS refresh`,
      [family],
    );
    return found.rows[0] ?? { access: -1, refresh: -1 };
  }

  describe("the access tokens", () => {
    function tokenOf(hash: Buffer, at = later(T0, 2)): Promise<AccessTokenRow[]> {
      return anonymously<AccessTokenRow>(app, "SELECT * FROM access.oauth_access_token_by_token($1, $2)", [hash, at]);
    }

    it("finds a live access token by its hash, before any company is set, with its person, the identity's status, its consent, company, membership, client and scopes", async () => {
      const client = await registerClient(app, { name: "Kodassistenten" });
      const login = await logIn(app, alvaBeta, { client, scopes: ["profile", "companyinformation"] });
      const live: AccessTokenRow = {
        token_id: login.tokens.accessTokenId ?? "",
        identity_id: alva.actor,
        status: "active",
        consent_id: login.approval.consent.id,
        consent_company_id: beta.id,
        membership_id: alvaInBeta,
        oauth_client_id: client.id,
        client_id: client.clientId,
        client_name: "Kodassistenten",
        scopes: ["profile", "companyinformation"],
      };
      expect(await tokenOf(login.tokens.accessHash)).toEqual([live]);
      expect(await tokenOf(login.tokens.accessHash, later(T0, 61))).toEqual([live]);
      // From its end on, by another hash, and a refresh token's hash: nothing.
      expect(await tokenOf(login.tokens.accessHash, later(T0, 62))).toEqual([]);
      expect(await tokenOf(tokenHash())).toEqual([]);
      expect(await tokenOf(login.tokens.refreshHash)).toEqual([]);
    });

    it("finds no access token that is revoked, or whose consent is revoked, and gives a deleted person's status as it is", async () => {
      const revoked = await logIn(app, alvaAlfa);
      await anonymously(app, "SELECT * FROM access.revoke_oauth_token($1, $2, $3)", [revoked.tokens.accessHash, revoked.client.clientId, later(T0, 2)]);
      expect(await tokenOf(revoked.tokens.accessHash)).toEqual([]);
      const ofConsent = await logIn(app, alvaAlfa);
      await asMember(app, alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [ofConsent.approval.consent.id]);
      expect(await tokenOf(ofConsent.tokens.accessHash)).toEqual([]);
      // A person who is then deleted.
      const person = await addIdentity(owner, { name: "Stina Ek" });
      const membership = await addMembership(app, owner, alfa, { user: person });
      const theirs = await logIn(app, { company: alfa.id, membership, who: { actor: person, kind: "user" } });
      expect((await tokenOf(theirs.tokens.accessHash))[0]?.status).toBe("active");
      await deleteIdentity(app, person);
      expect((await tokenOf(theirs.tokens.accessHash))[0]?.status).toBe("deleted");
    });

    it("takes a token's hash of 32 bytes, once in its table, and its scopes in their form, and keeps its revoke once it is set", async () => {
      const login = await logIn(app, alvaAlfa);
      const insert = (table: string, hash: Buffer, scopes: unknown = ["profile"]): Promise<unknown> =>
        owner.query(`INSERT INTO ${table} (token_hash, consent_id, family_id, scopes, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $5)`, [
          hash,
          login.approval.consent.id,
          randomUUID(),
          scopes,
          T0,
        ]);
      for (const table of ["access.oauth_access_tokens", "access.oauth_refresh_tokens"]) {
        const short = table.replace("access.", "");
        for (const hash of [Buffer.alloc(0), Buffer.alloc(31, 7), Buffer.alloc(33, 7)]) {
          await expectError(insert(table, hash), CHECK_VIOLATION, new RegExp(`${short}_token_hash_form`));
        }
        const hash = tokenHash();
        await insert(table, hash);
        await expectError(insert(table, hash), UNIQUE_VIOLATION, new RegExp(`${short}_token_hash_key`));
        for (const scopes of [[], ["Profile"], ["profile", ""], ["åäö"]]) {
          await expectError(insert(table, tokenHash(), scopes), CHECK_VIOLATION, new RegExp(`${short}_scopes_form`));
        }
        await owner.query(`UPDATE ${table} SET revoked_at = $2 WHERE token_hash = $1`, [hash, T0]);
        for (const value of [later(T0, 1), null]) {
          await expectRefusal(owner.query(`UPDATE ${table} SET revoked_at = $2 WHERE token_hash = $1`, [hash, value]), "immutable_field", { field: "revoked_at", operation: "update" });
        }
      }
      // A refresh token's use is set once too.
      const used = await logIn(app, alvaAlfa);
      await redeemRefreshToken(app, used.tokens.refreshHash, { clientId: used.client.clientId });
      for (const value of [later(T0, 40), null]) {
        await expectRefusal(owner.query("UPDATE access.oauth_refresh_tokens SET used_at = $2 WHERE id = $1", [used.tokens.refreshTokenId, value]), "immutable_field", {
          field: "used_at",
          operation: "update",
        });
      }
    });
  });

  describe("the refresh tokens", () => {
    it("gives a new access token and a new refresh token of the same family once for a refresh token, which lasts 45 days from its own issue", async () => {
      const login = await logIn(app, gunnarAlfa, { scopes: ["companyinformation", "profile"] });
      const at = later(T0, 30);
      const refreshed = await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId, at });
      expect(refreshed).toMatchObject({ outcome: "issued", identityId: gunnar.actor, scopes: ["companyinformation", "profile"] });
      const made = await owner.query(
        "SELECT family_id, consent_id, scopes, created_at, expires_at FROM access.oauth_refresh_tokens WHERE id = $1 UNION ALL SELECT family_id, consent_id, scopes, created_at, expires_at FROM access.oauth_access_tokens WHERE id = $2",
        [refreshed.refreshTokenId, refreshed.accessTokenId],
      );
      const kin = { family_id: login.approval.codeId, consent_id: login.approval.consent.id, scopes: ["companyinformation", "profile"], created_at: at };
      expect(made.rows).toEqual([
        { ...kin, expires_at: later(at, 45 * 24 * 60) },
        { ...kin, expires_at: later(at, 60) },
      ]);
      const old = await owner.query("SELECT used_at, revoked_at FROM access.oauth_refresh_tokens WHERE id = $1", [login.tokens.refreshTokenId]);
      expect(old.rows).toEqual([{ used_at: at, revoked_at: null }]);
      // The old access token stays live until its end: a refresh revokes nothing.
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 2, refresh: 1 });
    });

    it("revokes every live token of its family when a used refresh token comes back, the newest access token too, and gives the person", async () => {
      const login = await logIn(app, alvaAlfa);
      const grant = { clientId: login.client.clientId };
      const first = await redeemRefreshToken(app, login.tokens.refreshHash, { ...grant, at: later(T0, 30) });
      const second = await redeemRefreshToken(app, first.refreshHash, { ...grant, at: later(T0, 40) });
      expect(second.outcome).toBe("issued");
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 3, refresh: 1 });
      // Another family of the same consent stays live.
      const otherRequest = await openRequest(app, login.client.id);
      const otherApproval = await approve(app, alvaAlfa, otherRequest);
      const other = await redeemCode(app, otherApproval.code, { clientId: login.client.clientId, challenge: otherRequest.challenge });
      expect(await redeemRefreshToken(app, login.tokens.refreshHash, { ...grant, at: later(T0, 50) })).toMatchObject({
        outcome: "reused",
        identityId: alva.actor,
        accessTokenId: null,
        refreshTokenId: null,
      });
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 0, refresh: 0 });
      expect(await liveTokens(otherApproval.codeId)).toEqual({ access: 1, refresh: 1 });
      // A token of a revoked family that comes back revokes again what is live, which is nothing, and is a reuse.
      expect((await redeemRefreshToken(app, second.refreshHash, { ...grant, at: later(T0, 51) })).outcome).toBe("reused");
      expect(other.outcome).toBe("issued");
    });

    it("gives tokens for a refresh token once, from two parallel calls too: the second waits, finds it used, and revokes the family with what the first got", async () => {
      const login = await logIn(app, alvaAlfa);
      const [first, second] = parallel as [Client, Client];
        const secondPid = await backendPid(second);
      const grant = { clientId: login.client.clientId };
      await first.query("BEGIN");
      try {
        expect((await redeemRefreshToken(first, login.tokens.refreshHash, grant)).outcome).toBe("issued");
        const waiting = redeemRefreshToken(second, login.tokens.refreshHash, grant);
        await untilWaitingForLock(app, secondPid);
        await first.query("COMMIT");
        expect((await waiting).outcome).toBe("reused");
      } catch (error) {
        await first.query("ROLLBACK");
        throw error;
      }
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 0, refresh: 0 });
      const again = await logIn(app, alvaAlfa);
      const both = await Promise.all(parallel.map((connection) => redeemRefreshToken(connection, again.tokens.refreshHash, { clientId: again.client.clientId })));
      expect(both.map((redemption) => redemption.outcome).sort()).toEqual(["issued", "reused"]);
    });

    it("narrows the scopes to those asked within the token's, and gives invalid-scope without using it for one outside them", async () => {
      const login = await logIn(app, alvaAlfa, { scopes: ["companyinformation", "profile"] });
      const grant = { clientId: login.client.clientId };
      expect(await redeemRefreshToken(app, login.tokens.refreshHash, { ...grant, scopes: ["profile", "users"] })).toMatchObject({
        outcome: "invalid-scope",
        scopes: ["companyinformation", "profile"],
        accessTokenId: null,
      });
      const narrowed = await redeemRefreshToken(app, login.tokens.refreshHash, { ...grant, scopes: ["profile"] });
      expect(narrowed).toMatchObject({ outcome: "issued", scopes: ["profile"] });
      // The narrowed refresh token cannot widen again.
      expect((await redeemRefreshToken(app, narrowed.refreshHash, { ...grant, scopes: ["companyinformation"] })).outcome).toBe("invalid-scope");
      expect((await redeemRefreshToken(app, narrowed.refreshHash, grant)).scopes).toEqual(["profile"]);
    });

    it("gives nothing and changes nothing for another client, another hash, from its end on, or once its consent is revoked", async () => {
      const login = await logIn(app, alvaAlfa);
      const other = await registerClient(app);
      expect((await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: other.clientId })).outcome).toBeNull();
      expect((await redeemRefreshToken(app, tokenHash(), { clientId: login.client.clientId })).outcome).toBeNull();
      // A refresh token older than 45 days.
      const end = later(T0, 2 + 45 * 24 * 60);
      expect((await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId, at: end })).outcome).toBeNull();
      // A used one with another client's id is not a reuse.
      const used = await logIn(app, alvaAlfa);
      await redeemRefreshToken(app, used.tokens.refreshHash, { clientId: used.client.clientId });
      expect((await redeemRefreshToken(app, used.tokens.refreshHash, { clientId: other.clientId })).outcome).toBeNull();
      expect(await liveTokens(used.approval.codeId)).toEqual({ access: 2, refresh: 1 });
      await asMember(app, alfa.id, alva, "UPDATE access.consents SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1", [login.approval.consent.id]);
      expect((await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId })).outcome).toBeNull();
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 1, refresh: 1 });
    });
  });

  describe("the client's revocation", () => {
    function revoke(hash: Buffer, clientId: string, at = later(T0, 5)): Promise<RevokeRow[]> {
      return anonymously<RevokeRow>(app, "SELECT * FROM access.revoke_oauth_token($1, $2, $3)", [hash, clientId, at]);
    }

    it("revokes an access token of the client, and gives what its entry needs: the consent's person, company, membership and client", async () => {
      const client = await registerClient(app, { name: "Kodassistenten" });
      const login = await logIn(app, alvaBeta, { client });
      const facts = {
        consent_id: login.approval.consent.id,
        identity_id: alva.actor,
        consent_company_id: beta.id,
        membership_id: alvaInBeta,
        oauth_client_id: client.id,
        client_name: "Kodassistenten",
      };
      expect(await revoke(login.tokens.accessHash, client.clientId)).toEqual([{ kind: "access", revoked: 1, ...facts }]);
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 0, refresh: 1 });
      // Again: nothing more to revoke.
      expect(await revoke(login.tokens.accessHash, client.clientId)).toEqual([{ kind: "access", revoked: 0, ...facts }]);
    });

    it("revokes a refresh token's whole family, every refresh and access token of it, and no other family", async () => {
      const login = await logIn(app, alvaAlfa);
      const refreshed = await redeemRefreshToken(app, login.tokens.refreshHash, { clientId: login.client.clientId, at: later(T0, 3) });
      const other = await logIn(app, alvaAlfa, { client: login.client });
      expect(await revoke(refreshed.refreshHash, login.client.clientId)).toMatchObject([{ kind: "refresh", revoked: 3 }]);
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 0, refresh: 0 });
      expect(await liveTokens(other.approval.codeId)).toEqual({ access: 1, refresh: 1 });
      // The used refresh token of the family revokes it too, with nothing left to revoke.
      expect(await revoke(login.tokens.refreshHash, login.client.clientId)).toMatchObject([{ kind: "refresh", revoked: 0 }]);
    });

    it("leaves another client's token as it is, and gives nothing for it or for an unknown token", async () => {
      const login = await logIn(app, alvaAlfa);
      const other = await registerClient(app);
      expect(await revoke(login.tokens.accessHash, other.clientId)).toEqual([]);
      expect(await revoke(login.tokens.refreshHash, other.clientId)).toEqual([]);
      expect(await revoke(tokenHash(), login.client.clientId)).toEqual([]);
      expect(await liveTokens(login.approval.codeId)).toEqual({ access: 1, refresh: 1 });
    });
  });
});
