// SPDX-License-Identifier: AGPL-3.0-only

// The idempotency keys. A write through /v1 or MCP stores its key and its
// first answer in the same transaction as the write. A key is a company row
// like any other: row level security, the history trigger and the table guard
// hold it. It belongs to the company and the actor of the transaction that
// stored it: a trigger writes the actor, its kind and the time, and refuses
// them when they are given. Each company and actor has a key once. The app
// may only insert a key: it never changes or deletes one.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_KEY_PATTERN } from "@nortfox/contract";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type Settings,
  type TestDatabase,
} from "../../../test/database.ts";
import { REQUEST_HASH } from "../../../test/every-table.ts";
import { addCompany, someActor, someIntegration, someUser, type Actor } from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a NULL in a column that may not hold one. */
const NOT_NULL_VIOLATION = "23502";

/** A stored key as the tests read it, with its time as text. */
interface StoredKey {
  readonly id: string;
  readonly company_id: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: unknown;
  readonly created_at: string;
}

const KEY_COLUMNS = `id, company_id, actor_id, actor_kind, idempotency_key, operation_id, request_hash, response_status, response_body,
  created_at::text AS created_at`;

/** The values a test stores with a key; each one left out takes a valid value. */
interface NewKey {
  readonly key?: string | null;
  readonly operation?: string | null;
  readonly hash?: string | null;
  readonly status?: number | null;
  readonly body?: unknown;
}

const INSERT_KEY = `INSERT INTO ledger.idempotency_keys (company_id, idempotency_key, operation_id, request_hash, response_status, response_body)
  VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${KEY_COLUMNS}`;

function keyValues(company: string, key: NewKey): unknown[] {
  return [
    company,
    key.key === undefined ? randomUUID() : key.key,
    key.operation === undefined ? "testBookVoucher" : key.operation,
    key.hash === undefined ? REQUEST_HASH : key.hash,
    key.status === undefined ? 201 : key.status,
    key.body === undefined ? { id: randomUUID(), number: 1 } : key.body,
  ];
}

