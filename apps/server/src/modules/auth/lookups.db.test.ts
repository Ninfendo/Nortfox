// SPDX-License-Identifier: AGPL-3.0-only

// The lookup functions of the login (db/README.md, the schema access). The
// app never reads a secret table: no policy and no privilege lets it. It
// reaches those rows only through these functions, which run as the owner,
// each with its search path pinned and EXECUTE for the app alone. Each takes
// a hash or an identifier and gives the columns its caller needs, of one
// row, with the identity's status. Each one that uses up a row that works
// once does it with one conditional update, so two parallel calls use it
// once. The times are the server's clock, which the server passes in, so a
// test moves it. The set-once columns never change once they are set.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, expectError, expectRefusal, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  PERSONAL_IDENTITY_NUMBERS,
  addIdentity,
  addPassword,
  addTotpSecret,
  anonymously,
  deleteIdentity,
  later,
  phcString,
  sealedSecret,
  someEmail,
  tokenHash,
} from "../../../test/identities.ts";

const [FIRST_NUMBER, SECOND_NUMBER] = PERSONAL_IDENTITY_NUMBERS;

/** The server's clock in these tests. */
const T0 = new Date("2090-03-15T10:00:00.000Z");

/** The tables that only the lookup functions read and write. */
const SECRET_TABLES = [
  "access.attempt_counters",
  "access.install_keys",
  "access.known_devices",
  "access.login_challenges",
  "access.password_credentials",
  "access.sessions",
  "access.setup_tokens",
  "access.totp_secrets",
];

/** The first row of one call, or undefined. */
async function first<T extends object>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

describe("the setup link", () => {
  let db: TestDatabase;
  let app: Client;
  let second: Client;
  let owner: Client;
  const END = later(T0, 28 * 24 * 60);

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    second = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  function create(hash: Buffer, at = T0, end = END): Promise<string | undefined> {
    return first(anonymously<{ id: string }>(app, "SELECT access.create_setup_token($1, $2, $3) AS id", [hash, at, end])).then((row) => row?.id);
  }

  async function complete(client: Client, hash: Buffer, at: Date, person: string = randomUUID()): Promise<boolean | undefined> {
    const row = await first(
      anonymously<{ done: boolean }>(client, "SELECT access.complete_setup($1, $2, $3, 'Alva Berg', $4, $5, $6, $7) AS done", [
        hash,
        at,
        person,
        someEmail(),
        phcString(),
        randomUUID(),
        sealedSecret(),
      ]),
    );
    return row?.done;
  }

  async function identityCount(): Promise<number> {
    return Number((await owner.query<{ count: bigint }>("SELECT count(*) AS count FROM access.identities")).rows[0]?.count);
  }

  it("refuses a link that is wrong, stopped by a newer link, or past its end, and makes nothing", async () => {
    const older = tokenHash();
    const newer = tokenHash();
    await create(older);
    await create(newer, later(T0, 1));
    expect(await complete(app, tokenHash(), later(T0, 2))).toBe(false);
    expect(await complete(app, older, later(T0, 2))).toBe(false);
    expect(await complete(app, newer, END)).toBe(false);
    expect(await identityCount()).toBe(0);
    const stopped = await owner.query<{ superseded: boolean; used: boolean }>(
      "SELECT superseded_at IS NOT NULL AS superseded, used_at IS NOT NULL AS used FROM access.setup_tokens WHERE token_hash = $1",
      [older],
    );
    expect(stopped.rows).toEqual([{ superseded: true, used: false }]);
  });

  it("creates the first identity once, with its password and a pending TOTP secret, and refuses a second use, also in parallel", async () => {
    const hash = tokenHash();
    await create(hash, later(T0, 3));
    const people = [randomUUID(), randomUUID()];
    const done = await Promise.all([complete(app, hash, later(T0, 4), people[0]), complete(second, hash, later(T0, 4), people[1])]);
    expect([...done].sort()).toEqual([false, true]);
    const made = await owner.query<{ id: string; name: string; status: string; hash: string; state: string }>(`
      SELECT i.id, i.name, i.status, p.password_hash AS hash, t.state
      FROM access.identities AS i
      JOIN access.password_credentials AS p ON p.identity_id = i.id
      JOIN access.totp_secrets AS t ON t.identity_id = i.id`);
    expect(made.rows).toHaveLength(1);
    expect(people).toContain(made.rows[0]?.id);
    expect(made.rows[0]).toMatchObject({ name: "Alva Berg", status: "active", state: "pending" });
    expect(made.rows[0]?.hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await complete(app, hash, later(T0, 5))).toBe(false);
    expect(await identityCount()).toBe(1);
  });

  it("makes no setup link on an install that has an identity", async () => {
    await expectRefusal(create(tokenHash(), later(T0, 6)), "install_not_empty", {});
  });
});

