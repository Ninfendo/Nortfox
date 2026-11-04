// SPDX-License-Identifier: AGPL-3.0-only

// The idempotency keys of a signed-in person's own writes (db/README.md,
// the schema access). A write that works in no company keeps its key in
// access.idempotency_keys, a person table: the app reads and adds only the
// keys of the transaction's person. The trigger stamps the person, the kind,
// the company the transaction works in, if any, and the time, and refuses
// each when it is given. A person has a key once per company, or once with
// no company. The checks are those of the company keys: the key's alphabet,
// a request hash of 64 hexadecimal digits, and a success. The keys are
// purged 24 hours after they were stored.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, bearer, buildTestApp, personOf, testResolver, type AppPool } from "../../../test/api.ts";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { REQUEST_HASH } from "../../../test/every-table.ts";
import { addIdentity, asPerson, later } from "../../../test/identities.ts";
import { addCompany } from "../../../test/ledger.ts";
import { SHAPES_REGISTRY, shapeLog, shapesHandlers } from "../../../test/shapes.ts";
import { personKeys } from "../../api/idempotency.ts";
import { commit } from "../../db/database.ts";

/** A stored key as the owner reads it. */
interface StoredKey {
  readonly key_company_id: string | null;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: unknown;
  readonly created_at: Date;
}

const INSERT_KEY = `INSERT INTO access.idempotency_keys (idempotency_key, operation_id, request_hash, response_status, response_body)
  VALUES ($1, 'logout', $2, $3, '{}')`;