describe("the idempotency keys", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: string;
  let other: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await addCompany(app);
    other = await addCompany(app);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Stores a key as the app, in a transaction of its own as `who` in `inCompany`, and gives it. */
  async function storeKey(who: Actor, key: NewKey = {}, inCompany = company): Promise<StoredKey> {
    const stored = await inTransaction(app, { company: inCompany, ...who }, () => app.query<StoredKey>(INSERT_KEY, keyValues(inCompany, key)));
    const [row] = stored.rows;
    if (row === undefined) {
      throw new Error("The key was not stored.");
    }
    return row;
  }

  /** The keys of `inCompany` that `client` reads. */
  async function keysOf(client: Client, inCompany: string): Promise<StoredKey[]> {
    return inTransaction(client, { company: inCompany }, async () => (await client.query<StoredKey>(`SELECT ${KEY_COLUMNS} FROM ledger.idempotency_keys ORDER BY id`)).rows);
  }

  it("writes the transaction's actor, its kind and the time, and the history row with them", async () => {
    for (const kind of ["user", "system", "integration"] as const) {
      const who = someActor(kind);
      const settings: Settings = { company, ...who, channel: "rest" };
      const { stored, began, after } = await inTransaction(app, settings, async () => {
        const times = await app.query<{ began: string }>("SELECT pg_catalog.transaction_timestamp()::text AS began");
        const found = await app.query<StoredKey>(INSERT_KEY, keyValues(company, { key: `key-of-${kind}`, body: { kind } }));
        const now = await app.query<{ after: string }>("SELECT pg_catalog.clock_timestamp()::text AS after");
        return { stored: found.rows[0], began: times.rows[0]?.began ?? "", after: now.rows[0]?.after ?? "" };
      });
      expect(stored).toMatchObject({
        company_id: company,
        actor_id: who.actor,
        actor_kind: kind,
        idempotency_key: `key-of-${kind}`,
        operation_id: "testBookVoucher",
        request_hash: REQUEST_HASH,
        response_status: 201,
        response_body: { kind },
      });
      const within = await app.query<{ within: boolean }>("SELECT $1::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz AS within", [
        stored?.created_at,
        began,
        after,
      ]);
      expect(within.rows[0]?.within).toBe(true);
      const history = await inTransaction(app, { company }, () =>
        app.query<{ actor_id: string; actor_kind: string; channel: string; body: unknown }>(
          "SELECT actor_id, actor_kind, channel, new_values -> 'response_body' AS body FROM audit.history WHERE table_name = 'ledger.idempotency_keys' AND row_id = $1",
          [stored?.id],
        ),
      );
      expect(history.rows).toEqual([{ actor_id: who.actor, actor_kind: kind, channel: "rest", body: { kind } }]);
    }
  });

  it("refuses an actor, a kind or a time that the caller gives, even the transaction's own", async () => {
    const who = someUser();
    for (const [column, value] of [
      ["actor_id", who.actor],
      ["actor_id", randomUUID()],
      ["actor_kind", who.kind],
      ["actor_kind", "system"],
      ["created_at", "2090-01-01T00:00:00Z"],
    ] as const) {
      await expectRefusal(
        inTransaction(app, { company, ...who }, () =>
          app.query(
            `INSERT INTO ledger.idempotency_keys (company_id, idempotency_key, operation_id, request_hash, response_status, response_body, ${column})
             VALUES ($1, $2, 'testBookVoucher', $3, 201, '{}', $4)`,
            [company, randomUUID(), REQUEST_HASH, value],
          ),
        ),
        "immutable_field",
        { field: column, operation: "create" },
      );
    }
    expect(await keysOf(app, company)).not.toContainEqual(expect.objectContaining({ actor_id: who.actor }));
  });

  it("refuses a key with no actor", async () => {
    await expectRefusal(
      inTransaction(app, { company }, () => app.query(INSERT_KEY, keyValues(company, {}))),
      "actor_missing",
      { setting: "nortfox.actor_id" },
    );
  });

  /**
   * Whether the database takes `key`, tried as the app in a savepoint of the
   * open transaction: true when it stores it, false when its check refuses it.
   */
  async function takes(key: string): Promise<boolean> {
    await app.query("SAVEPOINT attempt");
    try {
      await app.query(INSERT_KEY, keyValues(company, { key }));
      await app.query("RELEASE SAVEPOINT attempt");
      return true;
    } catch (error) {
      await app.query("ROLLBACK TO SAVEPOINT attempt");
      expect((error as { code?: unknown }).code, String(error)).toBe(CHECK_VIOLATION);
      expect(String(error)).toMatch(/idempotency_keys_key_form/);
      return false;
    }
  }

  it("takes a key of 1 to 255 characters of visible ASCII but the double quote and the backslash, the same alphabet as the contract's", async () => {
    const contract = new RegExp(IDEMPOTENCY_KEY_PATTERN, "u");
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(255);
    const characters = [
      ...Array.from({ length: 0x7f }, (_unused, index) => String.fromCodePoint(index + 1)),
      "\u0080",
      " ",
      "é",
      "Å",
      "ö",
      " ",
      "！",
      "\u{1f600}",
    ];
    await begin(app, { company, ...someUser() });
    try {
      const taken: string[] = [];
      for (const character of characters) {
        // Each key once: another character after it keeps the attempts apart.
        const key = `${character}${String(characters.indexOf(character))}`;
        expect(await takes(key), `the character ${JSON.stringify(character)}`).toBe(contract.test(key));
        if (contract.test(key)) {
          taken.push(character);
        }
      }
      expect(taken.length).toBe(0x7e - 0x21 + 1 - 2);
      expect(taken).not.toContain('"');
      expect(taken).not.toContain("\\");
      expect(await takes("")).toBe(false);
      expect(await takes("k")).toBe(true);
      expect(await takes("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toBe(true);
      expect(await takes("b".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toBe(false);
      expect(await takes('"quoted"')).toBe(false);
      expect(await takes(String.raw`back\slash`)).toBe(false);
      expect(await takes("two words")).toBe(false);
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("refuses a request fingerprint that is not 64 lower-case hexadecimal digits", async () => {
    for (const hash of [REQUEST_HASH.slice(1), `${REQUEST_HASH}0`, REQUEST_HASH.toUpperCase(), `g${REQUEST_HASH.slice(1)}`, "", ` ${REQUEST_HASH.slice(1)}`]) {
      await expectError(storeKey(someUser(), { hash }), CHECK_VIOLATION, /idempotency_keys_request_hash_form/);
    }
    expect((await storeKey(someUser(), { hash: "0".repeat(64) })).request_hash).toBe("0".repeat(64));
  });

  it("refuses an answer whose status is not a success, 200 to 299", async () => {
    for (const status of [0, 199, 300, 400, 422, 500, -201]) {
      await expectError(storeKey(someUser(), { status }), CHECK_VIOLATION, /idempotency_keys_response_status_success/);
    }
    for (const status of [200, 201, 299]) {
      expect((await storeKey(someUser(), { status })).response_status).toBe(status);
    }
  });

  it("refuses a key without its key, its operation, its fingerprint, its status or its answer", async () => {
    for (const [column, key] of [
      ["idempotency_key", { key: null }],
      ["operation_id", { operation: null }],
      ["request_hash", { hash: null }],
      ["response_status", { status: null }],
      ["response_body", { body: null }],
    ] as const) {
      await expectError(storeKey(someUser(), key), NOT_NULL_VIOLATION, new RegExp(column));
    }
  });

  it("keeps one key per company and actor: the same key again is refused, and ON CONFLICT DO NOTHING stores nothing and writes no history", async () => {
    const who = someUser();
    const first = await storeKey(who, { key: "once-per-actor" });
    await expectError(storeKey(who, { key: "once-per-actor", body: { another: true } }), UNIQUE_VIOLATION, /idempotency_keys_company_id_actor_id_idempotency_key_key/);
    const historyCount = async (): Promise<bigint | undefined> =>
      (await inTransaction(app, { company }, () => app.query<{ count: bigint }>("SELECT count(*) AS count FROM audit.history"))).rows[0]?.count;
    const before = await historyCount();
    const conflicting = await inTransaction(app, { company, ...who }, () =>
      app.query(
        `INSERT INTO ledger.idempotency_keys (company_id, idempotency_key, operation_id, request_hash, response_status, response_body)
         VALUES ($1, 'once-per-actor', 'testBookVoucher', $2, 201, '{"another": true}')
         ON CONFLICT (company_id, actor_id, idempotency_key) DO NOTHING RETURNING id`,
        [company, REQUEST_HASH],
      ),
    );
    expect(conflicting.rows).toEqual([]);
    expect(await historyCount()).toBe(before);
    expect((await keysOf(app, company)).filter((stored) => stored.idempotency_key === "once-per-actor")).toEqual([first]);
  });

  it("lets another actor of the company, and the same actor in another company, store the same key", async () => {
    const who = someUser();
    const first = await storeKey(who, { key: "shared-key" });
    const otherActor = await storeKey(someUser(), { key: "shared-key" });
    const otherKind = await storeKey(someIntegration(), { key: "shared-key" });
    const otherCompany = await storeKey(who, { key: "shared-key" }, other);
    expect(new Set([first.id, otherActor.id, otherKind.id, otherCompany.id]).size).toBe(4);
    expect(otherCompany).toMatchObject({ company_id: other, actor_id: who.actor });
  });

  it("lets the app store a key, and neither change, delete nor empty one", async () => {
    const stored = await storeKey(someUser());
    for (const sql of [
      "UPDATE ledger.idempotency_keys SET response_status = 200 WHERE id = $1",
      "UPDATE ledger.idempotency_keys SET response_body = '{}' WHERE id = $1",
      "DELETE FROM ledger.idempotency_keys WHERE id = $1",
    ]) {
      await expectError(
        inTransaction(app, { company, ...someUser() }, () => app.query(sql, [stored.id])),
        INSUFFICIENT_PRIVILEGE,
        /permission denied for table idempotency_keys/,
      );
    }
    await expectError(
      inTransaction(app, { company, ...someUser() }, () => app.query("TRUNCATE ledger.idempotency_keys")),
      INSUFFICIENT_PRIVILEGE,
      /permission denied for table idempotency_keys/,
    );
    expect((await keysOf(app, company)).find((key) => key.id === stored.id)).toEqual(stored);
  });

  it("shows a reader its own company's keys, and no other company's", async () => {
    const ownKey = await storeKey(someUser(), { key: "seen-by-its-reader" });
    const otherKey = await storeKey(someUser(), { key: "seen-by-its-reader" }, other);
    await inTransaction(owner, { company, ...someUser() }, () =>
      owner.query("INSERT INTO ledger.reader_roles (company_id, role_oid) VALUES ($1, 'nortfox_test_reader_a'::pg_catalog.regrole)", [company]),
    );
    const reader = await db.connect("readerA");
    for (const setting of [company, other]) {
      const seen = await keysOf(reader, setting);
      expect(seen.map((key) => key.id)).toContain(ownKey.id);
      expect(seen.map((key) => key.id)).not.toContain(otherKey.id);
      expect(new Set(seen.map((key) => key.company_id))).toEqual(new Set([company]));
    }
    await expectError(
      inTransaction(reader, { company, ...someUser() }, () => reader.query(INSERT_KEY, keyValues(company, {}))),
      INSUFFICIENT_PRIVILEGE,
      /permission denied for table idempotency_keys/,
    );
  });
});