describe("the lookup functions", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Connections of their own as the app, for the parallel calls. */
  const parallel: Client[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    for (let count = 0; count < 7; count += 1) {
      parallel.push(await db.connect("app"));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs one call on each of the first `count` parallel connections at once, each in its own transaction. */
  function atOnce<T>(count: number, call: (client: Client) => Promise<T>): Promise<T[]> {
    return Promise.all(parallel.slice(0, count).map(call));
  }

  it("lets the app read and write no secret table directly, and a reader neither the tables nor the functions", async () => {
    for (const table of SECRET_TABLES) {
      await expectError(app.query(`SELECT * FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
      await expectError(app.query(`INSERT INTO ${table} DEFAULT VALUES`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
      await expectError(app.query(`DELETE FROM ${table}`), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
    }
    const reader = await db.connect("readerA");
    await expectError(reader.query("SELECT * FROM access.find_login('x')"), INSUFFICIENT_PRIVILEGE, /permission denied for schema access/);
    await expectError(reader.query("SELECT * FROM access.identities"), INSUFFICIENT_PRIVILEGE, /permission denied for schema access/);
  });

  describe("signing in", () => {
    function find(identifier: string) {
      return anonymously(app, "SELECT * FROM access.find_login($1)", [identifier]);
    }

    it("finds a login by the e-mail in any case or by the personnummer, with the identity's status, and nothing by another identifier", async () => {
      const person = await addIdentity(owner, { email: "Dag.Ström@example.com", personalIdentityNumber: FIRST_NUMBER, twoStep: "every_login" });
      const hash = await addPassword(owner, person);
      const login = { identity_id: person, status: "active", two_step: "every_login", password_hash: hash };
      expect(await find("dag.STRÖM@example.com")).toEqual([login]);
      expect(await find(FIRST_NUMBER)).toEqual([login]);
      expect(await find("dag.strom@example.com")).toEqual([]);
      expect(await find(someEmail())).toEqual([]);
      expect(await find(SECOND_NUMBER)).toEqual([]);
      expect(await find("")).toEqual([]);
      const bare = await addIdentity(owner, { email: "Eva.Ek@example.com" });
      expect(await find("eva.ek@example.com")).toEqual([{ identity_id: bare, status: "active", two_step: "new_device_90_days", password_hash: null }]);
      // A deleted identity holds neither its address nor its number, so nothing finds it.
      await deleteIdentity(app, person);
      expect(await find("dag.ström@example.com")).toEqual([]);
      expect(await find(FIRST_NUMBER)).toEqual([]);
    });

    function open(hash: Buffer, person: string, device: Buffer | null = null, at = T0, end = later(T0, 20)): Promise<string | null | undefined> {
      return first(
        anonymously<{ id: string | null }>(app, "SELECT access.open_challenge($1, $2, 'password-email', $3, $4, $5) AS id", [hash, person, device, at, end]),
      ).then((row) => row?.id);
    }

    function challengeOf(hash: Buffer, at = T0) {
      return anonymously(app, "SELECT * FROM access.challenge_by_token($1, $2)", [hash, at]);
    }

    function claim(client: Client, challenge: string, at = T0): Promise<number | null | undefined> {
      return client.query<{ attempt: number | null }>("SELECT access.claim_attempt($1, $2) AS attempt", [challenge, at]).then((found) => found.rows[0]?.attempt);
    }

    function use(client: Client, challenge: string, at = T0): Promise<boolean | undefined> {
      return client.query<{ used: boolean }>("SELECT access.use_challenge($1, $2) AS used", [challenge, at]).then((found) => found.rows[0]?.used);
    }

    async function secretOf(id: string): Promise<Buffer | undefined> {
      return (await owner.query<{ secret: Buffer }>("SELECT secret FROM access.totp_secrets WHERE id = $1", [id])).rows[0]?.secret;
    }

    it("opens a login challenge only for an active identity, and finds a live one by its hash, with the person's TOTP secret", async () => {
      const person = await addIdentity(owner);
      const pending = await addTotpSecret(owner, person, "pending");
      const hash = tokenHash();
      const device = tokenHash();
      const id = await open(hash, person, device);
      const live = { challenge_id: id, identity_id: person, status: "active", method: "password-email", device_hash: device, wrong_attempts: 0 };
      expect(await challengeOf(hash)).toEqual([{ ...live, totp_secret_id: pending, totp_secret: await secretOf(pending), totp_state: "pending", totp_last_used_step: null }]);
      // The active secret comes before the pending one.
      const active = await addTotpSecret(owner, person, "active");
      expect(await challengeOf(hash)).toEqual([{ ...live, totp_secret_id: active, totp_secret: await secretOf(active), totp_state: "active", totp_last_used_step: null }]);
      // Nothing by a wrong hash, and nothing once its end has come.
      expect(await challengeOf(tokenHash())).toEqual([]);
      expect(await challengeOf(hash, later(T0, 20))).toEqual([]);
      // A person without a TOTP secret, and one who is deleted.
      const without = await addIdentity(owner);
      const bare = tokenHash();
      await open(bare, without);
      expect(await challengeOf(bare)).toEqual([
        { ...live, challenge_id: expect.any(String) as unknown, identity_id: without, device_hash: null, totp_secret_id: null, totp_secret: null, totp_state: null, totp_last_used_step: null },
      ]);
      await deleteIdentity(app, without);
      expect(await open(tokenHash(), without)).toBeNull();
      expect(await open(tokenHash(), randomUUID())).toBeNull();
    });

    it("claims five attempts in all, also from seven parallel calls, and then the challenge has ended", async () => {
      const person = await addIdentity(owner);
      const hash = tokenHash();
      const id = (await open(hash, person)) ?? "";
      const claims = await atOnce(7, (client) => claim(client, id));
      expect(claims.filter((attempt) => attempt !== null).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(claims.filter((attempt) => attempt === null)).toHaveLength(2);
      expect(await challengeOf(hash)).toEqual([]);
      expect(await claim(app, id)).toBeNull();
    });

    it("uses a challenge once, from two parallel calls too, only after a claim and before its end, and gives the claimed attempt back", async () => {
      const person = await addIdentity(owner);
      const hash = tokenHash();
      const id = (await open(hash, person)) ?? "";
      expect(await use(app, id)).toBe(false);
      expect(await claim(app, id)).toBe(1);
      expect(await claim(app, id)).toBe(2);
      const used = await atOnce(2, (client) => use(client, id, later(T0, 1)));
      expect([...used].sort()).toEqual([false, true]);
      const row = await owner.query<{ wrong_attempts: number; used_at: Date }>("SELECT wrong_attempts, used_at FROM access.login_challenges WHERE id = $1", [id]);
      expect(row.rows).toEqual([{ wrong_attempts: 1, used_at: later(T0, 1) }]);
      expect(await challengeOf(hash, later(T0, 1))).toEqual([]);
      expect(await claim(app, id, later(T0, 1))).toBeNull();
      // Past its end, no attempt is claimed and nothing is used.
      const ended = (await open(tokenHash(), person)) ?? "";
      expect(await claim(app, ended, later(T0, 20))).toBeNull();
      expect(await claim(app, ended, later(T0, 19))).toBe(1);
      expect(await use(app, ended, later(T0, 20))).toBe(false);
    });

    function step(client: Client, secret: string, person: string, number: number, at = T0): Promise<boolean | undefined> {
      return client.query<{ used: boolean }>("SELECT access.use_totp_step($1, $2, $3, $4) AS used", [secret, person, number, at]).then((found) => found.rows[0]?.used);
    }

    it("uses a TOTP step once, also from two parallel calls, and a right step makes a pending secret active", async () => {
      const person = await addIdentity(owner);
      const pending = await addTotpSecret(owner, person, "pending");
      expect(await step(app, pending, person, 100)).toBe(true);
      const row = await owner.query<{ state: string; last_used_step: bigint; confirmed_at: Date }>(
        "SELECT state, last_used_step, confirmed_at FROM access.totp_secrets WHERE id = $1",
        [pending],
      );
      expect(row.rows).toEqual([{ state: "active", last_used_step: 100n, confirmed_at: T0 }]);
      expect(await step(app, pending, person, 100)).toBe(false);
      expect(await step(app, pending, person, 99)).toBe(false);
      const used = await atOnce(2, (client) => step(client, pending, person, 101));
      expect([...used].sort()).toEqual([false, true]);
      // Not for another person, and not a pending secret while the person has an active one.
      const other = await addIdentity(owner);
      expect(await step(app, pending, other, 102)).toBe(false);
      const waiting = await addTotpSecret(owner, person, "pending");
      expect(await step(app, waiting, person, 103)).toBe(false);
      expect(await step(app, randomUUID(), person, 104)).toBe(false);
      expect(await step(app, pending, person, 105)).toBe(true);
    });

    function count(client: Client, subject: string, at: Date, kind = "password") {
      return first(anonymously(client, "SELECT * FROM access.count_failure($1, $2, '1 hour', $3)", [subject, kind, at]));
    }

    function counter(subject: string, kind = "password") {
      return anonymously(app, "SELECT * FROM access.attempt_counter($1, $2)", [subject, kind]);
    }

    it("counts failures in a window, also from ten parallel calls, starts a new window once it has passed, and locks and clears", async () => {
      const subject = randomUUID();
      expect(await counter(subject)).toEqual([]);
      expect(await count(app, subject, T0)).toEqual({ failures: 1, window_started_at: T0, last_failure_at: T0, locked_until: null });
      await Promise.all([atOnce(7, (client) => count(client, subject, later(T0, 1))), count(app, subject, later(T0, 1)), count(owner, subject, later(T0, 1))]);
      expect(await counter(subject)).toEqual([{ failures: 10, window_started_at: T0, last_failure_at: later(T0, 1), locked_until: null }]);
      // The window is the hour from its first failure.
      expect(await count(app, subject, later(T0, 59))).toMatchObject({ failures: 11, window_started_at: T0 });
      expect(await count(app, subject, later(T0, 60))).toEqual({ failures: 1, window_started_at: later(T0, 60), last_failure_at: later(T0, 60), locked_until: null });
      // Each kind counts on its own, and an identifier that names no identity is counted by its HMAC.
      expect(await count(app, subject, later(T0, 61), "totp")).toMatchObject({ failures: 1 });
      const unknown = `hmac:1:${randomBytes(32).toString("hex")}`;
      expect(await count(app, unknown, later(T0, 61))).toMatchObject({ failures: 1 });
      // A lock lasts until its end, and a shorter lock never shortens it.
      await anonymously(app, "SELECT access.lock_attempts($1, 'password', $2)", [subject, later(T0, 75)]);
      await anonymously(app, "SELECT access.lock_attempts($1, 'password', $2)", [subject, later(T0, 70)]);
      expect(await counter(subject)).toEqual([{ failures: 1, window_started_at: later(T0, 60), last_failure_at: later(T0, 60), locked_until: later(T0, 75) }]);
      expect(await count(app, subject, later(T0, 61))).toMatchObject({ failures: 2, locked_until: later(T0, 75) });
      await anonymously(app, "SELECT access.clear_attempts($1, 'password')", [subject]);
      expect(await counter(subject)).toEqual([]);
      expect(await counter(subject, "totp")).toHaveLength(1);
      // Only a subject of the two forms, and a known kind.
      await expectError(count(app, "nobody@example.com", T0), CHECK_VIOLATION, /attempt_counters_subject_form/);
      await expectError(count(app, `hmac:1:${randomBytes(31).toString("hex")}`, T0), CHECK_VIOLATION, /attempt_counters_subject_form/);
      await expectError(count(app, subject, T0, "pin"), CHECK_VIOLATION, /attempt_counters_kind_known/);
    });

    function remember(person: string, hash: Buffer, at: Date): Promise<string | null | undefined> {
      return first(anonymously<{ id: string | null }>(app, "SELECT access.remember_device($1, $2, $3) AS id", [person, hash, at])).then((row) => row?.id);
    }

    function known(person: string, hash: Buffer) {
      return anonymously(app, "SELECT * FROM access.known_device($1, $2)", [person, hash]);
    }

    it("knows a device by the person and its hash, with the identity's status, and remembers each TOTP step on it", async () => {
      const person = await addIdentity(owner);
      const hash = tokenHash();
      const id = await remember(person, hash, T0);
      expect(await known(person, hash)).toEqual([{ device_id: id, status: "active", last_totp_at: T0 }]);
      expect(await remember(person, hash, later(T0, 5))).toBe(id);
      expect(await remember(person, hash, later(T0, 4))).toBe(id);
      expect(await known(person, hash)).toEqual([{ device_id: id, status: "active", last_totp_at: later(T0, 5) }]);
      expect(await known(person, tokenHash())).toEqual([]);
      // One browser, two people: each knows the device on its own.
      const other = await addIdentity(owner);
      expect(await known(other, hash)).toEqual([]);
      const theirs = await remember(other, hash, T0);
      expect(theirs).not.toBe(id);
      expect(await known(other, hash)).toEqual([{ device_id: theirs, status: "active", last_totp_at: T0 }]);
      await deleteIdentity(app, other);
      expect(await known(other, hash)).toEqual([{ device_id: theirs, status: "deleted", last_totp_at: T0 }]);
      expect(await remember(other, tokenHash(), T0)).toBeNull();
    });

    function openSession(hash: Buffer, person: string, device: string | null, at = T0, method = "password-email"): Promise<string | null | undefined> {
      return first(
        anonymously<{ id: string | null }>(app, "SELECT access.open_session($1, $2, $3, $4, $5) AS id", [hash, person, method, device, at]),
      ).then((row) => row?.id);
    }

    function sessionOf(hash: Buffer) {
      return anonymously(app, "SELECT * FROM access.session_by_token($1)", [hash]);
    }

    function end(client: Client, session: string, at: Date, reason = "logout"): Promise<boolean | undefined> {
      return client.query<{ ended: boolean }>("SELECT access.end_session($1, $2, $3) AS ended", [session, reason, at]).then((found) => found.rows[0]?.ended);
    }

    function touch(session: string, at: Date): Promise<boolean | undefined> {
      return first(anonymously<{ touched: boolean }>(app, "SELECT access.touch_session($1, $2) AS touched", [session, at])).then((row) => row?.touched);
    }

    it("opens a session for an active identity, finds it by its hash with the identity's status, touches it and ends it once", async () => {
      const person = await addIdentity(owner);
      const device = (await remember(person, tokenHash(), T0)) ?? null;
      const hash = tokenHash();
      const id = (await openSession(hash, person, device)) ?? "";
      const live = { session_id: id, identity_id: person, status: "active", method: "password-email", device_id: device, started_at: T0, last_seen_at: T0 };
      expect(await sessionOf(hash)).toEqual([live]);
      expect(await sessionOf(tokenHash())).toEqual([]);
      expect(await touch(id, later(T0, 2))).toBe(true);
      expect(await touch(id, later(T0, 1))).toBe(false);
      expect(await sessionOf(hash)).toEqual([{ ...live, last_seen_at: later(T0, 2) }]);
      const ended = await atOnce(2, (client) => end(client, id, later(T0, 3)));
      expect([...ended].sort()).toEqual([false, true]);
      expect(await sessionOf(hash)).toEqual([]);
      expect(await touch(id, later(T0, 4))).toBe(false);
      const row = await owner.query("SELECT ended_at, end_reason FROM access.sessions WHERE id = $1", [id]);
      expect(row.rows).toEqual([{ ended_at: later(T0, 3), end_reason: "logout" }]);
      // Never with another person's device, and never for an identity that is not active.
      const other = await addIdentity(owner);
      expect(await openSession(tokenHash(), other, device)).toBeNull();
      expect(await openSession(tokenHash(), other, null, T0, "bankid")).toEqual(expect.any(String));
      // A live session of a person who is then deleted gives the status, and the server refuses it.
      const kept = tokenHash();
      await openSession(kept, other, null);
      await deleteIdentity(app, other);
      expect(await sessionOf(kept)).toEqual([expect.objectContaining({ identity_id: other, status: "deleted" })]);
      expect(await openSession(tokenHash(), other, null)).toBeNull();
      // Only the known methods and reasons.
      await expectError(openSession(tokenHash(), person, null, T0, "password-sms"), CHECK_VIOLATION, /sessions_method_known/);
      const open = (await openSession(tokenHash(), person, null)) ?? "";
      await expectError(end(app, open, T0, "tired"), CHECK_VIOLATION, /sessions_end_reason_known/);
    });

    it("ends every other session of a person, and keeps the one it names and other people's", async () => {
      const person = await addIdentity(owner);
      const other = await addIdentity(owner);
      const hashes = [tokenHash(), tokenHash(), tokenHash()];
      const [keep = "", ...rest] = await Promise.all(hashes.map(async (hash) => (await openSession(hash, person, null)) ?? ""));
      const theirs = tokenHash();
      await openSession(theirs, other, null);
      const ended = await first(
        anonymously<{ ended: number }>(app, "SELECT access.end_other_sessions($1, $2, 'credentials-changed', $3) AS ended", [person, keep, later(T0, 1)]),
      );
      expect(ended?.ended).toBe(2);
      expect(await sessionOf(hashes[0] ?? tokenHash())).toHaveLength(1);
      expect(await sessionOf(hashes[1] ?? tokenHash())).toEqual([]);
      expect(await sessionOf(theirs)).toHaveLength(1);
      const reasons = await owner.query("SELECT end_reason FROM access.sessions WHERE id = ANY ($1::uuid[])", [rest]);
      expect(reasons.rows).toEqual([{ end_reason: "credentials-changed" }, { end_reason: "credentials-changed" }]);
    });
  });

  describe("the install key", () => {
    function keep(client: Client, keyId: number, value: Buffer): Promise<Buffer | undefined> {
      return client.query<{ kept: Buffer }>("SELECT access.install_key($1, $2) AS kept", [keyId, value]).then((found) => found.rows[0]?.kept);
    }

    it("keeps each key id's check value as the first start stored it, also when two start at once", async () => {
      const [a, b, c, d] = [randomBytes(44), randomBytes(44), randomBytes(44), randomBytes(44)];
      expect(await keep(app, 1, a)).toEqual(a);
      expect(await keep(app, 1, b)).toEqual(a);
      expect(await keep(app, 2, b)).toEqual(b);
      const kept = await Promise.all([keep(parallel[0] ?? app, 3, c), keep(parallel[1] ?? app, 3, d)]);
      expect(kept[0]).toEqual(kept[1]);
      await expectError(keep(app, 0, a), CHECK_VIOLATION, /install_keys_key_id_range/);
      await expectError(keep(app, 256, a), CHECK_VIOLATION, /install_keys_key_id_range/);
      await expectRefusal(owner.query("UPDATE access.install_keys SET check_value = $1 WHERE key_id = 1", [b]), "append_only", {
        table: "access.install_keys",
        operation: "UPDATE",
      });
      await expectRefusal(owner.query("DELETE FROM access.install_keys WHERE key_id = 1"), "append_only", { table: "access.install_keys", operation: "DELETE" });
      expect(await keep(app, 1, b)).toEqual(a);
    });
  });

  describe("the forms the database keeps", () => {
    it("keeps a token only as its hash of 32 bytes, once", async () => {
      const person = await addIdentity(owner);
      const short = randomBytes(31);
      const at = later(T0, 20);
      await expectError(anonymously(app, "SELECT access.open_session($1, $2, 'password-email', NULL, $3)", [short, person, T0]), CHECK_VIOLATION, /sessions_token_hash_form/);
      await expectError(anonymously(app, "SELECT access.open_challenge($1, $2, 'password-email', NULL, $3, $4)", [short, person, T0, at]), CHECK_VIOLATION, /login_challenges_token_hash_form/);
      await expectError(
        anonymously(app, "SELECT access.open_challenge($1, $2, 'password-email', $3, $4, $5)", [tokenHash(), person, short, T0, at]),
        CHECK_VIOLATION,
        /login_challenges_device_hash_form/,
      );
      await expectError(anonymously(app, "SELECT access.remember_device($1, $2, $3)", [person, short, T0]), CHECK_VIOLATION, /known_devices_device_hash_form/);
      await expectError(
        owner.query("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at) VALUES ($1, $2, $3)", [short, T0, at]),
        CHECK_VIOLATION,
        /setup_tokens_token_hash_form/,
      );
      const hash = tokenHash();
      await anonymously(app, "SELECT access.open_session($1, $2, 'password-email', NULL, $3)", [hash, person, T0]);
      await expectError(anonymously(app, "SELECT access.open_session($1, $2, 'password-email', NULL, $3)", [hash, person, T0]), UNIQUE_VIOLATION, /sessions_token_hash_key/);
    });

    it("keeps a password only as an Argon2id hash in the PHC string format", async () => {
      const person = await addIdentity(owner);
      for (const hash of [
        "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
        "$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
        "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA",
        "Glömt lösenordet en gång till",
        "",
      ]) {
        await expectError(addPassword(owner, person, hash), CHECK_VIOLATION, /password_credentials_argon2id/);
      }
      await addPassword(owner, person);
    });

    it("keeps a TOTP secret only sealed, and at most one active and one pending secret per identity", async () => {
      const person = await addIdentity(owner);
      const insert = (secret: Buffer, state = "replaced"): Promise<unknown> =>
        owner.query("INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), person, secret, state, T0]);
      await expectError(insert(sealedSecret().subarray(0, 49)), CHECK_VIOLATION, /totp_secrets_sealed/);
      await expectError(insert(Buffer.concat([sealedSecret(), Buffer.from([0])])), CHECK_VIOLATION, /totp_secrets_sealed/);
      await expectError(insert(Buffer.concat([Buffer.from([2, 1]), randomBytes(48)])), CHECK_VIOLATION, /totp_secrets_sealed/);
      await expectError(insert(Buffer.concat([Buffer.from([1, 0]), randomBytes(48)])), CHECK_VIOLATION, /totp_secrets_sealed/);
      await insert(sealedSecret());
      await insert(sealedSecret());
      await addTotpSecret(owner, person, "pending");
      await expectError(addTotpSecret(owner, person, "pending"), UNIQUE_VIOLATION, /totp_secrets_one_per_state/);
      await addTotpSecret(owner, person, "active");
      await expectError(addTotpSecret(owner, person, "active"), UNIQUE_VIOLATION, /totp_secrets_one_per_state/);
      await expectError(insert(sealedSecret(), "lost"), CHECK_VIOLATION, /totp_secrets_state_known/);
    });
  });

  describe("the set-once columns", () => {
    /** Makes a row whose column is set, as the owner, and gives its id. */
    const SET: Record<string, (person: string) => Promise<string>> = {
      "access.login_challenges": async (person) =>
        (
          await owner.query<{ id: string }>(
            "INSERT INTO access.login_challenges (token_hash, identity_id, method, created_at, expires_at, used_at) VALUES ($1, $2, 'password-email', $3, $4, $3) RETURNING id",
            [tokenHash(), person, T0, later(T0, 20)],
          )
        ).rows[0]?.id ?? "",
      "access.setup_tokens": async () =>
        (
          await owner.query<{ id: string }>(
            "INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, used_at) VALUES ($1, $2, $3, $2), ($4, $2, $3, NULL) RETURNING id",
            [tokenHash(), T0, later(T0, 60), tokenHash()],
          )
        ).rows[0]?.id ?? "",
      "access.sessions": async (person) =>
        (
          await owner.query<{ id: string }>(
            "INSERT INTO access.sessions (token_hash, identity_id, method, started_at, last_seen_at, ended_at, end_reason) VALUES ($1, $2, 'password-email', $3, $3, $3, 'logout') RETURNING id",
            [tokenHash(), person, T0],
          )
        ).rows[0]?.id ?? "",
    };

    it.each([
      ["access.login_challenges", "used_at", "used_at + interval '1 second'"],
      ["access.setup_tokens", "used_at", "used_at + interval '1 second'"],
      ["access.sessions", "ended_at", "ended_at + interval '1 second'"],
      ["access.sessions", "end_reason", "'idle'"],
    ])("never changes %s.%s once it is set, nor clears it", async (table, column, other) => {
      const person = await addIdentity(owner);
      const id = await (SET[table] ?? (() => Promise.resolve("")))(person);
      for (const value of [other, "NULL"]) {
        await expectRefusal(owner.query(`UPDATE ${table} SET ${column} = ${value} WHERE id = $1`, [id]), "immutable_field", { field: column, operation: "update" });
      }
      // The same value again is no change.
      await owner.query(`UPDATE ${table} SET ${column} = ${column} WHERE id = $1`, [id]);
    });

    it("sets a stopped setup link's mark once, and never one on a link that was used", async () => {
      const used = await (SET["access.setup_tokens"] ?? (() => Promise.resolve("")))("");
      await expectError(owner.query("UPDATE access.setup_tokens SET superseded_at = $2 WHERE id = $1", [used, T0]), CHECK_VIOLATION, /setup_tokens_used_or_superseded/);
      const stopped = await owner.query<{ id: string }>(
        "INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, superseded_at) VALUES ($1, $2, $3, $2) RETURNING id",
        [tokenHash(), T0, later(T0, 60)],
      );
      for (const value of ["superseded_at + interval '1 second'", "NULL"]) {
        await expectRefusal(owner.query(`UPDATE access.setup_tokens SET superseded_at = ${value} WHERE id = $1`, [stopped.rows[0]?.id]), "immutable_field", {
          field: "superseded_at",
          operation: "update",
        });
      }
      await expectError(owner.query("UPDATE access.setup_tokens SET used_at = $2 WHERE id = $1", [stopped.rows[0]?.id, T0]), CHECK_VIOLATION, /setup_tokens_used_or_superseded/);
    });
  });
});