describe("the keys of a person's own writes", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 2);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function keysOf(person: string): Promise<StoredKey[]> {
    const found = await owner.query<StoredKey>(
      `SELECT key_company_id, actor_id, actor_kind, idempotency_key, operation_id, request_hash, response_status, response_body, created_at
       FROM access.idempotency_keys WHERE actor_id = $1 ORDER BY idempotency_key, key_company_id NULLS FIRST`,
      [person],
    );
    return found.rows;
  }

  it("stores a person's key with its first answer through personKeys, and finds it again for that person only", async () => {
    const person = await addIdentity(owner);
    const other = await addIdentity(owner);
    const settings = { actorId: person, actorKind: "user", channel: "rest" } as const;
    const stored = await pool.database.write(settings, async (tx) =>
      commit(await personKeys.store(tx, { key: "end-1", operationId: "logout", hash: REQUEST_HASH, status: 204, body: {} })),
    );
    expect(stored).toBe(true);
    expect(await pool.database.read(settings, async (tx) => commit(await personKeys.find(tx, person, "end-1")))).toEqual({ hash: REQUEST_HASH, status: 204, body: {} });
    expect(await pool.database.read(settings, async (tx) => commit(await personKeys.find(tx, person, "end-2")))).toBeUndefined();
    // Another person, even when the request names the first person's id, finds nothing.
    const theirs = { actorId: other, actorKind: "user", channel: "rest" } as const;
    expect(await pool.database.read(theirs, async (tx) => commit(await personKeys.find(tx, person, "end-1")))).toBeUndefined();
    // The same key again stores nothing, and says so.
    const again = await pool.database.write(settings, async (tx) =>
      commit(await personKeys.store(tx, { key: "end-1", operationId: "logout", hash: REQUEST_HASH, status: 204, body: {} })),
    );
    expect(again).toBe(false);
    expect(await keysOf(person)).toEqual([
      {
        key_company_id: null,
        actor_id: person,
        actor_kind: "user",
        idempotency_key: "end-1",
        operation_id: "logout",
        request_hash: REQUEST_HASH,
        response_status: 204,
        response_body: {},
        created_at: expect.any(Date) as unknown,
      },
    ]);
  });

  it("keeps a key once per person and company: another person's key, or the person's key in a company, is another key", async () => {
    const person = await addIdentity(owner);
    const other = await addIdentity(owner);
    const company = await addCompany(app);
    await asPerson(app, person, () => app.query(INSERT_KEY, ["k-1", REQUEST_HASH, 204]));
    await expectError(asPerson(app, person, () => app.query(INSERT_KEY, ["k-1", REQUEST_HASH, 204])), UNIQUE_VIOLATION, /idempotency_keys_once/);
    await asPerson(app, other, () => app.query(INSERT_KEY, ["k-1", REQUEST_HASH, 204]));
    await inTransaction(app, { company, actor: person, kind: "user", channel: "rest" }, () => app.query(INSERT_KEY, ["k-1", REQUEST_HASH, 200]));
    await expectError(
      inTransaction(app, { company, actor: person, kind: "user", channel: "rest" }, () => app.query(INSERT_KEY, ["k-1", REQUEST_HASH, 200])),
      UNIQUE_VIOLATION,
      /idempotency_keys_once/,
    );
    expect((await keysOf(person)).map((key) => [key.idempotency_key, key.key_company_id, key.response_status])).toEqual([
      ["k-1", null, 204],
      ["k-1", company, 200],
    ]);
    expect(await keysOf(other)).toHaveLength(1);
  });

  it("stamps the person, the kind, the company and the time, and refuses each when it is given", async () => {
    const person = await addIdentity(owner);
    const company = await addCompany(app);
    const insert = (column: string, value: unknown): Promise<unknown> =>
      asPerson(app, person, () =>
        app.query(
          `INSERT INTO access.idempotency_keys (idempotency_key, operation_id, request_hash, response_status, response_body, ${column}) VALUES ('k-2', 'logout', $1, 204, '{}', $2)`,
          [REQUEST_HASH, value],
        ),
      );
    for (const [column, value] of [
      ["actor_id", person],
      ["actor_kind", "user"],
      ["key_company_id", company],
      ["created_at", new Date()],
    ] as const) {
      await expectRefusal(insert(column, value), "immutable_field", { field: column, operation: "create" });
    }
    // The person comes from the transaction's actor, as an integration too, never from the request.
    await asPerson(app, person, () => app.query(INSERT_KEY, ["k-3", REQUEST_HASH, 201]), "integration");
    expect((await keysOf(person)).map((key) => [key.idempotency_key, key.actor_kind])).toEqual([["k-3", "integration"]]);
    // With no person, or as the internal system user, the row is nobody's, and the policy refuses it.
    await expectError(inTransaction(app, { actor: person, kind: "system" }, () => app.query(INSERT_KEY, ["k-4", REQUEST_HASH, 204])), INSUFFICIENT_PRIVILEGE, /row-level security/);
    await expectRefusal(inTransaction(app, { channel: "rest" }, () => app.query(INSERT_KEY, ["k-4", REQUEST_HASH, 204])), "actor_missing", { setting: "nortfox.actor_id" });
  });

  it("takes only a key of the alphabet, a request hash of 64 lower-case hexadecimal digits, and a success", async () => {
    const person = await addIdentity(owner);
    for (const [key, hash, status, constraint] of [
      ["k 5", REQUEST_HASH, 204, "idempotency_keys_key_form"],
      ['k"5', REQUEST_HASH, 204, "idempotency_keys_key_form"],
      ["", REQUEST_HASH, 204, "idempotency_keys_key_form"],
      ["k".repeat(256), REQUEST_HASH, 204, "idempotency_keys_key_form"],
      ["k-5", REQUEST_HASH.toUpperCase(), 204, "idempotency_keys_request_hash_form"],
      ["k-5", REQUEST_HASH.slice(1), 204, "idempotency_keys_request_hash_form"],
      ["k-5", `${REQUEST_HASH}0`, 204, "idempotency_keys_request_hash_form"],
      ["k-5", REQUEST_HASH, 422, "idempotency_keys_response_status_success"],
      ["k-5", REQUEST_HASH, 199, "idempotency_keys_response_status_success"],
    ] as const) {
      await expectError(asPerson(app, person, () => app.query(INSERT_KEY, [key, hash, status])), CHECK_VIOLATION, new RegExp(constraint));
    }
    await asPerson(app, person, () => app.query(INSERT_KEY, ["k".repeat(255), REQUEST_HASH, 299]));
  });

  it("stores a person's keyed write through /v1 in the person's keys, and a repeat gives the first answer and runs nothing", async () => {
    const person = await addIdentity(owner);
    const log = shapeLog();
    const server = buildTestApp({
      database: pool.database,
      resolve: testResolver({ person: personOf({ personId: person }) }),
      registry: SHAPES_REGISTRY,
      handlers: shapesHandlers(log),
    });
    const send = (key: string): Promise<Response> =>
      Promise.resolve(server.hono.request("/v1/test-session-ends", { method: "POST", headers: { ...bearer("person"), "idempotency-key": key } }));
    const answer = await send("end-9");
    expect(answer.status).toBe(204);
    expect(answer.headers.getSetCookie()).toHaveLength(1);
    const repeat = await send("end-9");
    expect(repeat.status).toBe(204);
    // A replay gives no cookie effects, and the handler ran once.
    expect(repeat.headers.getSetCookie()).toEqual([]);
    expect(log.calls.filter((call) => call.operationId === "testEndSession")).toHaveLength(1);
    expect((await keysOf(person)).map((key) => [key.idempotency_key, key.key_company_id, key.operation_id, key.response_status])).toEqual([
      ["end-9", null, "testEndSession", 204],
    ]);
    // Nothing reached a company table.
    const companyKeys = await owner.query<{ count: bigint }>("SELECT count(*) AS count FROM ledger.idempotency_keys");
    expect(companyKeys.rows[0]?.count).toBe(0n);
  });

  it("never lets the app change or delete a key", async () => {
    const person = await addIdentity(owner);
    await asPerson(app, person, () => app.query(INSERT_KEY, ["k-6", REQUEST_HASH, 204]));
    for (const sql of ["UPDATE access.idempotency_keys SET response_status = 200", "DELETE FROM access.idempotency_keys", "TRUNCATE access.idempotency_keys"]) {
      await expectError(asPerson(app, person, () => app.query(sql)), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
    }
    expect(await keysOf(person)).toHaveLength(1);
  });

  it("purges a key 24 hours after it was stored, by the server's clock", async () => {
    const person = await addIdentity(owner);
    await asPerson(app, person, () => app.query(INSERT_KEY, ["k-7", REQUEST_HASH, 204]));
    const [stored] = await keysOf(person);
    const at = stored?.created_at ?? new Date();
    const purge = (when: Date): Promise<unknown> => inTransaction(app, { channel: "rest" }, () => app.query("SELECT access.purge_expired($1)", [when]));
    // The database keeps the time to the microsecond, and a Date only to the
    // millisecond, so the purge just past the 24 hours is 1 ms later.
    await purge(new Date(later(at, 24 * 60).getTime() - 1));
    expect(await keysOf(person)).toHaveLength(1);
    await purge(new Date(later(at, 24 * 60).getTime() + 1));
    expect(await keysOf(person)).toEqual([]);
  });
});
